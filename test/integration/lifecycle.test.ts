import { describe, expect, it } from 'vitest';
import { SubmissionError, ValidationError } from '../../src/domain/transaction-error.js';
import { ACCOUNT, createHarness, loggedEvents, REVERTER, TARGET } from '../fixtures/harness.js';

describe('transaction lifecycle', () => {
  it('submits, confirms, and reconciles a successful call', async () => {
    const { manager, logs } = createHarness();
    const handle = await manager.submit({
      account: ACCOUNT,
      to: TARGET,
      data: '0x1234',
      value: 1n,
      gasLimit: 80_000n,
    });
    expect(handle.nonce).toBe(0);
    expect(handle.hash).toMatch(/^0x[0-9a-f]{64}$/);
    const pending = manager.getStatus(handle.transactionId);
    expect(pending.status).toBe('PENDING');
    expect(pending.currentHash).toBe(handle.hash);

    const confirmed = await manager.waitForConfirmation(handle.transactionId);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmations).toBeGreaterThanOrEqual(1);
    expect(confirmed.blockNumber).not.toBeNull();
    expect(confirmed.receiptStatus).toBe('success');

    const report = await manager.reconcile(handle.transactionId);
    expect(report.outcome).toBe('confirmed');
    expect(report.status).toBe('RECONCILED');
    expect(report.logCount).toBe(1);
    expect(manager.getStatus(handle.transactionId).reconciledAt).not.toBeNull();
    expect(loggedEvents(logs)).toEqual(
      expect.arrayContaining([
        'transaction submitted',
        'transaction pending',
        'transaction confirmed',
        'transaction reconciled',
      ]),
    );
    manager.close();
  });

  it('marks an on-chain revert and does not send another attempt', async () => {
    const { evm, manager } = createHarness();
    evm.executionRevert.add(REVERTER);
    const handle = await manager.submit({
      account: ACCOUNT,
      to: REVERTER,
      data: '0x1234',
      simulate: false,
      gasLimit: 80_000n,
    });
    const reverted = await manager.waitForConfirmation(handle.transactionId);
    expect(reverted.status).toBe('REVERTED');
    expect(reverted.attemptCount).toBe(1);
    expect(reverted.errorCode).toBe('TRANSACTION_REVERTED');

    const report = await manager.reconcile(handle.transactionId);
    expect(report.outcome).toBe('reverted');
    expect(report.status).toBe('RECONCILED');
    expect(manager.getAttempts(handle.transactionId)).toHaveLength(1);
    await expect(manager.replace(handle.transactionId)).rejects.toThrow(/cannot replace/);
    manager.close();
  });

  it('replaces a slow transaction with the same nonce and a higher fee', async () => {
    const { evm, manager, clock } = createHarness({
      replacementTimeoutMs: 5_000,
      minimumFeeBump: 1n,
    });
    evm.automine = false;
    const handle = await manager.submit({
      account: ACCOUNT,
      to: TARGET,
      data: '0x1234',
      gasLimit: 80_000n,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
    });
    clock.advance(5_000);
    await manager.inspect(handle.transactionId);
    const replaced = manager.getStatus(handle.transactionId);
    expect(replaced.status).toBe('REPLACEMENT_PENDING');
    expect(replaced.nonce).toBe(handle.nonce);
    expect(replaced.attemptCount).toBe(2);
    expect(replaced.currentHash).not.toBe(handle.hash);
    expect(replaced.maxFeePerGas).toBeGreaterThan(100n);
    expect(replaced.maxPriorityFeePerGas).toBeGreaterThan(10n);
    expect(replaced.replacementHashes).toContain(replaced.currentHash);

    await manager.inspect(handle.transactionId);
    const events = manager.getAttempts(handle.transactionId);
    expect(events.every((attempt) => attempt.nonce === handle.nonce)).toBe(true);
    expect(manager.getStatus(handle.transactionId).status).toBe('PENDING');

    evm.mine();
    const confirmed = await manager.waitForConfirmation(handle.transactionId);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.currentHash).not.toBe(handle.hash);
    const report = await manager.reconcile(handle.transactionId);
    expect(report.outcome).toBe('confirmed');
    expect(report.hash).toBe(replaced.currentHash);
    manager.close();
  });

  it('allocates distinct nonces for concurrent submissions from one account', async () => {
    const { manager } = createHarness();
    const handles = await Promise.all(
      Array.from({ length: 10 }, () =>
        manager.submit({
          account: ACCOUNT,
          to: TARGET,
          data: '0x1234',
          gasLimit: 80_000n,
        }),
      ),
    );
    expect(handles.map((handle) => handle.nonce)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(handles.map((handle) => handle.hash)).size).toBe(10);
    manager.close();
  });

  it('waits for the configured confirmation depth', async () => {
    const { evm, manager } = createHarness({ requiredConfirmations: 3 });
    const handle = await manager.submit({
      account: ACCOUNT,
      to: TARGET,
      data: '0x1234',
      gasLimit: 80_000n,
    });
    await manager.inspect(handle.transactionId);
    expect(manager.getStatus(handle.transactionId).status).toBe('PENDING');
    expect(manager.getStatus(handle.transactionId).confirmations).toBe(1);
    evm.advanceHead(2);
    await manager.inspect(handle.transactionId);
    expect(manager.getStatus(handle.transactionId).status).toBe('CONFIRMED');
    expect(manager.getStatus(handle.transactionId).confirmations).toBe(3);
    manager.close();
  });

  it('rejects an invalid request before creating a record', async () => {
    const { manager } = createHarness();
    await expect(
      manager.submit({
        account: '0x1234',
        to: TARGET,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(manager.listTransactions()).toHaveLength(0);
    manager.close();
  });
});

describe('crash recovery', () => {
  it('reconciles a mined transaction after the process stops before monitoring', async () => {
    const { database, evm, manager } = createHarness();
    const handle = await manager.submit({
      account: ACCOUNT,
      to: TARGET,
      data: '0x1234',
      gasLimit: 80_000n,
    });
    expect(manager.getStatus(handle.transactionId).status).toBe('PENDING');
    manager.close();

    const restarted = createHarness({ database, evm });
    const recovery = await restarted.manager.recover();
    expect(recovery.checked).toBe(1);
    expect(restarted.manager.getStatus(handle.transactionId).status).toBe('RECONCILED');
    expect(restarted.manager.getStatus(handle.transactionId).receiptStatus).toBe('success');
    restarted.manager.close();
  });

  it('rebroadcasts a signed payload when the first broadcast timed out before acceptance', async () => {
    const { database, evm, manager } = createHarness();
    evm.broadcastFault = 'timeout-before-accept';
    let transactionId = '';
    try {
      await manager.submit({
        account: ACCOUNT,
        to: TARGET,
        data: '0x1234',
        gasLimit: 80_000n,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(SubmissionError);
      transactionId = String((error as SubmissionError).context.transactionId);
    }
    const stuck = manager.getStatus(transactionId);
    expect(stuck.status).toBe('RECONCILIATION_REQUIRED');
    expect(stuck.currentHash).toMatch(/^0x/);
    expect(manager.getAttempts(transactionId)[0]?.status).toBe('SIGNED');
    manager.close();

    evm.broadcastFault = 'none';
    const restarted = createHarness({ database, evm });
    const recovery = await restarted.manager.recover();
    expect(recovery.rebroadcast).toBe(1);
    expect(restarted.manager.getStatus(transactionId).status).toBe('RECONCILED');
    restarted.manager.close();
  });
});
