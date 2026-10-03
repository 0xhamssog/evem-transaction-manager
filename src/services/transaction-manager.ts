import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../persistence/database.js';
import { openDatabase } from '../persistence/database.js';
import type { EvmClient } from '../clients/evm-client.js';
import {
  NotFoundError,
  ReplacementError,
  SimulationError,
  SubmissionError,
  TransactionManagerError,
  ValidationError,
  TimeoutWaitingError,
} from '../domain/transaction-error.js';
import type {
  TransactionAttempt,
  TransactionHandle,
  TransactionRecord,
  TransactionRequest,
} from '../domain/transaction.js';
import { isMonitorableStatus, isTerminalStatus } from '../domain/transaction-status.js';
import type { Logger } from '../logging/logger.js';
import { SilentLogger } from '../logging/logger.js';
import { ConfirmationMonitor } from '../monitoring/confirmation-monitor.js';
import { ReceiptMonitor } from '../monitoring/receipt-monitor.js';
import {
  TimeoutScheduler,
  TransactionMonitor,
  type Scheduler,
} from '../monitoring/transaction-monitor.js';
import { NonceLock } from '../nonce/nonce-lock.js';
import { NonceManager } from '../nonce/nonce-manager.js';
import { NonceRepository } from '../persistence/nonce-repository.js';
import { SqliteTransactionRepository } from '../persistence/transaction-repository.js';
import {
  TransactionReconciler,
  type ReconciliationReport,
} from '../reconciliation/transaction-reconciler.js';
import { StatusJournal } from './status-journal.js';
import { feePolicyFromClient, type FeePolicy } from '../submission/fee-policy.js';
import { RetryPolicy, type FailureCategory } from '../submission/retry-policy.js';
import { TransactionSubmitter, type PreparedAttempt } from '../submission/transaction-submitter.js';
import {
  isAddress,
  isHex,
  normalizeAddress,
  normalizeHex,
  systemClock,
  toIsoTimestamp,
  type Address,
  type Clock,
  type Hex,
} from '../types/common.js';

export type TransactionManagerOptions = {
  chainId: number;
  evm: EvmClient;
  databasePath?: string;
  database?: AppDatabase;
  pollIntervalMs?: number;
  requiredConfirmations?: number;
  replacementTimeoutMs?: number;
  maxRetries?: number;
  replacementBumpPercent?: number;
  minimumFeeBump?: bigint;
  maxFeePerGasCap?: bigint | null;
  maxPriorityFeePerGasCap?: bigint | null;
  broadcastRetryLimit?: number;
  maxPollIntervalMs?: number;
  confirmationTimeoutMs?: number;
  retryableCategories?: readonly FailureCategory[];
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  scheduler?: Scheduler;
  logger?: Logger;
};

export type RecoveryReport = {
  checked: number;
  rebroadcast: number;
};

/**
 * Orchestrates nonce allocation, submission, monitoring, replacement, and reconciliation
 * for one logical action at a time. Receiving a transaction hash only means the payload
 * was accepted for broadcast, not that the action completed.
 */
export class TransactionManager {
  private readonly database: AppDatabase;
  private readonly ownsDatabase: boolean;
  private readonly repository: SqliteTransactionRepository;
  private readonly nonceManager: NonceManager;
  private readonly journal: StatusJournal;
  private readonly submitter: TransactionSubmitter;
  private readonly reconciler: TransactionReconciler;
  private readonly receipts: ReceiptMonitor;
  private readonly confirmationMonitor: ConfirmationMonitor;
  private readonly monitor: TransactionMonitor;
  private readonly actionLock = new NonceLock();
  private readonly retryPolicy: RetryPolicy;
  private readonly feePolicy: FeePolicy;
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Logger;
  private readonly chainId: number;
  private readonly requiredConfirmations: number;
  private readonly replacementTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly pollIntervalMs: number;
  private readonly confirmationTimeoutMs: number;
  private readonly broadcastRetryLimit: number;

  constructor(options: TransactionManagerOptions) {
    this.chainId = options.chainId;
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? new SilentLogger();
    this.requiredConfirmations = options.requiredConfirmations ?? 1;
    this.replacementTimeoutMs = options.replacementTimeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? 120_000;
    this.broadcastRetryLimit = options.broadcastRetryLimit ?? 2;
    this.ownsDatabase = options.database === undefined;
    this.database = options.database ?? openDatabase(options.databasePath ?? ':memory:');
    this.repository = new SqliteTransactionRepository(this.database);
    const nonceRepository = new NonceRepository(this.database);
    this.nonceManager = new NonceManager(
      options.chainId,
      options.evm,
      nonceRepository,
      new NonceLock(),
      this.logger,
      () => this.iso(),
    );
    this.journal = new StatusJournal(this.repository, () => this.iso());
    this.retryPolicy = new RetryPolicy(this.maxRetries, options.retryableCategories);
    this.feePolicy = feePolicyFromClient(options.evm, {
      replacementBumpPercent: options.replacementBumpPercent ?? 15,
      minimumFeeBump: options.minimumFeeBump ?? 1_000_000_000n,
      maxFeePerGasCap: options.maxFeePerGasCap ?? null,
      maxPriorityFeePerGasCap: options.maxPriorityFeePerGasCap ?? null,
    });
    this.submitter = new TransactionSubmitter(
      options.evm,
      this.repository,
      this.feePolicy,
      this.retryPolicy,
      this.logger,
      () => this.iso(),
      this.sleep,
      this.broadcastRetryLimit,
    );
    this.reconciler = new TransactionReconciler(
      options.evm,
      this.repository,
      this.journal,
      this.logger,
      () => this.iso(),
      this.requiredConfirmations,
    );
    this.receipts = new ReceiptMonitor(options.evm);
    this.confirmationMonitor = new ConfirmationMonitor(options.evm);
    this.monitor = new TransactionMonitor({
      pollIntervalMs: this.pollIntervalMs,
      maxPollIntervalMs: options.maxPollIntervalMs ?? 30_000,
      scheduler: options.scheduler ?? new TimeoutScheduler(),
      loadPendingIds: () => this.repository.findPending().map((record) => record.id),
      inspect: (id) => this.inspect(id),
      isTransportFailure: (error) => {
        const category = this.retryPolicy.classify(error).category;
        return category === 'temporary_rpc' || category === 'transient_transport';
      },
      logger: this.logger,
    });
    this.evm = options.evm;
  }

  private readonly evm: EvmClient;

  /**
   * Reloads non-terminal transactions from SQLite and starts one shared polling loop.
   * Safe to call after a process restart.
   */
  async start(): Promise<RecoveryReport> {
    const report = await this.recover();
    this.monitor.start();
    return report;
  }

  /** Stops background polling. Persisted transactions are kept. */
  stop(): void {
    this.monitor.stop();
  }

  /** Stops polling and closes the database when this manager opened it. */
  close(): void {
    this.stop();
    if (this.ownsDatabase) this.database.close();
  }

  /**
   * Validates, allocates a nonce, optionally simulates, signs, persists the hash,
   * then broadcasts. The hash is durable before broadcast returns.
   */
  async submit(request: TransactionRequest): Promise<TransactionHandle> {
    const validated = validateRequest(request);
    const id = randomUUID();
    this.repository.create({
      id,
      chainId: this.chainId,
      account: validated.account,
      to: validated.to,
      data: validated.data,
      value: validated.value,
      gasLimit: validated.gasLimit ?? null,
      maxFeePerGas: validated.maxFeePerGas ?? null,
      maxPriorityFeePerGas: validated.maxPriorityFeePerGas ?? null,
      createdAt: this.iso(),
    });
    this.journal.transition(id, 'QUEUED', 'accepted for processing');

    let nonce: number | null = null;
    try {
      if (validated.nonce !== undefined) {
        await this.nonceManager.adoptNonce(validated.account, validated.nonce, id);
        nonce = validated.nonce;
      } else {
        nonce = await this.nonceManager.allocateNonce(validated.account, id);
      }
      let record = this.repository.update(id, { nonce });
      const shouldSimulate = validated.simulate !== false && validated.data !== '0x';
      if (shouldSimulate) {
        this.journal.transition(id, 'SIMULATING', 'simulating contract call');
        await this.withRpcRetry(() => this.submitter.simulate(record));
        record = this.must(id);
      }
      this.journal.transition(id, 'SUBMITTING', 'signing transaction');
      const prepared = await this.signWithRetry(record, nonce, 1, {
        ...(validated.maxFeePerGas !== undefined ? { maxFeePerGas: validated.maxFeePerGas } : {}),
        ...(validated.maxPriorityFeePerGas !== undefined
          ? { maxPriorityFeePerGas: validated.maxPriorityFeePerGas }
          : {}),
      });
      await this.submitter.broadcast(prepared, id);
      await this.nonceManager.markSubmitted(validated.account, nonce);
      const submittedAt = this.iso();
      this.repository.update(id, { submittedAt });
      this.journal.transition(id, 'SUBMITTED', 'signed hash persisted and broadcast');
      this.journal.transition(id, 'PENDING', 'waiting for inclusion');
      this.monitor.track(id);
      this.log('transaction submitted', id, prepared.hash, nonce, 'SUBMITTED', 1);
      this.log('transaction pending', id, prepared.hash, nonce, 'PENDING', 1);
      return { transactionId: id, hash: prepared.hash, nonce };
    } catch (error) {
      await this.handleSubmitFailure(id, validated.account, nonce, error);
      throw error;
    }
  }

  /** Returns every persisted logical transaction, including terminal records. */
  listTransactions(): TransactionRecord[] {
    return this.repository.listAll();
  }

  /** Runs one pass of the shared monitor. Does not start a background timer. */
  async poll(): Promise<void> {
    await this.monitor.tick();
  }

  /** Returns the persisted lifecycle record. */
  getStatus(transactionId: string): TransactionRecord {
    return this.must(transactionId);
  }

  /** Returns every signed attempt, including replacements that did not land. */
  getAttempts(transactionId: string): TransactionAttempt[] {
    this.must(transactionId);
    return this.repository.listAttempts(transactionId);
  }

  /**
   * Polls until the lifecycle reaches a decisive status or the timeout elapses.
   * `CONFIRMED` here means the receipt succeeded and the confirmation threshold was met.
   * It still is not `RECONCILED` until `reconcile` runs.
   */
  async waitForConfirmation(
    transactionId: string,
    options?: { timeoutMs?: number },
  ): Promise<TransactionRecord> {
    this.must(transactionId);
    const timeoutMs = options?.timeoutMs ?? this.confirmationTimeoutMs;
    const started = this.clock();
    for (;;) {
      await this.inspect(transactionId);
      const record = this.must(transactionId);
      if (isDecisive(record.status)) return record;
      if (this.clock() - started >= timeoutMs) {
        throw new TimeoutWaitingError(
          `timed out waiting for transaction ${transactionId} after ${timeoutMs}ms`,
          { transactionId, status: record.status },
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** Verifies on-chain state for one transaction and persists the result. */
  async reconcile(transactionId: string): Promise<ReconciliationReport> {
    return this.actionLock.runExclusive(transactionId, () =>
      this.reconciler.reconcile(transactionId),
    );
  }

  /**
   * Stops local monitoring for one transaction.
   * This does not cancel the transaction in the mempool. Submit a replacement to change fees,
   * or leave the original attempt to be mined.
   */
  cancelMonitoring(transactionId: string): void {
    this.must(transactionId);
    this.monitor.cancel(transactionId);
  }

  /**
   * Rebroadcasts signed-but-unconfirmed payloads and reconciles every non-terminal record.
   */
  async recover(): Promise<RecoveryReport> {
    const active = this.repository.listActive();
    let rebroadcast = 0;
    for (const record of active) {
      const resent = await this.rebroadcastSigned(record);
      if (resent) rebroadcast += 1;
      try {
        await this.reconciler.reconcile(record.id);
      } catch (error) {
        this.logger.error('reconciliation during recovery failed', {
          transactionId: record.id,
          account: record.account,
          nonce: record.nonce ?? undefined,
          hash: record.currentHash ?? undefined,
          status: record.status,
          errorCode: error instanceof TransactionManagerError ? error.code : 'RECONCILIATION',
        });
      }
    }
    const accounts = new Set(active.map((record) => record.account));
    for (const account of accounts) {
      await this.nonceManager.reconcileNonce(account);
    }
    return { checked: active.length, rebroadcast };
  }

  /** Broadcasts a higher-fee transaction with the same nonce. */
  async replace(transactionId: string): Promise<TransactionHandle> {
    return this.actionLock.runExclusive(transactionId, () => this.replaceLocked(transactionId));
  }

  /** Checks one transaction immediately. Used by the shared monitor and by waiters. */
  async inspect(transactionId: string): Promise<void> {
    await this.actionLock.runExclusive(transactionId, () => this.inspectLocked(transactionId));
  }

  private async inspectLocked(transactionId: string): Promise<void> {
    const record = this.repository.findById(transactionId);
    if (!record || !isMonitorableStatus(record.status) || this.monitor.isCancelled(transactionId)) {
      return;
    }
    this.repository.update(transactionId, { lastCheckedAt: this.iso() });
    const attempts = this.repository.listAttempts(transactionId);
    const located = await this.receipts.locate(record, attempts);
    if (located) {
      await this.applyReceipt(record, located.hash, located.receipt, located.attempt.attemptNumber);
      return;
    }

    for (const attempt of attempts) {
      const transaction = await this.evm.getTransaction(attempt.hash);
      if (!transaction || transaction.blockNumber === null) continue;
      let receipt = await this.evm.getReceipt(attempt.hash);
      if (!receipt) {
        await delay(200);
        receipt = await this.evm.getReceipt(attempt.hash);
      }
      if (receipt) {
        await this.applyReceipt(record, attempt.hash, receipt, attempt.attemptNumber);
        return;
      }
      this.repository.update(transactionId, {
        errorCode: 'RECONCILIATION',
        errorMessage: 'transaction is in a block but the receipt is not available yet',
      });
      this.journal.moveTo(
        transactionId,
        'RECONCILIATION_REQUIRED',
        'included transaction is missing a receipt',
      );
      return;
    }

    if (record.nonce !== null) {
      const latest = await this.evm.getLatestNonce(record.account);
      if (latest > record.nonce) {
        const resolved = await this.resolveNonceConsumption(record, attempts);
        if (resolved) return;
      }
    }

    const notedReplacement = await this.noteKnownReplacement(record);
    if (notedReplacement) return;

    const fresh = this.must(transactionId);
    if (!isMonitorableStatus(fresh.status) || fresh.submittedAt === null) return;
    const age = this.clock() - Date.parse(fresh.submittedAt);
    if (age < this.replacementTimeoutMs) return;
    if (fresh.attemptCount >= this.maxRetries) {
      if (fresh.status !== 'TIMED_OUT') {
        this.journal.transition(transactionId, 'TIMED_OUT', 'pending timeout');
      }
      this.journal.moveTo(
        transactionId,
        'RECONCILIATION_REQUIRED',
        'replacement attempts exhausted while the transaction was still pending',
      );
      return;
    }
    if (fresh.status !== 'TIMED_OUT' && fresh.status !== 'REPLACEMENT_PENDING') {
      this.journal.transition(
        transactionId,
        'TIMED_OUT',
        'pending longer than the replacement timeout',
      );
    }
    await this.replaceLocked(transactionId);
  }

  private async applyReceipt(
    record: TransactionRecord,
    hash: Hex,
    receipt: {
      status: 'success' | 'reverted';
      blockNumber: bigint;
      blockHash: Hex;
      transactionIndex: number;
      logs: unknown[];
    },
    attempt: number,
  ): Promise<void> {
    const confirmations = await this.confirmationMonitor.count({
      hash,
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      transactionIndex: receipt.transactionIndex,
      gasUsed: 0n,
      logs: [],
    });
    this.repository.update(record.id, {
      currentHash: hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      transactionIndex: receipt.transactionIndex,
      confirmations,
      receiptStatus: receipt.status,
      logCount: receipt.logs.length,
    });
    this.repository.updateAttemptStatus(hash, 'MINED');
    if (receipt.status === 'reverted') {
      // A reverted receipt is final for this payload. Do not sign another attempt.
      this.repository.update(record.id, {
        errorCode: 'TRANSACTION_REVERTED',
        errorMessage: 'execution reverted on chain; this is not retried automatically',
        confirmedAt: this.iso(),
      });
      this.journal.moveTo(record.id, 'REVERTED', 'receipt status is reverted');
      this.log('transaction reverted', record.id, hash, record.nonce, 'REVERTED', attempt);
      return;
    }
    if (confirmations >= this.requiredConfirmations) {
      this.repository.update(record.id, {
        confirmedAt: this.iso(),
        errorCode: null,
        errorMessage: null,
      });
      this.journal.moveTo(record.id, 'CONFIRMED', `reached ${confirmations} confirmation(s)`);
      this.log('transaction confirmed', record.id, hash, record.nonce, 'CONFIRMED', attempt);
      return;
    }
    this.log('transaction pending', record.id, hash, record.nonce, record.status, attempt);
  }

  /**
   * The account nonce moved. A known hash in a recent block is our transaction.
   * A different hash is unknown consumption. A missing hash is still uncertain.
   */
  private async resolveNonceConsumption(
    record: TransactionRecord,
    attempts: TransactionAttempt[],
  ): Promise<boolean> {
    if (record.nonce === null) return false;
    let mined = await this.evm.findTransactionByNonce(record.account, record.nonce);
    let known = new Set(attempts.map((attempt) => attempt.hash.toLowerCase()));
    if (!mined || !known.has(mined.hash.toLowerCase())) {
      // Nonce counts can move before eth_getTransactionByHash can see the same block.
      await delay(200);
      const located = await this.receipts.locate(record, attempts);
      if (located) {
        await this.applyReceipt(
          record,
          located.hash,
          located.receipt,
          located.attempt.attemptNumber,
        );
        return true;
      }
      mined = await this.evm.findTransactionByNonce(record.account, record.nonce);
      known = new Set(attempts.map((attempt) => attempt.hash.toLowerCase()));
    }
    if (mined && known.has(mined.hash.toLowerCase())) {
      const receipt = await this.evm.getReceipt(mined.hash);
      if (receipt) {
        const attempt = attempts.find(
          (item) => item.hash.toLowerCase() === mined.hash.toLowerCase(),
        );
        await this.applyReceipt(
          record,
          mined.hash,
          receipt,
          attempt?.attemptNumber ?? record.attemptCount,
        );
        return true;
      }
      this.repository.update(record.id, {
        currentHash: mined.hash,
        errorCode: 'RECONCILIATION',
        errorMessage: 'known hash is in a block but the receipt is not available yet',
      });
      this.journal.moveTo(
        record.id,
        'RECONCILIATION_REQUIRED',
        'included transaction is missing a receipt',
      );
      return true;
    }
    const message = mined
      ? `nonce ${record.nonce} was consumed by ${mined.hash}, which this manager did not submit`
      : 'account nonce advanced but none of the known hashes were included';
    this.repository.update(record.id, { errorCode: 'RECONCILIATION', errorMessage: message });
    this.journal.moveTo(record.id, 'RECONCILIATION_REQUIRED', 'unknown nonce consumption');
    this.logger.warn('unknown nonce consumption', {
      transactionId: record.id,
      account: record.account,
      nonce: record.nonce,
      hash: mined?.hash ?? record.currentHash ?? undefined,
      status: 'RECONCILIATION_REQUIRED',
    });
    return true;
  }

  private async noteKnownReplacement(record: TransactionRecord): Promise<boolean> {
    if (record.status !== 'REPLACEMENT_PENDING' || !record.currentHash) return false;
    const current = await this.evm.getTransaction(record.currentHash);
    if (!current || current.blockNumber !== null) return false;
    const previous = [record.originalHash, ...record.replacementHashes].filter(
      (hash): hash is Hex => hash !== null && hash !== record.currentHash,
    );
    if (previous.length === 0) return false;
    const stillPresent = await Promise.all(previous.map((hash) => this.evm.getTransaction(hash)));
    if (stillPresent.some((transaction) => transaction !== null)) return false;
    this.journal.transition(record.id, 'REPLACED', 'a known replacement superseded the prior hash');
    this.journal.transition(record.id, 'PENDING', 'monitoring the replacement hash');
    return true;
  }

  private async replaceLocked(transactionId: string): Promise<TransactionHandle> {
    const record = this.must(transactionId);
    const replaceable = ['PENDING', 'SUBMITTED', 'TIMED_OUT', 'REPLACEMENT_PENDING', 'REPLACED'];
    if (!replaceable.includes(record.status)) {
      throw new ReplacementError(`cannot replace a transaction in status ${record.status}`, {
        transactionId,
        status: record.status,
      });
    }
    if (
      record.nonce === null ||
      record.maxFeePerGas === null ||
      record.maxPriorityFeePerGas === null
    ) {
      throw new ReplacementError(
        'transaction is missing the nonce or fees required for replacement',
        {
          transactionId,
        },
      );
    }
    if (record.attemptCount >= this.maxRetries) {
      throw new ReplacementError('replacement retry limit reached', {
        transactionId,
        attempt: record.attemptCount,
      });
    }
    // Replacements keep the allocated nonce. A new nonce would be a different action.
    const nonce = record.nonce;
    const previousFees = {
      maxFeePerGas: record.maxFeePerGas,
      maxPriorityFeePerGas: record.maxPriorityFeePerGas,
    };
    const nextFees = this.feePolicy.getReplacementFees(previousFees, record.attemptCount + 1);
    const previousHash = record.currentHash;
    if (record.status === 'REPLACEMENT_PENDING') {
      this.journal.transition(
        transactionId,
        'REPLACED',
        'superseding an in-flight attempt with another known replacement',
      );
    } else if (record.status !== 'TIMED_OUT') {
      this.journal.transition(transactionId, 'TIMED_OUT', 'replacement requested');
    }
    this.journal.transition(
      transactionId,
      'REPLACEMENT_PENDING',
      'submitting a same-nonce replacement',
    );
    try {
      const prepared = await this.submitter.signAndPersist(
        this.must(transactionId),
        nonce,
        record.attemptCount + 1,
        nextFees,
      );
      await this.submitter.broadcast(prepared, transactionId);
      this.repository.update(transactionId, { submittedAt: this.iso() });
      this.log(
        'transaction replacement submitted',
        transactionId,
        prepared.hash,
        nonce,
        'REPLACEMENT_PENDING',
        prepared.attemptNumber,
      );
      return { transactionId, hash: prepared.hash, nonce };
    } catch (error) {
      if (error instanceof SubmissionError && error.ambiguous) {
        this.repository.update(transactionId, {
          errorCode: error.code,
          errorMessage: error.message,
        });
        this.journal.moveTo(
          transactionId,
          'RECONCILIATION_REQUIRED',
          'replacement broadcast outcome is uncertain',
        );
        throw error;
      }
      this.repository.update(transactionId, {
        currentHash: previousHash,
        maxFeePerGas: previousFees.maxFeePerGas,
        maxPriorityFeePerGas: previousFees.maxPriorityFeePerGas,
        errorCode: error instanceof TransactionManagerError ? error.code : 'REPLACEMENT',
        errorMessage: error instanceof Error ? error.message : 'replacement failed',
      });
      const fresh = this.must(transactionId);
      if (fresh.status === 'REPLACEMENT_PENDING') {
        this.journal.transition(
          transactionId,
          'PENDING',
          'replacement was rejected before acceptance',
        );
      }
      if (error instanceof TransactionManagerError) throw error;
      throw new ReplacementError(
        error instanceof Error ? error.message : 'replacement failed',
        { transactionId },
        error,
      );
    }
  }

  private async rebroadcastSigned(record: TransactionRecord): Promise<boolean> {
    const signed = [...this.repository.listAttempts(record.id)]
      .reverse()
      .find((attempt) => attempt.status === 'SIGNED');
    if (!signed) return false;
    const [existing, receipt] = await Promise.all([
      this.evm.getTransaction(signed.hash),
      this.evm.getReceipt(signed.hash),
    ]);
    if (existing || receipt) {
      this.repository.updateAttemptStatus(
        signed.hash,
        'BROADCAST',
        signed.submittedAt ?? this.iso(),
      );
      if (record.nonce !== null)
        await this.nonceManager.markSubmitted(record.account, record.nonce);
      return false;
    }
    try {
      await this.evm.broadcast(signed.signedPayload);
      this.repository.updateAttemptStatus(signed.hash, 'BROADCAST', this.iso());
      if (record.nonce !== null)
        await this.nonceManager.markSubmitted(record.account, record.nonce);
      this.logger.info('rebroadcast signed transaction after restart', {
        transactionId: record.id,
        account: record.account,
        nonce: record.nonce ?? undefined,
        hash: signed.hash,
        status: record.status,
        attempt: signed.attemptNumber,
      });
      return true;
    } catch (error) {
      const classified = this.retryPolicy.classify(error);
      if (classified.category === 'already_known') {
        this.repository.updateAttemptStatus(signed.hash, 'BROADCAST', this.iso());
        if (record.nonce !== null)
          await this.nonceManager.markSubmitted(record.account, record.nonce);
        return false;
      }
      if (!classified.ambiguous) {
        this.repository.updateAttemptStatus(signed.hash, 'REJECTED');
      }
      this.logger.error('rebroadcast failed', {
        transactionId: record.id,
        hash: signed.hash,
        errorCode: classified.category,
      });
      return false;
    }
  }

  private async signWithRetry(
    record: TransactionRecord,
    nonce: number,
    attemptNumber: number,
    fees: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint },
  ): Promise<PreparedAttempt> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.broadcastRetryLimit; attempt += 1) {
      const before = this.repository.listAttempts(record.id).length;
      try {
        return await this.submitter.signAndPersist(record, nonce, attemptNumber, fees);
      } catch (error) {
        lastError = error;
        if (this.repository.listAttempts(record.id).length !== before) throw error;
        const classified = this.retryPolicy.classify(error);
        if (!classified.retryable || classified.ambiguous || attempt === this.broadcastRetryLimit) {
          throw error;
        }
        await this.sleep(Math.min(50 * 2 ** attempt, 1_000));
      }
    }
    throw lastError;
  }

  private async withRpcRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.broadcastRetryLimit; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (error instanceof TransactionManagerError) throw error;
        const classified = this.retryPolicy.classify(error);
        if (!classified.retryable || classified.ambiguous || attempt === this.broadcastRetryLimit) {
          throw error;
        }
        await this.sleep(Math.min(50 * 2 ** attempt, 1_000));
      }
    }
    throw lastError;
  }

  private async handleSubmitFailure(
    id: string,
    account: Address,
    nonce: number | null,
    error: unknown,
  ): Promise<void> {
    const record = this.repository.findById(id);
    if (!record || isTerminalStatus(record.status) || record.status === 'RECONCILIATION_REQUIRED') {
      return;
    }
    if (error instanceof SimulationError) {
      this.fail(id, error);
      if (nonce !== null) await this.releaseQuietly(account, nonce, id);
      return;
    }
    if (error instanceof SubmissionError && error.ambiguous) {
      if (nonce !== null) await this.nonceManager.markSubmitted(account, nonce);
      this.repository.update(id, { errorCode: error.code, errorMessage: error.message });
      this.journal.moveTo(
        id,
        'RECONCILIATION_REQUIRED',
        'broadcast outcome is uncertain; the signed hash was persisted',
      );
      return;
    }
    const classified = this.retryPolicy.classify(error);
    if (classified.category === 'nonce_conflict') {
      if (nonce !== null) await this.nonceManager.markSubmitted(account, nonce);
      this.repository.update(id, { errorCode: 'NONCE_MISMATCH', errorMessage: classified.message });
      this.journal.moveTo(id, 'RECONCILIATION_REQUIRED', 'nonce conflict requires reconciliation');
      return;
    }
    if (error instanceof TransactionManagerError) this.fail(id, error);
    else {
      this.fail(
        id,
        new SubmissionError(
          classified.message,
          { transactionId: id, category: classified.category },
          {
            cause: error,
          },
        ),
      );
    }
    if (nonce !== null) await this.releaseQuietly(account, nonce, id);
  }

  private fail(id: string, error: TransactionManagerError): void {
    const record = this.repository.findById(id);
    if (!record || isTerminalStatus(record.status)) return;
    this.repository.update(id, { errorCode: error.code, errorMessage: error.message });
    this.journal.moveTo(id, 'FAILED', error.message);
  }

  private async releaseQuietly(
    account: Address,
    nonce: number,
    transactionId: string,
  ): Promise<void> {
    try {
      await this.nonceManager.releaseNonce(account, nonce);
    } catch (error) {
      this.logger.warn('nonce release skipped', {
        transactionId,
        account,
        nonce,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private must(id: string): TransactionRecord {
    const record = this.repository.findById(id);
    if (!record) throw new NotFoundError(`transaction ${id} was not found`, { transactionId: id });
    return record;
  }

  private iso(): string {
    return toIsoTimestamp(this.clock());
  }

  private log(
    event: string,
    transactionId: string,
    hash: Hex | null,
    nonce: number | null,
    status: TransactionRecord['status'],
    attempt: number,
  ): void {
    const record = this.repository.findById(transactionId);
    this.logger.info(event, {
      transactionId,
      account: record?.account,
      nonce: nonce ?? undefined,
      hash: hash ?? undefined,
      status,
      attempt,
    });
  }
}

function validateRequest(request: TransactionRequest): {
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  nonce?: number;
  simulate?: boolean;
} {
  if (!isAddress(request.account))
    throw new ValidationError('account must be a 20-byte hex address');
  if (!isAddress(request.to)) throw new ValidationError('to must be a 20-byte hex address');
  if (request.value !== undefined && request.value < 0n) {
    throw new ValidationError('value cannot be negative');
  }
  if (request.gasLimit !== undefined && request.gasLimit <= 0n) {
    throw new ValidationError('gasLimit must be positive');
  }
  if (request.maxFeePerGas !== undefined && request.maxFeePerGas < 0n) {
    throw new ValidationError('maxFeePerGas cannot be negative');
  }
  if (request.maxPriorityFeePerGas !== undefined && request.maxPriorityFeePerGas < 0n) {
    throw new ValidationError('maxPriorityFeePerGas cannot be negative');
  }
  if (
    request.maxFeePerGas !== undefined &&
    request.maxPriorityFeePerGas !== undefined &&
    request.maxPriorityFeePerGas > request.maxFeePerGas
  ) {
    throw new ValidationError('maxPriorityFeePerGas cannot exceed maxFeePerGas');
  }
  if (request.data !== undefined && !isHex(request.data)) {
    throw new ValidationError('data must be even-length hex');
  }
  if (request.nonce !== undefined && (!Number.isInteger(request.nonce) || request.nonce < 0)) {
    throw new ValidationError('nonce must be a non-negative integer');
  }
  return {
    account: normalizeAddress(request.account),
    to: normalizeAddress(request.to),
    data: request.data ? normalizeHex(request.data) : '0x',
    value: request.value ?? 0n,
    ...(request.gasLimit !== undefined ? { gasLimit: request.gasLimit } : {}),
    ...(request.maxFeePerGas !== undefined ? { maxFeePerGas: request.maxFeePerGas } : {}),
    ...(request.maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGas: request.maxPriorityFeePerGas }
      : {}),
    ...(request.nonce !== undefined ? { nonce: request.nonce } : {}),
    ...(request.simulate !== undefined ? { simulate: request.simulate } : {}),
  };
}

function isDecisive(status: TransactionRecord['status']): boolean {
  return (
    status === 'CONFIRMED' ||
    status === 'REVERTED' ||
    status === 'RECONCILED' ||
    status === 'FAILED' ||
    status === 'RECONCILIATION_REQUIRED'
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
