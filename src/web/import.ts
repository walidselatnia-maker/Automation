import { parseCsvTable } from '../lib/csv.js';
import { getSiteByDomain, insertKeyword, listSites, setLink, upsertSite } from '../db/repos.js';
import { transaction } from '../db/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('import');

/**
 * CSV import for keywords and their per-site status.
 *
 * Bulk entry stays where it works well — a spreadsheet — while the database
 * remains the source of truth. Unlike the sheet this replaces, a duplicate
 * site column cannot produce contradictory state: the last value simply wins
 * on a single row, and the UNIQUE constraint enforces one status per pair.
 */

const KEYWORD_FIELDS = new Set([
  'seed_keyword',
  'spy_title',
  'spy_description',
  'spy_image_url',
  'spy_article_url',
  'spy_pin_image',
  'annotation',
  'status',
  'row_number',
]);

/** Accept the old sheet's headers as well as the new ones. */
const ALIASES: Record<string, string> = {
  'seed keyword': 'seed_keyword',
  'spy title': 'spy_title',
  'spy description': 'spy_description',
  'spy image url': 'spy_image_url',
  'spy article url': 'spy_article_url',
  'spy pin image': 'spy_pin_image',
  row: 'status',
  keyword: 'seed_keyword',
};

const normaliseHeader = (header: string): string => {
  const lower = header.trim().toLowerCase();
  return ALIASES[lower] ?? lower.replace(/\s+/g, '_');
};

const normaliseStatus = (value: string): 'go' | 'done' | 'no' => {
  const v = value.trim().toLowerCase();
  if (v === 'go') return 'go';
  if (v === 'done') return 'done';
  return 'no';
};

export interface ImportReport {
  imported: number;
  skipped: number;
  linksSet: number;
  unknownDomains: string[];
  errors: string[];
}

export function importKeywordsCsv(csv: string): ImportReport {
  const { headers, rows } = parseCsvTable(csv);

  const report: ImportReport = {
    imported: 0,
    skipped: 0,
    linksSet: 0,
    unknownDomains: [],
    errors: [],
  };

  if (headers.length === 0) {
    report.errors.push('The file appears to be empty.');
    return report;
  }

  const normalised = headers.map(normaliseHeader);
  if (!normalised.includes('seed_keyword')) {
    report.errors.push(
      'No "seed_keyword" column found. Expected a column named seed_keyword (or "Seed keyword").',
    );
    return report;
  }

  // Any header that is not a known keyword field is treated as a site domain.
  const knownDomains = new Map(listSites().map((s) => [s.domain.toLowerCase(), s.id]));
  const domainColumns: { header: string; siteId: number }[] = [];
  const unknown = new Set<string>();

  headers.forEach((header, index) => {
    const key = normalised[index]!;
    if (KEYWORD_FIELDS.has(key) || key === '') return;

    const siteId = knownDomains.get(header.trim().toLowerCase());
    if (siteId) domainColumns.push({ header, siteId });
    else unknown.add(header);
  });

  report.unknownDomains = [...unknown];

  transaction(() => {
    rows.forEach((row, rowIndex) => {
      const value = (key: string): string => {
        const index = normalised.indexOf(key);
        return index === -1 ? '' : (row[headers[index]!] ?? '');
      };

      const seed = value('seed_keyword').trim();
      if (!seed) {
        report.skipped++;
        return;
      }

      try {
        const keywordId = insertKeyword({
          seed_keyword: seed,
          spy_title: value('spy_title'),
          spy_description: value('spy_description'),
          spy_image_url: value('spy_image_url'),
          spy_article_url: value('spy_article_url'),
          spy_pin_image: value('spy_pin_image'),
          annotation: value('annotation'),
          status: normaliseStatus(value('status') || 'go'),
        });

        for (const column of domainColumns) {
          const cell = (row[column.header] ?? '').trim();
          if (cell === '') continue;
          setLink(keywordId, column.siteId, normaliseStatus(cell));
          report.linksSet++;
        }

        report.imported++;
      } catch (err) {
        report.skipped++;
        report.errors.push(
          `Row ${rowIndex + 2}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  });

  log.info(
    `imported ${report.imported} keyword(s), ${report.linksSet} link(s), skipped ${report.skipped}`,
  );
  return report;
}

/** Import sites from the old KEYS sheet layout. */
export function importSitesCsv(
  csv: string,
  encryptionKey: Buffer,
): { imported: number; errors: string[] } {
  const { rows } = parseCsvTable(csv);
  const errors: string[] = [];
  let imported = 0;

  transaction(() => {
    for (const row of rows) {
      const pick = (...names: string[]): string => {
        for (const name of names) {
          const found = Object.entries(row).find(
            ([k]) => k.trim().toLowerCase() === name.toLowerCase(),
          );
          if (found?.[1]) return found[1];
        }
        return '';
      };

      const domain = pick('Domain', 'domain').trim();
      if (!domain) continue;

      try {
        const existing = getSiteByDomain(domain);
        const toNumber = (value: string, fallback: number): number => {
          const n = Number(value);
          return Number.isFinite(n) ? n : fallback;
        };

        // The old sheet expressed the gap in hours; store it as minutes.
        const hours = pick('hours_between');
        const intervalMinutes = hours
          ? Math.round(toNumber(hours, 8) * 60)
          : (existing?.interval_minutes ?? 480);

        upsertSite(
          {
            name: pick('Website Name', 'name') || domain,
            domain,
            status: pick('status').toLowerCase() === 'active' ? 'active' : 'paused',
            pin_username: pick('Pin username'),
            project_id: pick('Project ID'),
            daily_target: toNumber(pick('daily_target'), existing?.daily_target ?? 0),
            interval_minutes: intervalMinutes,
            // Credentials are entered per site in the UI, never imported: the
            // old sheet repeated one token across every row.
          },
          encryptionKey,
        );
        imported++;
      } catch (err) {
        errors.push(`${domain}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  return { imported, errors };
}
