# Nonce management

`eth_getTransactionCount` is not called once per send and then trusted. Concurrent callers would all read the same count and reuse it.

`NonceLock` is a per-account promise queue. `allocateNonce` holds that lock across the chain read, the reservation write, and the cursor update. Twenty overlapping `allocateNonce` calls in the unit tests receive `0` through `19` with no sleeps.

## Latest and pending

`latest` is `eth_getTransactionCount(account, "latest")`: transactions included in the canonical head.

`pending` is `eth_getTransactionCount(account, "pending")`: that count plus transactions the node already has in the mempool. Pending is always treated as at least latest.

Neither number includes a transaction this process has reserved but not broadcast. Those live in `nonce_reservations`.

The next nonce is the first integer at or above `max(latest, pending)` that is not `reserved` or `submitted`.

```text
chain pending = 10
local reservations = 10 reserved, 11 submitted
next allocation = 12
```

## Stale local state

On restart the reservations and `nonce_state` row are still in SQLite.

- If the chain pending nonce has moved past every local reservation, the cursor jumps forward. Included nonces are marked `consumed`.
- If the stored cursor is ahead of the chain and nothing is reserved or submitted, the cursor rewinds to the chain. That is the crash-before-broadcast case.
- `getNextNonce` reports the value `allocateNonce` would use and does not reserve it.

## Release

`releaseNonce` is only for a `reserved` nonce whose broadcast definitely did not happen. A `submitted` nonce throws `NonceMismatchError`. A timeout during `eth_sendRawTransaction` is not definite: the node may have the transaction, so the nonce stays submitted and the record moves to `RECONCILIATION_REQUIRED`.

An explicit `nonce` on `TransactionRequest` must equal the next safe nonce. It cannot skip ahead or reuse a submitted value.

## Same account, many actions

```text
10 signals
    |
    v
one wallet
    |
    +-- nonce 100
    +-- nonce 101
    +-- nonce 102
```

Each action has its own record. Replacements of action 100 keep nonce 100.
