import { openDatabase, type AppDatabase } from '../../src/persistence/database.js';
import { StructuredLogger } from '../../src/logging/logger.js';
import { createTransactionManager } from '../../src/index.js';
import type { TransactionManager } from '../../src/services/transaction-manager.js';
import type { Address } from '../../src/types/common.js';
import { InMemoryEvm } from './in-memory-evm.js';

export const ACCOUNT: Address = '0x1111111111111111111111111111111111111111';
export const OTHER: Address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const TARGET: Address = '0x2222222222222222222222222222222222222222';
export const REVERTER: Address = '0x3333333333333333333333333333333333333333';

export class ManualClock {
  value = Date.parse('2026-01-01T00:00:00.000Z');

  now = (): number => this.value;

  advance(ms: number): void {
    this.value += ms;
  }
}

export type Harness = {
  database: AppDatabase;
  evm: InMemoryEvm;
  manager: TransactionManager;
  clock: ManualClock;
  logs: string[];
};

export function createHarness(
  overrides: {
    database?: AppDatabase;
    evm?: InMemoryEvm;
    requiredConfirmations?: number;
    replacementTimeoutMs?: number;
    maxRetries?: number;
    minimumFeeBump?: bigint;
    maxFeePerGasCap?: bigint | null;
    confirmationTimeoutMs?: number;
    broadcastRetryLimit?: number;
  } = {},
): Harness {
  const database = overrides.database ?? openDatabase(':memory:');
  const evm = overrides.evm ?? new InMemoryEvm();
  const clock = new ManualClock();
  const logs: string[] = [];
  const manager = createTransactionManager({
    chainId: evm.chainId,
    evm,
    database,
    pollIntervalMs: 1_000,
    requiredConfirmations: overrides.requiredConfirmations ?? 1,
    replacementTimeoutMs: overrides.replacementTimeoutMs ?? 60_000,
    maxRetries: overrides.maxRetries ?? 3,
    replacementBumpPercent: 15,
    minimumFeeBump: overrides.minimumFeeBump ?? 1n,
    maxFeePerGasCap: overrides.maxFeePerGasCap ?? null,
    broadcastRetryLimit: overrides.broadcastRetryLimit ?? 2,
    confirmationTimeoutMs: overrides.confirmationTimeoutMs ?? 10_000,
    clock: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    logger: new StructuredLogger((line) => {
      logs.push(line);
    }),
  });
  return { database, evm, manager, clock, logs };
}

export function loggedEvents(logs: string[]): string[] {
  return logs.map((line) => (JSON.parse(line) as { event: string }).event);
}
