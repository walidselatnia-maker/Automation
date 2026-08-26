import { randomUUID } from 'node:crypto';
import { get, run } from '../db/index.js';
import {
  createRun,
  getKeyword,
  getLinkShare,
  getSite,
  loadKeywordViews,
  loadLinkViews,
  loadSiteViews,
  pruneDecisions,
  pruneEvents,
  recordDecisions,
} from '../db/repos.js';
import { localDateKey, selectTask } from '../core/selector.js';
import { executePipeline, PipelineContext } from '../pipeline/index.js';
import type { Settings } from '../settings.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('scheduler');

/**
 * The scheduler.
 *
 * One tick does at most one thing: find a valid keyword+site pair and publish
 * it. It never loops, never retries in place, and never runs concurrently
 * with itself. If a tick finds nothing, it records why and stops — the next
 * tick starts from fresh state.
 */

export interface TickResult {
  cycleId: string;
  outcome: 'published' | 'failed' | 'spy-rejected' | 'no-task' | 'busy' | 'disabled' | 'misconfigured';
  runId?: number;
  detail?: string;
}

/* -- Lock ---------------------------------------------------------------- */

interface LockRow {
  id: number;
  run_id: number | null;
  locked_at: string | null;
  heartbeat_at: string | null;
}

/** A lock older than this is assumed orphaned by a crash or restart. */
const STALE_LOCK_MINUTES = 90;

function acquireLock(): boolean {
  const result = run(
    `UPDATE scheduler_lock
        SET locked_at = datetime('now'), heartbeat_at = datetime('now')
      WHERE id = 1
        AND (locked_at IS NULL OR locked_at < datetime('now', ?))`,
    `-${STALE_LOCK_MINUTES} minutes`,
  );
  return result.changes > 0;
}

function releaseLock(): void {
  run('UPDATE scheduler_lock SET locked_at = NULL, run_id = NULL, heartbeat_at = NULL WHERE id = 1');
}

function attachRunToLock(runId: number): void {
  run("UPDATE scheduler_lock SET run_id = ?, heartbeat_at = datetime('now') WHERE id = 1", runId);
}

export function heartbeat(): void {
  run("UPDATE scheduler_lock SET heartbeat_at = datetime('now') WHERE id = 1");
}

export const lockStatus = (): LockRow | undefined =>
  get<LockRow>('SELECT * FROM scheduler_lock WHERE id = 1');

export function forceReleaseLock(): void {
  log.warn('scheduler lock released manually');
  releaseLock();
}

/* -- Tick ---------------------------------------------------------------- */

export async function tick(settings: Settings, encryptionKey: Buffer): Promise<TickResult> {
  const cycleId = randomUUID();

  if (!settings.getBool('automation_enabled')) {
    return { cycleId, outcome: 'disabled' };
  }

  const problems = settings.validate();
  if (problems.length > 0) {
    log.warn('cannot run: configuration incomplete', problems);
    recordDecisions(cycleId, [
      {
        subjectType: 'cycle',
        subjectId: null,
        subjectLabel: '',
        decision: 'none',
        reason: `Configuration incomplete: ${problems.join(' ')}`,
      },
    ]);
    return { cycleId, outcome: 'misconfigured', detail: problems.join(' ') };
  }

  if (!acquireLock()) {
    log.debug('a run is already in progress; skipping this tick');
    return { cycleId, outcome: 'busy' };
  }

  try {
    const timezone = settings.get('timezone');
    const now = new Date();
    const dayKey = localDateKey(now, timezone);

    const sites = loadSiteViews(dayKey, timezone);
    const keywords = loadKeywordViews();
    const links = loadLinkViews();

    const { task, decisions } = selectTask(sites, keywords, links, { now, timezone });
    recordDecisions(cycleId, decisions);

    if (!task) {
      const reason = decisions.at(-1)?.reason ?? 'No valid pair';
      log.info(`nothing to publish: ${reason}`);
      return { cycleId, outcome: 'no-task', detail: reason };
    }

    log.info(`selected "${task.seedKeyword}" for ${task.siteDomain}`);

    const site = getSite(task.siteId);
    const keyword = getKeyword(task.keywordId);
    if (!site || !keyword) {
      return { cycleId, outcome: 'no-task', detail: 'Selected site or keyword disappeared' };
    }

    const runId = createRun(task.keywordId, task.siteId);
    attachRunToLock(runId);

    const ctx = new PipelineContext({
      runId,
      site,
      keyword,
      settings,
      encryptionKey,
      shareImages: getLinkShare(keyword.id, site.id),
    });
    const outcome = await executePipeline(ctx);

    return {
      cycleId,
      outcome: outcome.status === 'published' ? 'published' : outcome.status,
      runId,
      detail: outcome.error ?? outcome.postUrl,
    };
  } catch (err) {
    log.error('tick failed unexpectedly', errorMessage(err));
    return { cycleId, outcome: 'failed', detail: errorMessage(err) };
  } finally {
    releaseLock();
  }
}

/** Re-run a failed run, reusing every completed checkpoint. */
export async function resumeRun(
  runId: number,
  settings: Settings,
  encryptionKey: Buffer,
): Promise<TickResult> {
  const cycleId = randomUUID();

  if (!acquireLock()) return { cycleId, outcome: 'busy' };

  try {
    const runRow = get<{ keyword_id: number | null; site_id: number | null }>(
      'SELECT keyword_id, site_id FROM runs WHERE id = ?',
      runId,
    );
    if (!runRow?.site_id || !runRow.keyword_id) {
      return { cycleId, outcome: 'failed', detail: `Run ${runId} not found` };
    }

    const site = getSite(runRow.site_id);
    const keyword = getKeyword(runRow.keyword_id);
    if (!site || !keyword) {
      return { cycleId, outcome: 'failed', detail: 'Site or keyword no longer exists' };
    }

    run("UPDATE runs SET status = 'running', error = NULL, failed_step = NULL WHERE id = ?", runId);
    attachRunToLock(runId);

    log.info(`resuming run ${runId}`);
    const ctx = new PipelineContext({
      runId,
      site,
      keyword,
      settings,
      encryptionKey,
      shareImages: getLinkShare(keyword.id, site.id),
    });
    const outcome = await executePipeline(ctx);

    return {
      cycleId,
      outcome: outcome.status === 'published' ? 'published' : outcome.status,
      runId,
      detail: outcome.error ?? outcome.postUrl,
    };
  } finally {
    releaseLock();
  }
}

/* -- Loop ---------------------------------------------------------------- */

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly settings: Settings,
    private readonly encryptionKey: Buffer,
  ) {}

  start(): void {
    const minutes = Math.max(1, this.settings.getNumber('tick_minutes'));
    log.info(`scheduler started, checking every ${minutes} minute(s)`);

    this.timer = setInterval(() => void this.safeTick(), minutes * 60_000);
    // Give the web server a moment to come up before the first check.
    setTimeout(() => void this.safeTick(), 10_000);
  }

  private async safeTick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const result = await tick(this.settings, this.encryptionKey);
      if (result.outcome !== 'disabled' && result.outcome !== 'busy') {
        log.debug(`tick: ${result.outcome}`);
      }
      this.maybePrune();
    } catch (err) {
      log.error('scheduler tick threw', errorMessage(err));
    } finally {
      this.running = false;
    }
  }

  private lastPrune = 0;

  private maybePrune(): void {
    const DAY = 86_400_000;
    if (Date.now() - this.lastPrune < DAY) return;
    this.lastPrune = Date.now();

    const days = Math.max(1, this.settings.getNumber('retention_days'));
    const removed = pruneDecisions(days) + pruneEvents(days);
    if (removed > 0) log.info(`pruned ${removed} old log rows (retention ${days}d)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.info('scheduler stopped');
  }
}
