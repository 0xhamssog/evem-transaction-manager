import type { ChainLog, EvmClient } from '../clients/evm-client.js';
import type { TransactionRecord } from '../domain/transaction.js';
import { ReconciliationError } from '../domain/transaction-error.js';
import { type TransactionStatus } from '../domain/transaction-status.js';
import type { Logger } from '../logging/logger.js';
import { ConfirmationMonitor } from '../monitoring/confirmation-monitor.js';
import type { SqliteTransactionRepository } from '../persistence/transaction-repository.js';
import type { StatusJournal } from '../services/status-journal.js';
import type { Hex } from '../types/common.js';

export type ReconciliationOutcome =
  | 'confirmed'
  | 'reverted'
  | 'pending'
  | 'pending_confirmations'
  | 'missing_receipt'
  | 'unknown_nonce_consumption'
  | 'nonce_mismatch'
  | 'already_final';

export type ReconciliationReport = {
  transactionId: string;
  outcome: ReconciliationOutcome;
  status: TransactionStatus;
  hash: Hex | null;
  nonce: number | null;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  confirmations: number;
  logCount: number | null;
  logs: ChainLog[];
  message: string;
};

/**
 * Answers "what actually happened on chain?" from the database plus RPC.
 * It does not treat nonce advancement as proof that our replacement was the transaction
 * that consumed the nonce.
 */
export class TransactionReconciler {
  private readonly confirmations: ConfirmationMonitor;

  constructor(
    private readonly evm: EvmClient,
    private readonly repository: SqliteTransactionRepository,
    private readonly journal: StatusJournal,
    private readonly logger: Logger,
    private readonly now: () => string,
    private readonly requiredConfirmations: number,
  ) {
    this.confirmations = new ConfirmationMonitor(evm);
  }

  /** Re-reads chain state for one logical transaction and persists the verified result. */
  async reconcile(transactionId: string): Promise<ReconciliationReport> {
    const record = this.repository.findById(transactionId);
    if (!record) {
      throw new ReconciliationError(`transaction ${transactionId} was not found`, {
        transactionId,
      });
    }
    if (record.status === 'RECONCILED' || record.status === 'FAILED') {
      return this.report(
        record,
        record.status === 'RECONCILED' ? 'already_final' : 'already_final',
        [],
        'no further reconciliation',
      );
    }

    const attempts = [...this.repository.listAttempts(transactionId)].reverse();
    let pendingAttempt: (typeof attempts)[number] | null = null;
    let includedWithoutReceipt = false;
    for (const attempt of attempts) {
      const [transaction, receipt] = await Promise.all([
        this.evm.getTransaction(attempt.hash),
        this.evm.getReceipt(attempt.hash),
      ]);
      if (transaction && transaction.nonce !== attempt.nonce) {
        this.repository.update(transactionId, {
          errorCode: 'NONCE_MISMATCH',
          errorMessage: `on-chain nonce ${transaction.nonce} does not match recorded nonce ${attempt.nonce}`,
          lastCheckedAt: this.now(),
        });
        this.journal.moveTo(
          transactionId,
          'RECONCILIATION_REQUIRED',
          'on-chain nonce did not match the persisted attempt',
        );
        throw new ReconciliationError('on-chain nonce did not match the persisted attempt', {
          transactionId,
          nonce: attempt.nonce,
          chainNonce: transaction.nonce,
          hash: attempt.hash,
        });
      }
      if (!receipt) {
        if (transaction && transaction.blockNumber === null && pendingAttempt === null) {
          pendingAttempt = attempt;
        }
        if (transaction && transaction.blockNumber !== null) includedWithoutReceipt = true;
        continue;
      }

      const confirmationCount = await this.confirmations.count(receipt);
      const updated = this.repository.update(transactionId, {
        currentHash: attempt.hash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex,
        confirmations: confirmationCount,
        receiptStatus: receipt.status,
        logCount: receipt.logs.length,
        lastCheckedAt: this.now(),
      });
      this.repository.updateAttemptStatus(attempt.hash, 'MINED');

      if (receipt.status === 'reverted') {
        this.journal.moveTo(transactionId, 'REVERTED', 'receipt status is reverted');
        const reconciled = this.finish(
          transactionId,
          'execution reverted; reconciled without retrying the reverted call',
        );
        this.logger.info('transaction reconciled', {
          transactionId,
          account: record.account,
          nonce: record.nonce ?? undefined,
          hash: attempt.hash,
          status: 'RECONCILED',
          attempt: attempt.attemptNumber,
        });
        return this.report(reconciled, 'reverted', receipt.logs, 'reverted execution was verified');
      }

      if (confirmationCount < this.requiredConfirmations) {
        if (
          record.status === 'SUBMITTING' ||
          record.status === 'SUBMITTED' ||
          record.status === 'RECONCILIATION_REQUIRED'
        ) {
          this.journal.moveTo(
            transactionId,
            'PENDING',
            'included, waiting for the confirmation threshold',
          );
        }
        const waiting = this.repository.findById(transactionId) ?? updated;
        return this.report(
          waiting,
          'pending_confirmations',
          receipt.logs,
          `included with ${confirmationCount} confirmation(s); ${this.requiredConfirmations} required`,
        );
      }

      this.journal.moveTo(
        transactionId,
        'CONFIRMED',
        `included with ${confirmationCount} confirmation(s)`,
      );
      const reconciled = this.finish(transactionId, 'inclusion and receipt were verified');
      this.logger.info('transaction reconciled', {
        transactionId,
        account: record.account,
        nonce: record.nonce ?? undefined,
        hash: attempt.hash,
        status: 'RECONCILED',
        attempt: attempt.attemptNumber,
      });
      return this.report(
        reconciled,
        'confirmed',
        receipt.logs,
        'successful execution was verified',
      );
    }

    if (includedWithoutReceipt) {
      this.repository.update(transactionId, {
        errorCode: 'RECONCILIATION',
        errorMessage: 'a known hash is in a block but the receipt is not available',
        lastCheckedAt: this.now(),
      });
      const uncertain = this.journal.moveTo(
        transactionId,
        'RECONCILIATION_REQUIRED',
        'included transaction is missing a receipt',
      );
      return this.report(
        uncertain,
        'missing_receipt',
        [],
        'receipt is missing for an included transaction',
      );
    }

    if (pendingAttempt) {
      this.repository.update(transactionId, {
        currentHash: pendingAttempt.hash,
        lastCheckedAt: this.now(),
      });
      const visible = this.journal.moveTo(
        transactionId,
        'PENDING',
        'known hash is still in the mempool',
      );
      return this.report(visible, 'pending', [], 'transaction is still pending');
    }

    if (record.nonce !== null) {
      const latest = await this.evm.getLatestNonce(record.account);
      if (latest > record.nonce) {
        const message =
          'the account nonce advanced, but none of the known hashes were found on chain';
        this.repository.update(transactionId, {
          errorCode: 'RECONCILIATION',
          errorMessage: message,
          lastCheckedAt: this.now(),
        });
        const uncertain = this.journal.moveTo(
          transactionId,
          'RECONCILIATION_REQUIRED',
          'unknown nonce consumption',
        );
        this.logger.warn('unknown nonce consumption', {
          transactionId,
          account: record.account,
          nonce: record.nonce,
          status: 'RECONCILIATION_REQUIRED',
        });
        return this.report(uncertain, 'unknown_nonce_consumption', [], message);
      }
    }

    const current = this.repository.update(transactionId, { lastCheckedAt: this.now() });
    return this.report(current, 'missing_receipt', [], 'no receipt for any known hash');
  }

  private finish(transactionId: string, reason: string): TransactionRecord {
    const current = this.repository.findById(transactionId);
    if (!current) {
      throw new ReconciliationError(`transaction ${transactionId} was not found`, {
        transactionId,
      });
    }
    if (current.status === 'RECONCILED' || current.status === 'FAILED') return current;
    const reconciled = this.journal.moveTo(transactionId, 'RECONCILED', reason);
    return this.repository.update(transactionId, {
      reconciledAt: this.now(),
      errorCode: reconciled.receiptStatus === 'reverted' ? 'TRANSACTION_REVERTED' : null,
      errorMessage:
        reconciled.receiptStatus === 'reverted'
          ? 'execution reverted; reconciled without an automatic retry'
          : null,
    });
  }

  private report(
    record: TransactionRecord,
    outcome: ReconciliationOutcome,
    logs: ChainLog[],
    message: string,
  ): ReconciliationReport {
    return {
      transactionId: record.id,
      outcome,
      status: record.status,
      hash: record.currentHash,
      nonce: record.nonce,
      blockNumber: record.blockNumber,
      blockHash: record.blockHash,
      confirmations: record.confirmations,
      logCount: record.logCount,
      logs,
      message,
    };
  }
}
