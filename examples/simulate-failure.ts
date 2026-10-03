import { existsSync, readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, SimulationError } from '../src/index.js';
import { boot } from './shared.js';

const { manager, account } = await boot();
const config = loadConfig();

try {
  const reverter = await resolveReverter(config.rpcUrl ?? '', config.privateKey ?? '0x');
  const data = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'fail',
        stateMutability: 'nonpayable',
        inputs: [],
        outputs: [],
      },
    ] as const,
    functionName: 'fail',
  });

  try {
    await manager.submit({ account, to: reverter, data });
    console.error('simulation was expected to fail');
    process.exitCode = 1;
  } catch (error) {
    if (!(error instanceof SimulationError)) throw error;
    console.log('simulation failed');
    console.log(error.code);
    const failed = manager.listTransactions().at(-1);
    console.log(failed?.status ?? '');
    console.log(failed?.attemptCount ?? 0);
  }

  const handle = await manager.submit({
    account,
    to: reverter,
    data,
    simulate: false,
    gasLimit: 200_000n,
  });
  const reverted = await manager.waitForConfirmation(handle.transactionId);
  console.log(reverted.status);
  console.log(reverted.attemptCount);
  const report = await manager.reconcile(handle.transactionId);
  console.log(report.outcome);
  console.log(report.status);
} finally {
  manager.close();
}

async function resolveReverter(rpcUrl: string, privateKey: Hex): Promise<`0x${string}`> {
  const configured = process.env.REVERTER_ADDRESS;
  if (configured && /^0x[0-9a-fA-F]{40}$/.test(configured)) return configured as `0x${string}`;
  const artifactPath = 'out/MockRevertingTarget.sol/MockRevertingTarget.json';
  if (!existsSync(artifactPath)) {
    console.error('Run forge build, or set REVERTER_ADDRESS to a deployed MockRevertingTarget.');
    process.exit(1);
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as {
    abi: Abi;
    bytecode: { object: Hex };
  };
  const chain = defineChain({
    id: Number(process.env.CHAIN_ID),
    name: 'local',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    account,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) {
    console.error('MockRevertingTarget deployment failed');
    process.exit(1);
  }
  return receipt.contractAddress;
}
