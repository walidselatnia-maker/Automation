import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../lib/logger.js';

const log = createLogger('db');

export type Db = DatabaseSync;

let instance: Db | null = null;

function schemaPath(): string {
  // Resolves correctly from both src (tsx) and dist (compiled).
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'schema.sql');
}

/**
 * Columns added to a table that already exists.
 *
 * schema.sql is all CREATE TABLE IF NOT EXISTS, which is a no-op on a table
 * that is already there — so a column added to one of those definitions never
 * reaches a database that has been deployed before. The symptom is not a
 * migration error, it is a query failing at runtime on a column that the code
 * is certain exists.
 *
 * Adding a column is the one schema change that is safe to apply
 * automatically: it cannot lose data and it cannot fail on a second run.
 * Anything larger belongs in a considered migration, not here.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  {
    table: 'keyword_sites',
    column: 'share_images',
    definition: "INTEGER NOT NULL DEFAULT 1 CHECK (share_images IN (0, 1))",
  },
];

function addMissingColumns(db: Db): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];

    // No rows means the table does not exist yet, in which case schema.sql has
    // just created it with the column already present.
    if (columns.length === 0) continue;
    if (columns.some((c) => c.name === column)) continue;

    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    log.info(`added ${table}.${column} to an existing database`);
  }
}

export function openDatabase(dbPath: string): Db {
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(readFileSync(schemaPath(), 'utf8'));
  addMissingColumns(db);

  log.info(`Database ready at ${dbPath}`);
  instance = db;
  return db;
}

export function getDb(): Db {
  if (!instance) throw new Error('Database not opened. Call openDatabase() first.');
  return instance;
}

export function setDb(db: Db): void {
  instance = db;
}

export function closeDatabase(): void {
  instance?.close();
  instance = null;
}

/**
 * Run `fn` inside a transaction. node:sqlite has no transaction helper, so
 * this wraps the statements directly.
 */
export function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback of an already-failed transaction */
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------
 * Thin typed helpers over node:sqlite.
 * ---------------------------------------------------------------------- */

type Param = string | number | bigint | null | Uint8Array;

export function all<T>(sql: string, ...params: Param[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const result = getDb().prepare(sql).run(...params);
  return {
    changes: Number(result.changes),
    lastInsertRowid: Number(result.lastInsertRowid),
  };
}

/** SQLite has no boolean type; normalise the 0/1 integers it returns. */
export const toBool = (value: unknown): boolean => value === 1 || value === true;
export const fromBool = (value: boolean): number => (value ? 1 : 0);
