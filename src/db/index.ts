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
 * Column additions for databases created before the column existed.
 *
 * schema.sql only ever runs CREATE TABLE IF NOT EXISTS, which is a no-op on a
 * table that is already there — so a new column has to be added explicitly.
 * Guarded by PRAGMA table_info rather than by catching an error, because
 * "duplicate column" and "database is locked" arrive as the same exception
 * type and swallowing the second one would hide a real failure.
 */
function migrate(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(keyword_sites)').all() as { name: string }[];

  if (columns.length > 0 && !columns.some((c) => c.name === 'share_images')) {
    // DEFAULT 1 fills existing rows as it goes, so no separate backfill.
    db.exec(
      'ALTER TABLE keyword_sites ADD COLUMN share_images INTEGER NOT NULL DEFAULT 1 ' +
        'CHECK (share_images IN (0, 1))',
    );
    log.info('Added keyword_sites.share_images — existing links default to sharing on');
  }
}

export function openDatabase(dbPath: string): Db {
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(readFileSync(schemaPath(), 'utf8'));
  migrate(db);

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
