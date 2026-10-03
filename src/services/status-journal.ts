import { findTransitionPath, type TransactionStatus } from '../domain/transaction-status.js';
import { InvalidTransitionError, NotFoundError } from '../domain/transaction-error.js';
import type { TransactionRecord } from '../domain/transaction.js';
import type { SqliteTransactionRepository } from '../persistence/transaction-repository.js';

/** Applies one legal transition, or the shortest legal path, and persists each step. */
export class StatusJournal {
  constructor(
    private readonly repository: SqliteTransactionRepository,
    private readonly now: () => string,
  ) {}

  /** Persists a single legal status change. */
  transition(id: string, to: TransactionStatus, reason: string): TransactionRecord {
    return this.repository.transition(id, to, reason, this.now());
  }

  /**
   * Walks the shortest valid path to `to`.
   * Used when reconciliation discovers a later state after a restart.
   */
  moveTo(id: string, to: TransactionStatus, reason: string): TransactionRecord {
    const current = this.repository.findById(id);
    if (!current) throw new NotFoundError(`transaction ${id} was not found`, { transactionId: id });
    if (current.status === to) return current;
    const path = findTransitionPath(current.status, to);
    if (!path) throw new InvalidTransitionError(current.status, to);
    let record = current;
    for (const step of path) {
      record = this.repository.transition(id, step, reason, this.now());
    }
    return record;
  }
}
