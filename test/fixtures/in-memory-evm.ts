import { keccak256, stringToHex } from 'viem';
import type {
  ChainReceipt,
  ChainTransaction,
  EvmClient,
  FeeEstimate,
  SignedTransaction,
  SimulationRequest,
  UnsignedTransaction,
} from '../../src/clients/evm-client.js';
import type { Address, Hex } from '../../src/types/common.js';
import { normalizeAddress } from '../../src/types/common.js';

type StoredTransaction = UnsignedTransaction & {
  hash: Hex;
  serialized: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  transactionIndex: number | null;
  receipt: ChainReceipt | null;
};

export type BroadcastFault = 'none' | 'timeout-before-accept' | 'timeout-after-accept';

/**
 * Chain double used by unit and integration tests.
 * It enforces nonce order, same-nonce replacement, and receipt status.
 */
export class InMemoryEvm implements EvmClient {
  readonly chainId: number;
  automine = true;
  rpcDown = false;
  hideReceipts = false;
  rejectReplacements = false;
  forceNonceTooLow = false;
  broadcastFault: BroadcastFault = 'none';
  feeFailuresRemaining = 0;
  broadcastFailuresRemaining = 0;
  feeEstimate: FeeEstimate = {
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  };
  readonly simulationRevert = new Set<string>();
  readonly executionRevert = new Set<string>();
  head = 0n;

  private readonly latest = new Map<string, number>();
  private readonly balances = new Map<string, bigint>();
  private readonly mempool = new Map<string, StoredTransaction>();
  private readonly mined = new Map<string, StoredTransaction>();
  private readonly signed = new Map<string, StoredTransaction>();

  constructor(chainId = 31_337) {
    this.chainId = chainId;
  }

  setBalance(account: Address, balance: bigint): void {
    this.balances.set(normalizeAddress(account), balance);
  }

  /** Includes queued transactions whose nonces are contiguous from the account nonce. */
  mine(): void {
    this.includeReady();
  }

  /** Moves the canonical head forward without including new transactions. */
  advanceHead(blocks: number): void {
    this.head += BigInt(blocks);
  }

  /**
   * Consumes the next nonce with a transaction this manager did not sign.
   * The mempool entry for that nonce is dropped and no known hash remains.
   */
  consumeNonce(account: Address): void {
    const key = normalizeAddress(account);
    const cursor = this.latest.get(key) ?? 0;
    for (const transaction of this.mempool.values()) {
      if (transaction.account === key && transaction.nonce === cursor) {
        this.mempool.delete(transaction.hash);
      }
    }
    this.latest.set(key, cursor + 1);
  }

  async getPendingNonce(account: Address): Promise<number> {
    await yieldToEventLoop();
    this.assertRpc();
    const key = normalizeAddress(account);
    let cursor = this.latest.get(key) ?? 0;
    const pending = [...this.mempool.values()]
      .filter((transaction) => transaction.account === key)
      .map((transaction) => transaction.nonce)
      .sort((left, right) => left - right);
    for (const nonce of pending) {
      if (nonce === cursor) cursor += 1;
    }
    return cursor;
  }

  async getLatestNonce(account: Address): Promise<number> {
    await yieldToEventLoop();
    this.assertRpc();
    return this.latest.get(normalizeAddress(account)) ?? 0;
  }

  async getBlockNumber(): Promise<bigint> {
    await yieldToEventLoop();
    this.assertRpc();
    return this.head;
  }

  async estimateFeesPerGas(): Promise<FeeEstimate> {
    await yieldToEventLoop();
    this.assertRpc();
    if (this.feeFailuresRemaining > 0) {
      this.feeFailuresRemaining -= 1;
      throw httpError('fetch failed: connect ECONNREFUSED');
    }
    return { ...this.feeEstimate };
  }

  async estimateGas(request: SimulationRequest): Promise<bigint> {
    await yieldToEventLoop();
    this.assertRpc();
    return request.data === '0x' ? 21_000n : 80_000n;
  }

  async simulate(request: SimulationRequest): Promise<{ returnData: Hex }> {
    await yieldToEventLoop();
    this.assertRpc();
    if (this.balanceOf(request.account) < request.value) {
      throw new Error('insufficient funds for transfer');
    }
    if (this.simulationRevert.has(normalizeAddress(request.to))) {
      const error = new Error('execution reverted: intentional revert');
      error.name = 'CallExecutionError';
      throw error;
    }
    return { returnData: '0x' };
  }

  async sign(transaction: UnsignedTransaction): Promise<SignedTransaction> {
    const serialized = stringToHex(
      JSON.stringify({
        chainId: this.chainId,
        account: normalizeAddress(transaction.account),
        to: normalizeAddress(transaction.to),
        data: transaction.data,
        value: transaction.value.toString(10),
        nonce: transaction.nonce,
        gasLimit: transaction.gasLimit.toString(10),
        maxFeePerGas: transaction.maxFeePerGas.toString(10),
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(10),
      }),
    );
    const hash = keccak256(serialized);
    const stored: StoredTransaction = {
      ...transaction,
      account: normalizeAddress(transaction.account),
      to: normalizeAddress(transaction.to),
      hash,
      serialized,
      blockNumber: null,
      blockHash: null,
      transactionIndex: null,
      receipt: null,
    };
    this.signed.set(serialized, stored);
    return { hash, serialized };
  }

  async broadcast(serialized: Hex): Promise<Hex> {
    await yieldToEventLoop();
    this.assertRpc();
    if (this.broadcastFailuresRemaining > 0) {
      this.broadcastFailuresRemaining -= 1;
      throw httpError('fetch failed: connect ECONNREFUSED');
    }
    const signed = this.signed.get(serialized);
    if (!signed) throw new Error('unknown signed payload');
    if (this.broadcastFault === 'timeout-before-accept') {
      throw timeoutError();
    }
    this.accept(signed);
    if (this.broadcastFault === 'timeout-after-accept') {
      if (this.automine) this.includeReady();
      throw timeoutError();
    }
    if (this.automine) this.includeReady();
    return signed.hash;
  }

  async getTransaction(hash: Hex): Promise<ChainTransaction | null> {
    await yieldToEventLoop();
    this.assertRpc();
    const transaction = this.mempool.get(hash.toLowerCase()) ?? this.mined.get(hash.toLowerCase());
    if (!transaction) return null;
    return {
      hash: transaction.hash,
      nonce: transaction.nonce,
      from: transaction.account,
      to: transaction.to,
      value: transaction.value,
      blockNumber: transaction.blockNumber,
      blockHash: transaction.blockHash,
    };
  }

  async getReceipt(hash: Hex): Promise<ChainReceipt | null> {
    await yieldToEventLoop();
    this.assertRpc();
    if (this.hideReceipts) return null;
    return this.mined.get(hash.toLowerCase())?.receipt ?? null;
  }

  async findTransactionByNonce(account: Address, nonce: number): Promise<ChainTransaction | null> {
    await yieldToEventLoop();
    this.assertRpc();
    const key = normalizeAddress(account);
    const transaction = [...this.mined.values()].find(
      (candidate) => candidate.account === key && candidate.nonce === nonce,
    );
    if (!transaction) return null;
    return {
      hash: transaction.hash,
      nonce: transaction.nonce,
      from: transaction.account,
      to: transaction.to,
      value: transaction.value,
      blockNumber: transaction.blockNumber,
      blockHash: transaction.blockHash,
    };
  }

  private accept(signed: StoredTransaction): void {
    if (this.forceNonceTooLow) {
      this.forceNonceTooLow = false;
      throw new Error('nonce too low');
    }
    const latest = this.latest.get(signed.account) ?? 0;
    if (signed.nonce < latest) throw new Error('nonce too low');
    if (this.balanceOf(signed.account) < signed.value) {
      throw new Error('insufficient funds for transfer');
    }
    const existing = [...this.mempool.values()].find(
      (transaction) => transaction.account === signed.account && transaction.nonce === signed.nonce,
    );
    if (existing) {
      if (existing.hash === signed.hash) throw new Error('already known');
      if (
        this.rejectReplacements ||
        signed.maxFeePerGas <= existing.maxFeePerGas ||
        signed.maxPriorityFeePerGas <= existing.maxPriorityFeePerGas
      ) {
        throw new Error('replacement transaction underpriced');
      }
      this.mempool.delete(existing.hash);
    }
    const alreadyMined = [...this.mined.values()].find(
      (transaction) => transaction.hash === signed.hash,
    );
    if (alreadyMined) throw new Error('already known');
    this.mempool.set(signed.hash, { ...signed, receipt: null, blockNumber: null, blockHash: null });
  }

  private includeReady(): void {
    const cursors = new Map(this.latest);
    const ready: StoredTransaction[] = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      const queued = [...this.mempool.values()].sort((left, right) => left.nonce - right.nonce);
      for (const transaction of queued) {
        const cursor = cursors.get(transaction.account) ?? 0;
        if (transaction.nonce !== cursor) continue;
        if (ready.some((included) => included.hash === transaction.hash)) continue;
        ready.push(transaction);
        cursors.set(transaction.account, cursor + 1);
        progressed = true;
      }
    }
    if (ready.length === 0) return;
    this.head += 1n;
    const blockHash = keccak256(stringToHex(`block:${this.head.toString()}`));
    ready.forEach((transaction, index) => {
      this.mempool.delete(transaction.hash);
      const status = this.executionRevert.has(transaction.to) ? 'reverted' : 'success';
      const included: StoredTransaction = {
        ...transaction,
        blockNumber: this.head,
        blockHash,
        transactionIndex: index,
        receipt: {
          hash: transaction.hash,
          status,
          blockNumber: this.head,
          blockHash,
          transactionIndex: index,
          gasUsed: 21_000n,
          logs:
            status === 'success'
              ? [
                  {
                    address: transaction.to,
                    topics: [keccak256(stringToHex('Executed(address,uint256,uint256)'))],
                    data: '0x',
                  },
                ]
              : [],
        },
      };
      this.mined.set(transaction.hash, included);
    });
    for (const [account, nonce] of cursors) this.latest.set(account, nonce);
  }

  private balanceOf(account: Address): bigint {
    return this.balances.get(normalizeAddress(account)) ?? 1_000n * 10n ** 18n;
  }

  private assertRpc(): void {
    if (!this.rpcDown) return;
    throw httpError('fetch failed: connect ECONNREFUSED');
  }
}

function yieldToEventLoop(): Promise<void> {
  return Promise.resolve();
}

function httpError(message: string): Error {
  const error = new Error(message);
  error.name = 'HttpRequestError';
  return error;
}

function timeoutError(): Error {
  const error = new Error('The request timed out.');
  error.name = 'TimeoutError';
  return error;
}
