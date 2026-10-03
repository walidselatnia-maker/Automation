import { get, transaction } from '../db/index.js';
import { insertKeyword, setKeywordStatus, setLink } from '../db/repos.js';
import type { ShortlistItem } from './steps.js';

export interface ImportReport {
  /** Every item's keyword id, in item order. */
  ids: number[];
  /** The ids this import inserted, as opposed to reused. Only these need search text written. */
  newIds: number[];
  /** Already published on this site, so left exactly as it was. */
  alreadyOnSite: number[];
  /** Turned off everywhere in Keywords: linked here, but not switched back on. */
  switchedOff: number[];
}

/**
 * The shortlist, into Keywords.
 *
 * Each new item becomes a keyword for this site, and nothing else -- the
 * scheduler then writes them at the site's own pace. New recipes are held until
 * their search text exists (see writeSeoFor); articles are ready at once. An exact match of a
 * keyword that already exists is reused rather than added twice, with two
 * guards: one this site already published stays published (re-queuing it would
 * make the scheduler write it a second time), and one the operator turned off
 * everywhere stays off (switching it on would make every other site write it).
 *
 * `annotation` records where it came from, so a keyword list can tell guide
 * keywords from imported ones.
 */
export function importShortlistReport(siteId: number, pillar: string, items: ShortlistItem[]): ImportReport {
  return transaction(() => {
    const report: ImportReport = { ids: [], newIds: [], alreadyOnSite: [], switchedOff: [] };

    for (const item of items) {
      const existing = get<{ id: number; status: string }>(
        'SELECT id, status FROM keywords WHERE lower(trim(seed_keyword)) = lower(trim(?)) ORDER BY id LIMIT 1',
        item.keyword,
      );

      if (!existing) {
        const id = insertKeyword({
          seed_keyword: item.keyword,
          content_type: item.type,
          niche: item.type === 'article' ? pillar : '',
          annotation: `guide:${pillar}`,
          status: 'go',
        });
        // A new recipe has no title yet, and the pipeline rejects a recipe
        // without one (which would switch the keyword off on every site for
        // good). So the link is held back, 'no', until the SEO writer saves the
        // title and releases it. The keyword itself stays 'go': it is not
        // switched off, it just has no site waiting for it yet, so Keywords
        // shows it as stuck-without-a-title rather than as turned off. An
        // article needs no search text and goes live at once.
        setLink(id, siteId, item.type === 'recipe' ? 'no' : 'go');
        report.ids.push(id);
        report.newIds.push(id);
        continue;
      }

      const id = existing.id;
      report.ids.push(id);

      const link = get<{ status: string }>(
        'SELECT status FROM keyword_sites WHERE keyword_id = ? AND site_id = ?',
        id,
        siteId,
      );
      if (link?.status === 'done') {
        report.alreadyOnSite.push(id);
        continue;
      }

      setLink(id, siteId, 'go');
      if (existing.status === 'no') report.switchedOff.push(id);
      else setKeywordStatus(id, 'go');
    }

    return report;
  });
}

/** Just the keyword ids, for callers that do not need the report. */
export const importShortlist = (siteId: number, pillar: string, items: ShortlistItem[]): number[] =>
  importShortlistReport(siteId, pillar, items).ids;
