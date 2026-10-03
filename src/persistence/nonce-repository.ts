import type { AppDatabase } from './database.js';
import type { Address } from '../types/common.js';

export type ReservationStatus = 'reserved' | 'submitted' | 'released' | 'consumed';

export type NonceReservation = {
  chainId: number;
  account: Address;
  nonce: number;
  status: ReservationStatus;
  transactionId: string | null;
  updatedAt: string;
};

export type NonceStateRow = {
  chainId: number;
  account: Address;
  nextNonce: number;
  updatedAt: string;
};

export class NonceRepository {
  constructor(private readonly database: AppDatabase) {}

  getState(chainId: number, account: Address): NonceStateRow | null {
    const row = this.database
      .prepare(
        `SELECT chain_id, account, next_nonce, updated_at
         FROM nonce_state WHERE chain_id = ? AND account = ?`,
      )
      .get(chainId, account) as
      { chain_id: number; account: string; next_nonce: number; updated_at: string } | undefined;
    if (!row) return null;
    return {
      chainId: row.chain_id,
      account: row.account as Address,
      nextNonce: row.next_nonce,
      updatedAt: row.updated_at,
    };
  }

  setNextNonce(chainId: number, account: Address, nextNonce: number, updatedAt: string): void {
    this.database
      .prepare(
        `INSERT INTO nonce_state (chain_id, account, next_nonce, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(chain_id, account) DO UPDATE SET
           next_nonce = excluded.next_nonce,
           updated_at = excluded.updated_at`,
      )
      .run(chainId, account, nextNonce, updatedAt);
  }

  list(chainId: number, account: Address): NonceReservation[] {
    const rows = this.database
      .prepare(
        `SELECT chain_id, account, nonce, status, transaction_id, updated_at
         FROM nonce_reservations
         WHERE chain_id = ? AND account = ?
         ORDER BY nonce ASC`,
      )
      .all(chainId, account) as ReservationRow[];
    return rows.map(mapReservation);
  }

  getReservation(chainId: number, account: Address, nonce: number): NonceReservation | null {
    const row = this.database
      .prepare(
        `SELECT chain_id, account, nonce, status, transaction_id, updated_at
         FROM nonce_reservations
         WHERE chain_id = ? AND account = ? AND nonce = ?`,
      )
      .get(chainId, account, nonce) as ReservationRow | undefined;
    return row ? mapReservation(row) : null;
  }

  reserve(reservation: NonceReservation): void {
    this.database
      .prepare(
        `INSERT INTO nonce_reservations
           (chain_id, account, nonce, status, transaction_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, account, nonce) DO UPDATE SET
           status = excluded.status,
           transaction_id = excluded.transaction_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        reservation.chainId,
        reservation.account,
        reservation.nonce,
        reservation.status,
        reservation.transactionId,
        reservation.updatedAt,
      );
  }

  mark(
    chainId: number,
    account: Address,
    nonce: number,
    status: ReservationStatus,
    updatedAt: string,
  ): void {
    this.database
      .prepare(
        `UPDATE nonce_reservations
         SET status = ?, updated_at = ?
         WHERE chain_id = ? AND account = ? AND nonce = ?`,
      )
      .run(status, updatedAt, chainId, account, nonce);
  }
}

type ReservationRow = {
  chain_id: number;
  account: string;
  nonce: number;
  status: ReservationStatus;
  transaction_id: string | null;
  updated_at: string;
};

function mapReservation(row: ReservationRow): NonceReservation {
  return {
    chainId: row.chain_id,
    account: row.account as Address,
    nonce: row.nonce,
    status: row.status,
    transactionId: row.transaction_id,
    updatedAt: row.updated_at,
  };
}
