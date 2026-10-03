# Retry and replacement

Retries are chosen from the failure, not from "the send threw".

| Category                                                                             | Action                                                                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Temporary RPC rejection such as connection refused                                   | Broadcast the same signed payload again, up to `BROADCAST_RETRY_LIMIT`.                                  |
| Timeout or reset after the payload was signed                                        | Do not sign a new hash. Mark `RECONCILIATION_REQUIRED` and let recovery rebroadcast or find the receipt. |
| Pending longer than `REPLACEMENT_TIMEOUT_MS`                                         | Same nonce, higher EIP-1559 fees, if `attemptCount < MAX_RETRIES`.                                       |
| Nonce too low                                                                        | `RECONCILIATION_REQUIRED`. The nonce is not reused.                                                      |
| Simulation revert, execution revert, bad calldata, authorization, insufficient funds | `FAILED` or `REVERTED`. No automatic replacement.                                                        |

`MAX_RETRIES` counts broadcasts of one logical action, including the original. With the default of 3, the original plus two replacements are allowed. After that the record becomes `RECONCILIATION_REQUIRED` instead of signing forever.

## Fees

`Eip1559FeePolicy.getReplacementFees` raises both `maxFeePerGas` and `maxPriorityFeePerGas`. The percent and the minimum wei bump are configuration (`REPLACEMENT_BUMP_PERCENT`, `MINIMUM_FEE_BUMP`). Networks do not share one replacement rule, so the code does not hard-code a universal bump and claim it works everywhere.

Both fields must be strictly greater than the previous attempt. If the bump would pass `MAX_FEE_PER_GAS_CAP` or `MAX_PRIORITY_FEE_PER_GAS_CAP`, replacement throws `ReplacementError` and the record stays on the previous hash.

Wei math uses `bigint`. The percent is an integer. There is no floating-point fee.

## Same nonce

```text
nonce 50
  attempt 1  hash A  fees F
  attempt 2  hash B  fees > F
  attempt 3  hash C  fees > previous
```

`transaction_attempts` keeps every hash, the signed payload, and the fees. `currentHash` is the attempt being watched. `replacementHashes` lists the hashes after the original.

A replacement that the node rejects as underpriced is marked `REJECTED`, `currentHash` returns to the previous hash, and the status returns to `PENDING`.

## Known replacement versus unknown consumption

`REPLACED` is used only when a hash this manager signed is still pending and the previous known hash is no longer returned by the node. The status then moves back to `PENDING` so the new hash is monitored.

If the account's latest nonce is greater than the record nonce and the included transaction is not one of our hashes, the status becomes `RECONCILIATION_REQUIRED`. Nonce movement alone is not treated as proof of our replacement.
