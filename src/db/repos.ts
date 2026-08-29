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
  /** Why it is paused, written down so it is still knowable next week. */
  paused_reason: string;
  /** When the pause lifts by itself. Null means "until someone says". */
  paused_until: string | null;
  /** 0 holds every article for a person to read before it is published. */
  auto_publish: number;
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
  /** Left undefined, the stored value is kept — these are not on every form. */
  paused_reason?: string;
  paused_until?: string | null;
  auto_publish?: boolean;
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
         paused_reason = ?, paused_until = ?, auto_publish = ?,
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
      // An active site holds no pause reason. Leaving one behind means the
      // Sites page explains a pause that is not in effect.
      input.status === 'active' ? '' : (input.paused_reason ?? existing.paused_reason),
      input.status === 'active' ? null : (input.paused_until ?? existing.paused_until),
      input.auto_publish === undefined
        ? existing.auto_publish
        : fromBool(input.auto_publish),
      encryptOrKeep(input.apiToken, existing.api_token_encrypted),
      encryptOrKeep(input.bufferToken, existing.buffer_token_encrypted),
      existing.id,
    );
    return existing.id;
  }

  return run(
    `INSERT INTO sites (name, domain, status, pin_username, project_id,
       daily_target, interval_minutes, paused_reason, paused_until, auto_publish,
       api_token_encrypted, buffer_token_encrypted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.domain,
    input.status,
    input.pin_username,
    input.project_id,
    input.daily_target,
    input.interval_minutes,
    input.status === 'active' ? '' : (input.paused_reason ?? ''),
    input.status === 'active' ? null : (input.paused_until ?? null),
    fromBool(input.auto_publish ?? true),
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
    last_attempt_at: string | null;
  }

  const rows = all<Row>(
    `SELECT s.*,
            (SELECT COUNT(*) FROM runs r
              WHERE r.site_id = s.id
                AND r.status = 'published'
                AND date(r.published_at, ?) = ?)          AS published_today,
            (SELECT MAX(r2.published_at) FROM runs r2
              WHERE r2.site_id = s.id
                AND r2.status = 'published')              AS last_publish_at,
            -- Every run, not just the successful ones: this is what makes the
            -- sites take turns even when one of them keeps failing.
            (SELECT MAX(r3.started_at) FROM runs r3
              WHERE r3.site_id = s.id)                    AS last_attempt_at
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
    lastAttemptAt: r.last_attempt_at,
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

/**
 * The grid the keywords page renders: status and image sharing for every pair.
 *
 * Separate from loadLinkViews on purpose. That one feeds selectTask, whose
 * input type stays as small as the decision it makes — sharing has no bearing
 * on whether a keyword may run.
 */
export const loadLinkGrid = (): {
  keywordId: number;
  siteId: number;
  status: 'go' | 'done' | 'no';
  shareImages: boolean;
}[] =>
  all<{ keyword_id: number; site_id: number; status: 'go' | 'done' | 'no'; share_images: number }>(
    'SELECT keyword_id, site_id, status, share_images FROM keyword_sites',
  ).map((r) => ({
    keywordId: r.keyword_id,
    siteId: r.site_id,
    status: r.status,
    shareImages: r.share_images === 1,
  }));

export const getLinkShare = (keywordId: number, siteId: number): boolean =>
  get<{ share_images: number }>(
    'SELECT share_images FROM keyword_sites WHERE keyword_id = ? AND site_id = ?',
    keywordId,
    siteId,
  )?.share_images === 1;

export const setLinkShareImages = (keywordId: number, siteId: number, share: boolean): void => {
  run(
    `INSERT INTO keyword_sites (keyword_id, site_id, status, share_images)
     VALUES (?, ?, 'no', ?)
     ON CONFLICT (keyword_id, site_id)
       DO UPDATE SET share_images = excluded.share_images, updated_at = datetime('now')`,
    keywordId,
    siteId,
    share ? 1 : 0,
  );
};

/** The "share all" control: one keyword, every site it is linked to. */
export const setKeywordShareImages = (keywordId: number, share: boolean): void => {
  run(
    `UPDATE keyword_sites SET share_images = ?, updated_at = datetime('now')
      WHERE keyword_id = ?`,
    share ? 1 : 0,
    keywordId,
  );
};

/* =========================================================================
 * Shared article images
 *
 * One row per keyword, holding the public URL of each of the four article
 * images. The first site to publish a keyword writes it; every later site
 * reads it and copies the files into its own media library.
 * ====================================================================== */

export interface SharedImageUrls {
  feature: string;
  topShot: string;
  textureMacro: string;
  beforeAfter: string;
}

export const getSharedImages = (keywordId: number): SharedImageUrls | undefined => {
  const row = get<{
    feature_url: string;
    top_shot_url: string;
    texture_macro_url: string;
    before_after_url: string;
  }>(
    `SELECT feature_url, top_shot_url, texture_macro_url, before_after_url
       FROM keyword_images WHERE keyword_id = ?`,
    keywordId,
  );

  return row
    ? {
        feature: row.feature_url,
        topShot: row.top_shot_url,
        textureMacro: row.texture_macro_url,
        beforeAfter: row.before_after_url,
      }
    : undefined;
};

export const saveSharedImages = (
  keywordId: number,
  sourceSiteId: number,
  urls: SharedImageUrls,
): void => {
  run(
    `INSERT INTO keyword_images
       (keyword_id, feature_url, top_shot_url, texture_macro_url, before_after_url, source_site_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (keyword_id) DO UPDATE SET
       feature_url       = excluded.feature_url,
       top_shot_url      = excluded.top_shot_url,
       texture_macro_url = excluded.texture_macro_url,
       before_after_url  = excluded.before_after_url,
       source_site_id    = excluded.source_site_id,
       created_at        = datetime('now')`,
    keywordId,
    urls.feature,
    urls.topShot,
    urls.textureMacro,
    urls.beforeAfter,
    sourceSiteId,
  );
};

export const clearSharedImages = (keywordId: number): void => {
  run('DELETE FROM keyword_images WHERE keyword_id = ?', keywordId);
};

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
  mode: 'live' | 'dry';
  hold: '' | 'awaiting' | 'dry';
  attempts: number;
  retry_after: string | null;
  title: string;
}

export const createRun = (
  keywordId: number,
  siteId: number,
  mode: 'live' | 'dry' = 'live',
): number =>
  run(
    "INSERT INTO runs (keyword_id, site_id, status, mode) VALUES (?, ?, 'running', ?)",
    keywordId,
    siteId,
    mode,
  ).lastInsertRowid;

export const getRun = (id: number): RunRow | undefined =>
  get<RunRow>('SELECT * FROM runs WHERE id = ?', id);

export const markRunPublished = (
  id: number,
  postId: string,
  postUrl: string,
  title = '',
): void => {
  run(
    `UPDATE runs SET status = 'published', published_at = datetime('now'),
       finished_at = datetime('now'), post_id = ?, post_url = ?,
       error = NULL, failed_step = NULL, hold = '', retry_after = NULL,
       title = CASE WHEN ? = '' THEN title ELSE ? END
     WHERE id = ?`,
    postId,
    postUrl,
    title,
    title,
    id,
  );
};

/**
 * Stop a run short of publishing, on purpose.
 *
 * `cancelled` rather than `failed`: nothing went wrong, and counting a held
 * article as a failure would put it in the dashboard's failure count and in
 * every "this site is broken" heuristic built on top of it. Resume is what
 * releases it, and resume already reuses every completed step.
 */
export const markRunHeld = (id: number, hold: 'awaiting' | 'dry', title: string): void => {
  run(
    `UPDATE runs SET status = 'cancelled', finished_at = datetime('now'),
       hold = ?, title = ?, error = NULL, failed_step = NULL, retry_after = NULL
     WHERE id = ?`,
    hold,
    title,
    id,
  );
};

/** Runs stopped for a person to look at, newest first. */
export const listHeldRuns = (limit = 50): RunListRow[] =>
  all<RunListRow>(
    `SELECT r.*, s.domain AS site_domain, k.seed_keyword
       FROM runs r
       LEFT JOIN sites s ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
      WHERE r.hold != ''
      ORDER BY r.id DESC
      LIMIT ?`,
    limit,
  );

export const countHeldRuns = (): number =>
  get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE hold != ''")?.n ?? 0;

/** Titles already published on a site, for the near-duplicate check. */
export const publishedTitles = (siteId: number, limit = 500): { title: string; url: string | null }[] =>
  all<{ title: string; post_url: string | null }>(
    `SELECT title, post_url FROM runs
      WHERE site_id = ? AND status = 'published' AND title != ''
      ORDER BY id DESC LIMIT ?`,
    siteId,
    limit,
  ).map((r) => ({ title: r.title, url: r.post_url }));

export const setRunTitle = (id: number, title: string): void => {
  run('UPDATE runs SET title = ? WHERE id = ?', title, id);
};

/* -- Automatic retries ---------------------------------------------------- */

/** Schedule this run to be tried again, or clear a pending schedule. */
export const scheduleRetry = (id: number, retryAfter: string | null): void => {
  run(
    `UPDATE runs SET retry_after = ?,
       attempts = CASE WHEN ? IS NULL THEN attempts ELSE attempts END
     WHERE id = ?`,
    retryAfter,
    retryAfter,
    id,
  );
};

/**
 * The one failed run that is due to be retried, if any.
 *
 * Oldest first, so a backlog drains in the order it accumulated rather than
 * letting the newest failure starve the rest.
 */
export const dueRetry = (): RunRow | undefined =>
  get<RunRow>(
    `SELECT * FROM runs
      WHERE status = 'failed'
        AND retry_after IS NOT NULL
        AND retry_after <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      ORDER BY retry_after LIMIT 1`,
  );

/** Count this attempt and clear the schedule, so it cannot be picked twice. */
export const consumeRetry = (id: number): void => {
  run('UPDATE runs SET attempts = attempts + 1, retry_after = NULL WHERE id = ?', id);
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
  tokens_in: number;
  tokens_out: number;
  images: number;
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
    tokensIn?: number;
    tokensOut?: number;
    images?: number;
  },
): void {
  run(
    `UPDATE run_steps SET status = ?, finished_at = datetime('now'), duration_ms = ?,
       endpoint = ?, model = ?, output_json = ?, error = ?,
       tokens_in = ?, tokens_out = ?, images = ?
     WHERE run_id = ? AND step = ?`,
    outcome.status,
    outcome.durationMs ?? null,
    outcome.endpoint ?? null,
    outcome.model ?? null,
    outcome.output === undefined ? null : safeStringify(outcome.output),
    outcome.error ?? null,
    Math.max(0, Math.round(outcome.tokensIn ?? 0)),
    Math.max(0, Math.round(outcome.tokensOut ?? 0)),
    Math.max(0, Math.round(outcome.images ?? 0)),
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

/* =========================================================================
 * Prompt overrides
 *
 * An edited prompt lives in the database because the files ship inside the
 * image, where an edit lasts only until the next redeploy. The file stays the
 * default: deleting the row restores the shipped text exactly.
 * ====================================================================== */

export interface PromptOverrideRow {
  name: string;
  body: string;
  updated_at: string;
}

export const getPromptOverride = (name: string): string | undefined =>
  get<{ body: string }>('SELECT body FROM prompt_overrides WHERE name = ?', name)?.body;

export const listPromptOverrides = (): PromptOverrideRow[] =>
  all<PromptOverrideRow>('SELECT * FROM prompt_overrides ORDER BY name');

export const setPromptOverride = (name: string, body: string): void => {
  run(
    `INSERT INTO prompt_overrides (name, body) VALUES (?, ?)
     ON CONFLICT (name) DO UPDATE SET body = excluded.body, updated_at = datetime('now')`,
    name,
    body,
  );
};

export const deletePromptOverride = (name: string): void => {
  run('DELETE FROM prompt_overrides WHERE name = ?', name);
};

/**
 * Find the row a CSV line refers to, so a re-import corrects rather than
 * duplicates.
 *
 * The article, not the group, is the identity. `seed_keyword` is a research
 * label shared by every recipe found under one topic — five different dishes
 * arrive as five rows all saying "Chicken Thighs" — so matching on it made a
 * re-import collapse those five into one, each row overwriting the previous
 * one's title, description and annotation. What survived was the last line of
 * the file, and the other four recipes were gone.
 *
 * `spy_title` names the actual dish, so that is what identifies a row. A line
 * with no title falls back to the seed, which is the only thing left to go on.
 */
export const findKeywordRow = (seed: string, spyTitle: string): KeywordRow | undefined => {
  const title = spyTitle.trim();

  if (title) {
    return get<KeywordRow>(
      'SELECT * FROM keywords WHERE spy_title = ? COLLATE NOCASE',
      title,
    );
  }

  // No article title: the seed is the whole of what this row says it is, so
  // two such rows are indistinguishable and treating them as one is right.
  return get<KeywordRow>(
    "SELECT * FROM keywords WHERE seed_keyword = ? COLLATE NOCASE AND spy_title = ''",
    seed.trim(),
  );
};

/** Kept for the URL importer, which has a title but no group to match within. */
export const getKeywordBySeed = (seed: string): KeywordRow | undefined =>
  get<KeywordRow>('SELECT * FROM keywords WHERE seed_keyword = ? COLLATE NOCASE', seed.trim());

/** Every recipe found under one research label. */
export const keywordsInGroup = (seed: string, excludeId = 0): KeywordRow[] =>
  all<KeywordRow>(
    'SELECT * FROM keywords WHERE seed_keyword = ? COLLATE NOCASE AND id != ? ORDER BY id',
    seed.trim(),
    excludeId,
  );

/** Overwrite a keyword's imported fields, leaving its id and links intact. */
export function updateKeywordFields(
  id: number,
  fields: Omit<Partial<KeywordRow>, 'id' | 'seed_keyword'>,
): void {
  run(
    `UPDATE keywords SET spy_title = ?, spy_description = ?, spy_image_url = ?,
       spy_article_url = ?, spy_pin_image = ?, annotation = ?, status = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    fields.spy_title ?? '',
    fields.spy_description ?? '',
    fields.spy_image_url ?? '',
    fields.spy_article_url ?? '',
    fields.spy_pin_image ?? '',
    fields.annotation ?? '',
    fields.status ?? 'go',
    id,
  );
}

/**
 * Bring stored domains to one spelling.
 *
 * Sites entered before the form normalised, or imported from a KEYS sheet that
 * did not, are stored as `https://bitespoon.com`. A CSV column headed
 * `bitespoon.com` then matches nothing, the import reports success, and every
 * keyword lands linked to no site. Running this once at boot means the repair
 * does not depend on someone re-saving eleven sites by hand.
 *
 * Idempotent: a domain already normalised is left alone. A domain that would
 * collide with another row is left alone too and reported, because silently
 * merging two sites is worse than the inconsistency.
 */
export function normaliseStoredDomains(
  normalise: (value: string) => string,
): { changed: string[]; conflicted: string[] } {
  const sites = listSites();
  const changed: string[] = [];
  const conflicted: string[] = [];

  // Keyed by the domain as it stands, not by its normalised form: keying by
  // the target collapses both spellings of a colliding pair into one entry, so
  // the guard below never fires and the UPDATE hits the UNIQUE constraint.
  const occupied = new Set(sites.map((s) => s.domain));

  for (const site of sites) {
    const target = normalise(site.domain);
    if (target === '' || target === site.domain) continue;

    if (occupied.has(target)) {
      conflicted.push(`${site.domain} -> ${target}`);
      continue;
    }

    run("UPDATE sites SET domain = ?, updated_at = datetime('now') WHERE id = ?", target, site.id);
    occupied.delete(site.domain);
    occupied.add(target);
    changed.push(`${site.domain} -> ${target}`);
  }

  return { changed, conflicted };
}

/* =========================================================================
 * Keywords: searching and bulk edits
 *
 * A hundred keywords across five sites is five hundred cells, and changing
 * them one select at a time is how a page stops being used. Filtering narrows
 * the table to the rows you mean; the bulk writes then act on exactly those.
 * ====================================================================== */

/**
 * A named view of the keyword list.
 *
 * The page used to expose the raw fields — keyword status, site, and link
 * status — as four separate dropdowns, one of which was labelled "Where it
 * stands there". Nobody could work out what a combination of them would show,
 * because answering that needed the data model in your head.
 *
 * These are the questions people actually ask instead. Each is one option.
 */
export type KeywordListView = 'all' | 'queued' | 'stuck' | 'done' | 'off';

export interface KeywordFilter {
  /** Matched against the keyword and its spy title, case-insensitively. */
  q?: string;
  view?: KeywordListView;
  /** Narrows every view to one site. 0 means "any site". */
  siteId?: number;
}

/** WHERE clause and parameters shared by the list and its count. */
function keywordWhere(filter: KeywordFilter): { sql: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  const q = (filter.q ?? '').trim();
  if (q) {
    clauses.push('(k.seed_keyword LIKE ? COLLATE NOCASE OR k.spy_title LIKE ? COLLATE NOCASE)');
    params.push(`%${q}%`, `%${q}%`);
  }

  // "Is this keyword going to publish somewhere?" — the question both `queued`
  // and `stuck` are asking, from opposite sides. Narrowed to one site when one
  // is chosen, so the same view reads as "here" rather than "anywhere".
  const goesSomewhere = filter.siteId
    ? 'EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.status = \'go\' AND ks.site_id = ?)'
    : "EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.status = 'go')";

  switch (filter.view ?? 'all') {
    case 'queued':
      clauses.push("k.status = 'go'", goesSomewhere);
      if (filter.siteId) params.push(filter.siteId);
      break;

    case 'stuck':
      // Set to go and linked to nothing that will take it. This is the state
      // that looks like supply on the dashboard and publishes nothing, which
      // is why it gets a view of its own.
      clauses.push("k.status = 'go'", `NOT ${goesSomewhere}`);
      if (filter.siteId) params.push(filter.siteId);
      break;

    case 'done':
      clauses.push("k.status = 'done'");
      if (filter.siteId) {
        clauses.push(
          'EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.site_id = ?)',
        );
        params.push(filter.siteId);
      }
      break;

    case 'off':
      clauses.push("k.status = 'no'");
      if (filter.siteId) {
        clauses.push(
          'EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.site_id = ?)',
        );
        params.push(filter.siteId);
      }
      break;

    case 'all':
    default:
      if (filter.siteId) {
        clauses.push(
          'EXISTS (SELECT 1 FROM keyword_sites ks WHERE ks.keyword_id = k.id AND ks.site_id = ?)',
        );
        params.push(filter.siteId);
      }
      break;
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** How many keywords each view holds, for the labels on the view picker. */
export function keywordViewCounts(siteId = 0): Record<KeywordListView, number> {
  const count = (view: KeywordListView): number => countKeywordsMatching({ view, siteId });
  return {
    all: count('all'),
    queued: count('queued'),
    stuck: count('stuck'),
    done: count('done'),
    off: count('off'),
  };
}

export const searchKeywords = (
  filter: KeywordFilter,
  limit = 100,
  offset = 0,
): KeywordRow[] => {
  const where = keywordWhere(filter);
  return all<KeywordRow>(
    `SELECT k.* FROM keywords k ${where.sql} ORDER BY k.id LIMIT ? OFFSET ?`,
    ...where.params,
    limit,
    offset,
  );
};

export const countKeywordsMatching = (filter: KeywordFilter): number => {
  const where = keywordWhere(filter);
  return (
    get<{ n: number }>(`SELECT COUNT(*) AS n FROM keywords k ${where.sql}`, ...where.params)?.n ?? 0
  );
};

/** `?, ?, ?` for an IN list. Ids are numbers, so nothing is interpolated raw. */
const placeholders = (ids: number[]): string => ids.map(() => '?').join(', ');

export const bulkSetKeywordStatus = (ids: number[], status: 'go' | 'done' | 'no'): number => {
  if (ids.length === 0) return 0;
  return run(
    `UPDATE keywords SET status = ?, updated_at = datetime('now')
      WHERE id IN (${placeholders(ids)})`,
    status,
    ...ids,
  ).changes;
};

export const bulkDeleteKeywords = (ids: number[]): number => {
  if (ids.length === 0) return 0;
  return run(`DELETE FROM keywords WHERE id IN (${placeholders(ids)})`, ...ids).changes;
};

/**
 * Set the link status for every (keyword, site) pair in the selection.
 *
 * `siteIds` empty means every site, which is what "all sites" in the bulk bar
 * sends. Wrapped in one transaction so a half-applied grid is impossible.
 */
export const bulkSetLinks = (
  keywordIds: number[],
  siteIds: number[],
  status: 'go' | 'done' | 'no',
): number => {
  if (keywordIds.length === 0) return 0;
  const targets = siteIds.length ? siteIds : listSites().map((s) => s.id);
  if (targets.length === 0) return 0;

  return transaction(() => {
    let n = 0;
    for (const keywordId of keywordIds) {
      for (const siteId of targets) {
        setLink(keywordId, siteId, status);
        n += 1;
      }
    }
    return n;
  });
};

/** The same shape for image sharing. Only touches pairs that already exist. */
export const bulkSetShareImages = (
  keywordIds: number[],
  siteIds: number[],
  share: boolean,
): number => {
  if (keywordIds.length === 0) return 0;

  return transaction(() => {
    if (siteIds.length === 0) {
      return run(
        `UPDATE keyword_sites SET share_images = ?, updated_at = datetime('now')
          WHERE keyword_id IN (${placeholders(keywordIds)})`,
        share ? 1 : 0,
        ...keywordIds,
      ).changes;
    }
    return run(
      `UPDATE keyword_sites SET share_images = ?, updated_at = datetime('now')
        WHERE keyword_id IN (${placeholders(keywordIds)})
          AND site_id IN (${placeholders(siteIds)})`,
      share ? 1 : 0,
      ...keywordIds,
      ...siteIds,
    ).changes;
  });
};

/* =========================================================================
 * Pausing a site
 * ====================================================================== */

/**
 * Pause one site, with a note and optionally an end.
 *
 * The note is the point. "Paused" on its own is a state whose reason is gone
 * within a week, and the usual outcome is that nobody dares turn it back on.
 */
export const pauseSite = (
  id: number,
  reason: string,
  until: string | null,
): void => {
  run(
    `UPDATE sites SET status = 'paused', paused_reason = ?, paused_until = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    reason.trim(),
    until,
    id,
  );
};

export const activateSite = (id: number): void => {
  run(
    `UPDATE sites SET status = 'active', paused_reason = '', paused_until = NULL,
       updated_at = datetime('now')
     WHERE id = ?`,
    id,
  );
};

/**
 * Bring back every site whose pause has run out.
 *
 * A real write rather than a rule applied at read time. Deriving it would mean
 * the Sites page showing "active" over a row that still says paused in the
 * database, and every later query having to remember the same rule. One
 * UPDATE, called at the top of a tick, keeps the table honest.
 *
 * Returns the domains resumed so the caller can log or announce them.
 */
export function resumeExpiredPauses(): string[] {
  const due = all<{ id: number; domain: string }>(
    `SELECT id, domain FROM sites
      WHERE status = 'paused'
        AND paused_until IS NOT NULL
        AND paused_until <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
  );

  for (const site of due) activateSite(site.id);
  return due.map((s) => s.domain);
}

/* =========================================================================
 * Prompt history
 * ====================================================================== */

/**
 * How many versions of one prompt are kept.
 *
 * Prompts run to thousands of characters and every save appends one. Twenty
 * covers "put back what I had this morning", which is the whole use; keeping
 * every version forever would make prompt_versions the largest table here.
 */
export const PROMPT_VERSION_LIMIT = 20;

export interface PromptVersionRow {
  id: number;
  name: string;
  body: string;
  created_at: string;
}

/** Append a version, then drop everything past the limit for that prompt. */
export function savePromptVersion(name: string, body: string): void {
  transaction(() => {
    // Saving the same text twice in a row is a no-op, not a new version:
    // pressing Save without editing should not push a real version out.
    const newest = get<{ body: string }>(
      'SELECT body FROM prompt_versions WHERE name = ? ORDER BY id DESC LIMIT 1',
      name,
    );
    if (newest?.body === body) return;

    run('INSERT INTO prompt_versions (name, body) VALUES (?, ?)', name, body);
    run(
      `DELETE FROM prompt_versions
        WHERE name = ?
          AND id NOT IN (
            SELECT id FROM prompt_versions WHERE name = ? ORDER BY id DESC LIMIT ?
          )`,
      name,
      name,
      PROMPT_VERSION_LIMIT,
    );
  });
}

export const listPromptVersions = (name: string): PromptVersionRow[] =>
  all<PromptVersionRow>(
    'SELECT * FROM prompt_versions WHERE name = ? ORDER BY id DESC',
    name,
  );

export const getPromptVersion = (id: number): PromptVersionRow | undefined =>
  get<PromptVersionRow>('SELECT * FROM prompt_versions WHERE id = ?', id);

/* =========================================================================
 * Which model runs which prompt
 * ====================================================================== */

export const listModelOverrides = (): Map<string, string> =>
  new Map(
    all<{ prompt: string; model: string }>('SELECT prompt, model FROM model_overrides').map(
      (r) => [r.prompt, r.model] as const,
    ),
  );

export const setModelOverride = (prompt: string, model: string): void => {
  const trimmed = model.trim();

  // Blank means "back to the shipped default", which is the absence of a row
  // rather than a row holding an empty string.
  if (trimmed === '') {
    run('DELETE FROM model_overrides WHERE prompt = ?', prompt);
    return;
  }

  run(
    `INSERT INTO model_overrides (prompt, model) VALUES (?, ?)
     ON CONFLICT (prompt) DO UPDATE SET model = excluded.model, updated_at = datetime('now')`,
    prompt,
    trimmed,
  );
};

/* =========================================================================
 * Notification de-duplication
 * ====================================================================== */

/**
 * Record the state last announced for one kind of notice.
 *
 * Returns true when the state changed, which is exactly when a message should
 * be sent. The check and the write are one call so there is no window where a
 * second caller sees the old state and sends a duplicate.
 */
export function noticeChanged(kind: string, state: string): boolean {
  const previous = get<{ state: string }>('SELECT state FROM notice_state WHERE kind = ?', kind);
  if (previous?.state === state) return false;

  run(
    `INSERT INTO notice_state (kind, state) VALUES (?, ?)
     ON CONFLICT (kind) DO UPDATE SET state = excluded.state, updated_at = datetime('now')`,
    kind,
    state,
  );
  return true;
}

/* =========================================================================
 * Usage
 * ====================================================================== */

export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  images: number;
  durationMs: number;
  llmCalls: number;
}

export const runUsage = (runId: number): RunUsage => {
  const row = get<{
    tokens_in: number;
    tokens_out: number;
    images: number;
    duration_ms: number;
    llm_calls: number;
  }>(
    `SELECT COALESCE(SUM(tokens_in), 0)  AS tokens_in,
            COALESCE(SUM(tokens_out), 0) AS tokens_out,
            COALESCE(SUM(images), 0)     AS images,
            COALESCE(SUM(duration_ms), 0) AS duration_ms,
            COALESCE(SUM(CASE WHEN model IS NOT NULL AND model != '' THEN 1 ELSE 0 END), 0)
              AS llm_calls
       FROM run_steps WHERE run_id = ?`,
    runId,
  );

  return {
    tokensIn: Number(row?.tokens_in ?? 0),
    tokensOut: Number(row?.tokens_out ?? 0),
    images: Number(row?.images ?? 0),
    durationMs: Number(row?.duration_ms ?? 0),
    llmCalls: Number(row?.llm_calls ?? 0),
  };
};

export interface StepCost {
  step: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  avgDurationMs: number;
}

/** Which steps cost the most, across recent history. Answers "which prompt". */
export const stepCosts = (days = 30): StepCost[] =>
  all<{
    step: string;
    runs: number;
    tokens_in: number;
    tokens_out: number;
    avg_duration: number;
  }>(
    `SELECT s.step,
            COUNT(*)                       AS runs,
            COALESCE(SUM(s.tokens_in), 0)  AS tokens_in,
            COALESCE(SUM(s.tokens_out), 0) AS tokens_out,
            COALESCE(AVG(s.duration_ms), 0) AS avg_duration
       FROM run_steps s
      WHERE s.started_at >= datetime('now', ?)
      GROUP BY s.step
      ORDER BY (COALESCE(SUM(s.tokens_in), 0) + COALESCE(SUM(s.tokens_out), 0)) DESC`,
    `-${Math.max(1, Math.floor(days))} days`,
  ).map((r) => ({
    step: r.step,
    runs: Number(r.runs),
    tokensIn: Number(r.tokens_in),
    tokensOut: Number(r.tokens_out),
    avgDurationMs: Number(r.avg_duration),
  }));

/**
 * Published and failed counts per local day, oldest first.
 *
 * `days` days of history, including days with nothing — a gap in the series is
 * a day the platform did not publish, and dropping it would draw a chart that
 * quietly hides exactly the thing you are looking for.
 */
export function dailyActivity(
  days: number,
  timezone: string,
): { day: string; published: number; failed: number }[] {
  const modifier = tzModifier(timezone);

  const rows = all<{ day: string; published: number; failed: number }>(
    `SELECT date(started_at, ?) AS day,
            SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) AS published,
            SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed
       FROM runs
      WHERE started_at >= datetime('now', ?)
      GROUP BY day`,
    modifier,
    `-${Math.max(1, Math.floor(days))} days`,
  );

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series: { day: string; published: number; failed: number }[] = [];

  for (let back = days - 1; back >= 0; back--) {
    const at = new Date(Date.now() - back * 86_400_000);
    const day = get<{ d: string }>("SELECT date(?, ?) AS d", at.toISOString(), modifier)?.d ?? '';
    const found = byDay.get(day);
    series.push({
      day,
      published: Number(found?.published ?? 0),
      failed: Number(found?.failed ?? 0),
    });
  }

  return series;
}

/* =========================================================================
 * Held runs: editing what was written, and throwing it away
 * ====================================================================== */

/**
 * Overwrite a completed step's stored output.
 *
 * The checkpoint *is* the article: a resume replays from stored outputs, so
 * editing one before approving is what makes the edit reach the site. Only
 * ever called with a document the caller has already parsed.
 */
export const replaceStepOutput = (runId: number, step: string, output: unknown): void => {
  run(
    "UPDATE run_steps SET output_json = ? WHERE run_id = ? AND step = ? AND status = 'ok'",
    safeStringify(output),
    runId,
    step,
  );
};

/**
 * Close a held run without publishing it.
 *
 * The steps stay. They are the record of what was written and what it cost,
 * and deleting them to tidy up would make a discarded article invisible in the
 * usage figures it genuinely contributed to.
 */
export const discardRun = (id: number): void => {
  run(
    `UPDATE runs SET status = 'cancelled', hold = '', finished_at = datetime('now'),
       error = 'Discarded before publishing', retry_after = NULL
     WHERE id = ?`,
    id,
  );
};

/** Every run for one keyword, newest first — the keyword's own history. */
export const listRunsForKeyword = (keywordId: number, limit = 25): RunListRow[] =>
  all<RunListRow>(
    `SELECT r.*, s.domain AS site_domain, k.seed_keyword
       FROM runs r
       LEFT JOIN sites s ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
      WHERE r.keyword_id = ?
      ORDER BY r.id DESC
      LIMIT ?`,
    keywordId,
    limit,
  );

/* =========================================================================
 * Where a keyword's images came from
 * ====================================================================== */

export interface SharedImageInfo extends SharedImageUrls {
  sourceDomain: string | null;
  createdAt: string;
  /** Sites that have copied this set rather than generating their own. */
  reusedBy: number;
}

/**
 * The stored image set for one keyword, with its provenance.
 *
 * Exists because "are these four images really this keyword's own?" was not a
 * question the UI could answer. The store is keyed by keyword_id, so crossing
 * keywords is not representable — but being told that is not the same as being
 * able to open two keywords and see two different sets of URLs.
 */
export const sharedImageInfo = (keywordId: number): SharedImageInfo | undefined => {
  const row = get<{
    feature_url: string;
    top_shot_url: string;
    texture_macro_url: string;
    before_after_url: string;
    created_at: string;
    domain: string | null;
    source_site_id: number | null;
  }>(
    `SELECT i.feature_url, i.top_shot_url, i.texture_macro_url, i.before_after_url,
            i.created_at, i.source_site_id, s.domain
       FROM keyword_images i
       LEFT JOIN sites s ON s.id = i.source_site_id
      WHERE i.keyword_id = ?`,
    keywordId,
  );

  if (!row) return undefined;

  // Every site that published this keyword other than the one that made the
  // images. Those are the runs that copied instead of generating.
  const reused =
    get<{ n: number }>(
      `SELECT COUNT(DISTINCT site_id) AS n FROM runs
        WHERE keyword_id = ? AND status = 'published'
          AND (? IS NULL OR site_id != ?)`,
      keywordId,
      row.source_site_id,
      row.source_site_id,
    )?.n ?? 0;

  return {
    feature: row.feature_url,
    topShot: row.top_shot_url,
    textureMacro: row.texture_macro_url,
    beforeAfter: row.before_after_url,
    sourceDomain: row.domain,
    createdAt: row.created_at,
    reusedBy: reused,
  };
};

export interface KeywordImageCounts {
  /** Runs that generated a fresh set of four article images. */
  generatedRuns: number;
  /** Runs that copied an existing set instead of calling Google. */
  copiedRuns: number;
  /** Pinterest graphics successfully made. One per site, never shared. */
  pinsMade: number;
  /** Attempts at a Pinterest graphic that failed. */
  pinsFailed: number;
  /** Article images that reached Google: four per generating run. */
  articleGenerated: number;
}

/** How many article images one generating run makes. */
export const ARTICLE_IMAGES_PER_RUN = 4;

/**
 * What this keyword has cost at the image service.
 *
 * Counts *runs* from facts that have always been recorded — a step's status,
 * and which site the stored image set came from — rather than summing
 * run_steps.images.
 *
 * That column arrived in migration 005 with DEFAULT 0, so every run from
 * before that deploy reports zero. Summing it made a run that generated four
 * images indistinguishable from one that copied them, and the page confidently
 * reported "0 article images made" directly above the four images it was
 * displaying. A column added later is not evidence about what happened
 * earlier, and a counter that cannot say "I do not know" will instead say
 * something false.
 *
 * The tell for a generating run is `images > 0` where that was measured, or
 * being the site the image set is recorded against where it was not.
 */
export const keywordImageCounts = (keywordId: number): KeywordImageCounts => {
  const row = get<{
    generated: number;
    copied: number;
    pins_made: number;
    pins_failed: number;
  }>(
    `SELECT
       COALESCE(SUM(CASE
         WHEN s.step = 'generate-images' AND s.status = 'ok'
          AND (s.images > 0 OR r.site_id = (
                SELECT source_site_id FROM keyword_images WHERE keyword_id = ?))
         THEN 1 ELSE 0 END), 0)                                        AS generated,

       COALESCE(SUM(CASE
         WHEN s.step = 'generate-images' AND s.status = 'ok'
          AND s.images = 0
          AND (r.site_id IS NULL OR r.site_id IS NOT (
                SELECT source_site_id FROM keyword_images WHERE keyword_id = ?))
         THEN 1 ELSE 0 END), 0)                                        AS copied,

       COALESCE(SUM(CASE WHEN s.step = 'generate-pin-image' AND s.status = 'ok'
                         THEN 1 ELSE 0 END), 0)                        AS pins_made,
       COALESCE(SUM(CASE WHEN s.step = 'generate-pin-image' AND s.status = 'failed'
                         THEN 1 ELSE 0 END), 0)                        AS pins_failed
     FROM run_steps s
     JOIN runs r ON r.id = s.run_id
     WHERE r.keyword_id = ?`,
    keywordId,
    keywordId,
    keywordId,
  );

  const generatedRuns = Number(row?.generated ?? 0);

  return {
    generatedRuns,
    copiedRuns: Number(row?.copied ?? 0),
    pinsMade: Number(row?.pins_made ?? 0),
    pinsFailed: Number(row?.pins_failed ?? 0),
    articleGenerated: generatedRuns * ARTICLE_IMAGES_PER_RUN,
  };
};

/** Whether this site publishes on its own or holds each article for approval. */
export const setAutoPublish = (id: number, auto: boolean): void => {
  run(
    "UPDATE sites SET auto_publish = ?, updated_at = datetime('now') WHERE id = ?",
    fromBool(auto),
    id,
  );
};
