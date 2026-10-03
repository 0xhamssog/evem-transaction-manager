-- Wei, gas, and fee values are TEXT so SQLite does not coerce them through IEEE-754 numbers.
-- Private keys are never stored. signed_payload is the already-signed raw transaction.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  account TEXT NOT NULL,
  nonce INTEGER,
  to_address TEXT NOT NULL,
  data TEXT NOT NULL,
  value TEXT NOT NULL,
  gas_limit TEXT,
  max_fee_per_gas TEXT,
  max_priority_fee_per_gas TEXT,
  current_hash TEXT,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  confirmed_at TEXT,
  reconciled_at TEXT,
  last_checked_at TEXT,
  block_number TEXT,
  block_hash TEXT,
  transaction_index INTEGER,
  confirmations INTEGER NOT NULL DEFAULT 0,
  receipt_status TEXT,
  log_count INTEGER,
  error_code TEXT,
  error_message TEXT
);

CREATE TABLE IF NOT EXISTS transaction_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  attempt_number INTEGER NOT NULL,
  submitted_at TEXT,
  signed_at TEXT NOT NULL,
  max_fee_per_gas TEXT NOT NULL,
  max_priority_fee_per_gas TEXT NOT NULL,
  gas_limit TEXT NOT NULL,
  signed_payload TEXT NOT NULL,
  status TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

CREATE TABLE IF NOT EXISTS status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (transaction_id) REFERENCES transactions(id)
);

CREATE TABLE IF NOT EXISTS nonce_state (
  chain_id INTEGER NOT NULL,
  account TEXT NOT NULL,
  next_nonce INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, account)
);

CREATE TABLE IF NOT EXISTS nonce_reservations (
  chain_id INTEGER NOT NULL,
  account TEXT NOT NULL,
  nonce INTEGER NOT NULL,
  status TEXT NOT NULL,
  transaction_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (chain_id, account, nonce)
);

CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_account_nonce ON transactions(chain_id, account, nonce);
CREATE INDEX IF NOT EXISTS idx_attempts_hash ON transaction_attempts(hash);
CREATE INDEX IF NOT EXISTS idx_attempts_transaction ON transaction_attempts(transaction_id, attempt_number);
