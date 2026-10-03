export const TRANSACTION_STATUSES = [
  'CREATED',
  'QUEUED',
  'SIMULATING',
  'SUBMITTING',
  'SUBMITTED',
  'PENDING',
  'CONFIRMED',
  'REVERTED',
  'REPLACEMENT_PENDING',
  'REPLACED',
  'TIMED_OUT',
  'RECONCILIATION_REQUIRED',
  'RECONCILED',
  'FAILED',
] as const;

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/**
 * Allowed status transitions.
 *
 * `RECONCILED` means the service verified chain state. It does not mean the
 * call succeeded. A reverted execution is reconciled with `receiptStatus = reverted`.
 *
 * `REPLACED` means a hash this service submitted superseded an earlier known
 * attempt. Nonce advancement alone is never enough to enter `REPLACED`.
 */
export const STATUS_TRANSITIONS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  CREATED: ['QUEUED'],
  QUEUED: ['SIMULATING', 'SUBMITTING', 'FAILED'],
  SIMULATING: ['SUBMITTING', 'FAILED'],
  SUBMITTING: ['SUBMITTED', 'FAILED', 'RECONCILIATION_REQUIRED'],
  SUBMITTED: [
    'PENDING',
    'CONFIRMED',
    'REVERTED',
    'REPLACEMENT_PENDING',
    'TIMED_OUT',
    'RECONCILIATION_REQUIRED',
    'FAILED',
  ],
  PENDING: [
    'CONFIRMED',
    'REVERTED',
    'REPLACEMENT_PENDING',
    'TIMED_OUT',
    'RECONCILIATION_REQUIRED',
    'FAILED',
  ],
  REPLACEMENT_PENDING: [
    'REPLACED',
    'PENDING',
    'CONFIRMED',
    'REVERTED',
    'TIMED_OUT',
    'RECONCILIATION_REQUIRED',
    'FAILED',
  ],
  REPLACED: ['PENDING', 'CONFIRMED', 'REVERTED', 'REPLACEMENT_PENDING', 'RECONCILIATION_REQUIRED'],
  TIMED_OUT: [
    'PENDING',
    'REPLACEMENT_PENDING',
    'RECONCILIATION_REQUIRED',
    'FAILED',
    'CONFIRMED',
    'REVERTED',
  ],
  CONFIRMED: ['RECONCILED', 'RECONCILIATION_REQUIRED'],
  REVERTED: ['RECONCILED', 'RECONCILIATION_REQUIRED'],
  RECONCILIATION_REQUIRED: ['RECONCILED', 'FAILED', 'CONFIRMED', 'REVERTED', 'PENDING'],
  RECONCILED: [],
  FAILED: [],
};

export const TERMINAL_STATUSES = [
  'RECONCILED',
  'FAILED',
] as const satisfies readonly TransactionStatus[];

const MONITORABLE_STATUSES = [
  'SUBMITTED',
  'PENDING',
  'REPLACEMENT_PENDING',
  'REPLACED',
  'TIMED_OUT',
] as const satisfies readonly TransactionStatus[];

export function isTerminalStatus(status: TransactionStatus): boolean {
  return (TERMINAL_STATUSES as readonly TransactionStatus[]).includes(status);
}

export function isMonitorableStatus(status: TransactionStatus): boolean {
  return (MONITORABLE_STATUSES as readonly TransactionStatus[]).includes(status);
}

export function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  return STATUS_TRANSITIONS[from].includes(to);
}

/**
 * Shortest legal path from `from` to `to`, excluding `from`.
 * Returns an empty array when the statuses are equal, or `null` when no path exists.
 */
export function findTransitionPath(
  from: TransactionStatus,
  to: TransactionStatus,
): TransactionStatus[] | null {
  if (from === to) return [];
  const queue: TransactionStatus[][] = [[from]];
  const seen = new Set<TransactionStatus>([from]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (!path) break;
    const current = path[path.length - 1];
    if (!current) break;
    for (const next of STATUS_TRANSITIONS[current]) {
      if (seen.has(next)) continue;
      const nextPath = [...path, next];
      if (next === to) return nextPath.slice(1);
      seen.add(next);
      queue.push(nextPath);
    }
  }
  return null;
}
