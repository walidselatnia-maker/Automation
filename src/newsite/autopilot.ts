import { all, get, run } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { parseImageSet } from './images.js';
import { notReadyReason, publishQueued, queuePublish, type PublishDeps } from './publish.js';
import { isMainSlot, queuePictures, retryFailedPictures, type PictureRow } from './pictures.js';
import { getNewWebsite, listNewWebsites, type NewWebsiteRow } from './repo.js';
import { retriesOf, type StepName } from './retries.js';
import { queueNotStartedSteps, type SeoRow } from './seo.js';

/**
 * Automation for the new websites: the one place that decides which keyword
 * is worked on, and when. Checked every minute, and right after anything
 * that moves the keyword on (a step written, its pictures made).
 *
 * One keyword at a time, across the whole platform. The keyword Automation
 * is working on is marked (keyword_seo.auto_active); the writer and the
 * picture maker only work on that one (and on a Generate now keyword), so
 * no other keyword is written or pictured meanwhile. Its pipeline:
 *
 *   1. Waiting in line. The next one is the first keyword, in the order the
 *      Keywords page shows (oldest main keyword first, its pillar then its
 *      sub-keywords), of a website whose turn has come: Automation is ON,
 *      the website is active, its gap since its last published article has
 *      passed, and it has not reached its posts per day.
 *   2. Writing: SEO, recipe, outline, article, image prompts (seo.ts).
 *   3. Pictures: its main pictures, made straight away (pictures.ts). No
 *      approval is asked for pictures.
 *   4. Publishing. On "Publish automatically" it goes out at once (its
 *      gap has passed: that is how it got its turn). On "Wait for my
 *      approval" it waits, with everything else, for its Publish button;
 *      pressing it is the approval, and the line moves on once it is out.
 *   5. Done: published. The next keyword gets its turn when its website's
 *      gap and posts per day allow it.
 *
 * Strict order: a website's next keyword is always its first one not
 * published yet. No later keyword of that website starts before it is out.
 *
 * Failure: a writing step the AI could not do, or a main picture that could
 * not be made, is tried again by the platform's retry settings (retries.ts),
 * and the keyword keeps its turn while a try is left. When none is (or the
 * publish failed), the keyword is stopped: it keeps its failed step, with Try
 * again, and its website's line waits for it (other websites carry on).
 * Pressing Try again carries it on from its failed step.
 *
 * Turning Automation off: the step being done right now (one AI answer, one
 * picture, one publish) finishes and is kept; nothing after it starts. The
 * keyword keeps its turn, and carries on from that step when it is turned
 * on again, by the same gap and posts per day.
 *
 * Generate now (generate-now.ts) is the owner's own: it runs whatever the
 * switch says, and while it runs, Automation starts no new keyword.
 * Every start, finish and stop is kept in newsite_automation_log.
 */

const log = createLogger('newsite-autopilot');

/** How long after Automation is turned on the first check runs. */
export const START_DELAY_MS = 30_000;
/** When Automation was last turned on (ms), kept across restarts. */
export const AUTOMATION_ON_AT = 'newsite_automation_on_at';
export const automationOnAt = (settings: Settings): number => Number(settings.get(AUTOMATION_ON_AT) || 0);
/** The new dashboard's own Automation switch: separate from the old dashboard's automation_enabled. */
export const AUTOMATION_KEY = 'newsite_automation_enabled';
export const automationOn = (settings: Settings | undefined): boolean => settings?.get(AUTOMATION_KEY) === 'true';

export interface AutopilotState {
  /** Articles with every main picture made, waiting to be published. */
  ready: number;
  /** Articles not published yet that are neither ready nor stopped. */
  preparing: number;
  /** Articles published today, in the platform's timezone. */
  today: number;
  /** One line on what happens next. */
  next: string;
}

export interface ConductorDeps extends PublishDeps {
  /** Wakes the writer, for the keyword whose turn it is. */
  startWriter?: () => void;
}

/* -- Small helpers ----------------------------------------------------------- */

const dayKey = (ms: number, tz: string): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
};

/** An SQLite datetime('now') value (UTC) in ms. */
const sqlTime = (value: string | null | undefined): number => (value ? Date.parse(`${value.replace(' ', 'T')}Z`) : 0);

const clock = (ms: number, tz: string): string => {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
};

/** One line of the automation history. */
function remember(seoId: number, event: string, note = ''): void {
  run('INSERT INTO newsite_automation_log (seo_id, event, note) VALUES (?, ?, ?)', seoId, event, note.slice(0, 400));
}

export interface LogLine {
  at: string;
  seo_id: number;
  event: string;
  note: string;
}
export const automationLog = (): LogLine[] => all<LogLine>('SELECT at, seo_id, event, note FROM newsite_automation_log ORDER BY id');

/** A website's keywords, in line order: oldest main keyword first, its pillar then its sub-keywords. */
const siteRows = (siteId: number): SeoRow[] =>
  all<SeoRow>(`SELECT s.* FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id WHERE p.website_id = ? ORDER BY s.plan_id, s.position`, siteId);

const siteOf = (row: SeoRow): NewWebsiteRow | undefined => {
  const plan = get<{ website_id: number }>('SELECT website_id FROM keyword_plans WHERE id = ?', row.plan_id);
  return plan ? getNewWebsite(plan.website_id) : undefined;
};

/** A keyword's main pictures, from its image prompts as they are now: one left from an older prompt counts for nothing. */
function mainPictures(row: SeoRow): PictureRow[] {
  const prompts = new Map((row.images_status === 'done' ? parseImageSet(row.images_json)?.images ?? [] : []).map((im) => [im.slot, im.prompt]));
  return all<PictureRow>('SELECT * FROM newsite_pictures WHERE seo_id = ? ORDER BY position', row.id).filter(
    (p) => isMainSlot(p.slot) && prompts.get(p.slot) === p.prompt,
  );
}

const TEXT_STEPS: [StepName, keyof SeoRow][] = [
  ['seo', 'status'],
  ['recipe', 'recipe_status'],
  ['skeleton', 'skeleton_status'],
  ['article', 'article_status'],
  ['images', 'images_status'],
];

/**
 * Why a keyword is stopped, or '' when it is not: a failed writing step with
 * no automatic try left, a failed main picture, or a failed publish.
 */
export function stoppedReason(row: SeoRow, settings: Settings): string {
  const failed = TEXT_STEPS.find(([, column]) => row[column] === 'failed');
  if (failed) {
    const left = settings.getBool('auto_retry_enabled') && (retriesOf(row)[failed[0]] ?? 0) < Math.max(0, settings.getNumber('auto_retry_max'));
    return left ? '' : `The ${failed[0]} step failed.`;
  }
  if (mainPictures(row).some((p) => p.status === 'failed') && pictureTriesLeft(row, settings) <= 0) return 'A picture failed.';
  if (row.post_status === 'failed') return `Publishing failed: ${row.post_error}`;
  return '';
}

/** Automatic picture tries a keyword has left: the platform's retry settings, counted in the automation history. */
function pictureTriesLeft(row: SeoRow, settings: Settings): number {
  if (!settings.getBool('auto_retry_enabled')) return 0;
  const used = get<{ n: number }>(`SELECT COUNT(*) AS n FROM newsite_automation_log WHERE seo_id = ? AND event = 'pictures again'`, row.id)?.n ?? 0;
  return Math.max(0, settings.getNumber('auto_retry_max')) - used;
}

/** When a website may start its next keyword, and whether today's posts per day are reached. */
function schedule(site: NewWebsiteRow, rows: SeoRow[], now: number, tz: string): { due: number; full: boolean; today: number } {
  const posted = rows.filter((r) => r.post_status === 'published' && r.posted_at).map((r) => sqlTime(r.posted_at));
  const last = posted.length ? Math.max(...posted) : 0;
  const today = posted.filter((t) => dayKey(t, tz) === dayKey(now, tz)).length;
  return { due: last ? last + site.interval_minutes * 60_000 : 0, full: site.daily_target > 0 && today >= site.daily_target, today };
}

/** The keyword Automation is working on, if any. */
export const activeKeyword = (): SeoRow | undefined => get<SeoRow>('SELECT * FROM keyword_seo WHERE auto_active = 1 ORDER BY id LIMIT 1');

/** A Generate now keyword still under way holds the line: one keyword at a time. */
const generateNowBusy = (settings: Settings): boolean =>
  all<SeoRow>(`SELECT * FROM keyword_seo WHERE generate_now = 1 AND COALESCE(post_status, '') != 'published'`).some((r) => !stoppedReason(r, settings));

/**
 * A website's keyword whose turn it is: its first one not published yet, in
 * the Keywords page's order. None while that one is stopped, being
 * published, or under way through Generate now: the line waits for it, and
 * no later keyword goes ahead of it.
 */
function firstInLine(rows: SeoRow[], settings: Settings): SeoRow | undefined {
  const first = rows.find((r) => r.post_status !== 'published');
  if (!first || first.post_status === 'publishing' || first.generate_now || stoppedReason(first, settings)) return undefined;
  return first;
}

/* -- The conductor --------------------------------------------------------- */

/** Ends the active keyword's turn. */
function release(row: SeoRow, event: string, note = ''): void {
  run('UPDATE keyword_seo SET auto_active = 0 WHERE id = ?', row.id);
  remember(row.id, event, note);
  log.info(`Automation: "${row.keyword}" ${event}${note ? `: ${note}` : ''}.`);
}

/** Move the active keyword one stage on: writing, pictures, publishing. */
function advance(row: SeoRow, site: NewWebsiteRow, deps: ConductorDeps, now: number, tz: string): void {
  if (row.post_status === 'publishing' || publishQueued(row.id)) return;
  if (row.images_status !== 'done') {
    // Still being written: make sure its next step is queued and the writer is awake.
    queueNotStartedSteps();
    deps.startWriter?.();
    return;
  }
  const pictures = mainPictures(row);
  if (pictures.some((p) => p.status === 'failed')) {
    // stoppedReason let it through: an automatic try is left.
    if (retryFailedPictures({ seoId: row.id })) remember(row.id, 'pictures again');
    deps.startPictures?.();
    return;
  }
  const wanted = (parseImageSet(row.images_json)?.images ?? []).filter((im) => isMainSlot(im.slot)).length;
  if (pictures.length < wanted || pictures.some((p) => p.status === 'queued' || p.status === 'making')) {
    if (queuePictures(row.id, deps.dataDir)) remember(row.id, 'pictures', `${wanted} main pictures`);
    deps.startPictures?.();
    return;
  }
  if (notReadyReason(row, pictures)) return;
  // Every main picture made: publish, or wait for the Publish button.
  if (!site.auto_publish) return;
  const s = schedule(site, siteRows(site.id), now, tz);
  if (s.full || now < s.due) return;
  remember(row.id, 'publishing');
  log.info(`Automation: publishing "${row.keyword}" on ${site.domain}.`);
  void queuePublish(row.id, deps);
}

/**
 * One look by the conductor: carry the active keyword on, or end its turn
 * and give the next keyword in line its turn. Calling it again and again
 * changes nothing until something has moved: it is safe from every trigger.
 */
export function autopilotTick(deps: ConductorDeps, now = Date.now()): void {
  if (!automationOn(deps.settings)) return;
  const tz = deps.settings.get('timezone') || 'UTC';

  const active = activeKeyword();
  if (active) {
    const site = siteOf(active);
    if (!site || site.status !== 'active') return release(active, 'paused', 'Its website is paused or gone.');
    if (active.post_status === 'published') release(active, 'published', active.post_url);
    else {
      const stopped = stoppedReason(active, deps.settings);
      if (stopped) release(active, 'stopped', stopped);
      else return advance(active, site, deps, now, tz);
    }
  }
  if (generateNowBusy(deps.settings)) return;

  // The website whose turn came first, then its first keyword in line.
  let pick: { row: SeoRow; site: NewWebsiteRow; due: number } | null = null;
  for (const site of listNewWebsites()) {
    if (site.status !== 'active') continue;
    const rows = siteRows(site.id);
    const s = schedule(site, rows, now, tz);
    if (s.full || now < s.due) continue;
    const row = firstInLine(rows, deps.settings);
    if (row && (!pick || s.due < pick.due || (s.due === pick.due && site.id < pick.site.id))) pick = { row, site, due: s.due };
  }
  if (!pick) return;
  run('UPDATE keyword_seo SET auto_active = 1 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM keyword_seo WHERE auto_active = 1)', pick.row.id);
  remember(pick.row.id, 'started', pick.site.domain);
  log.info(`Automation: starting "${pick.row.keyword}" on ${pick.site.domain}.`);
  advance({ ...pick.row, auto_active: 1 }, pick.site, deps, now, tz);
}

/* -- What the dashboard says ------------------------------------------------- */

/** Which stage a keyword is at, in words. */
function stage(row: SeoRow, site: NewWebsiteRow, due: number, now: number, tz: string): string {
  if (row.post_status === 'publishing' || publishQueued(row.id)) return `Publishing “${row.keyword}”`;
  if (row.images_status !== 'done') return `Writing “${row.keyword}”`;
  if (notReadyReason(row, mainPictures(row))) return `Making the pictures of “${row.keyword}”`;
  if (!site.auto_publish) return `“${row.keyword}” is waiting for your approval: press Publish`;
  return due > now ? `“${row.keyword}” goes out at ${clock(due, tz)}` : `Publishing “${row.keyword}” within a minute`;
}

/** Where a website's Automation stands, for the dashboard and the Keywords page. */
export function autopilotState(site: NewWebsiteRow, tz: string, now = Date.now(), _onAt = 0, settings?: Settings): AutopilotState {
  const rows = siteRows(site.id);
  const s = schedule(site, rows, now, tz);
  const stoppedOf = (r: SeoRow) => (settings ? stoppedReason(r, settings) : r.post_status === 'failed' ? 'failed' : '');
  const waiting = rows.filter((r) => r.post_status !== 'published');
  const stopped = waiting.filter((r) => stoppedOf(r));
  const ready = waiting.filter((r) => !stoppedOf(r) && r.post_status !== 'publishing' && !notReadyReason(r, mainPictures(r)));
  const base = { ready: ready.length, preparing: waiting.length - ready.length - stopped.length, today: s.today };
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const stoppedNote = stopped.length ? ` · ${plural(stopped.length, 'article')} stopped` : '';

  const active = activeKeyword();
  let next: string;
  if (site.status !== 'active') next = 'Paused';
  else if (active && rows.some((r) => r.id === active.id)) next = `${stage(active, site, s.due, now, tz)}${stoppedNote}`;
  else if (waiting[0] && stoppedOf(waiting[0])) next = `“${waiting[0].keyword}” stopped: press Try again. The next keywords wait for it`;
  else if (!waiting.some((r) => !stoppedOf(r) && r.post_status !== 'publishing' && !r.generate_now)) {
    next = stopped.length ? `${plural(stopped.length, 'article')} stopped: open Keywords & articles` : 'No keywords left: add keywords';
  } else if (active) next = `Waits for its turn: one keyword at a time (now “${active.keyword}”)${stoppedNote}`;
  else if (s.full) next = `Next keyword tomorrow${stoppedNote}`;
  else if (s.due > now) {
    // The next in line may be made already (before Automation ran it): it still waits for the gap.
    const first = waiting[0];
    next = first && ready.includes(first)
      ? `“${first.keyword}” is ready and goes out at ${clock(s.due, tz)}, when the website’s gap has passed${stoppedNote}`
      : `Next keyword starts at ${clock(s.due, tz)}${stoppedNote}`;
  }
  else next = `Next keyword starts within a minute${stoppedNote}`;
  return { ...base, next };
}
