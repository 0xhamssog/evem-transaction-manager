import type { EvmClient } from '../clients/evm-client.js';
import { NonceMismatchError } from '../domain/transaction-error.js';
import type { Logger } from '../logging/logger.js';
import type { NonceRepository, ReservationStatus } from '../persistence/nonce-repository.js';
import type { Address } from '../types/common.js';
import { normalizeAddress } from '../types/common.js';
import { NonceLock } from './nonce-lock.js';

export type NonceSnapshot = {
  account: Address;
  chainPendingNonce: number;
  chainLatestNonce: number;
  nextNonce: number;
  stale: boolean;
};

type OccupiedReservation = {
  nonce: number;
  status: ReservationStatus;
};

/**
 * Allocates nonces for one chain.
 *
 * `latest` is the count of transactions included in the canonical head.
 * `pending` is that count plus transactions the node already knows in the mempool.
 * Local reservations cover transactions this process has signed but the node may not
 * count yet. The next nonce is the first integer at or above `max(latest, pending)`
 * that is not reserved or submitted. That is what prevents two callers from receiving
 * the same nonce when they arrive together.
 */
export class NonceManager {
  constructor(
    private readonly chainId: number,
    private readonly evm: Pick<EvmClient, 'getPendingNonce' | 'getLatestNonce'>,
    private readonly repository: NonceRepository,
    private readonly lock: NonceLock,
    private readonly logger: Logger,
    private readonly now: () => string,
  ) {}

  /** Reserves the next safe nonce for `account`. */
  async allocateNonce(account: Address, transactionId?: string): Promise<number> {
    const normalized = normalizeAddress(account);
    return this.lock.runExclusive(this.key(normalized), async () => {
      const snapshot = await this.compute(normalized);
      this.repository.reserve({
        chainId: this.chainId,
        account: normalized,
        nonce: snapshot.nextNonce,
        status: 'reserved',
        transactionId: transactionId ?? null,
        updatedAt: this.now(),
      });
      this.repository.setNextNonce(this.chainId, normalized, snapshot.nextNonce + 1, this.now());
      if (snapshot.stale) {
        this.logger.warn('stale local nonce corrected during allocation', {
          account: normalized,
          nonce: snapshot.nextNonce,
        });
      }
      return snapshot.nextNonce;
    });
  }

  /**
   * Adopts a caller-supplied nonce only when it is exactly the next safe nonce.
   */
  async adoptNonce(account: Address, nonce: number, transactionId?: string): Promise<void> {
    const normalized = normalizeAddress(account);
    await this.lock.runExclusive(this.key(normalized), async () => {
      const snapshot = await this.compute(normalized);
      if (nonce !== snapshot.nextNonce) {
        throw new NonceMismatchError(
          `requested nonce ${nonce} does not match the next safe nonce ${snapshot.nextNonce}`,
          {
            account: normalized,
            nonce,
            expected: snapshot.nextNonce,
          },
        );
      }
      this.repository.reserve({
        chainId: this.chainId,
        account: normalized,
        nonce,
        status: 'reserved',
        transactionId: transactionId ?? null,
        updatedAt: this.now(),
      });
      this.repository.setNextNonce(this.chainId, normalized, nonce + 1, this.now());
    });
  }

  /** Returns the nonce that `allocateNonce` would reserve, without reserving it. */
  async getNextNonce(account: Address): Promise<number> {
    const normalized = normalizeAddress(account);
    return this.lock.runExclusive(this.key(normalized), async () => {
      const snapshot = await this.compute(normalized);
      return snapshot.nextNonce;
    });
  }

  /**
   * Returns a nonce to the pool after a definite pre-broadcast failure.
   * Submitted nonces are not released: the node may still have the transaction.
   */
  async releaseNonce(account: Address, nonce: number): Promise<void> {
    const normalized = normalizeAddress(account);
    await this.lock.runExclusive(this.key(normalized), async () => {
      const current = this.repository.getReservation(this.chainId, normalized, nonce);
      if (!current || current.status === 'released' || current.status === 'consumed') return;
      if (current.status === 'submitted') {
        throw new NonceMismatchError(
          `nonce ${nonce} was already submitted and cannot be reused automatically`,
          { account: normalized, nonce },
        );
      }
      this.repository.mark(this.chainId, normalized, nonce, 'released', this.now());
      const snapshot = await this.compute(normalized);
      this.repository.setNextNonce(this.chainId, normalized, snapshot.nextNonce, this.now());
    });
  }

  /** Marks a nonce as broadcast so a later allocation cannot reuse it. */
  async markSubmitted(account: Address, nonce: number): Promise<void> {
    const normalized = normalizeAddress(account);
    await this.lock.runExclusive(this.key(normalized), async () => {
      this.repository.mark(this.chainId, normalized, nonce, 'submitted', this.now());
    });
  }

  /** Reloads chain counts and repairs the local cursor. Safe to call after a restart. */
  async reconcileNonce(account: Address): Promise<NonceSnapshot> {
    const normalized = normalizeAddress(account);
    return this.lock.runExclusive(this.key(normalized), async () => {
      const snapshot = await this.compute(normalized);
      this.repository.setNextNonce(this.chainId, normalized, snapshot.nextNonce, this.now());
      if (snapshot.stale) {
        this.logger.warn('nonce state reconciled with chain', {
          account: normalized,
          nonce: snapshot.nextNonce,
        });
      }
      return snapshot;
    });
  }

  private async compute(account: Address): Promise<NonceSnapshot> {
    const [pending, latest] = await Promise.all([
      this.evm.getPendingNonce(account),
      this.evm.getLatestNonce(account),
    ]);
    const floor = Math.max(pending, latest);
    const reservations = this.repository.list(this.chainId, account);
    for (const reservation of reservations) {
      if (reservation.nonce < latest && reservation.status !== 'consumed') {
        this.repository.mark(this.chainId, account, reservation.nonce, 'consumed', this.now());
      }
    }
    const occupied: OccupiedReservation[] = this.repository
      .list(this.chainId, account)
      .filter(
        (reservation) =>
          (reservation.status === 'reserved' || reservation.status === 'submitted') &&
          reservation.nonce >= floor,
      );
    const nextNonce = firstFree(
      floor,
      occupied.map((reservation) => reservation.nonce),
    );
    const stored = this.repository.getState(this.chainId, account);
    const stale = stored !== null && stored.nextNonce !== nextNonce;
    return {
      account,
      chainPendingNonce: pending,
      chainLatestNonce: latest,
      nextNonce,
      stale,
    };
  }

  private key(account: Address): string {
    return `${this.chainId}:${account}`;
  }
}

function firstFree(start: number, occupied: number[]): number {
  const taken = new Set(occupied);
  let cursor = start;
  while (taken.has(cursor)) cursor += 1;
  return cursor;
}
