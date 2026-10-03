# evm-transaction-manager

Transaction submission is not the same as successful execution.

Automated EVM trading systems lose trades when they treat an RPC hash as a fill. The nonce can collide, the transaction can sit in the mempool, a replacement can land instead, the receipt can revert, or the process can die after the node has already mined the transaction. This repository is a reusable engineering reference implementation for that layer: nonce allocation, durable lifecycle state, replacement, receipt tracking, and restart-safe reconciliation.

It is infrastructure for execution services. It is not a strategy, a sniper, or a copy-trading bot. The same manager can sit under a perps trader, a stock-token trader, an arbitrage executor, a copy-trading service, a terminal, or any other application that submits EVM transactions. Nothing in the core is tied to one venue.

## Overview

`TransactionManager.submit` accepts one logical action and returns a transaction id plus the hash that was signed. The record then moves through explicit states until a receipt is confirmed and a separate reconciliation pass agrees with the chain.

```ts
const manager = createTransactionManager(config);

const result = await manager.submit({
  account,
  to,
  data,
  value,
});

console.log(result.transactionId);
console.log(result.hash);

const confirmed = await manager.waitForConfirmation(result.transactionId);
const report = await manager.reconcile(result.transactionId);
```

`result.hash` is not a completed trade. `confirmed.status === 'CONFIRMED'` means a successful receipt reached the configured confirmation depth. `report.status === 'RECONCILED'` means that fact was read back from the chain. A reverted receipt can also be reconciled. Check `receiptStatus`.

## Why this exists

A direct `writeContract` or `sendTransaction` hides the states that matter under load:

- two signals for the same account read the same pending nonce
- the hash is persisted too late, so a crash loses the only handle on an in-flight transaction
- a timeout is retried with a new nonce and strands the original
- a higher fee replacement is confused with some other transaction that happened to consume the nonce
- a reverted receipt is submitted again

Those are infrastructure bugs. They show up in any automated sender.

## Architecture

```text
Trading strategy
        |
        v
Risk / execution layer
        |
        v
EVM Transaction Manager
        |
        +---- Nonce Manager
        +---- Transaction Store
        +---- Submission
        +---- Pending Monitor
        +---- Receipt Monitor
        +---- Retry / Replacement
        +---- Reconciliation
        |
        v
EVM RPC
        |
        v
Blockchain
```

Domain code does not talk to SQLite or viem. `EvmClient` is the only RPC boundary. `ViemEvmClient` implements it with a public client and a wallet client. Tests implement the same interface with an in-memory chain, and `test/integration/anvil.test.ts` runs the viem adapter against Anvil and the mock contracts.

Details: [docs/architecture.md](docs/architecture.md).

## Transaction lifecycle

```text
CREATED -> QUEUED -> SIMULATING -> SUBMITTING -> SUBMITTED -> PENDING
                                                              |
                              +-------------------------------+
                              |               |               |
                          CONFIRMED        REVERTED     TIMED_OUT
                              |               |               |
                         RECONCILED      RECONCILED   REPLACEMENT_PENDING
                                                              |
                                          REPLACED or CONFIRMED or REVERTED
                                                              |
                                                    RECONCILIATION_REQUIRED
                                                              |
                                                    RECONCILED or FAILED
```

Illegal edges throw `InvalidTransitionError` and are not written. Every accepted edge is stored in `status_events`.

`RECONCILED` means the chain was checked. It does not mean the call succeeded.

Details: [docs/transaction-lifecycle.md](docs/transaction-lifecycle.md).

## Nonce management

`latest` is the count of included transactions. `pending` is that count plus what the node already sees in the mempool. This process also remembers nonces it has reserved but not broadcast. The next nonce is the first free value at or above both chain counts.

Allocations for one account are serialized by `NonceLock`. Concurrent callers do not need sleeps to stay unique.

```text
Request A -> nonce 42
Request B -> nonce 43
Request C -> nonce 44
```

A caller-supplied nonce is accepted only when it is exactly that next value. Details: [docs/nonce-management.md](docs/nonce-management.md).

## Retry logic

| Situation                                                                                   | What happens                                                                                     |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Connection refused before the node accepts the payload                                      | The same signed bytes are sent again.                                                            |
| Timeout after signing                                                                       | No second hash. The record is `RECONCILIATION_REQUIRED` until recovery finds or rebroadcasts it. |
| Pending too long                                                                            | Same nonce, higher EIP-1559 fees, until `MAX_RETRIES`.                                           |
| Nonce conflict                                                                              | Reconcile. Do not grab another nonce for the same action.                                        |
| Simulation revert, on-chain revert, bad calldata, authorization failure, insufficient funds | Stop.                                                                                            |

## Replacement transactions

```text
nonce 50
   |
   +--> hash A
   |
   +--> hash B   same nonce, both fees strictly higher
   |
   v
confirmed
```

`REPLACEMENT_BUMP_PERCENT` and `MINIMUM_FEE_BUMP` are configuration. Fee math is `bigint`. A bump that would cross `MAX_FEE_PER_GAS_CAP` or `MAX_PRIORITY_FEE_PER_GAS_CAP` is rejected.

`REPLACED` is used only when one of our hashes is still the pending transaction and the previous known hash is gone. If the nonce was consumed by a hash we did not sign, the state is `RECONCILIATION_REQUIRED`.

Details: [docs/retry-and-replacement.md](docs/retry-and-replacement.md).

## Reconciliation

Reconciliation is separate from the mempool poll. It re-reads the transaction, the receipt, the nonce, the block, and the logs. `recover()` does this for every non-terminal row, so a restart after the transaction has already mined can still reach `RECONCILED`.

```text
Strategy
   |
   | submit
   v
Transaction Manager
   |
   | simulate
   v
RPC
   |
   | success
   v
Transaction Manager
   |
   | send
   v
Wallet / RPC
   |
   | tx hash
   v
Database
   |
   | poll
   v
Blockchain
   |
   | receipt
   v
Reconciler
```

Details: [docs/reconciliation.md](docs/reconciliation.md).

## Persistence

SQLite via `better-sqlite3`. Wei, gas, and fee values are decimal text, not floating-point numbers. Nonces and chain ids are integers.

```text
transactions
  identity, nonce, call data, fees, current hash, status, timestamps,
  block, confirmations, receipt status, error

transaction_attempts
  every hash, nonce, fees, signed payload, attempt status

status_events
  every legal transition

nonce_state / nonce_reservations
  local nonce cursor and in-flight reservations
```

The signed payload is stored so recovery can rebroadcast the same hash. It is not a private key. Private keys are never inserted.

## Testing

TypeScript tests cover nonce allocation (including concurrency and restart), the state machine, retry and fee policy, persistence of large `bigint` values, the full submit/confirm/reconcile path, on-chain reverts, replacement, unknown nonce consumption, missing receipts, RPC failure, and crash recovery.

Foundry tests cover `MockTarget` (unit and fuzz) and `MockRevertingTarget` (unit and fuzz), plus an invariant that successful pings match the handler's call count.

Anvil tests deploy those contracts and run success, revert, and same-nonce replacement through `ViemEvmClient`.

## Local setup

Requires Node.js 22 or newer, npm, and [Foundry](https://book.getfoundry.sh/getting-started/installation).

```text
npm install
npm run build
npm test
npm run lint
npm run format:check
forge build
forge test
```

Anvil:

```text
anvil
```

Copy `.env.example` to `.env`. The sample private key is Foundry's published account #0 for local nodes. Do not use it anywhere value can be lost.

```text
npm run example:submit
npm run example:wait
npm run example:revert
```

`example:revert` needs `forge build` first so it can deploy `MockRevertingTarget`, unless `REVERTER_ADDRESS` is already set.

Deploy the mocks with Foundry:

```text
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $PRIVATE_KEY
```

## Configuration

| Variable                   | Role                                                                |
| -------------------------- | ------------------------------------------------------------------- |
| `RPC_URL`                  | HTTP endpoint. Required when a client is not injected.              |
| `CHAIN_ID`                 | Chain id checked against the node.                                  |
| `PRIVATE_KEY`              | Local signer. Optional when tests inject `EvmClient`. Never logged. |
| `DATABASE_PATH`            | SQLite file. Default `./data/transactions.sqlite`.                  |
| `POLL_INTERVAL_MS`         | Shared monitor interval.                                            |
| `CONFIRMATIONS`            | Inclusion depth required before `CONFIRMED`.                        |
| `REPLACEMENT_TIMEOUT_MS`   | How long a pending attempt waits before replacement.                |
| `MAX_RETRIES`              | Maximum broadcasts for one action, including the first.             |
| `REPLACEMENT_BUMP_PERCENT` | Integer percent applied to both EIP-1559 caps.                      |
| `MINIMUM_FEE_BUMP`         | Extra wei added on replacement, scaled by attempt number.           |

Optional caps: `MAX_FEE_PER_GAS_CAP`, `MAX_PRIORITY_FEE_PER_GAS_CAP`.

## Example

`examples/submit-transaction.ts` creates the manager, submits a zero-value self-transfer, prints the id and hash, waits for confirmation, reconciles, and prints the final status.

`examples/simulate-failure.ts` deploys `MockRevertingTarget`, shows simulation failure with no broadcast, then submits with `simulate: false` and an explicit gas limit so the reverted receipt is recorded and not retried.

## Failure scenarios

The suite exercises RPC refusal, a single retry of fee estimation, a refused broadcast of the same payload, simulation revert, insufficient funds, nonce conflict, stale local nonce state, a pending transaction, replacement, a reverted receipt, process restart after inclusion, restart after an ambiguous broadcast, unknown nonce consumption, and a missing receipt.

## Limitations

- This is a reference implementation, not an audited production system.
- Replacement fees follow the configured bump. They are not a promise that every EVM client will accept them. Geth-style nodes usually want at least a 10% increase on both EIP-1559 fields; set the percent for the network you run.
- The block scan used when a hash lookup misses only looks back 25 blocks.
- Cancellation stops local monitoring. It does not evict a transaction from the mempool.
- There is no multi-signer queue, no private transaction relay, and no L2-specific fee market beyond EIP-1559 fields.

## Future extensions

- A second persistence adapter behind the same repository interface.
- Operator tooling that resolves `RECONCILIATION_REQUIRED` rows whose nonce was consumed by an external transaction.
- Optional WebSocket new-heads to cut polling on chains that support it.
- Gas estimation that can still submit an expected revert without a caller-supplied `gasLimit`.

## Security rules in the code

The implementation follows these constraints:

- private keys and seed phrases are not logged or stored in SQLite
- wei, gas, and fees stay `bigint` end to end
- a reverted receipt is not retried
- a replacement reuses the nonce
- a hash is not a completed action
- nonce movement is not proof of our replacement
- uncertainty stays in `RECONCILIATION_REQUIRED` instead of being marked reconciled

## Public API

`src/index.ts` exports `createTransactionManager`, `createTransactionManagerFromEnv`, the status helpers, and the error types.

```ts
manager.getStatus(transactionId);
manager.waitForConfirmation(transactionId);
manager.reconcile(transactionId);
manager.cancelMonitoring(transactionId);
manager.recover();
```

`getAttempts` returns the hash history. `replace` forces a same-nonce bump before the timeout.
