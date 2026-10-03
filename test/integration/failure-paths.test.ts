import { describe, expect, it } from 'vitest';
import {
  NonceMismatchError,
  ReplacementError,
  SimulationError,
  SubmissionError,
} from '../../src/domain/transaction-error.js';
import { redactFields } from '../../src/logging/logger.js';
import { ACCOUNT, createHarness, REVERTER, TARGET } from '../fixtures/harness.js';

const request = {
  account: ACCOUNT,
  to: TARGET,
  data: '0x1234' as const,
  gasLimit: 80_000n,
};

describe('failure paths', () => {
  it('fails a transaction when the RPC is unavailable', async () => {
    const { evm, manager } = createHarness();
    evm.rpcDown = true;
    await expect(manager.submit(request)).rejects.toThrow(/ECONNREFUSED/);
    const [record] = manager.listTransactions();
    expect(record?.status).toBe('FAILED');
    expect(record?.currentHash).toBeNull();
    manager.close();
  });

  it('retries one fee-estimate failure and then submits', async () => {
    const { evm, manager } = createHarness();
    evm.feeFailuresRemaining = 1;
    const handle = await manager.submit(request);
    expect(handle.nonce).toBe(0);
    expect(manager.getStatus(handle.transactionId).status).toBe('PENDING');
    manager.close();
  });

  it('retries a refused broadcast of the same signed payload', async () => {
    const { evm, manager } = createHarness();
    evm.broadcastFailuresRemaining = 1;
    const handle = await manager.submit(request);
    expect(manager.getAttempts(handle.transactionId)).toHaveLength(1);
    expect(manager.getStatus(handle.transactionId).currentHash).toBe(handle.hash);
    manager.close();
  });

  it('fails simulation without broadcasting or retrying', async () => {
    const { evm, manager } = createHarness();
    evm.simulationRevert.add(REVERTER);
    let transactionId = '';
    try {
      await manager.submit({ ...request, to: REVERTER });
    } catch (error) {
      expect(error).toBeInstanceOf(SimulationError);
      transactionId = String((error as SimulationError).context.transactionId);
    }
    const record = manager.getStatus(transactionId);
    expect(record.status).toBe('FAILED');
    expect(record.attemptCount).toBe(0);
    expect(record.currentHash).toBeNull();
    expect(manager.getAttempts(transactionId)).toHaveLength(0);
    manager.close();
  });

  it('fails insufficient funds without a replacement', async () => {
    const { evm, manager } = createHarness();
    evm.setBalance(ACCOUNT, 0n);
    await expect(manager.submit({ ...request, value: 5n, simulate: false })).rejects.toThrow(
      /insufficient funds/,
    );
    const [record] = manager.listTransactions();
    expect(record?.status).toBe('FAILED');
    expect(record?.errorCode).toBe('SUBMISSION');
    expect(record?.attemptCount).toBe(1);
    manager.close();
  });

  it('moves a nonce conflict to reconciliation instead of signing another attempt', async () => {
    const { evm, manager } = createHarness();
    evm.forceNonceTooLow = true;
    let transactionId = '';
    try {
      await manager.submit(request);
    } catch (error) {
      expect(error).toBeInstanceOf(SubmissionError);
      transactionId = String((error as SubmissionError).context.transactionId);
    }
    const record = manager.getStatus(transactionId);
    expect(record.status).toBe('RECONCILIATION_REQUIRED');
    expect(manager.getAttempts(transactionId)).toHaveLength(1);
    expect(record.nonce).toBe(0);
    manager.close();
  });

  it('does not treat unknown nonce consumption as a known replacement', async () => {
    const { evm, manager } = createHarness();
    evm.automine = false;
    const handle = await manager.submit(request);
    evm.consumeNonce(ACCOUNT);
    await manager.inspect(handle.transactionId);
    const record = manager.getStatus(handle.transactionId);
    expect(record.status).toBe('RECONCILIATION_REQUIRED');
    expect(record.errorMessage).toMatch(/none of the known hashes/);
    const report = await manager.reconcile(handle.transactionId);
    expect(report.outcome).toBe('unknown_nonce_consumption');
    expect(report.status).toBe('RECONCILIATION_REQUIRED');
    manager.close();
  });

  it('keeps a missing receipt uncertain when the transaction is already in a block', async () => {
    const { evm, manager } = createHarness();
    const handle = await manager.submit(request);
    evm.hideReceipts = true;
    await manager.inspect(handle.transactionId);
    expect(manager.getStatus(handle.transactionId).status).toBe('RECONCILIATION_REQUIRED');
    const report = await manager.reconcile(handle.transactionId);
    expect(report.outcome).toBe('missing_receipt');
    manager.close();
  });

  it('returns a rejected replacement to pending and keeps the original hash', async () => {
    const { evm, manager } = createHarness();
    evm.automine = false;
    evm.rejectReplacements = true;
    const handle = await manager.submit({
      ...request,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });
    await expect(manager.replace(handle.transactionId)).rejects.toBeInstanceOf(SubmissionError);
    const record = manager.getStatus(handle.transactionId);
    expect(record.status).toBe('PENDING');
    expect(record.currentHash).toBe(handle.hash);
    expect(record.nonce).toBe(handle.nonce);
    manager.close();
  });

  it('refuses a replacement that would exceed the fee cap', async () => {
    const { evm, manager } = createHarness({ maxFeePerGasCap: 110n, minimumFeeBump: 1n });
    evm.automine = false;
    const handle = await manager.submit({
      ...request,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });
    await expect(manager.replace(handle.transactionId)).rejects.toBeInstanceOf(ReplacementError);
    expect(manager.getStatus(handle.transactionId).status).toBe('PENDING');
    expect(manager.getAttempts(handle.transactionId)).toHaveLength(1);
    manager.close();
  });

  it('stops monitoring one transaction without starting a second loop', async () => {
    const { evm, manager, clock } = createHarness({ replacementTimeoutMs: 1_000 });
    evm.automine = false;
    const handle = await manager.submit(request);
    manager.cancelMonitoring(handle.transactionId);
    clock.advance(5_000);
    await manager.poll();
    expect(manager.getStatus(handle.transactionId).status).toBe('PENDING');
    expect(manager.getStatus(handle.transactionId).attemptCount).toBe(1);
    manager.close();
  });

  it('redacts secret fields and never logs a private key', () => {
    const key = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    expect(redactFields({ privateKey: key, hash: '0xabc', seed: 'abandon' })).toEqual({
      privateKey: '[redacted]',
      hash: '0xabc',
      seed: '[redacted]',
    });
  });

  it('rejects an explicit nonce that skips the allocator', async () => {
    const { manager } = createHarness();
    await expect(manager.submit({ ...request, nonce: 5 })).rejects.toBeInstanceOf(
      NonceMismatchError,
    );
    manager.close();
  });
});
