import { createHash } from 'node:crypto';
import { get } from '../db/index.js';
import type { NewWebsiteRow } from './repo.js';

/**
 * The wait between two posts of a website.
 *
 * Articles: the website's fixed gap (interval_minutes), or, when its random
 * gap is set (random_gap_to > 0), a random time from random_gap_from to
 * random_gap_to minutes. Social posts and reels: nothing, or, when the
 * website's social random gap is set, a random time in that range between two
 * things it sends one channel.
 *
 * The random time is drawn from the last post's own moment, so it is the same
 * at every look until the next post goes out: a wait is drawn once, never
 * again each minute.
 */

/** A number from 0 (inclusive) to 1 (exclusive), the same for the same seed. */
export function seededUnit(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) / 2 ** 32;
}

/** A whole number of minutes from `from` to `to`, both included, the same for the same seed. */
export function randomGapMinutes(from: number, to: number, seed: string): number {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.max(from, to);
  return lo + Math.floor(seededUnit(seed) * (hi - lo + 1));
}

type GapSite = Pick<NewWebsiteRow, 'id' | 'interval_minutes' | 'random_gap_from' | 'random_gap_to'>;

/** Minutes a website waits after the article it published at `lastMs`. */
export function articleGapMinutes(site: GapSite, lastMs: number): number {
  if (!(site.random_gap_to > 0)) return site.interval_minutes;
  return randomGapMinutes(site.random_gap_from, site.random_gap_to, `article:${site.id}:${lastMs}`);
}

type SocialGapSite = Pick<NewWebsiteRow, 'id' | 'social_gap_from' | 'social_gap_to'>;

/** When a website may next send something to a channel, given the last thing it sent there (ms); 0 = now. */
export function socialDueAt(site: SocialGapSite, channelId: number, lastMs: number): number {
  if (!(site.social_gap_to > 0) || !lastMs) return 0;
  return lastMs + randomGapMinutes(site.social_gap_from, site.social_gap_to, `social:${site.id}:${channelId}:${lastMs}`) * 60_000;
}

/** An SQLite datetime('now') value (UTC) in ms. */
const sqlTime = (value: string | null | undefined): number => (value ? Date.parse(`${value.replace(' ', 'T')}Z`) : 0);

/** The last image post or reel a website sent a channel (ms), or 0. */
export function lastSocialSent(siteId: number, channelId: number): number {
  const seoIds = 'SELECT s.id FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id WHERE p.website_id = ?';
  const row = get<{ at: string | null }>(
    `SELECT MAX(at) AS at FROM (
       SELECT sent_at AS at FROM newsite_social_posts WHERE status = 'sent' AND channel_id = ? AND seo_id IN (${seoIds})
       UNION ALL
       SELECT r.sent_at AS at FROM newsite_reel_shares r JOIN newsite_reels v ON v.id = r.reel_id
        WHERE r.status = 'sent' AND r.channel_id = ? AND v.seo_id IN (${seoIds}))`,
    channelId, siteId, channelId, siteId,
  );
  return sqlTime(row?.at);
}
