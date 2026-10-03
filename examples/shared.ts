import { privateKeyToAccount } from 'viem/accounts';
import { createTransactionManagerFromEnv, loadConfig } from '../src/index.js';
import type { TransactionManager } from '../src/services/transaction-manager.js';
import type { Address } from '../src/types/common.js';

/**
 * Boots the manager from the environment.
 * The private key is passed to the signer and is not printed.
 */
export async function boot(): Promise<{ manager: TransactionManager; account: Address }> {
  const config = loadConfig();
  if (!config.rpcUrl || !config.privateKey) {
    console.error(
      'Set RPC_URL, CHAIN_ID, and PRIVATE_KEY. Start from .env.example and an Anvil node.',
    );
    process.exit(1);
  }
  const manager = createTransactionManagerFromEnv();
  await manager.start();
  return {
    manager,
    account: privateKeyToAccount(config.privateKey).address,
  };
}
