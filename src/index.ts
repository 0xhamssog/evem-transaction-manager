import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ConfigurationError } from './domain/transaction-error.js';
import { loadConfig } from './config/env.js';
import { ViemEvmClient, type EvmClient } from './clients/evm-client.js';
import type { Logger } from './logging/logger.js';
import { StructuredLogger } from './logging/logger.js';
import {
  TransactionManager,
  type TransactionManagerOptions,
} from './services/transaction-manager.js';
import type { Clock } from './types/common.js';

export { loadConfig, type AppConfig } from './config/env.js';
export { ViemEvmClient, type EvmClient, type ViemEvmClientOptions } from './clients/evm-client.js';
export {
  NonceAllocationError,
  NonceMismatchError,
  SimulationError,
  SubmissionError,
  TransactionRevertedError,
  ReplacementError,
  ReconciliationError,
  ConfigurationError,
  InvalidTransitionError,
  ValidationError,
  NotFoundError,
  TimeoutWaitingError,
  TransactionManagerError,
} from './domain/transaction-error.js';
export {
  TRANSACTION_STATUSES,
  canTransition,
  findTransitionPath,
  isTerminalStatus,
  type TransactionStatus,
} from './domain/transaction-status.js';
export type {
  TransactionAttempt,
  TransactionHandle,
  TransactionRecord,
  TransactionRequest,
} from './domain/transaction.js';
export { NonceManager, type NonceSnapshot } from './nonce/nonce-manager.js';
export { NonceLock } from './nonce/nonce-lock.js';
export { Eip1559FeePolicy, type FeeParameters, type FeePolicy } from './submission/fee-policy.js';
export {
  RetryPolicy,
  DEFAULT_RETRYABLE_CATEGORIES,
  type FailureCategory,
  type ClassifiedFailure,
} from './submission/retry-policy.js';
export type { RecoveryReport, TransactionManagerOptions } from './services/transaction-manager.js';
export {
  TransactionReconciler,
  type ReconciliationReport,
  type ReconciliationOutcome,
} from './reconciliation/transaction-reconciler.js';
export { StructuredLogger, SilentLogger, type Logger } from './logging/logger.js';

export type CreateTransactionManagerOptions = TransactionManagerOptions;

/** Builds a manager from an injected client and database. Tests use this directly. */
export function createTransactionManager(options: TransactionManagerOptions): TransactionManager {
  return new TransactionManager(options);
}

export type EnvManagerOverrides = {
  evm?: EvmClient;
  logger?: Logger;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  database?: TransactionManagerOptions['database'];
};

/**
 * Builds a manager from environment variables.
 * A private key is required only when `overrides.evm` is not supplied.
 * The key is passed to the signer and is not written to SQLite or logs.
 */
export function createTransactionManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: EnvManagerOverrides = {},
): TransactionManager {
  const config = loadConfig(env);
  if (!overrides.evm) {
    if (!config.rpcUrl) {
      throw new ConfigurationError('RPC_URL is required when a client is not injected');
    }
    if (!config.privateKey) {
      throw new ConfigurationError('PRIVATE_KEY is required when a client is not injected');
    }
  }
  const evm =
    overrides.evm ??
    new ViemEvmClient({
      rpcUrl: config.rpcUrl ?? '',
      chainId: config.chainId,
      ...(config.privateKey ? { privateKey: config.privateKey } : {}),
    });
  if (config.databasePath !== ':memory:') {
    mkdirSync(dirname(config.databasePath), { recursive: true });
  }
  return new TransactionManager({
    chainId: config.chainId,
    evm,
    databasePath: config.databasePath,
    ...(overrides.database ? { database: overrides.database } : {}),
    pollIntervalMs: config.pollIntervalMs,
    requiredConfirmations: config.requiredConfirmations,
    replacementTimeoutMs: config.replacementTimeoutMs,
    maxRetries: config.maxRetries,
    replacementBumpPercent: config.replacementBumpPercent,
    minimumFeeBump: config.minimumFeeBump,
    maxFeePerGasCap: config.maxFeePerGasCap,
    maxPriorityFeePerGasCap: config.maxPriorityFeePerGasCap,
    broadcastRetryLimit: config.broadcastRetryLimit,
    maxPollIntervalMs: config.maxPollIntervalMs,
    confirmationTimeoutMs: config.confirmationTimeoutMs,
    ...(overrides.logger ? { logger: overrides.logger } : { logger: new StructuredLogger() }),
    ...(overrides.clock ? { clock: overrides.clock } : {}),
    ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
  });
}

export { TransactionManager };
