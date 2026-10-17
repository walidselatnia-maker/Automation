import { all, run } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { CATCH_UP_DAYS, takesReels, websiteChannels } from './channels.js';
import { createReels } from './reels.js';
import { listNewWebsites } from './repo.js';
import { createSocialPosts } from './social.js';

/**
 * Each website decides where its articles are shared: which channels, and
 * for each one whether it gets image posts, reels or both. This keeps the
 * sharing pipeline in line with that choice, whenever it changes.
 *
 * - A channel added to a website, or set to get image posts or reels there,
 *   gets the posts and reels of the website's recent articles that it never
 *   had: articles published, and reels made, in the last CATCH_UP_DAYS.
 *   Older content is left alone, so a new channel never floods with a back
 *   catalogue. A reel is queued for a recent article that has none yet once
 *   one of its channels takes reels.
 * - A channel taken off a website, or no longer set to get that kind of post,
 *   loses what had not gone out yet. What already went out stays as it was.
 *
 * It runs after a website's channels are saved, after a channel's websites or
 * what it posts are saved, at start and every few minutes.
 */

const log = createLogger('newsite-sharing-sync');

export { CATCH_UP_DAYS };
const SINCE = `-${CATCH_UP_DAYS} days`;

export interface SyncResult {
  added: number;
  removed: number;
}

export function syncSharing(): SyncResult {
  let added = 0;
  let removed = 0;
  for (const site of listNewWebsites()) {
    const channels = websiteChannels(site.id);
    const seoIds = `SELECT s.id FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id WHERE p.website_id = ${Number(site.id)}`;

    // Wanted, and not there yet.
    const recent = all<{ id: number }>(
      `SELECT s.id FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id
        WHERE p.website_id = ? AND s.post_status = 'published' AND s.posted_at >= datetime('now', ?)`,
      site.id, SINCE,
    );
    for (const a of recent) added += createSocialPosts(a.id) + createReels(a.id);
    const reelChannels = channels.filter((c) => c.post_reel && takesReels(c.platform));
    if (reelChannels.length) {
      const reels = all<{ id: number }>(
        `SELECT id FROM newsite_reels WHERE status = 'done' AND done_at >= datetime('now', ?) AND seo_id IN (${seoIds})`,
        SINCE,
      );
      for (const r of reels) {
        for (const c of reelChannels) added += run('INSERT OR IGNORE INTO newsite_reel_shares (reel_id, channel_id) VALUES (?, ?)', r.id, c.id).changes;
      }
    }

    // No longer wanted, and not gone out yet.
    removed += run(
      `DELETE FROM newsite_social_posts WHERE status <> 'sent' AND seo_id IN (${seoIds})
         AND channel_id NOT IN (SELECT channel_id FROM newsite_website_channels WHERE website_id = ? AND post_image = 1)`,
      site.id,
    ).changes;
    removed += run(
      `DELETE FROM newsite_reel_shares WHERE status <> 'sent'
         AND reel_id IN (SELECT id FROM newsite_reels WHERE seo_id IN (${seoIds}))
         AND channel_id NOT IN (SELECT channel_id FROM newsite_website_channels WHERE website_id = ? AND post_reel = 1)`,
      site.id,
    ).changes;
  }
  if (added || removed) log.info(`sharing brought in line with the websites: ${added} added, ${removed} no longer wanted`);
  return { added, removed };
}

let afterChange: (() => void) | null = null;

/** What runs after a change is synced (the posters woken); set by the sharing routes. */
export function onSharingChanged(listener: (() => void) | null): void {
  afterChange = listener;
}

/** A website's or a channel's sharing choice was saved: bring everything in line, then get it moving. */
export function sharingChanged(): SyncResult {
  const result = syncSharing();
  afterChange?.();
  return result;
}
