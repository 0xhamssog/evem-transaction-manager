import type { EvmClient } from '../clients/evm-client.js';
import type { TransactionAttempt, TransactionRecord } from '../domain/transaction.js';
import type { ChainReceipt } from '../clients/evm-client.js';
import type { Hex } from '../types/common.js';

export type LocatedReceipt = {
  hash: Hex;
  receipt: ChainReceipt;
  attempt: TransactionAttempt;
};

/**
 * Looks up receipts for the current hash first, then older known attempts.
 * An older known hash that mined is still this lifecycle; it is not an unknown replacement.
 */
export class ReceiptMonitor {
  constructor(private readonly evm: Pick<EvmClient, 'getReceipt' | 'getTransaction'>) {}

  async locate(
    record: TransactionRecord,
    attempts: TransactionAttempt[],
  ): Promise<LocatedReceipt | null> {
    const ordered = [...attempts].sort((left, right) => {
      if (left.hash === record.currentHash) return -1;
      if (right.hash === record.currentHash) return 1;
      return right.attemptNumber - left.attemptNumber;
    });
    for (const attempt of ordered) {
      const receipt = await this.evm.getReceipt(attempt.hash);
      if (receipt) return { hash: attempt.hash, receipt, attempt };
    }
    return null;
  }
}
