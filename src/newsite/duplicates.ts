import { all, get, run } from '../db/index.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { listPosts, type Fetch, type SitePost } from './client.js';
import { closeness } from './keywords.js';
import { websiteApiKey, type NewWebsiteRow } from './repo.js';
import type { SeoRow } from './seo.js';

/**
 * The duplicate check, right before a keyword starts writing (Automation's
 * turn, or Generate now): one keyword at a time, so it is checked against
 * everything there is at that moment.
 *
 * Its keyword (and its title, when it has one) is compared with the website's
 * published posts, read through its /api/v1 posts API, and with the other
 * keywords in the website's list that come before it or are published.
 *
 *  - The same keyword or title, normalized (lower case, trimmed, no
 *    punctuation): a duplicate.
 *  - Very close: their meaning words (stop words and filler left out,
 *    keywords.ts) overlap by DUPLICATE_SIMILARITY or more: a duplicate.
 *
 * A duplicate is skipped (keyword_seo.skip_reason says of what), never
 * written, and the line moves on. Should the website not answer, only the
 * list is checked: a website that cannot be read is no reason to stop.
 */

const log = createLogger('newsite-duplicates');

/** Word overlap (0 to 1, on meaning words) from which two keywords or titles are the same article. */
export const DUPLICATE_SIMILARITY = 0.8;

/** Lower case, trimmed, no accents or punctuation, single spaces: "Mom's Best Cake!" is "moms best cake". */
export const normalizeTitle = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/['‘’]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Something a keyword must not repeat: a published post, or another keyword of the list. */
export interface Taken {
  /** What the skip reason names: a title, with its address when known. */
  label: string;
  texts: string[];
}

/** What the keyword duplicates, as "duplicate of …", or '' when it is new. */
export function duplicateOf(candidate: { keyword: string; title?: string }, taken: Taken[]): string {
  const mine = [candidate.keyword, candidate.title ?? ''].filter((t) => normalizeTitle(t));
  const exact = taken.find((t) => t.texts.some((x) => mine.some((m) => normalizeTitle(m) === normalizeTitle(x))));
  if (exact) return `duplicate of ${exact.label}`;
  const close = taken.find((t) => t.texts.some((x) => mine.some((m) => closeness(m, x) >= DUPLICATE_SIMILARITY)));
  return close ? `duplicate of ${close.label}` : '';
}

/** The other keywords of the website's list that this one must not repeat: the ones before it in line, and the published ones. */
export function listTaken(row: SeoRow): Taken[] {
  const rows = all<SeoRow>(
    `SELECT s.* FROM keyword_seo s JOIN keyword_plans p ON p.id = s.plan_id
      WHERE p.website_id = (SELECT website_id FROM keyword_plans WHERE id = ?) AND s.id != ? AND s.skip_reason = ''
        AND (s.post_status = 'published' OR s.plan_id < ? OR (s.plan_id = ? AND s.position < ?))
      ORDER BY s.plan_id, s.position`,
    row.plan_id, row.id, row.plan_id, row.plan_id, row.position,
  );
  return rows.map((r) => ({ label: r.post_url ? `“${r.title || r.keyword}” (${r.post_url})` : `“${r.keyword}” in the list`, texts: [r.keyword, r.title].filter(Boolean) }));
}

/** The website's published posts, as things not to repeat. Its own post (a keyword published before) is left out. */
export function postsTaken(posts: SitePost[], row: SeoRow): Taken[] {
  return posts
    .filter((p) => p.title && (!p.status || p.status === 'published') && String(p.id) !== String(row.post_id ?? ''))
    .map((p) => {
      const url = get<{ post_url: string }>(`SELECT post_url FROM keyword_seo WHERE post_id = ? AND post_url != ''`, Number(p.id))?.post_url ?? '';
      return { label: url ? `“${p.title}” (${url})` : `“${p.title}”`, texts: [p.title, p.slug.replace(/-/g, ' ')].filter(Boolean) };
    });
}

export interface DuplicateDeps {
  encryptionKey: Buffer;
  fetchImpl?: Fetch;
  /** Reads the website's posts; tests pass their own. */
  listPosts?: (domain: string, apiKey: string) => Promise<SitePost[]>;
}

/** The skip reason from the website's list alone, or ''. */
export const listDuplicate = (row: SeoRow): string => duplicateOf(row, listTaken(row));

/** The skip reason from the website's published posts, or '' (also when the website cannot be read). */
export async function postsDuplicate(row: SeoRow, site: NewWebsiteRow, deps: DuplicateDeps): Promise<string> {
  let posts: SitePost[];
  try {
    posts = await (deps.listPosts ?? ((d, k) => listPosts(d, k, deps.fetchImpl)))(site.domain, websiteApiKey(site, deps.encryptionKey));
  } catch (err) {
    log.warn(`"${row.keyword}": the posts of ${site.domain} could not be read, so only its keyword list was checked: ${errorMessage(err)}`);
    return '';
  }
  return duplicateOf(row, postsTaken(posts, row));
}

/** The skip reason for a keyword about to start, or '' when it may go. */
export async function findDuplicate(row: SeoRow, site: NewWebsiteRow, deps: DuplicateDeps): Promise<string> {
  return listDuplicate(row) || postsDuplicate(row, site, deps);
}

/** Mark a keyword skipped, with why. */
export function skipKeyword(seoId: number, reason: string): void {
  run(`UPDATE keyword_seo SET skip_reason = ?, auto_active = 0, generate_now = 0 WHERE id = ?`, reason.slice(0, 400), seoId);
  log.info(`keyword ${seoId} skipped: ${reason}`);
}

/** Skipped keywords, for the Dashboard and the Keywords page. */
export const skippedKeywords = (): { id: number; plan_id: number; keyword: string; skip_reason: string; site: string }[] =>
  all(
    `SELECT s.id, s.plan_id, s.keyword, s.skip_reason, COALESCE(w.name, '') AS site FROM keyword_seo s
       JOIN keyword_plans p ON p.id = s.plan_id LEFT JOIN new_websites w ON w.id = p.website_id
      WHERE s.skip_reason != '' ORDER BY s.id`,
  );
