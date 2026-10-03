import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/persistence/database.js';
import { SqliteTransactionRepository } from '../../src/persistence/transaction-repository.js';
import { ACCOUNT, TARGET } from '../fixtures/harness.js';

describe('transaction repository', () => {
  it('persists wei values without losing precision and reloads them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'evm-tx-'));
    const path = join(directory, 'transactions.sqlite');
    const value = 2n ** 200n;
    const fee = 12_345_678_901_234_567_890n;
    const first = openDatabase(path);
    const repository = new SqliteTransactionRepository(first);
    repository.create({
      id: 'tx-precision',
      chainId: 31337,
      account: ACCOUNT,
      to: TARGET,
      data: '0xabcdef',
      value,
      gasLimit: 80_000n,
      maxFeePerGas: fee,
      maxPriorityFeePerGas: 1n,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    repository.update('tx-precision', { nonce: 7, currentHash: '0xABC' });
    repository.addAttempt({
      transactionId: 'tx-precision',
      hash: '0xabc',
      nonce: 7,
      attemptNumber: 1,
      signedAt: '2026-01-01T00:00:01.000Z',
      submittedAt: '2026-01-01T00:00:01.000Z',
      maxFeePerGas: fee,
      maxPriorityFeePerGas: 1n,
      gasLimit: 80_000n,
      signedPayload: '0x01',
      status: 'BROADCAST',
    });
    repository.addAttempt({
      transactionId: 'tx-precision',
      hash: '0xdef',
      nonce: 7,
      attemptNumber: 2,
      signedAt: '2026-01-01T00:00:02.000Z',
      submittedAt: '2026-01-01T00:00:02.000Z',
      maxFeePerGas: fee + 1n,
      maxPriorityFeePerGas: 2n,
      gasLimit: 80_000n,
      signedPayload: '0x02',
      status: 'BROADCAST',
    });
    repository.update('tx-precision', { currentHash: '0xdef', attemptCount: 2 });
    first.close();

    const again = openDatabase(path);
    const reloaded = new SqliteTransactionRepository(again);
    const record = reloaded.findById('tx-precision');
    expect(record?.value).toBe(value);
    expect(record?.maxFeePerGas).toBe(fee);
    expect(record?.nonce).toBe(7);
    expect(record?.originalHash).toBe('0xabc');
    expect(record?.currentHash).toBe('0xdef');
    expect(record?.replacementHashes).toEqual(['0xdef']);
    expect(reloaded.findByHash('0xDEF')?.id).toBe('tx-precision');
    expect(reloaded.findByAccountAndNonce(31337, ACCOUNT, 7)?.id).toBe('tx-precision');
    expect(reloaded.findPending()).toEqual([]);
    const schema = again
      .prepare("SELECT group_concat(sql, '\n') AS sql FROM sqlite_master")
      .get() as {
      sql: string;
    };
    expect(schema.sql.toLowerCase()).not.toContain('private_key');
    again.close();
  });
});
