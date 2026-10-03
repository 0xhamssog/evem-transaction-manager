import type { EvmClient } from '../clients/evm-client.js';
import type { ChainReceipt } from '../clients/evm-client.js';
import { confirmationCount } from '../types/common.js';

/** Counts blocks after inclusion. One confirmation means the including block itself. */
export class ConfirmationMonitor {
  constructor(private readonly evm: Pick<EvmClient, 'getBlockNumber'>) {}

  async count(receipt: ChainReceipt): Promise<number> {
    const head = await this.evm.getBlockNumber();
    const confirmations = head - receipt.blockNumber + 1n;
    return confirmationCount(confirmations < 0n ? 0n : confirmations);
  }
}
