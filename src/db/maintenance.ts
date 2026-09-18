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
import { siteSecrets, type SiteRow } from './repos.js';

export type Dataset =
  | 'runs'
  | 'steps'
  | 'decisions'
  | 'events'
  | 'keywords'
  | 'sites'
  | 'articles'
  | 'reels';

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
      // No tokens. An export is a file that ends up in a downloads folder, and
      // this one should be safe to attach to a message without thinking.
      // exportSitesWithCredentials is the deliberate other choice.
      //
      // Every other column round-trips through importSitesCsv, which reads a
      // blank token as "keep the stored one" — so this file can be edited in a
      // spreadsheet and imported back without erasing the secrets it omits.
      const rows = all<Record<string, unknown>>(
        `SELECT name, domain, status, daily_target, interval_minutes,
                pin_username, project_id, auto_publish, paused_reason
           FROM sites ORDER BY id`,
      );
      return {
        filename: 'sites.csv',
        rows: [
          ['name', 'domain', 'status', 'daily_target', 'interval_minutes',
            'pin_username', 'project_id', 'auto_publish', 'paused_reason',
            'api_token', 'buffer_token'],
          ...rows.map((r) => [
            text(r.name), text(r.domain), text(r.status), text(r.daily_target),
            text(r.interval_minutes), text(r.pin_username), text(r.project_id),
            r.auto_publish === 1 ? 'yes' : 'no', text(r.paused_reason),
            // Present but empty, so the shape matches the credential export and
            // the columns are there to fill in by hand.
            '', '',
          ]),
        ],
      };
    }

    case 'articles':
      return exportArticles();

    case 'reels':
      return exportReels();
  }
}

/**
 * The latest successful output of each step, per run, parsed.
 *
 * The step outputs are where everything the model wrote lives -- the title,
 * the image links, the pin -- and a step that ran twice keeps both rows, so
 * the newest ok one wins.
 */
function stepOutputs(): Map<number, Map<string, unknown>> {
  const byRun = new Map<number, Map<string, unknown>>();
  const rows = all<{ run_id: number; step: string; output_json: string | null }>(
    `SELECT run_id, step, output_json FROM run_steps
      WHERE status = 'ok' AND output_json IS NOT NULL ORDER BY id`,
  );
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.output_json!);
    } catch {
      continue;
    }
    let steps = byRun.get(row.run_id);
    if (!steps) byRun.set(row.run_id, (steps = new Map()));
    steps.set(row.step, parsed);
  }
  return byRun;
}

const field = (value: unknown, key: string): string =>
  value && typeof value === 'object' ? text((value as Record<string, unknown>)[key]) : '';

/** The images step keeps the path the article uses; a sheet wants the link. */
const onSite = (domain: unknown, path: string): string => {
  if (!path || /^https?:\/\//.test(path)) return path;
  const host = text(domain).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return host ? `https://${host}${path}` : path;
};

/**
 * One row per article the platform made: what it is, where it went, and the
 * pictures and pin that went with it. The body is left out on purpose --
 * thousands of words a row is not something a spreadsheet opens.
 */
function exportArticles(): Export {
  const outputs = stepOutputs();
  const runs = all<Record<string, unknown>>(
    `SELECT r.id, r.status, r.title, r.post_id, r.post_url,
            s.domain AS site, k.seed_keyword AS keyword
       FROM runs r
       LEFT JOIN sites s ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
      ORDER BY r.id`,
  );
  return {
    filename: 'articles.csv',
    rows: [
      ['run_id', 'site', 'keyword', 'status', 'title', 'description', 'category',
        'post_url', 'post_id', 'feature_image', 'top_shot', 'texture_macro',
        'before_after', 'pin_image', 'pin_description'],
      ...runs.map((r) => {
        const steps = outputs.get(Number(r.id)) ?? new Map<string, unknown>();
        const seo = steps.get('validate-spy');
        const images = steps.get('generate-images');
        const pin = steps.get('generate-pin-image');
        return [
          text(r.id), text(r.site), text(r.keyword), text(r.status),
          field(seo, 'title') || text(r.title), field(seo, 'description'),
          field(seo, 'category'), text(r.post_url), text(r.post_id),
          onSite(r.site, field(images, 'feature')), onSite(r.site, field(images, 'topShot')),
          onSite(r.site, field(images, 'textureMacro')), onSite(r.site, field(images, 'beforeAfter')),
          field(pin, 'url'),
          text(steps.get('generate-pin-description')),
        ];
      }),
    ],
  };
}

/** One row per reel: what it is, which page it is for, and where the video is. */
function exportReels(): Export {
  const reels = all<Record<string, unknown>>(
    `SELECT r.status, r.stage, r.format, r.caption, r.video_url, r.fb_video_id, r.error,
            s.domain AS site, k.seed_keyword AS keyword,
            COALESCE(NULLIF(run.title, ''), k.spy_title) AS title,
            p.name AS fb_page,
            (SELECT COUNT(*) FROM reel_scenes sc WHERE sc.reel_id = r.id) AS scenes
       FROM reels r
       LEFT JOIN sites s    ON s.id = r.site_id
       LEFT JOIN keywords k ON k.id = r.keyword_id
       LEFT JOIN runs run   ON run.id = r.run_id
       LEFT JOIN fb_pages p ON p.id = r.fb_page_id
      ORDER BY r.id`,
  );
  return {
    filename: 'reels.csv',
    rows: [
      ['site', 'keyword', 'title', 'fb_page', 'status', 'mode', 'format', 'scenes',
        'caption', 'video_url', 'facebook_url', 'error'],
      ...reels.map((r) => {
        // A single-clip reel never enters the studio's stages and has no
        // shape; anything else is a storyboard.
        const scenes = r.stage !== 'done' || text(r.format) !== '' || Number(r.scenes) > 0;
        return [
          text(r.site), text(r.keyword), text(r.title), text(r.fb_page), text(r.status),
          scenes ? 'scenes' : 'single', text(r.format), scenes ? text(r.scenes) : '',
          text(r.caption), text(r.video_url),
          r.fb_video_id ? `https://www.facebook.com/reel/${text(r.fb_video_id)}` : '',
          text(r.error),
        ];
      }),
    ],
  };
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

/**
 * Every site with its credentials in plain text.
 *
 * Kept apart from exportDataset('sites') deliberately. That one omits the
 * tokens so it can be shared, diffed, or attached to a message without
 * thinking about it; this one is a file that can publish to all your sites,
 * and the difference has to be a separate deliberate action rather than a flag
 * somebody passes by accident.
 *
 * Round-trips through importSitesCsv, which treats a blank token as "keep the
 * stored one" — so the safe export can be edited and imported back without
 * erasing the secrets it does not contain.
 */
export function exportSitesWithCredentials(encryptionKey: Buffer): Export {
  const rows = all<SiteRow>('SELECT * FROM sites ORDER BY id');

  return {
    filename: 'sites-with-credentials.csv',
    rows: [
      ['name', 'domain', 'status', 'daily_target', 'interval_minutes', 'pin_username',
        'project_id', 'auto_publish', 'paused_reason', 'api_token', 'buffer_token'],
      ...rows.map((site) => {
        const secrets = siteSecrets(site, encryptionKey);
        return [
          site.name,
          site.domain,
          site.status,
          String(site.daily_target),
          String(site.interval_minutes),
          site.pin_username,
          site.project_id,
          site.auto_publish === 1 ? 'yes' : 'no',
          site.paused_reason,
          secrets.apiToken,
          secrets.bufferToken,
        ];
      }),
    ],
  };
}
