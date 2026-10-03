import type { Logger } from '../logging/logger.js';

export type TimerHandle = { id: number };

export interface Scheduler {
  schedule(delayMs: number, fn: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
}

/** Production scheduler. One timer drives every pending transaction. */
export class TimeoutScheduler implements Scheduler {
  private nextId = 1;
  private readonly timers = new Map<number, NodeJS.Timeout>();

  schedule(delayMs: number, fn: () => void): TimerHandle {
    const id = this.nextId;
    this.nextId += 1;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, delayMs);
    this.timers.set(id, timer);
    return { id };
  }

  cancel(handle: TimerHandle): void {
    const timer = this.timers.get(handle.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(handle.id);
  }
}

/**
 * One polling loop for every tracked transaction.
 * Call `cancel` to stop watching an id. That does not remove the transaction from the mempool.
 */
export class TransactionMonitor {
  private handle: TimerHandle | null = null;
  private running = false;
  private currentDelay: number;
  private ticking = false;
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly options: {
      pollIntervalMs: number;
      maxPollIntervalMs: number;
      scheduler: Scheduler;
      loadPendingIds: () => string[];
      inspect: (id: string) => Promise<void>;
      isTransportFailure: (error: unknown) => boolean;
      logger: Logger;
    },
  ) {
    this.currentDelay = options.pollIntervalMs;
  }

  /** Starts the shared polling loop. A second call does not create another loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.arm(this.currentDelay);
  }

  /** Stops the shared loop. Tracked ids remain in the database. */
  stop(): void {
    this.running = false;
    if (this.handle) this.options.scheduler.cancel(this.handle);
    this.handle = null;
  }

  track(id: string): void {
    this.cancelled.delete(id);
  }

  /** Stops local monitoring for one transaction. The on-chain transaction is unchanged. */
  cancel(id: string): void {
    this.cancelled.add(id);
  }

  isCancelled(id: string): boolean {
    return this.cancelled.has(id);
  }

  /** Runs one pass immediately. Safe to call from tests without starting the timer. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    let transportFailure = false;
    try {
      const ids = this.options.loadPendingIds().filter((id) => !this.cancelled.has(id));
      const results = await Promise.allSettled(ids.map((id) => this.options.inspect(id)));
      for (const result of results) {
        if (result.status === 'rejected') {
          if (this.options.isTransportFailure(result.reason)) transportFailure = true;
          const message =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          this.options.logger.error('transaction monitor check failed', { errorMessage: message });
        }
      }
      this.currentDelay = transportFailure
        ? Math.min(this.currentDelay * 2, this.options.maxPollIntervalMs)
        : this.options.pollIntervalMs;
    } finally {
      this.ticking = false;
      if (this.running) this.arm(this.currentDelay);
    }
  }

  private arm(delayMs: number): void {
    if (!this.running) return;
    if (this.handle) this.options.scheduler.cancel(this.handle);
    this.handle = this.options.scheduler.schedule(delayMs, () => {
      void this.tick();
    });
  }
}
