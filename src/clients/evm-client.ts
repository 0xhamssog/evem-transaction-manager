import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  type Account,
  type Chain,
  type Hex as ViemHex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { ConfigurationError } from '../domain/transaction-error.js';
import type { Address, Hex } from '../types/common.js';

export type FeeEstimate = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type UnsignedTransaction = {
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type SignedTransaction = {
  hash: Hex;
  serialized: Hex;
};

export type SimulationRequest = {
  account: Address;
  to: Address;
  data: Hex;
  value: bigint;
  gasLimit?: bigint;
};

export type ChainTransaction = {
  hash: Hex;
  nonce: number;
  from: Address;
  to: Address | null;
  value: bigint;
  blockNumber: bigint | null;
  blockHash: Hex | null;
};

export type ChainLog = {
  address: Address;
  topics: Hex[];
  data: Hex;
};

export type ChainReceipt = {
  hash: Hex;
  status: 'success' | 'reverted';
  blockNumber: bigint;
  blockHash: Hex;
  transactionIndex: number;
  gasUsed: bigint;
  logs: ChainLog[];
};

/**
 * The only blockchain boundary in the process.
 * Domain and persistence code depend on this interface, not on viem call sites.
 */
export interface EvmClient {
  readonly chainId: number;
  getPendingNonce(account: Address): Promise<number>;
  getLatestNonce(account: Address): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  estimateFeesPerGas(): Promise<FeeEstimate>;
  estimateGas(request: SimulationRequest): Promise<bigint>;
  simulate(request: SimulationRequest): Promise<{ returnData: Hex }>;
  sign(transaction: UnsignedTransaction): Promise<SignedTransaction>;
  broadcast(serialized: Hex): Promise<Hex>;
  getTransaction(hash: Hex): Promise<ChainTransaction | null>;
  getReceipt(hash: Hex): Promise<ChainReceipt | null>;
  /**
   * Searches a short canonical window for the transaction that used `nonce`.
   * Used only when the account nonce has moved and a hash lookup missed.
   */
  findTransactionByNonce(account: Address, nonce: number): Promise<ChainTransaction | null>;
}

export type ViemEvmClientOptions = {
  rpcUrl: string;
  chainId: number;
  privateKey?: Hex;
  account?: PrivateKeyAccount;
};

type ViemPublic = PublicClient<ReturnType<typeof http>, Chain>;
type ViemWallet = WalletClient<ReturnType<typeof http>, Chain, Account>;

/**
 * viem adapter. Nonce selection is intentionally not delegated to viem's nonce manager:
 * every signed transaction receives the nonce allocated by `NonceManager`.
 */
export class ViemEvmClient implements EvmClient {
  readonly chainId: number;
  private readonly publicClient: ViemPublic;
  private readonly walletClient: ViemWallet;
  private readonly signer: PrivateKeyAccount;

  constructor(options: ViemEvmClientOptions) {
    const signer =
      options.account ?? (options.privateKey ? privateKeyToAccount(options.privateKey) : null);
    if (!signer) {
      throw new ConfigurationError(
        'a private key or local account is required to sign transactions',
      );
    }
    const chain = defineChain({
      id: options.chainId,
      name: `evm-${options.chainId}`,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl] } },
    });
    const transport = http(options.rpcUrl, { retryCount: 0, timeout: 20_000 });
    this.chainId = options.chainId;
    this.signer = signer;
    this.publicClient = createPublicClient({ chain, transport });
    this.walletClient = createWalletClient({ account: signer, chain, transport });
  }

  async getPendingNonce(account: Address): Promise<number> {
    return this.publicClient.getTransactionCount({ address: account, blockTag: 'pending' });
  }

  async getLatestNonce(account: Address): Promise<number> {
    return this.publicClient.getTransactionCount({ address: account, blockTag: 'latest' });
  }

  async getBlockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async estimateFeesPerGas(): Promise<FeeEstimate> {
    const fees = await this.publicClient.estimateFeesPerGas({ type: 'eip1559' });
    return {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  }

  async estimateGas(request: SimulationRequest): Promise<bigint> {
    return this.publicClient.estimateGas({
      account: request.account,
      to: request.to,
      data: request.data,
      value: request.value,
    });
  }

  async simulate(request: SimulationRequest): Promise<{ returnData: Hex }> {
    const result = await this.publicClient.call({
      account: request.account,
      to: request.to,
      data: request.data,
      value: request.value,
      ...(request.gasLimit !== undefined ? { gas: request.gasLimit } : {}),
    });
    return { returnData: result.data ?? '0x' };
  }

  async sign(transaction: UnsignedTransaction): Promise<SignedTransaction> {
    const serialized = await this.walletClient.signTransaction({
      account: this.signer,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      nonce: transaction.nonce,
      gas: transaction.gasLimit,
      maxFeePerGas: transaction.maxFeePerGas,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      chainId: this.chainId,
      type: 'eip1559',
    });
    const hash = keccak256(serialized);
    return { hash, serialized };
  }

  async broadcast(serialized: Hex): Promise<Hex> {
    return this.publicClient.sendRawTransaction({
      serializedTransaction: serialized as ViemHex,
    });
  }

  async getTransaction(hash: Hex): Promise<ChainTransaction | null> {
    try {
      const transaction = await this.publicClient.getTransaction({ hash });
      return {
        hash: transaction.hash,
        nonce: transaction.nonce,
        from: transaction.from.toLowerCase() as Address,
        to: transaction.to ? (transaction.to.toLowerCase() as Address) : null,
        value: transaction.value,
        blockNumber: transaction.blockNumber,
        blockHash: transaction.blockHash,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getReceipt(hash: Hex): Promise<ChainReceipt | null> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== 'success' && receipt.status !== 'reverted') return null;
      return {
        hash: receipt.transactionHash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        transactionIndex: receipt.transactionIndex,
        gasUsed: receipt.gasUsed,
        logs: receipt.logs.map((log) => ({
          address: log.address.toLowerCase() as Address,
          topics: log.topics.map((topic) => topic as Hex),
          data: log.data,
        })),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async findTransactionByNonce(account: Address, nonce: number): Promise<ChainTransaction | null> {
    const head = await this.getBlockNumber();
    const depth = 25n;
    const start = head > depth ? head - depth : 0n;
    const target = account.toLowerCase();
    for (let blockNumber = head; blockNumber >= start; blockNumber -= 1n) {
      const block = await this.publicClient.getBlock({ blockNumber, includeTransactions: true });
      for (const transaction of block.transactions) {
        if (typeof transaction === 'string') continue;
        if (transaction.from.toLowerCase() !== target || transaction.nonce !== nonce) continue;
        return {
          hash: transaction.hash,
          nonce: transaction.nonce,
          from: transaction.from.toLowerCase() as Address,
          to: transaction.to ? (transaction.to.toLowerCase() as Address) : null,
          value: transaction.value,
          blockNumber: transaction.blockNumber,
          blockHash: transaction.blockHash,
        };
      }
    }
    return null;
  }
}

function isNotFound(error: unknown): boolean {
  const names = collectErrorNames(error);
  return (
    names.includes('TransactionNotFoundError') || names.includes('TransactionReceiptNotFoundError')
  );
}

export function collectErrorNames(error: unknown): string[] {
  const names: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && current.name) names.push(current.name);
    current = 'cause' in current ? current.cause : undefined;
  }
  return names;
}

export function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.name, current.message);
      if ('shortMessage' in current && typeof current.shortMessage === 'string') {
        parts.push(current.shortMessage);
      }
      if ('details' in current && typeof current.details === 'string') parts.push(current.details);
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  if (parts.length === 0) return String(error);
  return parts.join(' ');
}
