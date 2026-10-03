import { describe, expect, it } from 'vitest';
import { ConfigurationError, ReplacementError } from '../../src/domain/transaction-error.js';
import { Eip1559FeePolicy } from '../../src/submission/fee-policy.js';
import { assertReplacementFees, bumpWei } from '../../src/submission/replacement-policy.js';
import { RetryPolicy } from '../../src/submission/retry-policy.js';

describe('retry policy', () => {
  const policy = new RetryPolicy(3);

  it('retries a transient transport failure and stops at the attempt limit', () => {
    const error = new Error('fetch failed: connect ECONNREFUSED');
    error.name = 'HttpRequestError';
    const classified = policy.classify(error);
    expect(classified.category).toBe('temporary_rpc');
    expect(policy.decide(classified, 1).action).toBe('retry_broadcast');
    expect(policy.decide(classified, 3).retryable).toBe(false);
  });

  it('does not retry reverts, authorization, calldata, or insufficient funds', () => {
    const cases = [
      new Error('execution reverted: intentional revert'),
      new Error('unauthorized'),
      new Error('intrinsic gas too low'),
      new Error('insufficient funds for transfer'),
    ];
    for (const error of cases) {
      const decision = policy.decide(policy.classify(error), 0);
      expect(decision.action).toBe('fail');
      expect(decision.retryable).toBe(false);
    }
  });

  it('sends nonce conflicts to reconciliation and pending timeouts to replacement', () => {
    const nonce = policy.classify(new Error('nonce too low'));
    expect(policy.decide(nonce, 1).action).toBe('reconcile');
    const timeout = policy.decide(
      {
        category: 'pending_timeout',
        retryable: true,
        ambiguous: false,
        action: 'replace',
        message: 'pending too long',
      },
      1,
    );
    expect(timeout.action).toBe('replace');
    const exhausted = policy.decide(
      {
        category: 'pending_timeout',
        retryable: true,
        ambiguous: false,
        action: 'replace',
        message: 'pending too long',
      },
      3,
    );
    expect(exhausted.action).toBe('reconcile');
  });

  it('treats a timeout as ambiguous and already-known as acceptance', () => {
    const timeout = new Error('The request timed out.');
    timeout.name = 'TimeoutError';
    expect(policy.classify(timeout).ambiguous).toBe(true);
    expect(policy.classify(new Error('already known')).action).toBe('accept');
  });
});

describe('replacement fees', () => {
  it('bumps both EIP-1559 fields with integer math', () => {
    expect(bumpWei(100n, 15, 1n)).toBe(115n);
    expect(bumpWei(1n, 1, 0n)).toBe(2n);
    const previous = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n };
    const next = { maxFeePerGas: 115n, maxPriorityFeePerGas: 12n };
    expect(() => assertReplacementFees(previous, next)).not.toThrow();
    expect(() => assertReplacementFees(previous, previous)).toThrow(ReplacementError);
  });

  it('rejects a bump that would cross the configured cap', async () => {
    const policy = new Eip1559FeePolicy({
      estimate: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
      replacementBumpPercent: 15,
      minimumFeeBump: 1n,
      maxFeePerGasCap: 110n,
      maxPriorityFeePerGasCap: null,
    });
    await expect(
      Promise.resolve().then(() =>
        policy.getReplacementFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, 2),
      ),
    ).rejects.toBeInstanceOf(ReplacementError);
  });

  it('uses caller fees without a network estimate when both are present', async () => {
    let calls = 0;
    const policy = new Eip1559FeePolicy({
      estimate: async () => {
        calls += 1;
        return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n };
      },
      replacementBumpPercent: 10,
      minimumFeeBump: 1n,
      maxFeePerGasCap: null,
      maxPriorityFeePerGasCap: null,
    });
    const fees = await policy.getInitialFees({ maxFeePerGas: 50n, maxPriorityFeePerGas: 5n });
    expect(fees).toEqual({ maxFeePerGas: 50n, maxPriorityFeePerGas: 5n });
    expect(calls).toBe(0);
    expect(() => bumpWei(1n, 0, 1n)).toThrow(ConfigurationError);
  });
});
