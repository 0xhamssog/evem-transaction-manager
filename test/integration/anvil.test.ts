import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  http,
  publicActions,
  walletActions,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { SimulationError } from '../../src/domain/transaction-error.js';
import { ViemEvmClient } from '../../src/clients/evm-client.js';
import { createTransactionManager } from '../../src/index.js';
import { SilentLogger } from '../../src/logging/logger.js';
import { openDatabase } from '../../src/persistence/database.js';
import { ManualClock } from '../fixtures/harness.js';

/**
 * Anvil account #0. This key is published by Foundry for local nodes only.
 * It must never be used on a network that carries real value.
 */
const ANVIL_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Artifact = { abi: Abi; bytecode: { object: Hex } };

describe('anvil transaction lifecycle', () => {
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  let anvil: ChildProcess | undefined;
  let target: Address;
  let reverter: Address;
  let account: Address;

  beforeAll(async () => {
    ensureArtifacts();
    anvil = spawn(toolPath('anvil'), ['--port', String(port), '--chain-id', '31337', '--silent'], {
      stdio: 'ignore',
    });
    await waitForRpc(rpcUrl);
    const signer = privateKeyToAccount(ANVIL_KEY);
    account = signer.address;
    const wallet = createWalletClient({
      account: signer,
      chain: foundry,
      transport: http(rpcUrl),
    });
    const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
    target = await deploy(wallet, publicClient, 'MockTarget');
    reverter = await deploy(wallet, publicClient, 'MockRevertingTarget');
  }, 60_000);

  afterAll(async () => {
    if (!anvil?.pid) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(anvil.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      anvil.kill();
    }
  });

  it('confirms a successful mock call and reconciles it', async () => {
    const { manager } = bootManager();
    const data = encodeFunctionData({
      abi: artifact('MockTarget').abi,
      functionName: 'ping',
      args: [7n],
    });
    const handle = await manager.submit({ account, to: target, data });
    const confirmed = await manager.waitForConfirmation(handle.transactionId, {
      timeoutMs: 15_000,
    });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.receiptStatus).toBe('success');
    const report = await manager.reconcile(handle.transactionId);
    expect(report.status).toBe('RECONCILED');
    expect(report.outcome).toBe('confirmed');
    expect(report.logCount).toBeGreaterThan(0);
    manager.close();
  }, 30_000);

  it('records an on-chain revert and does not replace it', async () => {
    const { manager } = bootManager();
    const data = encodeFunctionData({
      abi: artifact('MockRevertingTarget').abi,
      functionName: 'fail',
    });
    await expect(manager.submit({ account, to: reverter, data })).rejects.toBeInstanceOf(
      SimulationError,
    );
    const handle = await manager.submit({
      account,
      to: reverter,
      data,
      simulate: false,
      gasLimit: 200_000n,
    });
    const reverted = await manager.waitForConfirmation(handle.transactionId, { timeoutMs: 15_000 });
    expect(reverted.status).toBe('REVERTED');
    expect(reverted.attemptCount).toBe(1);
    const report = await manager.reconcile(handle.transactionId);
    expect(report.outcome).toBe('reverted');
    expect(report.status).toBe('RECONCILED');
    manager.close();
  }, 30_000);

  it('replaces a pending transaction with the same nonce', async () => {
    const clock = new ManualClock();
    const testClient = createTestClient({
      chain: foundry,
      mode: 'anvil',
      transport: http(rpcUrl),
    })
      .extend(publicActions)
      .extend(walletActions);
    await testClient.setAutomine(false);
    const { manager } = bootManager(clock);
    const data = encodeFunctionData({
      abi: artifact('MockTarget').abi,
      functionName: 'ping',
      args: [1n],
    });
    const handle = await manager.submit({ account, to: target, data });
    const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
    await expect(publicClient.getTransactionReceipt({ hash: handle.hash })).rejects.toThrow();

    clock.advance(5_000);
    await manager.inspect(handle.transactionId);
    const pendingReplacement = manager.getStatus(handle.transactionId);
    expect(pendingReplacement.nonce).toBe(handle.nonce);
    expect(pendingReplacement.attemptCount).toBe(2);
    expect(pendingReplacement.currentHash).not.toBe(handle.hash);

    await testClient.mine({ blocks: 1 });
    const confirmed = await manager.waitForConfirmation(handle.transactionId, {
      timeoutMs: 15_000,
    });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.nonce).toBe(handle.nonce);
    expect(
      manager.getAttempts(handle.transactionId).every((attempt) => attempt.nonce === handle.nonce),
    ).toBe(true);
    await testClient.setAutomine(true);
    manager.close();
  }, 40_000);

  function bootManager(clock = new ManualClock()) {
    const database = openDatabase(':memory:');
    const manager = createTransactionManager({
      chainId: foundry.id,
      evm: new ViemEvmClient({ rpcUrl, chainId: foundry.id, privateKey: ANVIL_KEY }),
      database,
      pollIntervalMs: 250,
      requiredConfirmations: 1,
      replacementTimeoutMs: 1_000,
      maxRetries: 3,
      replacementBumpPercent: 20,
      minimumFeeBump: 1_000_000_000n,
      confirmationTimeoutMs: 15_000,
      clock: clock.now,
      sleep: async (ms) => {
        clock.advance(ms);
      },
      logger: new SilentLogger(),
    });
    return { manager, clock };
  }
});

function artifact(name: string): Artifact {
  const path = join(root, 'out', `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Artifact;
}

function ensureArtifacts(): void {
  if (existsSync(join(root, 'out', 'MockTarget.sol', 'MockTarget.json'))) return;
  execFileSync(toolPath('forge'), ['build'], { cwd: root, stdio: 'inherit' });
}

function toolPath(name: 'anvil' | 'forge'): string {
  const executable = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = join(homedir(), '.foundry', 'bin', executable);
  if (existsSync(bundled)) return bundled;
  return executable;
}

async function waitForRpc(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (response.ok) return;
    } catch {
      // Anvil is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`anvil did not accept RPC connections at ${url}`);
}

async function deploy(
  wallet: ReturnType<typeof createWalletClient>,
  publicClient: ReturnType<typeof createPublicClient>,
  name: string,
): Promise<Address> {
  const compiled = artifact(name);
  const hash = await wallet.deployContract({
    account: privateKeyToAccount(ANVIL_KEY),
    abi: compiled.abi,
    bytecode: compiled.bytecode.object,
    chain: foundry,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} deployment did not return an address`);
  return receipt.contractAddress;
}
