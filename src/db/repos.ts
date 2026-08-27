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

/** Look a keyword up by its seed text, so a re-import corrects rather than duplicates. */
export const getKeywordBySeed = (seed: string): KeywordRow | undefined =>
  get<KeywordRow>('SELECT * FROM keywords WHERE seed_keyword = ? COLLATE NOCASE', seed.trim());

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
