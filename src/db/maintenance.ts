/**
 * Housekeeping for the tables that grow forever.
 *
 * Runs, run steps, decisions and events all accumulate one row per attempt,
 * per scheduler check, per log line. Nothing here is derived state — deleting
 * any of it is safe for the platform's behaviour — but it is history, so the
 * only responsible order is export first, clear second. Both live here.
 *
 * The one thing that is never deleted blindly is a run still marked `running`:
 * the scheduler lock points at it, and removing it under the scheduler's feet
 * would leave a lock referencing nothing.
 */
import { all, get, run } from './index.js';

export type Dataset = 'runs' | 'steps' | 'decisions' | 'events' | 'keywords' | 'sites';

export interface DataCounts {
  runs: number;
  steps: number;
  decisions: number;
  cycles: number;
  events: number;
  sharedImages: number;
  /** Oldest run still stored, for "you are keeping N months of this". */
  oldestRunAt: string | null;
}

const count = (sql: string): number => get<{ n: number }>(sql)?.n ?? 0;

export function dataCounts(): DataCounts {
  return {
    runs: count('SELECT COUNT(*) AS n FROM runs'),
    steps: count('SELECT COUNT(*) AS n FROM run_steps'),
    decisions: count('SELECT COUNT(*) AS n FROM decisions'),
    cycles: count('SELECT COUNT(DISTINCT cycle_id) AS n FROM decisions'),
    events: count('SELECT COUNT(*) AS n FROM events'),
    sharedImages: count('SELECT COUNT(*) AS n FROM keyword_images'),
    oldestRunAt:
      get<{ at: string | null }>('SELECT MIN(started_at) AS at FROM runs')?.at ?? null,
  };
}

/**
 * Delete history older than `days`, or everything when `days` is null.
 *
 * Returns the number of rows removed so the UI can say what happened rather
 * than claiming success over a no-op.
 */
export function clearHistory(what: 'runs' | 'decisions' | 'events', days: number | null): number {
  const cutoff = days === null ? null : `-${Math.max(0, Math.floor(days))} days`;

  if (what === 'runs') {
    // run_steps cascades from runs, so this takes the steps with it.
    return cutoff === null
      ? run("DELETE FROM runs WHERE status != 'running'").changes
      : run(
          "DELETE FROM runs WHERE status != 'running' AND started_at < datetime('now', ?)",
          cutoff,
        ).changes;
  }

  if (what === 'decisions') {
    return cutoff === null
      ? run('DELETE FROM decisions').changes
      : run("DELETE FROM decisions WHERE created_at < datetime('now', ?)", cutoff).changes;
  }

  return cutoff === null
    ? run('DELETE FROM events').changes
    : run("DELETE FROM events WHERE created_at < datetime('now', ?)", cutoff).changes;
}

/**
 * Forget every stored shared-image set, for every keyword.
 *
 * These are URLs on sites you own, not files, so this deletes no image. It
 * only means the next site to publish that keyword generates a fresh set
 * instead of copying the existing one.
 */
export const forgetAllSharedImages = (): number => run('DELETE FROM keyword_images').changes;

/** Reclaim the file space the deletes freed. */
export function compactDatabase(): void {
  // VACUUM cannot run inside a transaction; nothing here opens one.
  run('VACUUM');
}

export interface Export {
  filename: string;
  rows: string[][];
}

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/** A dataset as header row plus data rows, ready to be written as CSV. */
export function exportDataset(dataset: Dataset): Export {
  switch (dataset) {
    case 'runs': {
      const rows = all<Record<string, unknown>>(
        `SELECT r.id, r.started_at, r.finished_at, r.published_at, r.status,
                s.domain AS site, k.seed_keyword AS keyword,
                r.post_url, r.failed_step, r.error
           FROM runs r
           LEFT JOIN sites s ON s.id = r.site_id
           LEFT JOIN keywords k ON k.id = r.keyword_id
          ORDER BY r.id`,
      );
      return {
        filename: 'runs.csv',
        rows: [
          ['id', 'started_at', 'finished_at', 'published_at', 'status', 'site', 'keyword',
            'post_url', 'failed_step', 'error'],
          ...rows.map((r) => [
            text(r.id), text(r.started_at), text(r.finished_at), text(r.published_at),
            text(r.status), text(r.site), text(r.keyword), text(r.post_url),
            text(r.failed_step), text(r.error),
          ]),
        ],
      };
    }

    case 'steps': {
      // Deliberately without input_json / output_json: those are whole
      // articles and would turn a spreadsheet into a memory problem.
      const rows = all<Record<string, unknown>>(
        `SELECT id, run_id, step, status, attempt, started_at, duration_ms,
                endpoint, model, error
           FROM run_steps ORDER BY id`,
      );
      return {
        filename: 'run-steps.csv',
        rows: [
          ['id', 'run_id', 'step', 'status', 'attempt', 'started_at', 'duration_ms',
            'endpoint', 'model', 'error'],
          ...rows.map((r) => [
            text(r.id), text(r.run_id), text(r.step), text(r.status), text(r.attempt),
            text(r.started_at), text(r.duration_ms), text(r.endpoint), text(r.model),
            text(r.error),
          ]),
        ],
      };
    }

    case 'decisions': {
      const rows = all<Record<string, unknown>>(
        `SELECT id, cycle_id, created_at, subject_type, subject_label, decision, reason
           FROM decisions ORDER BY id`,
      );
      return {
        filename: 'decisions.csv',
        rows: [
          ['id', 'cycle_id', 'created_at', 'subject_type', 'subject', 'decision', 'reason'],
          ...rows.map((r) => [
            text(r.id), text(r.cycle_id), text(r.created_at), text(r.subject_type),
            text(r.subject_label), text(r.decision), text(r.reason),
          ]),
        ],
      };
    }

    case 'events': {
      const rows = all<Record<string, unknown>>(
        'SELECT id, created_at, level, source, message, detail FROM events ORDER BY id',
      );
      return {
        filename: 'events.csv',
        rows: [
          ['id', 'created_at', 'level', 'source', 'message', 'detail'],
          ...rows.map((r) => [
            text(r.id), text(r.created_at), text(r.level), text(r.source),
            text(r.message), text(r.detail),
          ]),
        ],
      };
    }

    case 'keywords': {
      // Shaped so the export can be re-imported: the same columns the CSV
      // importer reads, one per site, holding go / done / no.
      const domains = all<{ id: number; domain: string }>(
        'SELECT id, domain FROM sites ORDER BY id',
      );
      const links = new Map(
        all<{ keyword_id: number; site_id: number; status: string }>(
          'SELECT keyword_id, site_id, status FROM keyword_sites',
        ).map((l) => [`${l.keyword_id}:${l.site_id}`, l.status] as const),
      );
      const keywords = all<Record<string, unknown>>(
        `SELECT id, seed_keyword, spy_title, spy_description, annotation, status
           FROM keywords ORDER BY id`,
      );

      return {
        filename: 'keywords.csv',
        rows: [
          ['seed_keyword', 'spy_title', 'spy_description', 'annotation', 'status',
            ...domains.map((d) => d.domain)],
          ...keywords.map((k) => [
            text(k.seed_keyword), text(k.spy_title), text(k.spy_description),
            text(k.annotation), text(k.status),
            ...domains.map((d) => links.get(`${Number(k.id)}:${d.id}`) ?? ''),
          ]),
        ],
      };
    }

    case 'sites': {
      // No tokens. An export is a file that ends up in a downloads folder.
      const rows = all<Record<string, unknown>>(
        `SELECT name, domain, status, daily_target, interval_minutes,
                pin_username, project_id
           FROM sites ORDER BY id`,
      );
      return {
        filename: 'sites.csv',
        rows: [
          ['Website Name', 'Domain', 'status', 'daily_target', 'interval_minutes',
            'Pin username', 'Project ID'],
          ...rows.map((r) => [
            text(r.name), text(r.domain), text(r.status), text(r.daily_target),
            text(r.interval_minutes), text(r.pin_username), text(r.project_id),
          ]),
        ],
      };
    }
  }
}

/**
 * Write a consistent copy of the whole database to `path`.
 *
 * VACUUM INTO rather than copying the file: the database runs in WAL mode, so
 * the .db file on disk is missing every write still sitting in the -wal
 * sidecar. Copying it gives you a backup that is silently out of date, and the
 * failure mode is not noticing until you restore it.
 *
 * The result is safe to hand over. Site tokens and API keys inside it are
 * encrypted with ENCRYPTION_KEY, which lives in the data volume and not in
 * here, so this file alone does not carry the credentials.
 */
export function backupTo(path: string): void {
  // Parameters are not allowed in VACUUM INTO, so the path is quoted by
  // doubling single quotes — the caller supplies it, never a request.
  run(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
}
