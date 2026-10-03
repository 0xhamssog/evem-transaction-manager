import type { Address, Hex } from '../types/common.js';
import type { TransactionStatus } from './transaction-status.js';

/** Persisted status change. Every accepted transition writes one event. */
export type StatusEvent = {
  id: number;
  transactionId: string;
  fromStatus: TransactionStatus | null;
  toStatus: TransactionStatus;
  reason: string | null;
  createdAt: string;
};

/** Fields attached to operational logs. Secrets are never part of this shape. */
export type TransactionLogContext = {
  transactionId?: string;
  account?: Address;
  nonce?: number;
  hash?: Hex;
  status?: TransactionStatus;
  attempt?: number;
  errorCode?: string;
};
