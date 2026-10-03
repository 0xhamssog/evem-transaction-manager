import { ConfigurationError } from '../domain/transaction-error.js';
import type { Hex } from '../types/common.js';

export type AppConfig = {
  rpcUrl: string | null;
  chainId: number;
  /** Present only in memory for client construction. Never written to SQLite or logs. */
  privateKey: Hex | null;
  databasePath: string;
  pollIntervalMs: number;
  requiredConfirmations: number;
  replacementTimeoutMs: number;
  maxRetries: number;
  replacementBumpPercent: number;
  minimumFeeBump: bigint;
  maxFeePerGasCap: bigint | null;
  maxPriorityFeePerGasCap: bigint | null;
  broadcastRetryLimit: number;
  maxPollIntervalMs: number;
  confirmationTimeoutMs: number;
};

const DEFAULTS = {
  databasePath: './data/transactions.sqlite',
  pollIntervalMs: 2_000,
  requiredConfirmations: 1,
  replacementTimeoutMs: 60_000,
  maxRetries: 3,
  replacementBumpPercent: 15,
  minimumFeeBump: 1_000_000_000n,
  broadcastRetryLimit: 2,
  maxPollIntervalMs: 30_000,
  confirmationTimeoutMs: 120_000,
} as const;

/**
 * Reads process environment and rejects malformed values before any client is created.
 * `PRIVATE_KEY` is optional so tests and injected wallet clients can boot without one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rpcRaw = readOptional(env, 'RPC_URL');
  if (rpcRaw !== null && !/^https?:\/\//.test(rpcRaw)) {
    throw new ConfigurationError('RPC_URL must be an http or https URL');
  }

  const chainRaw = readOptional(env, 'CHAIN_ID');
  if (chainRaw === null) {
    throw new ConfigurationError('CHAIN_ID is required');
  }

  return {
    rpcUrl: rpcRaw,
    chainId: readRequiredInt(chainRaw, 'CHAIN_ID', 1),
    privateKey: readPrivateKey(env),
    databasePath: readOptional(env, 'DATABASE_PATH') ?? DEFAULTS.databasePath,
    pollIntervalMs: readInt(env, 'POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs, 50),
    requiredConfirmations: readInt(env, 'CONFIRMATIONS', DEFAULTS.requiredConfirmations, 1),
    replacementTimeoutMs: readInt(env, 'REPLACEMENT_TIMEOUT_MS', DEFAULTS.replacementTimeoutMs, 1),
    maxRetries: readInt(env, 'MAX_RETRIES', DEFAULTS.maxRetries, 1),
    replacementBumpPercent: readInt(
      env,
      'REPLACEMENT_BUMP_PERCENT',
      DEFAULTS.replacementBumpPercent,
      1,
    ),
    minimumFeeBump: readBigint(env, 'MINIMUM_FEE_BUMP', DEFAULTS.minimumFeeBump),
    maxFeePerGasCap: readOptionalBigint(env, 'MAX_FEE_PER_GAS_CAP'),
    maxPriorityFeePerGasCap: readOptionalBigint(env, 'MAX_PRIORITY_FEE_PER_GAS_CAP'),
    broadcastRetryLimit: readInt(env, 'BROADCAST_RETRY_LIMIT', DEFAULTS.broadcastRetryLimit, 0),
    maxPollIntervalMs: readInt(env, 'MAX_POLL_INTERVAL_MS', DEFAULTS.maxPollIntervalMs, 50),
    confirmationTimeoutMs: readInt(
      env,
      'CONFIRMATION_TIMEOUT_MS',
      DEFAULTS.confirmationTimeoutMs,
      1,
    ),
  };
}

function readOptional(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (value === undefined || value.trim() === '') return null;
  return value.trim();
}

function readRequiredInt(raw: string, key: string, min: number): number {
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new ConfigurationError(`${key} must be an integer >= ${min}`);
  }
  return value;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = readOptional(env, key);
  if (raw === null) return fallback;
  return readRequiredInt(raw, key, min);
}

function readBigint(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = readOptional(env, key);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be a base-10 integer`);
  return BigInt(raw);
}

function readOptionalBigint(env: NodeJS.ProcessEnv, key: string): bigint | null {
  const raw = readOptional(env, key);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new ConfigurationError(`${key} must be a base-10 integer`);
  return BigInt(raw);
}

function readPrivateKey(env: NodeJS.ProcessEnv): Hex | null {
  const raw = readOptional(env, 'PRIVATE_KEY');
  if (raw === null) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new ConfigurationError('PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  }
  return raw as Hex;
}
