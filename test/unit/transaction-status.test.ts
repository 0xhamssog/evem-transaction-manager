import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../src/domain/transaction-error.js';
import { StatusJournal } from '../../src/services/status-journal.js';
import {
  canTransition,
  findTransitionPath,
  isTerminalStatus,
} from '../../src/domain/transaction-status.js';
import { openDatabase } from '../../src/persistence/database.js';
import { SqliteTransactionRepository } from '../../src/persistence/transaction-repository.js';
import { ACCOUNT, TARGET } from '../fixtures/harness.js';

function createRepository() {
  const repository = new SqliteTransactionRepository(openDatabase(':memory:'));
  const record = repository.create({
    id: 'tx-1',
    chainId: 31337,
    account: ACCOUNT,
    to: TARGET,
    data: '0x',
    value: 0n,
    gasLimit: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  return { repository, record };
}

describe('transaction status', () => {
  it('accepts the documented lifecycle edges', () => {
    expect(canTransition('CREATED', 'QUEUED')).toBe(true);
    expect(canTransition('QUEUED', 'SIMULATING')).toBe(true);
    expect(canTransition('SIMULATING', 'SUBMITTING')).toBe(true);
    expect(canTransition('SUBMITTING', 'SUBMITTED')).toBe(true);
    expect(canTransition('SUBMITTED', 'PENDING')).toBe(true);
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransition('CONFIRMED', 'RECONCILED')).toBe(true);
    expect(canTransition('PENDING', 'REVERTED')).toBe(true);
    expect(canTransition('REPLACEMENT_PENDING', 'REPLACED')).toBe(true);
    expect(canTransition('RECONCILIATION_REQUIRED', 'FAILED')).toBe(true);
  });

  it('rejects illegal and terminal transitions', () => {
    expect(canTransition('CREATED', 'CONFIRMED')).toBe(false);
    expect(canTransition('RECONCILED', 'PENDING')).toBe(false);
    expect(canTransition('FAILED', 'QUEUED')).toBe(false);
    expect(canTransition('REVERTED', 'PENDING')).toBe(false);
    expect(isTerminalStatus('RECONCILED')).toBe(true);
    expect(isTerminalStatus('FAILED')).toBe(true);
    expect(isTerminalStatus('PENDING')).toBe(false);
  });

  it('persists every step and rejects an illegal write', () => {
    const { repository } = createRepository();
    const journal = new StatusJournal(repository, () => '2026-01-01T00:00:01.000Z');
    journal.transition('tx-1', 'QUEUED', 'queued');
    expect(() => journal.transition('tx-1', 'RECONCILED', 'skip')).toThrow(InvalidTransitionError);
    const moved = journal.moveTo('tx-1', 'PENDING', 'recovered');
    expect(moved.status).toBe('PENDING');
    const statuses = repository.listStatusEvents('tx-1').map((event) => event.toStatus);
    expect(statuses).toEqual(['CREATED', 'QUEUED', 'SUBMITTING', 'SUBMITTED', 'PENDING']);
  });

  it('finds a path through replacement and confirmation', () => {
    expect(findTransitionPath('PENDING', 'RECONCILED')).toEqual(['CONFIRMED', 'RECONCILED']);
    expect(findTransitionPath('RECONCILED', 'FAILED')).toBeNull();
  });
});
