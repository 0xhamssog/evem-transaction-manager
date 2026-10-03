# Architecture

This repository is a reference implementation of the service that sits between an execution layer and an EVM node. It does not contain a trading strategy. Callers submit one logical action. The manager tracks that action until the chain outcome is verified.

```text
Trading strategy / execution service
        |
        v
TransactionManager
        |
        +-- NonceManager and NonceLock
        +-- SqliteTransactionRepository
        +-- TransactionSubmitter
        +-- TransactionMonitor
        +-- TransactionReconciler
        |
        v
EvmClient
        |
        +-- ViemEvmClient in production
        +-- test double in unit tests
        |
        v
EVM RPC
```

## Boundaries

Domain types in `src/domain` do not import viem or SQLite. Persistence is behind `TransactionRepository` and `NonceRepository`. All JSON-RPC calls go through `EvmClient` in `src/clients/evm-client.ts`.

`createTransactionManager` takes an `EvmClient` and a database. Tests inject both. `createTransactionManagerFromEnv` builds a viem client from `RPC_URL`, `CHAIN_ID`, and `PRIVATE_KEY`. The key is held by the signer only. It is not written to SQLite and the logger redacts fields whose names look like secrets.

## One action, one record

`submit` creates one `TransactionRecord`. Replacements add rows to `transaction_attempts` and update `currentHash`. They do not create a second logical record and they do not allocate a new nonce.

A returned hash means the signed payload was broadcast, or at least persisted before broadcast. `status` becomes `CONFIRMED` only after a successful receipt reaches `CONFIRMATIONS`. `RECONCILED` means a later read of the chain agreed with that record. A reverted call can be reconciled too. `receiptStatus` is what says whether the call succeeded.

## Crash window

The submitter signs the transaction, writes the hash and raw signed payload, and only then calls `eth_sendRawTransaction`. `recover` loads every non-terminal row. A `SIGNED` attempt that is not on chain is broadcast again. The same payload produces the same hash, so this is not a second nonce.

## Monitoring

`TransactionMonitor` runs one timer. Each tick loads pending rows and checks them. `cancelMonitoring` removes one id from that loop. It does not remove the transaction from the mempool.

Receipt indexing can lag nonce updates by a moment. Before the manager treats a moved nonce as unknown, it waits briefly and scans the last 25 blocks for that sender and nonce.
