import { get, transaction } from '../db/index.js';
import { insertKeyword, setKeywordStatus, setLink } from '../db/repos.js';
import type { ShortlistItem } from './steps.js';

/**
 * The shortlist, into Keywords.
 *
 * Each item becomes a keyword switched on for this site, and nothing else --
 * the scheduler then writes them at the site's own pace. An exact match of a
 * keyword that already exists is reused rather than added twice; the operator
 * just chose it for this site, so it is switched back on.
 *
 * `annotation` records where it came from, so a keyword list can tell guide
 * keywords from imported ones.
 */
export function importShortlist(siteId: number, pillar: string, items: ShortlistItem[]): number[] {
  return transaction(() =>
    items.map((item) => {
      const existing = get<{ id: number }>(
        'SELECT id FROM keywords WHERE lower(trim(seed_keyword)) = lower(trim(?)) ORDER BY id LIMIT 1',
        item.keyword,
      );

      const id =
        existing?.id ??
        insertKeyword({
          seed_keyword: item.keyword,
          content_type: item.type,
          niche: item.type === 'article' ? pillar : '',
          annotation: `guide:${pillar}`,
          status: 'go',
        });

      if (existing) setKeywordStatus(id, 'go');
      setLink(id, siteId, 'go');
      return id;
    }),
  );
}
