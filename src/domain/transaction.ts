import type { Address, Hex } from '../types/common.js';
import type { TransactionStatus } from './transaction-status.js';

/**
 * One logical action. Hashes are attempts inside this lifecycle.
 * A stored hash is not a completed trade.
 */
export type TransactionRecord = {
  id: string;
  chainId: number;
  account: Address;
  nonce: number | null;
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  originalHash: Hex | null;
  currentHash: Hex | null;
  replacementHashes: Hex[];
  status: TransactionStatus;
  attemptCount: number;
  createdAt: string;
  submittedAt: string | null;
  confirmedAt: string | null;
  reconciledAt: string | null;
  lastCheckedAt: string | null;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionIndex: number | null;
  confirmations: number;
  receiptStatus: 'success' | 'reverted' | null;
  logCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type TransactionAttempt = {
  id: number;
  transactionId: string;
  hash: Hex;
  nonce: number;
  attemptNumber: number;
  submittedAt: string | null;
  signedAt: string;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  /** Signed raw transaction. This is not a private key. It is stored so a restart can rebroadcast the same hash. */
  signedPayload: Hex;
  status: AttemptStatus;
};

export type AttemptStatus = 'SIGNED' | 'BROADCAST' | 'REJECTED' | 'MINED' | 'DROPPED';

export type TransactionRequest = {
  account: Address;
  to: Address;
  data?: Hex;
  value?: bigint;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /**
   * Optional explicit nonce. It must equal the next safe local nonce.
   * Callers cannot use this to skip the allocator.
   */
  nonce?: number;
  /** When false, skip `eth_call`. Simulation is not a guarantee of later execution. */
  simulate?: boolean;
};

export type TransactionHandle = {
  transactionId: string;
  hash: Hex;
  nonce: number;
};

export type NewTransaction = {
  id: string;
  chainId: number;
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit: bigint | null;
  maxFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint | null;
  createdAt: string;
};

export type TransactionPatch = {
  nonce?: number | null;
  gasLimit?: bigint | null;
  maxFeePerGas?: bigint | null;
  maxPriorityFeePerGas?: bigint | null;
  currentHash?: Hex | null;
  attemptCount?: number;
  submittedAt?: string | null;
  confirmedAt?: string | null;
  reconciledAt?: string | null;
  lastCheckedAt?: string | null;
  blockNumber?: bigint | null;
  blockHash?: Hex | null;
  transactionIndex?: number | null;
  confirmations?: number;
  receiptStatus?: 'success' | 'reverted' | null;
  logCount?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type NewAttempt = {
  transactionId: string;
  hash: Hex;
  nonce: number;
  attemptNumber: number;
  signedAt: string;
  submittedAt: string | null;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gasLimit: bigint;
  signedPayload: Hex;
  status: AttemptStatus;
};
