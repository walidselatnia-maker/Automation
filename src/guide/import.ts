import { get, transaction } from '../db/index.js';
import { insertKeyword, setKeywordStatus, setLink } from '../db/repos.js';
import type { ShortlistItem } from './steps.js';

export interface ImportReport {
  /** Every item's keyword id, in item order. */
  ids: number[];
  /** Already published on this site, so left exactly as it was. */
  alreadyOnSite: number[];
  /** Turned off everywhere in Keywords: linked here, but not switched back on. */
  switchedOff: number[];
}

/**
 * The shortlist, into Keywords.
 *
 * Each new item becomes a keyword switched on for this site, and nothing else --
 * the scheduler then writes them at the site's own pace. An exact match of a
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
    const report: ImportReport = { ids: [], alreadyOnSite: [], switchedOff: [] };

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
        setLink(id, siteId, 'go');
        report.ids.push(id);
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
