# Reconciliation

`TransactionReconciler` answers what the chain shows for one logical action. It does not trust the in-memory monitor. `recover` runs it for every non-terminal row after a restart, and `manager.reconcile(id)` runs it on demand.

For each known hash, newest first, it loads the transaction and the receipt.

1. If the on-chain nonce does not match the attempt, the record stays in `RECONCILIATION_REQUIRED` and the call throws `ReconciliationError`.
2. A successful receipt with enough confirmations moves the record through `CONFIRMED` to `RECONCILED`. Block number, block hash, transaction index, confirmation count, and log count are stored. The logs themselves are returned on the report.
3. A reverted receipt moves through `REVERTED` to `RECONCILED`. `errorCode` remains `TRANSACTION_REVERTED`. That is a verified revert, not a successful trade, and it is not retried.
4. A receipt that does not yet have `CONFIRMATIONS` blocks stays unreconciled and reports `pending_confirmations`.
5. A known hash that is still pending moves the record to `PENDING` when it was stuck in `SUBMITTING` or `RECONCILIATION_REQUIRED`.
6. A known hash in a block with no receipt reports `missing_receipt` and requires reconciliation.
7. If no known hash is included and `latest` nonce is greater than the record nonce, the reconciler scans the last 25 blocks. A different sender transaction at that nonce is `unknown_nonce_consumption`. The record is not marked `REPLACED` and it is not marked `RECONCILED`.

`RECONCILED` means the service verified the chain. It does not mean the call succeeded. Read `receiptStatus` and `outcome`.

## Restart

```text
submit
  sign
  persist hash and raw transaction
  broadcast
  node mines the transaction
  process stops before the monitor sees the receipt

restart
  recover()
  load PENDING row
  read the receipt
  CONFIRMED -> RECONCILED
```

If broadcast timed out before the node accepted the payload, the attempt is still `SIGNED`. Recovery broadcasts that same payload, then reconciles.

Private keys are not part of this path. The stored artifact is the signed transaction, which anyone could have broadcast and which does not reveal the key.
