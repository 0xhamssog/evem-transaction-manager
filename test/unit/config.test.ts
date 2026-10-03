import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/domain/transaction-error.js';
import { loadConfig } from '../../src/config/env.js';

describe('environment configuration', () => {
  it('applies defaults and keeps the private key out of derived public fields', () => {
    const config = loadConfig({
      CHAIN_ID: '31337',
      RPC_URL: 'http://127.0.0.1:8545',
      PRIVATE_KEY: `0x${'ab'.repeat(32)}`,
    });
    expect(config.chainId).toBe(31337);
    expect(config.pollIntervalMs).toBe(2_000);
    expect(config.requiredConfirmations).toBe(1);
    expect(config.maxRetries).toBe(3);
    expect(config.replacementBumpPercent).toBe(15);
    expect(config.minimumFeeBump).toBe(1_000_000_000n);
    expect(config.privateKey).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('rejects malformed values without echoing the secret', () => {
    expect(() => loadConfig({ CHAIN_ID: 'nope' })).toThrow(ConfigurationError);
    try {
      loadConfig({ CHAIN_ID: '1', PRIVATE_KEY: 'not-a-key' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain('not-a-key');
    }
  });
});
