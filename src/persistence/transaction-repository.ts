import { InvalidTransitionError } from '../domain/transaction-error.js';
import type { StatusEvent } from '../domain/transaction-events.js';
import { canTransition, type TransactionStatus } from '../domain/transaction-status.js';
import type {
  NewAttempt,
  NewTransaction,
  TransactionAttempt,
  TransactionPatch,
  TransactionRecord,
} from '../domain/transaction.js';
import type { Address, Hex } from '../types/common.js';
import type { AppDatabase } from './database.js';

const MONITOR_STATUSES = ['SUBMITTED', 'PENDING', 'REPLACEMENT_PENDING', 'REPLACED', 'TIMED_OUT'];

type TransactionRow = {
  id: string;
  chain_id: number;
  account: string;
  nonce: number | null;
  to_address: string;
  data: string;
  value: string;
  gas_limit: string | null;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
  current_hash: string | null;
  status: TransactionStatus;
  attempt_count: number;
  created_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
  reconciled_at: string | null;
  last_checked_at: string | null;
  block_number: string | null;
  block_hash: string | null;
  transaction_index: number | null;
  confirmations: number;
  receipt_status: 'success' | 'reverted' | null;
  log_count: number | null;
  error_code: string | null;
  error_message: string | null;
};

type AttemptRow = {
  id: number;
  transaction_id: string;
  hash: string;
  nonce: number;
  attempt_number: number;
  submitted_at: string | null;
  signed_at: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
  gas_limit: string;
  signed_payload: string;
  status: TransactionAttempt['status'];
};

/**
 * SQLite transaction store. Status changes go through `transition` so invalid
 * edges are rejected and every change is appended to `status_events`.
 */
export interface TransactionRepository {
  create(input: NewTransaction): TransactionRecord;
  update(id: string, patch: TransactionPatch): TransactionRecord;
  transition(
    id: string,
    to: TransactionStatus,
    reason: string,
    createdAt: string,
  ): TransactionRecord;
  findById(id: string): TransactionRecord | null;
  findByHash(hash: Hex): TransactionRecord | null;
  findPending(): TransactionRecord[];
  findByAccountAndNonce(chainId: number, account: Address, nonce: number): TransactionRecord | null;
  listActive(): TransactionRecord[];
  listAll(): TransactionRecord[];
  addAttempt(attempt: NewAttempt): TransactionAttempt;
  listAttempts(transactionId: string): TransactionAttempt[];
  updateAttemptStatus(hash: Hex, status: TransactionAttempt['status'], submittedAt?: string): void;
  listStatusEvents(transactionId: string): StatusEvent[];
}

export class SqliteTransactionRepository implements TransactionRepository {
  constructor(private readonly database: AppDatabase) {}

  create(input: NewTransaction): TransactionRecord {
    const insert = this.database.transaction((row: NewTransaction) => {
      this.database
        .prepare(
          `INSERT INTO transactions (
             id, chain_id, account, nonce, to_address, data, value, gas_limit,
             max_fee_per_gas, max_priority_fee_per_gas, current_hash, status,
             attempt_count, created_at, confirmations
           ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, 'CREATED', 0, ?, 0)`,
        )
        .run(
          row.id,
          row.chainId,
          row.account,
          row.to,
          row.data,
          row.value.toString(10),
          bigintToDb(row.gasLimit),
          bigintToDb(row.maxFeePerGas),
          bigintToDb(row.maxPriorityFeePerGas),
          row.createdAt,
        );
      this.database
        .prepare(
          `INSERT INTO status_events (transaction_id, from_status, to_status, reason, created_at)
           VALUES (?, NULL, 'CREATED', ?, ?)`,
        )
        .run(row.id, 'record created', row.createdAt);
    });
    insert(input);
    return this.require(input.id);
  }

  update(id: string, patch: TransactionPatch): TransactionRecord {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.nonce !== undefined) set('nonce', patch.nonce);
    if (patch.gasLimit !== undefined) set('gas_limit', bigintToDb(patch.gasLimit));
    if (patch.maxFeePerGas !== undefined) set('max_fee_per_gas', bigintToDb(patch.maxFeePerGas));
    if (patch.maxPriorityFeePerGas !== undefined) {
      set('max_priority_fee_per_gas', bigintToDb(patch.maxPriorityFeePerGas));
    }
    if (patch.currentHash !== undefined) {
      set('current_hash', patch.currentHash === null ? null : patch.currentHash.toLowerCase());
    }
    if (patch.attemptCount !== undefined) set('attempt_count', patch.attemptCount);
    if (patch.submittedAt !== undefined) set('submitted_at', patch.submittedAt);
    if (patch.confirmedAt !== undefined) set('confirmed_at', patch.confirmedAt);
    if (patch.reconciledAt !== undefined) set('reconciled_at', patch.reconciledAt);
    if (patch.lastCheckedAt !== undefined) set('last_checked_at', patch.lastCheckedAt);
    if (patch.blockNumber !== undefined) set('block_number', bigintToDb(patch.blockNumber));
    if (patch.blockHash !== undefined) set('block_hash', patch.blockHash);
    if (patch.transactionIndex !== undefined) set('transaction_index', patch.transactionIndex);
    if (patch.confirmations !== undefined) set('confirmations', patch.confirmations);
    if (patch.receiptStatus !== undefined) set('receipt_status', patch.receiptStatus);
    if (patch.logCount !== undefined) set('log_count', patch.logCount);
    if (patch.errorCode !== undefined) set('error_code', patch.errorCode);
    if (patch.errorMessage !== undefined) set('error_message', patch.errorMessage);
    if (assignments.length === 0) return this.require(id);
    values.push(id);
    this.database
      .prepare(`UPDATE transactions SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values);
    return this.require(id);
  }

  /** Rejects illegal edges and persists the accepted edge. */
  transition(
    id: string,
    to: TransactionStatus,
    reason: string,
    createdAt: string,
  ): TransactionRecord {
    const apply = this.database.transaction(() => {
      const current = this.require(id);
      if (!canTransition(current.status, to)) {
        throw new InvalidTransitionError(current.status, to);
      }
      this.database.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(to, id);
      this.database
        .prepare(
          `INSERT INTO status_events (transaction_id, from_status, to_status, reason, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, current.status, to, reason, createdAt);
    });
    apply();
    return this.require(id);
  }

  findById(id: string): TransactionRecord | null {
    const row = this.database.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as
      TransactionRow | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  findByHash(hash: Hex): TransactionRecord | null {
    const attempt = this.database
      .prepare('SELECT transaction_id FROM transaction_attempts WHERE hash = ?')
      .get(hash.toLowerCase()) as { transaction_id: string } | undefined;
    if (!attempt) return null;
    return this.findById(attempt.transaction_id);
  }

  findPending(): TransactionRecord[] {
    const placeholders = MONITOR_STATUSES.map(() => '?').join(', ');
    const rows = this.database
      .prepare(
        `SELECT * FROM transactions WHERE status IN (${placeholders}) ORDER BY created_at ASC`,
      )
      .all(...MONITOR_STATUSES) as TransactionRow[];
    return rows.map((row) => this.hydrate(row));
  }

  findByAccountAndNonce(
    chainId: number,
    account: Address,
    nonce: number,
  ): TransactionRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM transactions
         WHERE chain_id = ? AND account = ? AND nonce = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(chainId, account, nonce) as TransactionRow | undefined;
    return row ? this.hydrate(row) : null;
  }

  listAll(): TransactionRecord[] {
    const rows = this.database
      .prepare('SELECT * FROM transactions ORDER BY created_at ASC')
      .all() as TransactionRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listActive(): TransactionRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM transactions
         WHERE status NOT IN ('RECONCILED', 'FAILED')
         ORDER BY created_at ASC`,
      )
      .all() as TransactionRow[];
    return rows.map((row) => this.hydrate(row));
  }

  addAttempt(attempt: NewAttempt): TransactionAttempt {
    const result = this.database
      .prepare(
        `INSERT INTO transaction_attempts (
           transaction_id, hash, nonce, attempt_number, submitted_at, signed_at,
           max_fee_per_gas, max_priority_fee_per_gas, gas_limit, signed_payload, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.transactionId,
        attempt.hash.toLowerCase(),
        attempt.nonce,
        attempt.attemptNumber,
        attempt.submittedAt,
        attempt.signedAt,
        attempt.maxFeePerGas.toString(10),
        attempt.maxPriorityFeePerGas.toString(10),
        attempt.gasLimit.toString(10),
        attempt.signedPayload,
        attempt.status,
      );
    return this.requireAttempt(Number(result.lastInsertRowid));
  }

  listAttempts(transactionId: string): TransactionAttempt[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM transaction_attempts
         WHERE transaction_id = ?
         ORDER BY attempt_number ASC`,
      )
      .all(transactionId) as AttemptRow[];
    return rows.map(mapAttempt);
  }

  updateAttemptStatus(hash: Hex, status: TransactionAttempt['status'], submittedAt?: string): void {
    if (submittedAt !== undefined) {
      this.database
        .prepare('UPDATE transaction_attempts SET status = ?, submitted_at = ? WHERE hash = ?')
        .run(status, submittedAt, hash.toLowerCase());
      return;
    }
    this.database
      .prepare('UPDATE transaction_attempts SET status = ? WHERE hash = ?')
      .run(status, hash.toLowerCase());
  }

  listStatusEvents(transactionId: string): StatusEvent[] {
    const rows = this.database
      .prepare(
        `SELECT id, transaction_id, from_status, to_status, reason, created_at
         FROM status_events WHERE transaction_id = ? ORDER BY id ASC`,
      )
      .all(transactionId) as Array<{
      id: number;
      transaction_id: string;
      from_status: TransactionStatus | null;
      to_status: TransactionStatus;
      reason: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      reason: row.reason,
      createdAt: row.created_at,
    }));
  }

  private require(id: string): TransactionRecord {
    const record = this.findById(id);
    if (!record) throw new Error(`transaction ${id} disappeared during a write`);
    return record;
  }

  private requireAttempt(id: number): TransactionAttempt {
    const row = this.database.prepare('SELECT * FROM transaction_attempts WHERE id = ?').get(id) as
      AttemptRow | undefined;
    if (!row) throw new Error(`attempt ${id} disappeared during a write`);
    return mapAttempt(row);
  }

  private hydrate(row: TransactionRow): TransactionRecord {
    const attempts = this.listAttempts(row.id);
    const originalHash = attempts[0]?.hash ?? null;
    const currentHash = (row.current_hash as Hex | null) ?? null;
    const replacementHashes = attempts
      .map((attempt) => attempt.hash)
      .filter((hash) => hash !== originalHash);
    return {
      id: row.id,
      chainId: row.chain_id,
      account: row.account as Address,
      nonce: row.nonce,
      to: row.to_address as Address,
      data: row.data as Hex,
      value: BigInt(row.value),
      gasLimit: bigintFromDb(row.gas_limit),
      maxFeePerGas: bigintFromDb(row.max_fee_per_gas),
      maxPriorityFeePerGas: bigintFromDb(row.max_priority_fee_per_gas),
      originalHash,
      currentHash,
      replacementHashes,
      status: row.status,
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      submittedAt: row.submitted_at,
      confirmedAt: row.confirmed_at,
      reconciledAt: row.reconciled_at,
      lastCheckedAt: row.last_checked_at,
      blockNumber: bigintFromDb(row.block_number),
      blockHash: row.block_hash as Hex | null,
      transactionIndex: row.transaction_index,
      confirmations: row.confirmations,
      receiptStatus: row.receipt_status,
      logCount: row.log_count,
      errorCode: row.error_code,
      errorMessage: row.error_message,
    };
  }
}

function mapAttempt(row: AttemptRow): TransactionAttempt {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    hash: row.hash as Hex,
    nonce: row.nonce,
    attemptNumber: row.attempt_number,
    submittedAt: row.submitted_at,
    signedAt: row.signed_at,
    maxFeePerGas: BigInt(row.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(row.max_priority_fee_per_gas),
    gasLimit: BigInt(row.gas_limit),
    signedPayload: row.signed_payload as Hex,
    status: row.status,
  };
}

function bigintToDb(value: bigint | null): string | null {
  if (value === null) return null;
  return value.toString(10);
}

function bigintFromDb(value: string | null): bigint | null {
  if (value === null) return null;
  return BigInt(value);
}
