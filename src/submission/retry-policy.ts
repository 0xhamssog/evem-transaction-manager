import { collectErrorNames, errorText } from '../clients/evm-client.js';

export const FAILURE_CATEGORIES = [
  'temporary_rpc',
  'transient_transport',
  'pending_timeout',
  'contract_revert',
  'authorization',
  'invalid_calldata',
  'nonce_conflict',
  'insufficient_funds',
  'simulation_revert',
  'replacement_underpriced',
  'already_known',
  'unknown',
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export type RetryAction = 'retry_broadcast' | 'replace' | 'reconcile' | 'fail' | 'accept';

export type ClassifiedFailure = {
  category: FailureCategory;
  retryable: boolean;
  ambiguous: boolean;
  action: RetryAction;
  message: string;
};

export const DEFAULT_RETRYABLE_CATEGORIES: readonly FailureCategory[] = [
  'temporary_rpc',
  'transient_transport',
  'pending_timeout',
];

const AMBIGUOUS_CATEGORIES = new Set<FailureCategory>(['transient_transport']);

/**
 * Decides whether a failure may be retried.
 * Contract reverts, bad calldata, authorization, and insufficient funds are not retried.
 * Pending timeouts replace the same nonce; they do not allocate a new one.
 * Nonce conflicts require reconciliation instead of a blind resend.
 */
export class RetryPolicy {
  private readonly retryable: Set<FailureCategory>;

  constructor(
    private readonly maxRetries: number,
    retryableCategories: readonly FailureCategory[] = DEFAULT_RETRYABLE_CATEGORIES,
  ) {
    this.retryable = new Set(retryableCategories);
  }

  classify(error: unknown): ClassifiedFailure {
    const category = categorize(error);
    const ambiguous = isAmbiguous(error, category);
    return {
      category,
      retryable: this.retryable.has(category),
      ambiguous,
      action: actionFor(category, ambiguous),
      message: errorText(error),
    };
  }

  /**
   * `attemptCount` is how many broadcasts have already been recorded.
   * A replacement is allowed only while that count is below `maxRetries`.
   */
  decide(failure: ClassifiedFailure, attemptCount: number): ClassifiedFailure {
    if (failure.category === 'already_known') {
      return { ...failure, action: 'accept', retryable: false };
    }
    if (failure.category === 'pending_timeout') {
      return {
        ...failure,
        action: attemptCount < this.maxRetries ? 'replace' : 'reconcile',
        retryable: attemptCount < this.maxRetries,
      };
    }
    if (!failure.retryable) {
      return {
        ...failure,
        action: failure.category === 'nonce_conflict' ? 'reconcile' : 'fail',
      };
    }
    if (failure.ambiguous) return { ...failure, action: 'reconcile' };
    if (attemptCount < this.maxRetries) return { ...failure, action: 'retry_broadcast' };
    return { ...failure, action: 'fail', retryable: false };
  }
}

function actionFor(category: FailureCategory, ambiguous: boolean): RetryAction {
  if (category === 'already_known') return 'accept';
  if (category === 'pending_timeout') return 'replace';
  if (category === 'nonce_conflict') return 'reconcile';
  if (ambiguous) return 'reconcile';
  if (category === 'temporary_rpc' || category === 'transient_transport') {
    return 'retry_broadcast';
  }
  return 'fail';
}

function categorize(error: unknown): FailureCategory {
  const names = collectErrorNames(error);
  if (names.includes('SimulationError')) return 'simulation_revert';
  if (names.includes('TransactionRevertedError')) return 'contract_revert';
  const text = `${names.join(' ')} ${errorText(error)}`.toLowerCase();
  if (text.includes('already known')) return 'already_known';
  if (text.includes('insufficient funds')) return 'insufficient_funds';
  if (text.includes('nonce too low') || text.includes('nonce has already been used')) {
    return 'nonce_conflict';
  }
  if (text.includes('replacement transaction underpriced') || text.includes('fee too low')) {
    return 'replacement_underpriced';
  }
  if (text.includes('unauthorized') || text.includes('invalid sender')) return 'authorization';
  if (
    text.includes('intrinsic gas too low') ||
    text.includes('invalid calldata') ||
    text.includes('invalid data')
  ) {
    return 'invalid_calldata';
  }
  if (
    names.includes('CallExecutionError') ||
    text.includes('execution reverted') ||
    text.includes('revert')
  ) {
    return 'contract_revert';
  }
  if (
    names.includes('TimeoutError') ||
    text.includes('timed out') ||
    text.includes('timeout') ||
    text.includes('aborted')
  ) {
    return 'transient_transport';
  }
  if (
    names.includes('HttpRequestError') ||
    names.includes('RpcRequestError') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('fetch failed') ||
    text.includes('network') ||
    text.includes('429') ||
    text.includes('503') ||
    text.includes('rate limit')
  ) {
    return 'temporary_rpc';
  }
  return 'unknown';
}

function isAmbiguous(error: unknown, category: FailureCategory): boolean {
  if (AMBIGUOUS_CATEGORIES.has(category)) return true;
  const text = errorText(error).toLowerCase();
  return text.includes('econnreset') || text.includes('socket hang up');
}
