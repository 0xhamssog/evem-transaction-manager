export type ErrorContext = Record<string, string | number | boolean | null>;

export class TransactionManagerError extends Error {
  readonly code: string;
  readonly context: ErrorContext;

  constructor(code: string, message: string, context: ErrorContext = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.context = context;
  }
}

export class NonceAllocationError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super('NONCE_ALLOCATION', message, context, cause);
  }
}

export class NonceMismatchError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super('NONCE_MISMATCH', message, context, cause);
  }
}

export class SimulationError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super('SIMULATION', message, context, cause);
  }
}

export class SubmissionError extends TransactionManagerError {
  readonly ambiguous: boolean;

  constructor(
    message: string,
    context: ErrorContext = {},
    options?: { cause?: unknown; ambiguous?: boolean },
  ) {
    super('SUBMISSION', message, context, options?.cause);
    this.ambiguous = options?.ambiguous ?? false;
  }
}

export class TransactionRevertedError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super('TRANSACTION_REVERTED', message, context, cause);
  }
}

export class ReplacementError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super('REPLACEMENT', message, context, cause);
  }
}

export class ReconciliationError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super('RECONCILIATION', message, context, cause);
  }
}

export class ConfigurationError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}, cause?: unknown) {
    super('CONFIGURATION', message, context, cause);
  }
}

export class InvalidTransitionError extends TransactionManagerError {
  constructor(from: string, to: string) {
    super('INVALID_TRANSITION', `cannot transition from ${from} to ${to}`, { from, to });
  }
}

export class ValidationError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}) {
    super('VALIDATION', message, context);
  }
}

export class NotFoundError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}) {
    super('NOT_FOUND', message, context);
  }
}

export class TimeoutWaitingError extends TransactionManagerError {
  constructor(message: string, context: ErrorContext = {}) {
    super('TIMEOUT', message, context);
  }
}
