import { randomUUID } from 'node:crypto';
import { get, run } from '../db/index.js';
import {
  consumeRetry,
  createRun,
  dueRetry,
  getKeyword,
  getLinkShare,
  getSite,
  loadKeywordViews,
  loadLinkViews,
  loadSiteViews,
  pruneDecisions,
  pruneEvents,
  blockLink,
  consecutiveFailuresForPair,
  markRunFailed,
  pauseSite,
  recordDecisions,
  resumeExpiredPauses,
  scheduleRetry,
} from '../db/repos.js';
import { isTransient, planRetry, type RetryPolicy } from '../core/retry.js';
import { announceNotices } from '../core/notices.js';
import { localDateKey, selectTask } from '../core/selector.js';
import { isBufferExhausted } from '../integrations/buffer-pool.js';
import type { Decision } from '../core/types.js';
import { executePipeline, PipelineContext } from '../pipeline/index.js';
import type { Settings } from '../settings.js';
import { createLogger, errorMessage } from '../lib/logger.js';

const log = createLogger('scheduler');

/**
 * Everything worth interrupting someone about, sent only when it changes.
 *
 * This replaced a bespoke announcer that knew about one thing (the keyword
 * queue) and carried its own de-duplication. The set of things worth an alert
 * grew — a site that has stopped working, the image service being down,
 * articles waiting for approval — and each of them needed the same "only when
 * it changes" logic. See core/notices.ts.
 */
async function announce(settings: Settings): Promise<void> {
  try {
    // The image service's health is polled by the web server; the scheduler
    // sees only what the last poll left behind.
    await announceNotices(settings, imageServiceProblem());
  } catch (err) {
    // Never let a notification failure take down a publishing run.
    log.warn(`could not send notifications: ${errorMessage(err)}`);
  }
}

/**
 * The web server's view of the image service, without importing the server.
 *
 * The server polls it on a timer and calls setImageServiceProblem; the
 * scheduler reads whatever that left. A getter rather than an import because
 * the dependency only runs in that direction — the server owns the scheduler,
 * not the other way round.
 */
let lastImageServiceProblem: string | null = null;

export function setImageServiceProblem(problem: string | null): void {
  lastImageServiceProblem = problem;
}

function imageServiceProblem(): string | null {
  return lastImageServiceProblem;
}

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
  outcome:
    | 'published'
    | 'failed'
    | 'spy-rejected'
    | 'held'
    | 'no-task'
    | 'busy'
    | 'disabled'
    | 'misconfigured';
  runId?: number;
  detail?: string;
  /** Set when the outcome is 'held': why it stopped before publishing. */
  hold?: 'awaiting' | 'dry';
}

/** The automatic-retry settings, read once per tick. */
function retryPolicy(settings: Settings): RetryPolicy {
  return {
    enabled: settings.getBool('auto_retry_enabled'),
    maxAttempts: Math.max(0, settings.getNumber('auto_retry_max')),
    delayMinutes: Math.max(1, settings.getNumber('auto_retry_delay_minutes')),
  };
}

/**
 * Decide what happens to a run that just failed.
 *
 * Called from both tick and resume, because a retry that fails should be
 * considered for another retry on exactly the same terms.
 */
function considerRetry(
  runId: number,
  error: string,
  attempts: number,
  settings: Settings,
  siteId?: number,
): string {
  // A site whose Buffer accounts are all full is not a broken run. The article
  // is written, the images are made, the post is live on the site — only the
  // pin is missing, and the one thing that fixes it is time. Retrying on the
  // usual schedule would burn the attempt budget against a queue that will not
  // move for hours and then give up for good.
  if (siteId && isBufferExhausted(error)) {
    return holdForBufferQueue(runId, siteId, settings);
  }

  const decision = planRetry(error, attempts, retryPolicy(settings), new Date());
  scheduleRetry(runId, decision.retryAfter);

  if (decision.retry) log.info(`run ${runId}: ${decision.reason}`);
  else log.debug(`run ${runId}: not retrying — ${decision.reason}`);

  // Only once the retries are done with it. A run that is going to be tried
  // again has not failed yet in the sense that matters here.
  const held = decision.retry ? '' : considerBlockingPair(runId, error, settings);

  return held ? `${decision.reason} ${held}` : decision.reason;
}

/**
 * Stop offering a pair that keeps failing the same way.
 *
 * The count is deliberately narrow, because the obvious version of this is
 * wrong in three ways:
 *
 *   It would punish a pair for the world's problems. When the image service is
 *   down, every pair that runs fails, and none of them is what broke. So only
 *   failures that `isTransient` calls permanent are counted — the ones that
 *   will happen identically next time. That is the same classifier the retry
 *   policy uses, rather than a second opinion that can drift from it.
 *
 *   It would count across successes. A pair that published fine last week and
 *   failed twice today is not a hopeless pair. The count runs from the last run
 *   that got somewhere, so any success clears it.
 *
 *   It would write 'no' into the link, which is where a person records that a
 *   keyword does not belong on a site. Then nobody could tell a decision from a
 *   surrender, and unblocking would mean guessing which it was. This sets its
 *   own field and leaves the status alone.
 *
 * What it deliberately does not do is require the same failing step each time.
 * Three permanent failures at three different steps is still a pair nothing can
 * publish, and demanding they match would keep offering it for as long as it
 * found new ways to fail.
 */
function considerBlockingPair(runId: number, error: string, settings: Settings): string {
  const limit = Math.max(0, settings.getNumber('pair_failure_limit'));
  if (limit === 0) return '';

  const row = get<{ keyword_id: number | null; site_id: number | null }>(
    'SELECT keyword_id, site_id FROM runs WHERE id = ?',
    runId,
  );
  if (!row?.keyword_id || !row.site_id) return '';

  // The world's problems are the retry policy's business, not this one's.
  if (isTransient(error)) return '';

  const failures = consecutiveFailuresForPair(row.keyword_id, row.site_id);
  if (failures < limit) return '';

  const reason =
    `Failed ${failures} times in a row with nothing published in between. ` +
    `Last error: ${error.slice(0, 300)}`;

  blockLink(row.keyword_id, row.site_id, reason);
  log.warn(`keyword ${row.keyword_id} held back on site ${row.site_id}: ${reason}`);

  return `Held back on this site after ${failures} failures — clear it on the keyword page.`;
}

/**
 * Park a site whose Buffer accounts are all full, and finish the article later.
 *
 * The site is paused so the selector stops handing it new work — publishing
 * more articles it cannot pin would only deepen the backlog — and the run is
 * scheduled to resume when the pause lifts. Resume reuses every completed
 * step, so it picks up at the pin: the same article, on the same site, posted
 * to Buffer as soon as there is room for it.
 *
 * Both use the same instant, so the site comes back exactly when its article
 * is due rather than the two drifting apart.
 */
export function holdForBufferQueue(runId: number, siteId: number, settings: Settings): string {
  const hours = Math.max(1, settings.getNumber('buffer_hold_hours'));
  const until = new Date(Date.now() + hours * 60 * 60 * 1000);
  const site = getSite(siteId);
  const domain = site?.domain ?? `site ${siteId}`;

  const reason =
    `Every Buffer account is full. Paused for ${hours} hours, then run ${runId} ` +
    `resumes and posts its pin.`;

  pauseSite(siteId, reason, until.toISOString());
  scheduleRetry(runId, until.toISOString());

  log.warn(`${domain}: ${reason}`);
  return `Buffer queue full — ${domain} paused for ${hours}h, resuming run ${runId} after that.`;
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

export async function tick(
  settings: Settings,
  encryptionKey: Buffer,
  options: { mode?: 'live' | 'dry'; pick?: { siteId: number; keywordId: number } } = {},
): Promise<TickResult> {
  const cycleId = randomUUID();
  const mode = options.mode ?? 'live';
  const pick = options.pick;

  // Before anything else: a pause that has run out is not a pause. Done here
  // rather than derived at read time so the sites table never says "paused"
  // over a site the scheduler is treating as active.
  const resumed = resumeExpiredPauses();
  if (resumed.length > 0) log.info(`pause expired, resuming: ${resumed.join(', ')}`);

  // The automation switch guards publishing. A dry run publishes nothing, and
  // "try a prompt before turning automation on" is the main thing it is for,
  // so it is not gated on that switch.
  //
  // Neither is a hand-picked run. The switch decides whether the scheduler
  // acts on its own; someone standing at the dashboard choosing a site and a
  // keyword has already made that decision themselves.
  if (mode === 'live' && !pick && !settings.getBool('automation_enabled')) {
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
    // A failure that is due to be tried again takes this slot ahead of new
    // work. It is cheaper — every completed step is reused — and leaving it
    // behind new work would mean a busy queue never retries anything.
    // A hand-picked run skips this: it was asked for by name, and handing its
    // slot to a queued retry would run something the person did not choose.
    const retry = mode === 'live' && !pick ? dueRetry() : undefined;
    if (retry) {
      releaseLock();
      log.info(`run ${retry.id}: automatic retry (attempt ${retry.attempts + 1})`);
      consumeRetry(retry.id);
      const result = await resumeRun(retry.id, settings, encryptionKey);
      await announce(settings);
      return { ...result, cycleId };
    }

    const timezone = settings.get('timezone');
    const now = new Date();
    const dayKey = localDateKey(now, timezone);

    // A hand-picked run goes straight to the pipeline. The selector's job is
    // to answer "what should run next", and that question has already been
    // answered by a person — running it anyway would only find reasons to
    // refuse a pair they can see on the screen in front of them: the site's
    // daily target, its interval since the last post, a keyword already used
    // elsewhere. Those pace the automation. They are not a veto over someone
    // asking for one article now.
    let task: { siteId: number; keywordId: number } | null = null;
    let decisions: Decision[] = [];

    if (pick) {
      task = { siteId: pick.siteId, keywordId: pick.keywordId };
    } else {
      const sites = loadSiteViews(dayKey, timezone);
      const keywords = loadKeywordViews();
      const links = loadLinkViews();
      const selection = selectTask(sites, keywords, links, { now, timezone });
      recordDecisions(cycleId, selection.decisions);
      task = selection.task;
      decisions = selection.decisions;
    }

    if (!task) {
      const reason = decisions.at(-1)?.reason ?? 'No valid pair';
      log.info(`nothing to publish: ${reason}`);
      await announce(settings);
      return { cycleId, outcome: 'no-task', detail: reason };
    }

    // Also checked on a productive tick, so "running low" is noticed while
    // there is still time to act rather than only once it has stopped.
    void announce(settings);

    const site = getSite(task.siteId);
    const keyword = getKeyword(task.keywordId);
    if (!site || !keyword) {
      return {
        cycleId,
        outcome: 'no-task',
        detail: pick ? 'That site or keyword no longer exists' : 'Selected site or keyword disappeared',
      };
    }

    log.info(
      `${pick ? 'hand-picked' : 'selected'} "${keyword.seed_keyword}" for ${site.domain}`,
    );

    // Recorded so the events log says why this ran, since no selector
    // decision explains it.
    if (pick) {
      recordDecisions(cycleId, [
        {
          subjectType: 'cycle',
          subjectId: null,
          subjectLabel: '',
          decision: 'eligible',
          reason: `Manual run: "${keyword.seed_keyword}" on ${site.domain}, chosen by hand`,
        },
      ]);
    }

    const runId = createRun(task.keywordId, task.siteId, mode);
    attachRunToLock(runId);

    const ctx = new PipelineContext({
      runId,
      site,
      keyword,
      settings,
      encryptionKey,
      shareImages: getLinkShare(keyword.id, site.id),
      mode,
    });
    const outcome = await withRunTimeout(executePipeline(ctx), settings, runId);

    const detail =
      outcome.status === 'failed'
        ? `${outcome.error ?? ''} ${considerRetry(
            runId,
            outcome.error ?? '',
            0,
            settings,
            task.siteId,
          )}`.trim()
        : (outcome.error ?? outcome.postUrl);

    return { cycleId, outcome: outcome.status, runId, detail, hold: outcome.hold };
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
    const runRow = get<{
      keyword_id: number | null;
      site_id: number | null;
      attempts: number;
      mode: 'live' | 'dry';
      hold: string;
    }>('SELECT keyword_id, site_id, attempts, mode, hold FROM runs WHERE id = ?', runId);
    if (!runRow?.site_id || !runRow.keyword_id) {
      return { cycleId, outcome: 'failed', detail: `Run ${runId} not found` };
    }

    const site = getSite(runRow.site_id);
    const keyword = getKeyword(runRow.keyword_id);
    if (!site || !keyword) {
      return { cycleId, outcome: 'failed', detail: 'Site or keyword no longer exists' };
    }

    run(
      `UPDATE runs SET status = 'running', error = NULL, failed_step = NULL,
         hold = '', retry_after = NULL
       WHERE id = ?`,
      runId,
    );
    attachRunToLock(runId);

    log.info(`resuming run ${runId}`);

    // Approving a held run means publishing it, so the resume is always live —
    // resuming a dry run is exactly the "publish it after all" action — and it
    // must not be stopped by the same gate a second time.
    const ctx = new PipelineContext({
      runId,
      site,
      keyword,
      settings,
      encryptionKey,
      shareImages: getLinkShare(keyword.id, site.id),
      mode: 'live',
      approved: true,
    });
    const outcome = await executePipeline(ctx);

    const detail =
      outcome.status === 'failed'
        ? `${outcome.error ?? ''} ${considerRetry(
            runId,
            outcome.error ?? '',
            runRow.attempts ?? 0,
            settings,
            runRow.site_id ?? undefined,
          )}`.trim()
        : (outcome.error ?? outcome.postUrl);

    return { cycleId, outcome: outcome.status, runId, detail, hold: outcome.hold };
  } finally {
    releaseLock();
  }
}

/**
 * The backstop for a run that keeps moving but never finishes.
 *
 * The step timeout catches one step that stops responding. This catches the
 * other shape: steps that each return in time, on a run that has been going
 * for an hour and is not going to stop on its own.
 */
async function withRunTimeout<T>(
  work: Promise<T>,
  settings: Settings,
  runId: number,
): Promise<T> {
  const minutes = Math.max(1, settings.getNumber('run_timeout_minutes'));
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Run ${runId} exceeded the ${minutes} minute run timeout`)),
          minutes * 60_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Reap a run whose process is gone.
 *
 * The two timeouts above only fire inside the process that started the run. A
 * container killed mid-run leaves the lock held and the run row saying
 * "running" forever — until now, for ninety minutes, with the dashboard
 * cheerfully reporting a run in progress and no way to clear it.
 *
 * Silence is the signal: the engine stamps the lock at every step, so a
 * heartbeat older than the step timeout means nothing is running any more.
 */
export function reapStalledRun(settings: Settings, now = new Date()): number | null {
  const lock = lockStatus();
  if (!lock?.locked_at) return null;

  const stallMinutes = Math.max(1, settings.getNumber('run_step_timeout_minutes')) + 5;
  const last = lock.heartbeat_at ?? lock.locked_at;
  const silentFor = now.getTime() - Date.parse(`${last.replace(' ', 'T')}Z`);

  if (!Number.isFinite(silentFor) || silentFor < stallMinutes * 60_000) return null;

  const minutes = Math.round(silentFor / 60_000);
  const reason =
    `Stalled: nothing happened for ${minutes} minutes. The run was abandoned — ` +
    `usually the container restarted mid-run. Resume it to carry on from the ` +
    `last completed step.`;

  log.warn(`run ${lock.run_id ?? '?'}: ${reason}`);

  if (lock.run_id) {
    markRunFailed(lock.run_id, reason, 'stalled');
    considerRetry(lock.run_id, reason, 0, settings);
  }
  releaseLock();

  return lock.run_id;
}

/**
 * Stop the run in progress, by hand.
 *
 * The pipeline itself cannot be interrupted — it is awaiting somebody else's
 * network call — so this marks the run failed and frees the lock, which is
 * what unblocks the scheduler and the dashboard. Any late reply from the work
 * still in flight lands on a run that is already closed and changes nothing.
 */
export function stopRun(reason = 'Stopped by hand from the dashboard'): number | null {
  const lock = lockStatus();
  if (!lock?.locked_at) return null;

  log.warn(`run ${lock.run_id ?? '?'} stopped by hand`);
  if (lock.run_id) markRunFailed(lock.run_id, reason, 'stopped');
  releaseLock();

  return lock.run_id;
}

/* -- Loop ---------------------------------------------------------------- */

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private announcedMinutes = 0;
  private lastCheckEndedAt = 0;

  constructor(
    private readonly settings: Settings,
    private readonly encryptionKey: Buffer,
    /** The work of one check. Replaceable so the cadence can be tested alone. */
    private readonly work: () => Promise<unknown> = async () => {
      // Before anything else: a lock held by a run that no longer exists is
      // not a run in progress, and leaving it would block every tick after it.
      reapStalledRun(this.settings);

      const result = await tick(this.settings, this.encryptionKey);
      if (result.outcome !== 'disabled' && result.outcome !== 'busy') {
        log.debug(`tick: ${result.outcome}`);
      }
      this.maybePrune();
    },
  ) {}

  start(): void {
    this.stopped = false;
    log.info(`scheduler started, checking every ${this.minutes()} minute(s)`);
    // Give the web server a moment to come up before the first check.
    this.timer = setTimeout(() => void this.safeTick(), 10_000);
  }

  /**
   * "Check every (minutes)", as it is now.
   *
   * Read before every wait rather than once at boot: this was a setInterval
   * built from the value at start-up, so saving a new number on the Settings
   * page changed nothing until the container restarted. A site set to post
   * every 5 minutes kept posting every 15, because nobody was looking in
   * between, and the page gave no sign that the number it showed was not the
   * one in force.
   */
  private minutes(): number {
    return Math.max(1, this.settings.getNumber('tick_minutes'));
  }

  /**
   * Wake at most a minute from now and see whether a check is due.
   *
   * Not one sleep for the whole period: a period armed at 15 minutes would
   * sit out the remaining fourteen after someone saved 1, which is the same
   * "nothing happened" the restart-only reading gave. Waking every minute
   * costs nothing and means a saved number is in force within a minute.
   */
  private scheduleNext(): void {
    if (this.stopped) return;
    const minutes = this.minutes();
    if (minutes !== this.announcedMinutes) {
      if (this.announcedMinutes) log.info(`scheduler now checking every ${minutes} minute(s)`);
      this.announcedMinutes = minutes;
    }
    const due = this.lastCheckEndedAt + minutes * 60_000;
    const wait = Math.max(0, Math.min(60_000, due - Date.now()));
    this.timer = setTimeout(() => {
      if (Date.now() >= this.lastCheckEndedAt + this.minutes() * 60_000) {
        void this.safeTick();
      } else {
        this.scheduleNext();
      }
    }, wait);
  }

  private async safeTick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.work();
    } catch (err) {
      log.error('scheduler tick threw', errorMessage(err));
    } finally {
      this.running = false;
      // Timed from the end of one check to the start of the next, so a long
      // run and the wait never overlap into a second run.
      this.lastCheckEndedAt = Date.now();
      this.scheduleNext();
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
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    log.info('scheduler stopped');
  }
}
