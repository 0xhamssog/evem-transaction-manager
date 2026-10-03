import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';

const MIGRATION_ID = '001_init';

export type AppDatabase = SqliteDatabase;

/** Opens SQLite and applies pending migrations. `:memory:` is supported for tests. */
export function openDatabase(path: string): AppDatabase {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const database = new BetterSqlite3(path);
  database.pragma('foreign_keys = ON');
  if (path !== ':memory:') {
    database.pragma('journal_mode = WAL');
  }
  migrate(database);
  return database;
}

export function migrate(database: AppDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const existing = database
    .prepare('SELECT id FROM schema_migrations WHERE id = ?')
    .get(MIGRATION_ID) as { id: string } | undefined;
  if (existing) return;
  database.exec(loadMigrationSql());
  database
    .prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)')
    .run(MIGRATION_ID, new Date().toISOString());
}

function loadMigrationSql(): string {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), 'migrations', '001_init.sql'),
    join(process.cwd(), 'src', 'persistence', 'migrations', '001_init.sql'),
    join(process.cwd(), 'dist', 'src', 'persistence', 'migrations', '001_init.sql'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error(`migration file not found. Looked in: ${candidates.join(', ')}`);
}
