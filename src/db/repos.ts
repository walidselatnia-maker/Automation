import { all, fromBool, get, run, toBool, transaction } from './index.js';
import type { Decision, KeywordView, LinkView, SiteView } from '../core/types.js';
import { decrypt, encrypt } from '../lib/crypto.js';

/* =========================================================================
 * Sites
 * ====================================================================== */

export interface SiteRow {
  id: number;
  name: string;
  domain: string;
  status: 'active' | 'paused';
  pin_username: string;
  project_id: string;
  api_token_encrypted: string;
  buffer_token_encrypted: string;
  daily_target: number;
  interval_minutes: number;
  created_at: string;
  updated_at: string;
}

/** A site's credentials, decrypted for use. Never logged, never rendered. */
export interface SiteSecrets {
  apiToken: string;
  bufferToken: string;
}

export function siteSecrets(site: SiteRow, key: Buffer): SiteSecrets {
  const safely = (value: string): string => {
    try {
      return decrypt(value, key);
    } catch {
      // A credential encrypted under a different key should surface as a
      // clear auth failure at call time, not crash page rendering.
      return '';
    }
  };
  return {
    apiToken: safely(site.api_token_encrypted),
    bufferToken: safely(site.buffer_token_encrypted),
  };
}

/** True when a secret column holds something, without decrypting it. */
export const hasSecret = (value: string): boolean => value.trim() !== '';

export const listSites = (): SiteRow[] =>
  all<SiteRow>('SELECT * FROM sites ORDER BY name');

export const getSite = (id: number): SiteRow | undefined =>
  get<SiteRow>('SELECT * FROM sites WHERE id = ?', id);

export const getSiteByDomain = (domain: string): SiteRow | undefined =>
  get<SiteRow>('SELECT * FROM sites WHERE domain = ?', domain);

export interface SiteInput {
  name: string;
  domain: string;
  status: 'active' | 'paused';
  pin_username: string;
  project_id: string;
  daily_target: number;
  interval_minutes: number;
  /** Plaintext. Blank on update means "keep the stored one". */
  apiToken?: string;
  bufferToken?: string;
}

/**
 * Create or update a site.
 *
 * `id` identifies the row when supplied, so the domain can be renamed. Without
 * it the domain is the key, which is what CSV import needs.
 */
export function upsertSite(input: SiteInput, key: Buffer, id?: number): number {
  const existing = id ? getSite(id) : getSiteByDomain(input.domain);

  const encryptOrKeep = (plain: string | undefined, stored: string): string =>
    plain && plain.trim() !== '' ? encrypt(plain.trim(), key) : stored;

  if (existing) {
    run(
      `UPDATE sites SET name = ?, domain = ?, status = ?, pin_username = ?,
         project_id = ?, daily_target = ?, interval_minutes = ?,
         api_token_encrypted = ?, buffer_token_encrypted = ?,
         updated_at = datetime('now')
       WHERE id = ?`,
      input.name,
      input.domain,
      input.status,
      input.pin_username,
      input.project_id,
      input.daily_target,
      input.interval_minutes,
      encryptOrKeep(input.apiToken, existing.api_token_encrypted),
      encryptOrKeep(input.bufferToken, existing.buffer_token_encrypted),
      existing.id,
    );
    return existing.id;
  }

  return run(
    `INSERT INTO sites (name, domain, status, pin_username, project_id,
       daily_target, interval_minutes, api_token_encrypted, buffer_token_encrypted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.domain,
    input.status,
    input.pin_username,
    input.project_id,
    input.daily_target,
    input.interval_minutes,
    encryptOrKeep(input.apiToken, ''),
    encryptOrKeep(input.bufferToken, ''),
  ).lastInsertRowid;
}

export const deleteSite = (id: number): void => {
  run('DELETE FROM sites WHERE id = ?', id);
};

/**
 * Build the selector's view of every site.
 *
 * publishedToday and lastPublishAt are computed here rather than stored.
 * That is the structural reason the counter bugs of the previous system
 * (string arithmetic, lost updates, midnight reset drift) cannot recur.
 * `dayKey` is the local calendar day, supplied by the caller.
 */
export function loadSiteViews(dayKey: string, timezone: string): SiteView[] {
  interface Row extends SiteRow {
    published_today: number;
    last_publish_at: string | null;
  }

  const rows = all<Row>(
    `SELECT s.*,
            (SELECT COUNT(*) FROM runs r
              WHERE r.site_id = s.id
                AND r.status = 'published'
                AND date(r.published_at, ?) = ?)          AS published_today,
            (SELECT MAX(r2.published_at) FROM runs r2
              WHERE r2.site_id = s.id
                AND r2.status = 'published')              AS last_publish_at
       FROM sites s
      ORDER BY s.name`,
    tzModifier(timezone),
    dayKey,
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    domain: r.domain,
    status: r.status,
    dailyTarget: r.daily_target,
    intervalMinutes: r.interval_minutes,
    publishedToday: Number(r.published_today ?? 0),
    lastPublishAt: r.last_publish_at,
  }));
}

/**
 * SQLite cannot resolve IANA timezones, so we pass a fixed offset modifier
 * computed in JS for the current instant. This is accurate for deciding
 * which calendar day a timestamp belongs to.
 */
export function tzModifier(timezone: string, at: Date = new Date()): string {
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(at.toLocaleString('en-US', { timeZone: timezone }));
  const minutes = Math.round((local.getTime() - utc.getTime()) / 60_000);
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/* =========================================================================
 * Keywords and the keyword x site matrix
 * ====================================================================== */

export interface KeywordRow {
  id: number;
  seed_keyword: string;
  spy_title: string;
  spy_description: string;
  spy_image_url: string;
  spy_article_url: string;
  spy_pin_image: string;
  annotation: string;
  status: 'go' | 'done' | 'no';
  created_at: string;
  updated_at: string;
}

export const listKeywords = (limit = 500, offset = 0): KeywordRow[] =>
  all<KeywordRow>('SELECT * FROM keywords ORDER BY id LIMIT ? OFFSET ?', limit, offset);

export const countKeywords = (): number =>
  get<{ n: number }>('SELECT COUNT(*) AS n FROM keywords')?.n ?? 0;

export const getKeyword = (id: number): KeywordRow | undefined =>
  get<KeywordRow>('SELECT * FROM keywords WHERE id = ?', id);

export function insertKeyword(k: Partial<KeywordRow> & { seed_keyword: string }): number {
  return run(
    `INSERT INTO keywords (seed_keyword, spy_title, spy_description, spy_image_url,
       spy_article_url, spy_pin_image, annotation, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    k.seed_keyword,
    k.spy_title ?? '',
    k.spy_description ?? '',
    k.spy_image_url ?? '',
    k.spy_article_url ?? '',
    k.spy_pin_image ?? '',
    k.annotation ?? '',
    k.status ?? 'go',
  ).lastInsertRowid;
}

export const setKeywordStatus = (id: number, status: 'go' | 'done' | 'no'): void => {
  run("UPDATE keywords SET status = ?, updated_at = datetime('now') WHERE id = ?", status, id);
};

export const deleteKeyword = (id: number): void => {
  run('DELETE FROM keywords WHERE id = ?', id);
};

export const loadKeywordViews = (): KeywordView[] =>
  all<KeywordRow>('SELECT * FROM keywords ORDER BY id').map((r) => ({
    id: r.id,
    seedKeyword: r.seed_keyword,
    spyTitle: r.spy_title,
    status: r.status,
  }));

export const loadLinkViews = (): LinkView[] =>
  all<{ keyword_id: number; site_id: number; status: 'go' | 'done' | 'no' }>(
    'SELECT keyword_id, site_id, status FROM keyword_sites',
  ).map((r) => ({ keywordId: r.keyword_id, siteId: r.site_id, status: r.status }));

export const setLink = (
  keywordId: number,
  siteId: number,
  status: 'go' | 'done' | 'no',
): void => {
  run(
    `INSERT INTO keyword_sites (keyword_id, site_id, status)
     VALUES (?, ?, ?)
     ON CONFLICT (keyword_id, site_id)
       DO UPDATE SET status = excluded.status, updated_at = datetime('now')`,
    keywordId,
    siteId,
    status,
  );
};

export const getLinksForKeyword = (keywordId: number) =>
  all<{ site_id: number; status: string; domain: string }>(
    `SELECT ks.site_id, ks.status, s.domain
       FROM keyword_sites ks JOIN sites s ON s.id = ks.site_id
      WHERE ks.keyword_id = ? ORDER BY s.name`,
    keywordId,
  );

/* =========================================================================
 * Runs and steps
 * ====================================================================== */

export interface RunRow {
  id: number;
  keyword_id: number | null;
  site_id: number | null;
  status: 'running' | 'published' | 'failed' | 'cancelled';
  started_at: string;
  finished_at: string | null;
  published_at: string | null;
  post_id: string | null;
  post_url: string | null;
  error: string | null;
  failed_step: string | null;
}

export const createRun = (keywordId: number, siteId: number): number =>
  run('INSERT INTO runs (keyword_id, site_id, status) VALUES (?, ?, ?)', keywordId, siteId, 'running')
    .lastInsertRowid;

export const getRun = (id: number): RunRow | undefined =>
  get<RunRow>('SELECT * FROM runs WHERE id = ?', id);

export const markRunPublished = (id: number, postId: string, postUrl: string): void => {
  run(
    `UPDATE runs SET status = 'published', published_at = datetime('now'),
       finished_at = datetime('now'), post_id = ?, post_url = ?, error = NULL, failed_step = NULL
     WHERE id = ?`,
    postId,
    postUrl,
    id,
  );
};

export const markRunFailed = (id: number, error: string, failedStep: string): void => {
  run(
    `UPDATE runs SET status = 'failed', finished_at = datetime('now'),
       error = ?, failed_step = ? WHERE id = ?`,
    error,
    failedStep,
    id,
  );
};

export interface RunListRow extends RunRow {
  site_domain: string | null;
  seed_keyword: string | null;
}

export const listRuns = (limit = 50, offset = 0): RunListRow[] =>
  all<RunListRow>(
    `SELECT r.*, s.domain AS site_domain, k.seed_keyword
       FROM runs r
       LEFT JOIN sites s ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
      ORDER BY r.started_at DESC, r.id DESC
      LIMIT ? OFFSET ?`,
    limit,
    offset,
  );

export const countRuns = (): number =>
  get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')?.n ?? 0;

export interface StepRow {
  id: number;
  run_id: number;
  step: string;
  status: 'running' | 'ok' | 'failed' | 'skipped';
  attempt: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  endpoint: string | null;
  model: string | null;
  input_json: string | null;
  output_json: string | null;
  error: string | null;
}

export const listSteps = (runId: number): StepRow[] =>
  all<StepRow>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY id', runId);

export const getCompletedStep = (runId: number, step: string): StepRow | undefined =>
  get<StepRow>(
    "SELECT * FROM run_steps WHERE run_id = ? AND step = ? AND status = 'ok'",
    runId,
    step,
  );

export function beginStep(runId: number, step: string): void {
  run(
    `INSERT INTO run_steps (run_id, step, status, started_at)
     VALUES (?, ?, 'running', datetime('now'))
     ON CONFLICT (run_id, step) DO UPDATE SET
       status = 'running', started_at = datetime('now'),
       attempt = run_steps.attempt + 1, error = NULL`,
    runId,
    step,
  );
}

export function finishStep(
  runId: number,
  step: string,
  outcome: {
    status: 'ok' | 'failed';
    output?: unknown;
    error?: string;
    durationMs?: number;
    endpoint?: string;
    model?: string;
  },
): void {
  run(
    `UPDATE run_steps SET status = ?, finished_at = datetime('now'), duration_ms = ?,
       endpoint = ?, model = ?, output_json = ?, error = ?
     WHERE run_id = ? AND step = ?`,
    outcome.status,
    outcome.durationMs ?? null,
    outcome.endpoint ?? null,
    outcome.model ?? null,
    outcome.output === undefined ? null : safeStringify(outcome.output),
    outcome.error ?? null,
    runId,
    step,
  );
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    // Keep a very large LLM payload from bloating the database.
    return json && json.length > 400_000 ? json.slice(0, 400_000) + '…[truncated]' : (json ?? 'null');
  } catch {
    return JSON.stringify({ unserialisable: String(value) });
  }
}

/* =========================================================================
 * Decisions
 * ====================================================================== */

export function recordDecisions(cycleId: string, decisions: Decision[]): void {
  transaction(() => {
    for (const d of decisions) {
      run(
        `INSERT INTO decisions (cycle_id, subject_type, subject_id, subject_label, decision, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        cycleId,
        d.subjectType,
        d.subjectId,
        d.subjectLabel,
        d.decision,
        d.reason,
      );
    }
  });
}

export interface DecisionRow {
  id: number;
  cycle_id: string;
  created_at: string;
  subject_type: string;
  subject_id: number | null;
  subject_label: string;
  decision: string;
  reason: string;
}

export const listRecentCycles = (limit = 20): { cycle_id: string; created_at: string; n: number }[] =>
  all(
    `SELECT cycle_id, MIN(created_at) AS created_at, COUNT(*) AS n
       FROM decisions GROUP BY cycle_id ORDER BY created_at DESC LIMIT ?`,
    limit,
  );

export const listDecisions = (cycleId: string): DecisionRow[] =>
  all<DecisionRow>('SELECT * FROM decisions WHERE cycle_id = ? ORDER BY id', cycleId);

export const pruneDecisions = (keepDays: number): number =>
  run("DELETE FROM decisions WHERE created_at < datetime('now', ?)", `-${keepDays} days`).changes;

/* =========================================================================
 * Settings (encrypted at rest when marked secret)
 * ====================================================================== */

export interface SettingRow {
  key: string;
  value: string;
  is_secret: number;
  updated_at: string;
}

export function getSetting(key: string, encryptionKey: Buffer): string {
  const row = get<SettingRow>('SELECT * FROM settings WHERE key = ?', key);
  if (!row) return '';
  return toBool(row.is_secret) ? decrypt(row.value, encryptionKey) : row.value;
}

export function setSetting(
  key: string,
  value: string,
  isSecret: boolean,
  encryptionKey: Buffer,
): void {
  const stored = isSecret ? encrypt(value, encryptionKey) : value;
  run(
    `INSERT INTO settings (key, value, is_secret) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       is_secret = excluded.is_secret, updated_at = datetime('now')`,
    key,
    stored,
    fromBool(isSecret),
  );
}

export const listSettingKeys = (): SettingRow[] =>
  all<SettingRow>('SELECT * FROM settings ORDER BY key');

/* =========================================================================
 * Events
 * ====================================================================== */

export const insertEvent = (
  level: string,
  source: string,
  message: string,
  detail?: string,
): void => {
  run(
    'INSERT INTO events (level, source, message, detail) VALUES (?, ?, ?, ?)',
    level,
    source,
    message,
    detail ?? null,
  );
};

export interface EventRow {
  id: number;
  created_at: string;
  level: string;
  source: string;
  message: string;
  detail: string | null;
}

export const listEvents = (limit = 200, level?: string): EventRow[] =>
  level
    ? all<EventRow>(
        'SELECT * FROM events WHERE level = ? ORDER BY id DESC LIMIT ?',
        level,
        limit,
      )
    : all<EventRow>('SELECT * FROM events ORDER BY id DESC LIMIT ?', limit);

export const pruneEvents = (keepDays: number): number =>
  run("DELETE FROM events WHERE created_at < datetime('now', ?)", `-${keepDays} days`).changes;
