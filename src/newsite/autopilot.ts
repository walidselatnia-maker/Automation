import { all } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { parseImageSet } from './images.js';
import { notReadyReason, queuePublish, type PublishDeps } from './publish.js';
import { isMainSlot, queuePictures, type PictureRow } from './pictures.js';
import { listNewWebsites, type NewWebsiteRow } from './repo.js';
import type { SeoRow } from './seo.js';

/**
 * Automation for the new websites: with the platform's Automation switch on
 * (Platform settings, also shown at the top of the Dashboard), every active
 * website runs without anyone pressing a button.
 *
 * Its articles are already written as soon as keywords are added (the AI
 * steps run by themselves). Autopilot does the rest, checked every minute:
 * - pictures: the main pictures of the next articles in line are made, one
 *   day's worth ahead (Posts per day, or 3 when there is no target), so Flow
 *   is never asked for a whole backlog at once;
 * - publishing: on "Publish automatically", one article at a time, never
 *   more than Posts per day in the platform's timezone, and at least the gap
 *   after the previous one. On "Wait for my approval" the pictures are made
 *   and the article waits for the Publish button.
 * Social posts and reels follow each publish on the website's channels, as
 * they already do.
 *
 * An article whose picture failed is passed over (it shows as failed on the
 * Images step, with Try again), so one bad picture never stops the website.
 */

const log = createLogger('newsite-autopilot');

const AHEAD_WITHOUT_TARGET = 3;

export interface AutopilotState {
  /** Articles with every main picture made, waiting to be published. */
  ready: number;
  /** Articles still being written or getting their pictures. */
  preparing: number;
  /** Articles published today, in the platform's timezone. */
  today: number;
  /** One line on what happens next. */
  next: string;
}

interface SiteWork {
  rows: SeoRow[];
  pictures: Map<number, PictureRow[]>;
}

function siteWork(siteId: number): SiteWork {
  const rows = all<SeoRow>(
    `SELECT s.* FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id WHERE p.website_id = ? ORDER BY s.plan_id, s.position`,
    siteId,
  );
  // Only pictures of each article's prompts as they are now: one left from an older prompt counts for nothing.
  const current = new Map(rows.map((r) => [r.id, new Map((r.images_status === 'done' ? parseImageSet(r.images_json)?.images ?? [] : []).map((im) => [im.slot, im.prompt]))]));
  const pictures = new Map<number, PictureRow[]>();
  for (const p of all<PictureRow>(
    `SELECT * FROM newsite_pictures WHERE seo_id IN (SELECT s.id FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id WHERE p.website_id = ?)`,
    siteId,
  )) {
    if (!isMainSlot(p.slot) || current.get(p.seo_id)?.get(p.slot) !== p.prompt) continue;
    pictures.set(p.seo_id, [...(pictures.get(p.seo_id) ?? []), p]);
  }
  return { rows, pictures };
}

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

function look(site: NewWebsiteRow, work: SiteWork, now: number, tz: string) {
  const pics = (r: SeoRow) => work.pictures.get(r.id) ?? [];
  const waiting = work.rows.filter((r) => r.post_status !== 'published');
  const stuck = (r: SeoRow) => pics(r).some((p) => p.status === 'failed') || r.post_status === 'failed';
  const started = (r: SeoRow) => pics(r).length > 0;
  const ready = waiting.filter((r) => !stuck(r) && r.post_status !== 'publishing' && !notReadyReason(r, pics(r)));
  const posted = work.rows.filter((r) => r.post_status === 'published' && r.posted_at).map((r) => sqlTime(r.posted_at));
  const today = posted.filter((t) => dayKey(t, tz) === dayKey(now, tz)).length;
  const last = posted.length ? Math.max(...posted) : 0;
  const due = last + site.interval_minutes * 60_000;
  return {
    pics,
    stuck,
    started,
    waiting,
    ready,
    today,
    due,
    full: site.daily_target > 0 && today >= site.daily_target,
    publishing: work.rows.some((r) => r.post_status === 'publishing'),
    ahead: site.daily_target > 0 ? site.daily_target : AHEAD_WITHOUT_TARGET,
  };
}

/** One minute of automation for every active website, while the platform's Automation switch is on. */
export function autopilotTick(deps: PublishDeps, now = Date.now()): void {
  if (!deps.settings.getBool('automation_enabled')) return;
  const tz = deps.settings.get('timezone') || 'UTC';
  let queued = 0;
  for (const site of listNewWebsites()) {
    if (site.status !== 'active') continue;
    const work = siteWork(site.id);
    const s = look(site, work, now, tz);

    // Pictures, one day's worth ahead of publishing.
    let lane = s.waiting.filter((r) => s.started(r) && !s.stuck(r)).length;
    for (const r of s.waiting) {
      if (lane >= s.ahead) break;
      if (r.images_status !== 'done' || s.started(r) || s.stuck(r)) continue;
      const n = queuePictures(r.id, deps.dataDir);
      if (n) {
        log.info(`Autopilot: making the pictures of "${r.keyword}" on ${site.domain}.`);
        queued += n;
        lane += 1;
      }
    }

    // Publishing, by Posts per day and the gap.
    if (!site.auto_publish || s.publishing || s.full || now < s.due) continue;
    const next = s.ready[0];
    if (next) {
      log.info(`Autopilot: publishing "${next.keyword}" on ${site.domain}.`);
      void queuePublish(next.id, deps);
    }
  }
  if (queued) deps.startPictures?.();
}

/** Where a website's Autopilot stands, for the dashboard and the Keywords page. */
export function autopilotState(site: NewWebsiteRow, tz: string, now = Date.now()): AutopilotState {
  const s = look(site, siteWork(site.id), now, tz);
  const textFailed = (r: SeoRow) =>
    [r.status, r.recipe_status, r.skeleton_status, r.article_status, r.images_status].includes('failed');
  const stopped = s.waiting.filter((r) => s.stuck(r) || textFailed(r));
  const going = s.waiting.filter((r) => !stopped.includes(r) && !s.ready.includes(r));
  const writing = going.filter((r) => r.images_status !== 'done');
  const picturing = going.filter((r) => r.images_status === 'done' && s.started(r));
  // Written, pictures not started yet: they start on the next minute, one day's worth at a time.
  const queued = going.filter((r) => r.images_status === 'done' && !s.started(r));
  const base = { ready: s.ready.length, preparing: going.length, today: s.today };
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  const stoppedNote = stopped.length ? ` · ${plural(stopped.length, 'article')} stopped` : '';
  let next: string;
  if (site.status !== 'active') next = 'Paused';
  else if (!site.auto_publish) next = s.ready.length ? `${s.ready.length} waiting for your approval` : 'Pictures are made, then each article waits for your approval';
  else if (!s.ready.length) {
    if (picturing.length) next = `Making the pictures of ${plural(picturing.length, 'article')}${stoppedNote}`;
    else if (queued.length) next = `Pictures start within a minute${stoppedNote}`;
    else if (writing.length) next = `Writing ${plural(writing.length, 'article')}${stoppedNote}`;
    else if (stopped.length) next = `${plural(stopped.length, 'article')} stopped: open Keywords & articles`;
    else next = 'No keywords left: add keywords';
  } else if (s.full) next = `Next article tomorrow${stoppedNote}`;
  else if (s.due > now) next = `Next article at ${clock(s.due, tz)}${stoppedNote}`;
  else next = `Next article in a minute${stoppedNote}`;
  return { ...base, next };
}
