import { all } from '../db/index.js';
import { getKeyword, updateKeywordFields, type KeywordRow } from '../db/repos.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { checkDescription, checkTitle, restrictedWords, rulesPrompt, TITLE_MAX } from './rules.js';

const log = createLogger('seo');

/**
 * Writes the title and description a guide keyword arrives without.
 *
 * A recipe is written from a source title and description; a keyword added by
 * the guide has neither, so the pipeline would stop at the first step. One
 * model call answers for the whole batch, so the recipes come out different
 * from each other. Everything it says is checked by the rules in rules.ts;
 * only the failures go back, with the exact problem. What still fails after
 * that gets a plain version built from the keyword -- importing must never
 * fail because the wording was hard.
 */

export interface WriterDeps {
  ask: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
}

export interface SeoDraft {
  title: string;
  description: string;
  notes: string;
}

export interface Drafted extends SeoDraft {
  /** True when the model never produced something that passed. */
  fallback: boolean;
}

export interface SeoItem {
  id: number;
  keyword: string;
}

export interface WriterContext {
  identity: string;
  pillar: string;
  /** Titles already used on the site. */
  others: string[];
}

/** The first ask plus two corrections. */
const ROUNDS = 3;

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const titleCase = (text: string): string => text.replace(/(^|\s)[a-z]/g, (m) => m.toUpperCase());

/** Plain, honest text from the keyword alone. It says nothing the keyword does not. */
export function fallbackFor(keyword: string): SeoDraft {
  // A restricted word (pork, alcohol, holidays) is dropped, never written out.
  const phrase =
    clean(keyword)
      .toLowerCase()
      .split(' ')
      .filter((word) => restrictedWords(word).length === 0)
      .join(' ') || 'easy home cooked meal';
  const title = titleCase(phrase);
  const cut = title.lastIndexOf(' ', TITLE_MAX);
  return {
    title: title.length > TITLE_MAX ? title.slice(0, cut > 0 ? cut : TITLE_MAX) : title,
    description: `A clear, step-by-step way to make ${phrase}, with the ingredients, timing and tips you need.`,
    notes: '',
  };
}

/** The model's answer as a list of objects, tolerating text around the JSON. */
function parseAnswer(raw: string): Record<string, unknown>[] {
  const tryParse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  let value = tryParse(raw);
  if (value === undefined) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) value = tryParse(raw.slice(start, end + 1));
  }
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? (value as { items?: unknown }).items
      : undefined;
  return Array.isArray(list)
    ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];
}

export async function draftSeo(
  deps: WriterDeps,
  items: SeoItem[],
  context: WriterContext,
): Promise<Map<number, Drafted>> {
  const done = new Map<number, Drafted>();
  const problems = new Map<number, string[]>();
  const takenTitles = [...context.others];
  const takenDescriptions: string[] = [];
  let pending = items.map((item, index) => ({ ...item, n: index + 1 }));

  for (let round = 0; round < ROUNDS && pending.length > 0; round += 1) {
    let answers: Record<string, unknown>[];
    try {
      answers = parseAnswer(
        await deps.ask('seo-writer', {
          identity: JSON.stringify(context.identity),
          pillar: JSON.stringify(context.pillar),
          itemsJson: JSON.stringify(
            pending.map((p) => ({ n: p.n, keyword: p.keyword, fix: problems.get(p.n) ?? [] })),
          ),
          takenJson: JSON.stringify(takenTitles),
          rules: rulesPrompt(),
        }),
      );
    } catch (err) {
      log.warn(`SEO writer unavailable, using plain text: ${errorMessage(err)}`);
      break;
    }

    const stillPending: typeof pending = [];
    for (const item of pending) {
      const answer = answers.find((a) => Number(a.n) === item.n);
      const title = clean(answer?.title);
      const description = clean(answer?.description);
      const found = answer
        ? [
            ...checkTitle(title, { keyword: item.keyword, others: takenTitles }),
            ...checkDescription(description, { keyword: item.keyword, others: takenDescriptions }),
          ]
        : ['No answer came back for this recipe.'];

      if (found.length === 0) {
        done.set(item.id, { title, description, notes: clean(answer?.notes), fallback: false });
        takenTitles.push(title);
        takenDescriptions.push(description);
      } else {
        problems.set(item.n, found);
        stillPending.push(item);
      }
    }
    pending = stillPending;
  }

  for (const item of pending) {
    done.set(item.id, { ...fallbackFor(item.keyword), fallback: true });
  }
  return done;
}

export interface WriterReport {
  written: number;
  fallbacks: number;
  skipped: number;
}

/**
 * Fill in the recipes among `ids` that have no source title yet.
 *
 * Articles are left alone (the article pipeline plans its own metadata, and a
 * source title would make it write "the same ground, better"), and so is any
 * recipe that already has research -- the operator's own words win.
 */
export async function writeSeoFor(
  deps: WriterDeps,
  siteId: number,
  pillar: string,
  identity: string,
  ids: number[],
): Promise<WriterReport> {
  const rows = [...new Set(ids)]
    .map((id) => getKeyword(id))
    .filter((row): row is KeywordRow => !!row && row.content_type === 'recipe' && row.spy_title.trim() === '');
  // A restricted word can never pass the title rules, so the plain version
  // would have to write it. Leave those for the operator.
  const skipped = rows.filter((row) => restrictedWords(row.seed_keyword).length > 0).length;
  const usable = rows.filter((row) => restrictedWords(row.seed_keyword).length === 0);
  if (usable.length === 0) return { written: 0, fallbacks: 0, skipped };

  const others = all<{ spy_title: string }>(
    `SELECT k.spy_title FROM keywords k
     JOIN keyword_sites ks ON ks.keyword_id = k.id
     WHERE ks.site_id = ? AND k.spy_title != ''`,
    siteId,
  ).map((r) => r.spy_title);

  let drafts: Map<number, Drafted>;
  try {
    drafts = await draftSeo(
      deps,
      usable.map((row) => ({ id: row.id, keyword: row.seed_keyword })),
      { identity, pillar, others },
    );
  } catch (err) {
    // draftSeo is built not to throw; this is the belt to its braces.
    log.warn(`SEO writer failed, using plain text: ${errorMessage(err)}`);
    drafts = new Map(
      usable.map((row) => [row.id, { ...fallbackFor(row.seed_keyword), fallback: true }]),
    );
  }

  let fallbacks = 0;
  let written = 0;
  for (const stale of usable) {
    // The model call took a while; work from the row as it is now.
    const row = getKeyword(stale.id);
    if (!row || row.spy_title.trim() !== '') continue;
    const draft = drafts.get(row.id) ?? { ...fallbackFor(row.seed_keyword), fallback: true };
    if (draft.fallback) fallbacks += 1;
    written += 1;
    const { id, seed_keyword: _seed, ...fields } = row;
    updateKeywordFields(id, {
      ...fields,
      spy_title: draft.title,
      spy_description: draft.description,
      annotation: [row.annotation, draft.notes, draft.fallback ? 'seo:fallback' : '']
        .filter(Boolean)
        .join(' | '),
    });
  }
  return { written, fallbacks, skipped };
}
