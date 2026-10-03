# Transaction lifecycle

`TransactionRecord.status` is one of the states in `STATUS_TRANSITIONS`. `SqliteTransactionRepository.transition` rejects any other edge and appends a row to `status_events`.

```text
CREATED
  -> QUEUED
QUEUED
  -> SIMULATING | SUBMITTING | FAILED
SIMULATING
  -> SUBMITTING | FAILED
SUBMITTING
  -> SUBMITTED | FAILED | RECONCILIATION_REQUIRED
SUBMITTED
  -> PENDING | CONFIRMED | REVERTED | REPLACEMENT_PENDING
     | TIMED_OUT | RECONCILIATION_REQUIRED | FAILED
PENDING
  -> CONFIRMED | REVERTED | REPLACEMENT_PENDING | TIMED_OUT
     | RECONCILIATION_REQUIRED | FAILED
REPLACEMENT_PENDING
  -> REPLACED | PENDING | CONFIRMED | REVERTED | TIMED_OUT
     | RECONCILIATION_REQUIRED | FAILED
REPLACED
  -> PENDING | CONFIRMED | REVERTED | REPLACEMENT_PENDING
     | RECONCILIATION_REQUIRED
TIMED_OUT
  -> PENDING | REPLACEMENT_PENDING | CONFIRMED | REVERTED
     | RECONCILIATION_REQUIRED | FAILED
CONFIRMED
  -> RECONCILED | RECONCILIATION_REQUIRED
REVERTED
  -> RECONCILED | RECONCILIATION_REQUIRED
RECONCILIATION_REQUIRED
  -> RECONCILED | FAILED | CONFIRMED | REVERTED | PENDING
```

`RECONCILED` and `FAILED` have no exits. Recovery that discovers a later state uses `StatusJournal.moveTo`, which walks the shortest legal path and persists every step. It cannot jump from `CREATED` to `CONFIRMED`.

## What the states mean

| Status                    | Meaning                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `CREATED` / `QUEUED`      | The action is durable and waiting for a nonce.                                                                              |
| `SIMULATING`              | `eth_call` is in progress. A revert here fails the record and releases the nonce.                                           |
| `SUBMITTING`              | The payload is being signed. The hash is stored before broadcast.                                                           |
| `SUBMITTED` / `PENDING`   | The hash is known. Inclusion is not.                                                                                        |
| `REPLACEMENT_PENDING`     | A higher-fee transaction with the same nonce has been broadcast.                                                            |
| `REPLACED`                | A hash this service signed is the one still in the mempool, and the previous known hash is gone.                            |
| `TIMED_OUT`               | The pending attempt exceeded `REPLACEMENT_TIMEOUT_MS`.                                                                      |
| `CONFIRMED`               | A successful receipt has at least `CONFIRMATIONS` blocks.                                                                   |
| `REVERTED`                | The receipt status is reverted. No further attempt is signed.                                                               |
| `RECONCILIATION_REQUIRED` | The chain moved and the service cannot yet prove which transaction did it, or a broadcast may have landed after a timeout.  |
| `RECONCILED`              | A chain read verified the record. Check `receiptStatus` for success or revert.                                              |
| `FAILED`                  | A definite local failure before inclusion, such as a simulation revert or an RPC rejection that did not accept the payload. |

## Example

A successful call records:

```text
CREATED -> QUEUED -> SIMULATING -> SUBMITTING -> SUBMITTED -> PENDING -> CONFIRMED -> RECONCILED
```

A contract call that reverts on chain, submitted with `simulate: false` and an explicit `gasLimit`, records:

```text
CREATED -> QUEUED -> SUBMITTING -> SUBMITTED -> PENDING -> REVERTED -> RECONCILED
```

`attemptCount` stays 1. `replace` throws. `errorCode` is `TRANSACTION_REVERTED`.

Simulation does not promise the later mined state. Another transaction can change the contract between `eth_call` and inclusion. The receipt is the execution result.
