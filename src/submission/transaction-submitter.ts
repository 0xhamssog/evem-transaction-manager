import type { EvmClient } from '../clients/evm-client.js';
import type { TransactionRecord } from '../domain/transaction.js';
import { SimulationError, SubmissionError } from '../domain/transaction-error.js';
import type { Logger } from '../logging/logger.js';
import type { SqliteTransactionRepository } from '../persistence/transaction-repository.js';
import type { Hex } from '../types/common.js';
import type { FeeParameters, FeePolicy } from './fee-policy.js';
import type { ClassifiedFailure, RetryPolicy } from './retry-policy.js';

export type PreparedAttempt = {
  hash: Hex;
  serialized: Hex;
  gasLimit: bigint;
  fees: FeeParameters;
  attemptNumber: number;
};

/**
 * Signs a transaction and writes the hash before any broadcast.
 * A crash after that write can rebroadcast the same payload; it must not sign a second hash.
 */
export class TransactionSubmitter {
  constructor(
    private readonly evm: EvmClient,
    private readonly repository: SqliteTransactionRepository,
    private readonly fees: FeePolicy,
    private readonly retryPolicy: RetryPolicy,
    private readonly logger: Logger,
    private readonly now: () => string,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly broadcastRetryLimit: number,
  ) {}

  async simulate(record: TransactionRecord, gasLimit?: bigint): Promise<void> {
    try {
      await this.evm.simulate({
        account: record.account,
        to: record.to,
        data: record.data,
        value: record.value,
        ...(gasLimit !== undefined ? { gasLimit } : {}),
      });
    } catch (error) {
      const classified = this.retryPolicy.classify(error);
      if (
        classified.category === 'temporary_rpc' ||
        classified.category === 'transient_transport'
      ) {
        throw error;
      }
      throw new SimulationError(
        `simulation failed: ${classified.message}`,
        { transactionId: record.id, account: record.account },
        error,
      );
    }
  }

  async signAndPersist(
    record: TransactionRecord,
    nonce: number,
    attemptNumber: number,
    requestedFees: Partial<FeeParameters>,
  ): Promise<PreparedAttempt> {
    const fees = await this.fees.getInitialFees(requestedFees);
    const gasLimit =
      record.gasLimit ??
      (await this.evm.estimateGas({
        account: record.account,
        to: record.to,
        data: record.data,
        value: record.value,
      }));
    const signed = await this.evm.sign({
      account: record.account,
      to: record.to,
      data: record.data,
      value: record.value,
      nonce,
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const signedAt = this.now();
    this.repository.addAttempt({
      transactionId: record.id,
      hash: signed.hash,
      nonce,
      attemptNumber,
      signedAt,
      submittedAt: null,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      gasLimit,
      signedPayload: signed.serialized,
      status: 'SIGNED',
    });
    this.repository.update(record.id, {
      currentHash: signed.hash,
      gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      attemptCount: attemptNumber,
    });
    return { hash: signed.hash, serialized: signed.serialized, gasLimit, fees, attemptNumber };
  }

  /**
   * Broadcasts a previously persisted signed payload.
   * Retries use that same payload. They never allocate a new nonce.
   */
  async broadcast(prepared: PreparedAttempt, transactionId: string): Promise<void> {
    let lastFailure: ClassifiedFailure | null = null;
    for (let attempt = 0; attempt <= this.broadcastRetryLimit; attempt += 1) {
      try {
        const returned = await this.evm.broadcast(prepared.serialized);
        if (returned.toLowerCase() !== prepared.hash.toLowerCase()) {
          this.logger.warn('broadcast returned a different hash than the signed payload', {
            transactionId,
            hash: prepared.hash,
            returnedHash: returned,
          });
        }
        this.repository.updateAttemptStatus(prepared.hash, 'BROADCAST', this.now());
        return;
      } catch (error) {
        const classified = this.retryPolicy.decide(this.retryPolicy.classify(error), attempt + 1);
        if (classified.action === 'accept') {
          this.repository.updateAttemptStatus(prepared.hash, 'BROADCAST', this.now());
          return;
        }
        lastFailure = classified;
        const samePayloadRetry =
          classified.action === 'retry_broadcast' && attempt < this.broadcastRetryLimit;
        if (samePayloadRetry) {
          await this.sleep(Math.min(50 * 2 ** attempt, 1_000));
          continue;
        }
        if (!classified.ambiguous && classified.action === 'fail') {
          this.repository.updateAttemptStatus(prepared.hash, 'REJECTED');
        }
        throw new SubmissionError(
          classified.message,
          {
            transactionId,
            hash: prepared.hash,
            category: classified.category,
            attempt: prepared.attemptNumber,
          },
          { cause: error, ambiguous: classified.ambiguous || classified.action === 'reconcile' },
        );
      }
    }
    throw new SubmissionError(lastFailure?.message ?? 'broadcast failed', {
      transactionId,
      hash: prepared.hash,
    });
  }
}
