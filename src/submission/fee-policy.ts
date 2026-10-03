import type { EvmClient, FeeEstimate } from '../clients/evm-client.js';
import { ConfigurationError, ReplacementError } from '../domain/transaction-error.js';
import { assertReplacementFees, bumpWei } from './replacement-policy.js';

export type FeeParameters = FeeEstimate;

export interface FeePolicy {
  /** Initial EIP-1559 fees. Caller-supplied fees win; missing fields come from the network. */
  getInitialFees(requested: Partial<FeeParameters>): Promise<FeeParameters>;
  /**
   * Fees for a same-nonce replacement.
   * The bump is configuration, not a universal network rule.
   */
  getReplacementFees(previous: FeeParameters, attempt: number): FeeParameters;
}

export type Eip1559FeePolicyOptions = {
  estimate: () => Promise<FeeEstimate>;
  replacementBumpPercent: number;
  minimumFeeBump: bigint;
  maxFeePerGasCap: bigint | null;
  maxPriorityFeePerGasCap: bigint | null;
};

export class Eip1559FeePolicy implements FeePolicy {
  constructor(private readonly options: Eip1559FeePolicyOptions) {}

  async getInitialFees(requested: Partial<FeeParameters>): Promise<FeeParameters> {
    const estimated =
      requested.maxFeePerGas === undefined || requested.maxPriorityFeePerGas === undefined
        ? await this.options.estimate()
        : null;
    const fees: FeeParameters = {
      maxFeePerGas: requested.maxFeePerGas ?? estimated?.maxFeePerGas ?? 0n,
      maxPriorityFeePerGas: requested.maxPriorityFeePerGas ?? estimated?.maxPriorityFeePerGas ?? 0n,
    };
    if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
      throw new ConfigurationError('maxPriorityFeePerGas cannot exceed maxFeePerGas');
    }
    assertWithinCaps(fees, this.options.maxFeePerGasCap, this.options.maxPriorityFeePerGasCap);
    return fees;
  }

  getReplacementFees(previous: FeeParameters, attempt: number): FeeParameters {
    const attemptFactor = BigInt(Math.max(attempt, 1));
    const minimum = this.options.minimumFeeBump * attemptFactor;
    let maxFeePerGas = bumpWei(previous.maxFeePerGas, this.options.replacementBumpPercent, minimum);
    const maxPriorityFeePerGas = bumpWei(
      previous.maxPriorityFeePerGas,
      this.options.replacementBumpPercent,
      minimum,
    );
    if (maxPriorityFeePerGas > maxFeePerGas) {
      maxFeePerGas = maxPriorityFeePerGas;
    }
    const next = { maxFeePerGas, maxPriorityFeePerGas };
    if (
      (this.options.maxFeePerGasCap !== null && next.maxFeePerGas > this.options.maxFeePerGasCap) ||
      (this.options.maxPriorityFeePerGasCap !== null &&
        next.maxPriorityFeePerGas > this.options.maxPriorityFeePerGasCap)
    ) {
      throw new ReplacementError('replacement fees exceed the configured cap', {
        maxFeePerGas: next.maxFeePerGas.toString(10),
        maxPriorityFeePerGas: next.maxPriorityFeePerGas.toString(10),
      });
    }
    assertReplacementFees(previous, next);
    return next;
  }
}

export function feePolicyFromClient(
  evm: Pick<EvmClient, 'estimateFeesPerGas'>,
  options: Omit<Eip1559FeePolicyOptions, 'estimate'>,
): Eip1559FeePolicy {
  return new Eip1559FeePolicy({
    ...options,
    estimate: () => evm.estimateFeesPerGas(),
  });
}

function assertWithinCaps(
  fees: FeeParameters,
  maxFeePerGasCap: bigint | null,
  maxPriorityFeePerGasCap: bigint | null,
): void {
  if (maxFeePerGasCap !== null && fees.maxFeePerGas > maxFeePerGasCap) {
    throw new ConfigurationError(
      `maxFeePerGas ${fees.maxFeePerGas} exceeds configured cap ${maxFeePerGasCap}`,
    );
  }
  if (maxPriorityFeePerGasCap !== null && fees.maxPriorityFeePerGas > maxPriorityFeePerGasCap) {
    throw new ConfigurationError(
      `maxPriorityFeePerGas ${fees.maxPriorityFeePerGas} exceeds configured cap ${maxPriorityFeePerGasCap}`,
    );
  }
}
