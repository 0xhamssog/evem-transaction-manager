import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NonceManager } from '../../src/nonce/nonce-manager.js';
import { NonceLock } from '../../src/nonce/nonce-lock.js';
import { NonceMismatchError } from '../../src/domain/transaction-error.js';
import { SilentLogger } from '../../src/logging/logger.js';
import { openDatabase } from '../../src/persistence/database.js';
import { NonceRepository } from '../../src/persistence/nonce-repository.js';
import { ACCOUNT } from '../fixtures/harness.js';
import { InMemoryEvm } from '../fixtures/in-memory-evm.js';

const databases: Array<{ close(): void }> = [];

function createNonceManager(evm = new InMemoryEvm(), path = ':memory:') {
  const database = openDatabase(path);
  databases.push(database);
  const manager = new NonceManager(
    evm.chainId,
    evm,
    new NonceRepository(database),
    new NonceLock(),
    new SilentLogger(),
    () => '2026-01-01T00:00:00.000Z',
  );
  return { database, evm, manager };
}

afterEach(() => {
  for (const database of databases) database.close();
  databases.length = 0;
});

describe('nonce manager', () => {
  it('starts from the pending chain nonce', async () => {
    const { evm, manager } = createNonceManager();
    evm.consumeNonce(ACCOUNT);
    evm.consumeNonce(ACCOUNT);
    await expect(manager.getNextNonce(ACCOUNT)).resolves.toBe(2);
    await expect(manager.allocateNonce(ACCOUNT)).resolves.toBe(2);
  });

  it('allocates sequential nonces', async () => {
    const { manager } = createNonceManager();
    const first = await manager.allocateNonce(ACCOUNT);
    const second = await manager.allocateNonce(ACCOUNT);
    const third = await manager.allocateNonce(ACCOUNT);
    expect([first, second, third]).toEqual([0, 1, 2]);
    await expect(manager.getNextNonce(ACCOUNT)).resolves.toBe(3);
  });

  it('gives concurrent callers distinct nonces', async () => {
    const { manager } = createNonceManager();
    const nonces = await Promise.all(
      Array.from({ length: 20 }, () => manager.allocateNonce(ACCOUNT)),
    );
    expect(nonces).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it('reloads reservations after the process restarts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'evm-nonce-'));
    const path = join(directory, 'nonce.sqlite');
    const evm = new InMemoryEvm();
    const first = createNonceManager(evm, path);
    await first.manager.allocateNonce(ACCOUNT);
    await first.manager.allocateNonce(ACCOUNT);
    first.database.close();
    databases.splice(databases.indexOf(first.database), 1);

    const second = createNonceManager(evm, path);
    await expect(second.manager.getNextNonce(ACCOUNT)).resolves.toBe(2);
    await expect(second.manager.allocateNonce(ACCOUNT)).resolves.toBe(2);
  });

  it('corrects a stale-high local cursor when nothing is in flight', async () => {
    const { database, evm, manager } = createNonceManager();
    const repository = new NonceRepository(database);
    repository.setNextNonce(evm.chainId, ACCOUNT, 40, '2026-01-01T00:00:00.000Z');
    const snapshot = await manager.reconcileNonce(ACCOUNT);
    expect(snapshot.stale).toBe(true);
    expect(snapshot.nextNonce).toBe(0);
  });

  it('jumps forward when the chain pending nonce passes the local cursor', async () => {
    const { evm, manager } = createNonceManager();
    await manager.allocateNonce(ACCOUNT);
    await manager.markSubmitted(ACCOUNT, 0);
    evm.consumeNonce(ACCOUNT);
    evm.consumeNonce(ACCOUNT);
    const snapshot = await manager.reconcileNonce(ACCOUNT);
    expect(snapshot.chainLatestNonce).toBe(2);
    expect(snapshot.nextNonce).toBe(2);
  });

  it('releases only an unsent nonce and refuses to release a submitted one', async () => {
    const { manager } = createNonceManager();
    const nonce = await manager.allocateNonce(ACCOUNT);
    await manager.releaseNonce(ACCOUNT, nonce);
    await expect(manager.allocateNonce(ACCOUNT)).resolves.toBe(nonce);
    const submitted = await manager.allocateNonce(ACCOUNT);
    await manager.markSubmitted(ACCOUNT, submitted);
    await expect(manager.releaseNonce(ACCOUNT, submitted)).rejects.toBeInstanceOf(
      NonceMismatchError,
    );
  });

  it('rejects a caller nonce that is not the next safe nonce', async () => {
    const { manager } = createNonceManager();
    await expect(manager.adoptNonce(ACCOUNT, 4)).rejects.toBeInstanceOf(NonceMismatchError);
    await expect(manager.allocateNonce(ACCOUNT)).resolves.toBe(0);
  });
});
