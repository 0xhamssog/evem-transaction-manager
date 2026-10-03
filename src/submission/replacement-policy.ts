import { ConfigurationError, ReplacementError } from '../domain/transaction-error.js';
import type { FeeParameters } from './fee-policy.js';

/**
 * Integer fee bump. Percent and minimum bump are configuration because
 * replacement rules differ across EVM networks. This does not claim a
 * universal bump that works everywhere.
 */
export function bumpWei(value: bigint, bumpPercent: number, minimumBump: bigint): bigint {
  if (!Number.isInteger(bumpPercent) || bumpPercent < 1) {
    throw new ConfigurationError('replacementBumpPercent must be a positive integer');
  }
  if (minimumBump < 0n) {
    throw new ConfigurationError('minimumFeeBump cannot be negative');
  }
  const percentBumped = ceilDiv(value * BigInt(100 + bumpPercent), 100n);
  const minBumped = value + minimumBump;
  let next = percentBumped > minBumped ? percentBumped : minBumped;
  if (next <= value) next = value + 1n;
  return next;
}

/** Both EIP-1559 caps must strictly increase or the replacement is invalid. */
export function assertReplacementFees(previous: FeeParameters, next: FeeParameters): void {
  if (
    next.maxFeePerGas <= previous.maxFeePerGas ||
    next.maxPriorityFeePerGas <= previous.maxPriorityFeePerGas
  ) {
    throw new ReplacementError(
      'replacement fees must be strictly higher than the previous attempt for both maxFeePerGas and maxPriorityFeePerGas',
      {
        previousMaxFeePerGas: previous.maxFeePerGas.toString(10),
        nextMaxFeePerGas: next.maxFeePerGas.toString(10),
        previousMaxPriorityFeePerGas: previous.maxPriorityFeePerGas.toString(10),
        nextMaxPriorityFeePerGas: next.maxPriorityFeePerGas.toString(10),
      },
    );
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}
