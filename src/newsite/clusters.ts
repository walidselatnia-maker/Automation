import { all } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { listPosts, patchPost, type Fetch, type SitePost } from './client.js';
import { clusterFields, pillarSeoId } from './publish.js';
import { listNewWebsites, websiteApiKey } from './repo.js';

/**
 * Keeps each website's topic clusters right for articles already published:
 * every post of a plan carries its label (pillar, or sub with its pillar), so
 * the site links them to each other. Posts published before the site knew
 * clusters get their label here; a post that already has the right one is left
 * alone. A site too old to know clusters is skipped until it is updated.
 * Pillars go first, so their sub-articles find them.
 */

const log = createLogger('newsite-clusters');

interface PublishedRow {
  id: number;
  plan_id: number;
  role: 'pillar' | 'sub';
  post_id: number;
}

/** Whether the post on the site already carries what the keyword says. */
function isRight(post: SitePost, want: ReturnType<typeof clusterFields>, pillarPostId: number | null): boolean {
  if (!('clusterRole' in want)) return true;
  if (post.clusterRole !== want.clusterRole) return false;
  if (want.clusterRole === 'pillar') return true;
  return post.pillarRef === want.pillar || (pillarPostId !== null && post.pillarId === pillarPostId);
}

export async function syncClusters(deps: { encryptionKey: Buffer; fetchImpl?: Fetch }): Promise<{ marked: number; failed: number }> {
  let marked = 0;
  let failed = 0;
  for (const site of listNewWebsites()) {
    const rows = all<PublishedRow>(
      `SELECT s.id, s.plan_id, s.role, s.post_id FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id
        WHERE p.website_id = ? AND s.post_status = 'published' AND s.post_id IS NOT NULL
        ORDER BY s.role = 'pillar' DESC, s.id`,
      site.id,
    );
    if (!rows.length) continue;
    const apiKey = websiteApiKey(site, deps.encryptionKey);
    let posts: SitePost[];
    try {
      posts = await listPosts(site.domain, apiKey, deps.fetchImpl);
    } catch (err) {
      log.warn(`Could not check the topic clusters of ${site.domain}: ${errorMessage(err)}`);
      continue;
    }
    if (posts.length && !posts.some((p) => 'clusterRole' in p)) continue;
    const byId = new Map(posts.map((p) => [Number(p.id), p]));
    const postIdOf = new Map(rows.map((r) => [r.id, r.post_id]));
    for (const row of rows) {
      const post = byId.get(row.post_id);
      if (!post) continue;
      const want = clusterFields(row);
      const pillar = pillarSeoId(row.plan_id);
      if (isRight(post, want, pillar ? (postIdOf.get(pillar) ?? null) : null)) continue;
      try {
        await patchPost(site.domain, apiKey, row.post_id, want, deps.fetchImpl);
        marked += 1;
      } catch (err) {
        failed += 1;
        log.warn(`Could not mark post ${row.post_id} on ${site.domain} in its topic cluster: ${errorMessage(err)}`);
      }
    }
  }
  if (marked || failed) log.info(`Topic clusters: ${marked} post(s) marked, ${failed} failed.`);
  return { marked, failed };
}
