import { createLogger } from '../lib/logger.js';
import type { Db } from './index.js';

const log = createLogger('migrate');

/**
 * Versioned schema changes, applied once each and recorded.
 *
 * schema.sql is all CREATE TABLE IF NOT EXISTS, which is a no-op against a
 * table that already exists — so a column added to one of those definitions
 * never reaches a database that has been deployed before. That was survivable
 * while nothing was live. It is not survivable now, and it had already broken:
 * a partial index added to schema.sql referenced a column that only existed on
 * fresh databases, so booting the new code against the deployed one failed
 * outright with "no such column: hold".
 *
 * The rules here:
 *
 *  - Every migration is idempotent on its own, so a half-applied state cannot
 *    wedge the next boot.
 *  - Each runs in a transaction and is recorded only if it commits.
 *  - Order is the array order, and it never changes. Appending is the only
 *    permitted edit to this list.
 *  - Nothing here drops a column, drops a table, or rewrites data. A migration
 *    that can lose something does not belong in a runner that executes
 *    unattended at boot; those go in a script somebody runs on purpose.
 */

export interface Migration {
  /** Stable identifier. Never renamed once deployed. */
  id: string;
  description: string;
  up(db: Db): void;
}

/* -- Idempotent helpers --------------------------------------------------- */

function hasTable(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present: number } | undefined;
  return row !== undefined;
}

function columns(db: Db, table: string): string[] {
  if (!hasTable(db, table)) return [];
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Add a column unless it is already there.
 *
 * The one schema change that is safe to apply unattended: it cannot lose data
 * and it cannot fail on a second run.
 *
 * CHECK constraints from schema.sql are deliberately not repeated in the
 * definitions passed here. SQLite cannot add a CHECK to an existing table
 * without rewriting the whole table, and rewriting a live table to gain a
 * constraint the application already enforces is a bad trade. A new database
 * gets the constraint from schema.sql; an older one gets the column and the
 * same behaviour.
 */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  // No table means schema.sql has not created it yet, or this deployment never
  // had it. Either way there is nothing to alter and nothing to fix.
  if (!hasTable(db, table)) return;
  if (columns(db, table).includes(column)) return;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info(`added ${table}.${column}`);
}

/* -- The list ------------------------------------------------------------- */

export const MIGRATIONS: Migration[] = [
  {
    id: '001-share-images',
    description: 'Per keyword-and-site control over reusing article images',
    up(db) {
      addColumn(db, 'keyword_sites', 'share_images', 'INTEGER NOT NULL DEFAULT 1');
    },
  },

  {
    id: '002-site-pause-and-approval',
    description: 'A pause with a reason and an expiry, and per-site approval',
    up(db) {
      addColumn(db, 'sites', 'paused_reason', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'paused_until', 'TEXT');
      addColumn(db, 'sites', 'auto_publish', 'INTEGER NOT NULL DEFAULT 1');
    },
  },

  {
    id: '003-run-mode-holds-retries',
    description: 'Dry runs, approval holds, automatic retries, and the published title',
    up(db) {
      addColumn(db, 'runs', 'mode', "TEXT NOT NULL DEFAULT 'live'");
      addColumn(db, 'runs', 'hold', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'runs', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'runs', 'retry_after', 'TEXT');
      addColumn(db, 'runs', 'title', "TEXT NOT NULL DEFAULT ''");
    },
  },

  {
    id: '004-run-indexes',
    description: 'Indexes over the columns 003 added',
    up(db) {
      // Separate from 003 on purpose. These are partial indexes over `hold`
      // and `retry_after`, so they cannot be created until those columns
      // exist. Having them in schema.sql — which runs before any column is
      // added — is precisely what broke booting against a deployed database.
      if (!columns(db, 'runs').includes('hold')) return;

      db.exec("CREATE INDEX IF NOT EXISTS idx_runs_hold ON runs (hold) WHERE hold != ''");
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_runs_retry ON runs (retry_after) ' +
          'WHERE retry_after IS NOT NULL',
      );
    },
  },

  {
    id: '005-step-usage',
    description: 'What each step cost, in tokens and images',
    up(db) {
      addColumn(db, 'run_steps', 'tokens_in', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'run_steps', 'tokens_out', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'run_steps', 'images', 'INTEGER NOT NULL DEFAULT 0');
    },
  },

  {
    id: '006-prompt-history-models-notices',
    description: 'Prompt versions, per-prompt models, notification de-duplication',
    up(db) {
      // Also in schema.sql, which is what creates them on a fresh database.
      // Repeated here so an existing one gets them without depending on the
      // order the two files happen to run in.
      db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL,
          body       TEXT    NOT NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_versions ON prompt_versions (name, id DESC);

        CREATE TABLE IF NOT EXISTS model_overrides (
          prompt     TEXT PRIMARY KEY,
          model      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS notice_state (
          kind       TEXT PRIMARY KEY,
          state      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },

  {
    id: '007-buffer-account-rotation',
    description: 'Per-site Buffer accounts, tried in order when a queue fills',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS buffer_accounts (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id          INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          label            TEXT    NOT NULL DEFAULT '',
          token_encrypted  TEXT    NOT NULL DEFAULT '',
          position         INTEGER NOT NULL DEFAULT 1,
          enabled          INTEGER NOT NULL DEFAULT 1,
          full_until       TEXT,
          last_used_at     TEXT,
          last_error       TEXT,
          created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_buffer_accounts_site ON buffer_accounts (site_id, position);
      `);

      // Every site that already had a token keeps posting through it, as
      // account one. Nothing to re-enter, and a site with one account behaves
      // exactly as it did before rotation existed.
      db.exec(`
        INSERT INTO buffer_accounts (site_id, label, token_encrypted, position)
        SELECT id, 'Account 1', buffer_token_encrypted, 1
          FROM sites
         WHERE buffer_token_encrypted <> ''
           AND id NOT IN (SELECT site_id FROM buffer_accounts);
      `);
    },
  },
];

/* -- The runner ----------------------------------------------------------- */

function ensureLedger(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function appliedMigrations(db: Db): string[] {
  ensureLedger(db);
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[];
  return rows.map((r) => r.id);
}

/** Migrations that would run against this database, in order. */
export function pendingMigrations(db: Db): Migration[] {
  const applied = new Set(appliedMigrations(db));
  return MIGRATIONS.filter((m) => !applied.has(m.id));
}

export interface MigrationReport {
  applied: string[];
  alreadyApplied: number;
}

/**
 * Bring the database up to date.
 *
 * Each migration is its own transaction: one that throws rolls back and is not
 * recorded, so the next boot retries exactly that one rather than skipping it
 * or re-running the ones that already succeeded. The error is rethrown — a
 * process that carries on against a half-migrated schema fails later, somewhere
 * less obvious, with a message about a missing column.
 */
export function runMigrations(db: Db): MigrationReport {
  const applied = new Set(appliedMigrations(db));
  const done: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* rolling back a transaction that already failed */
      }
      log.error(`migration ${migration.id} failed: ${String(err)}`);
      throw err;
    }

    log.info(`applied ${migration.id} — ${migration.description}`);
    done.push(migration.id);
  }

  return { applied: done, alreadyApplied: applied.size };
}
