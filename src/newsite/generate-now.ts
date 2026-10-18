import { all, run } from '../db/index.js';
import { createLogger } from '../lib/logger.js';
import { notReadyReason, queuePublish, type PublishDeps } from './publish.js';
import { isMainSlot, listPictures, queuePictures, retryFailedPictures } from './pictures.js';
import { listNewWebsites } from './repo.js';
import { getSeoRow, type SeoRow } from './seo.js';

/**
 * Generate now: the Dashboard button that takes one chosen keyword (a
 * pillar or a sub-keyword) of one website from the start to a published
 * article, ahead of everything else, whatever the Automation switch says.
 *
 * The keyword is marked (keyword_seo.generate_now) and every queue puts it
 * first: the writer, the picture maker. Any step that failed is tried again.
 * Once its main pictures are made it is published, then the mark is cleared.
 */

const log = createLogger('newsite-generate-now');

/** A website's keywords not published yet, in the order the platform would write them. */
export interface GenerateChoice {
  websiteId: number;
  websiteName: string;
  keywords: { id: number; keyword: string; role: 'pillar' | 'sub'; pillar: string }[];
}

export function generateChoices(): GenerateChoice[] {
  return listNewWebsites().map((w) => ({
    websiteId: w.id,
    websiteName: w.name,
    keywords: all<{ id: number; keyword: string; role: 'pillar' | 'sub'; pillar: string }>(
      `SELECT s.id, s.keyword, s.role, p.pillar FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id
        WHERE p.website_id = ? AND COALESCE(s.post_status, '') NOT IN ('published', 'publishing')
        ORDER BY s.plan_id, s.position`,
      w.id,
    ),
  }));
}

/** Mark one keyword and put every failed step of it back in its queue. */
export function startGenerateNow(seoId: number): SeoRow | undefined {
  const row = getSeoRow(seoId);
  if (!row || row.post_status === 'published' || row.post_status === 'publishing') return undefined;
  run(`UPDATE keyword_seo SET generate_now = 1, retry_step = '', retry_at = NULL WHERE id = ?`, seoId);
  if (row.status === 'failed') run(`UPDATE keyword_seo SET status = 'pending', problems = '' WHERE id = ?`, seoId);
  for (const step of ['recipe', 'skeleton', 'article', 'images'] as const) {
    run(`UPDATE keyword_seo SET ${step}_status = 'pending', ${step}_problems = '' WHERE id = ? AND ${step}_status = 'failed'`, seoId);
  }
  if (row.post_status === 'failed') run(`UPDATE keyword_seo SET post_status = '', post_error = '' WHERE id = ?`, seoId);
  retryFailedPictures({ seoId });
  log.info(`Generate now: "${row.keyword}".`);
  return getSeoRow(seoId);
}

/**
 * Carry every marked keyword one step further: its main pictures once it is
 * written, publishing once they are made. Runs every minute and on the click.
 */
export function generateNowTick(deps: PublishDeps & { dataDir?: string; startPictures?: () => void }): void {
  let queued = 0;
  for (const row of all<SeoRow>(`SELECT * FROM keyword_seo WHERE generate_now = 1`)) {
    if (row.post_status === 'published') {
      run(`UPDATE keyword_seo SET generate_now = 0 WHERE id = ?`, row.id);
      continue;
    }
    if (row.images_status !== 'done' || row.post_status === 'publishing' || row.post_status === 'failed') continue;
    const pictures = listPictures(row.id).filter((p) => isMainSlot(p.slot));
    if (!pictures.length) {
      queued += queuePictures(row.id, deps.dataDir);
      continue;
    }
    if (!notReadyReason(row, listPictures(row.id))) {
      log.info(`Generate now: publishing "${row.keyword}".`);
      void queuePublish(row.id, deps);
    }
  }
  if (queued) deps.startPictures?.();
}

/** Where a Generate now keyword stands, for the Dashboard. */
export function generateNowLines(): { keyword: string; site: string; step: string }[] {
  return all<SeoRow & { site: string }>(
    `SELECT s.*, w.name AS site FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id JOIN new_websites w ON w.id = p.website_id
      WHERE s.generate_now = 1 ORDER BY s.id`,
  ).map((r) => {
    const failed = [r.status, r.recipe_status, r.skeleton_status, r.article_status, r.images_status, r.post_status].includes('failed');
    const pics = listPictures(r.id).filter((p) => isMainSlot(p.slot));
    const step = failed || pics.some((p) => p.status === 'failed')
      ? 'stopped: open Keywords & articles'
      : r.post_status === 'publishing' ? 'publishing'
      : r.images_status === 'done' ? 'making the pictures'
      : 'writing';
    return { keyword: r.keyword, site: r.site, step };
  });
}

