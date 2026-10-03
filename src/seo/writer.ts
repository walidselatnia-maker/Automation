import { all, get, transaction } from '../db/index.js';
import { getKeyword, setLink, updateKeywordFields, type KeywordRow } from '../db/repos.js';
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

/**
 * How many taken titles the prompt shows. A large site would otherwise send
 * thousands of titles with every ask; the rule checks still see all of them.
 */
export const RECENT_TITLES = 200;

/** The first ask plus two corrections. */
const ROUNDS = 3;

const clean = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const titleCase = (text: string): string => text.replace(/(^|\s)[a-z]/g, (m) => m.toUpperCase());

/**
 * Plain, honest text from the keyword alone. It says nothing the keyword does not.
 *
 * It is a safety net, not a guarantee: a very short keyword makes a title under
 * the minimum length and a very long one a description over the maximum, so it
 * can still fail the checker. It is saved anyway, marked seo:fallback, because
 * a plain title is better than a recipe that cannot run.
 */
export function fallbackFor(keyword: string): SeoDraft {
  // Defensive: writeSeoFor never sends a restricted keyword here, but this is
  // exported, and a restricted word (pork, alcohol, holidays) is never written out.
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
          takenJson: JSON.stringify(takenTitles.slice(-RECENT_TITLES)),
          rules: rulesPrompt({ slug: false, focus: false }),
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
 * Save a row's text (when there is some) and let the site's scheduler have it,
 * in one write.
 *
 * The guide import holds a new recipe's link at 'no' until it has a title,
 * because a recipe without one is rejected by the pipeline and switched off
 * for good. Saving the title and lifting the hold together means there is no
 * moment where the row is runnable without its text, or has its text and is
 * still held. Only a held link ('no') is lifted: a link that is already 'go'
 * or published is left as it is.
 */
function saveAndRelease(siteId: number, row: KeywordRow, draft: Drafted | null): void {
  transaction(() => {
    if (draft) {
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
    const link = get<{ status: string }>(
      'SELECT status FROM keyword_sites WHERE keyword_id = ? AND site_id = ?',
      row.id,
      siteId,
    );
    if (link?.status === 'no') setLink(row.id, siteId, 'go');
  });
}

const isRecipe = (row: KeywordRow | undefined): row is KeywordRow => !!row && row.content_type === 'recipe';

/**
 * Fill in the recipes among `ids` that have no source title yet, and release
 * every recipe it looked at.
 *
 * Articles are left alone (the article pipeline plans its own metadata, and a
 * source title would make it write "the same ground, better"), and so is any
 * recipe that already has research -- the operator's own words win. A recipe
 * that already has a title is still released, because the hold exists only to
 * wait for text. The one exception is a keyword with a word this site does not
 * publish: it stays held for the operator to rename.
 */
export async function writeSeoFor(
  deps: WriterDeps,
  siteId: number,
  pillar: string,
  identity: string,
  ids: number[],
): Promise<WriterReport> {
  const recipes = [...new Set(ids)].map((id) => getKeyword(id)).filter(isRecipe);
  // A restricted word can never pass the title rules, so the plain version
  // would have to write it. Leave those held for the operator.
  const restricted = (row: KeywordRow): boolean => restrictedWords(row.seed_keyword).length > 0;
  const skipped = recipes.filter((row) => row.spy_title.trim() === '' && restricted(row)).length;

  // Rows that already have a title only need the hold lifted.
  for (const row of recipes.filter((r) => r.spy_title.trim() !== '')) saveAndRelease(siteId, row, null);

  const usable = recipes.filter((row) => row.spy_title.trim() === '' && !restricted(row));
  if (usable.length === 0) return { written: 0, fallbacks: 0, skipped };

  let drafts: Map<number, Drafted>;
  try {
    const others = all<{ spy_title: string }>(
      `SELECT k.spy_title FROM keywords k
       JOIN keyword_sites ks ON ks.keyword_id = k.id
       WHERE ks.site_id = ? AND k.spy_title != ''`,
      siteId,
    ).map((r) => r.spy_title);
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
    if (!row) continue;
    if (row.spy_title.trim() !== '') {
      // Someone filled it in meanwhile: keep their words, still lift the hold.
      saveAndRelease(siteId, row, null);
      continue;
    }
    const draft = drafts.get(row.id) ?? { ...fallbackFor(row.seed_keyword), fallback: true };
    saveAndRelease(siteId, row, draft);
    if (draft.fallback) fallbacks += 1;
    written += 1;
  }
  return { written, fallbacks, skipped };
}

/** Plain text for every recipe among `ids` still waiting, and lift its hold. Never throws. */
function releaseWithPlainText(siteId: number, ids: number[]): void {
  for (const id of new Set(ids)) {
    try {
      const row = getKeyword(id);
      if (!isRecipe(row)) continue;
      if (row.spy_title.trim() !== '') saveAndRelease(siteId, row, null);
      else if (restrictedWords(row.seed_keyword).length === 0) {
        saveAndRelease(siteId, row, { ...fallbackFor(row.seed_keyword), fallback: true });
      }
    } catch (err) {
      log.warn(`Could not release keyword ${id} after the SEO writer failed: ${errorMessage(err)}`);
    }
  }
}

/**
 * writeSeoFor with a time cap, for a web request that must not hang.
 *
 * It never throws. If the writer fails, the recipes get plain text so none is
 * left held for ever. If it is merely slow, `pending` is true and the writer
 * carries on in the background; when it ends, that is logged (and a failure
 * there is cleaned up the same way) so it is never silent.
 */
export async function writeSeoWithin(
  deps: WriterDeps,
  siteId: number,
  pillar: string,
  identity: string,
  ids: number[],
  limitMs: number,
): Promise<WriterReport & { pending: boolean }> {
  const none = { written: 0, fallbacks: 0, skipped: 0 };
  let timer: NodeJS.Timeout | undefined;
  try {
    const writing = writeSeoFor(deps, siteId, pillar, identity, ids);
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), limitMs);
    });
    const outcome = await Promise.race([writing, timedOut]);
    if (outcome === 'timeout') {
      writing.then(
        (report) => log.info(`SEO writer for site ${siteId} finished in the background: ${JSON.stringify(report)}`),
        (err) => {
          log.warn(`SEO writer for site ${siteId} failed in the background: ${errorMessage(err)}`);
          releaseWithPlainText(siteId, ids);
        },
      );
      return { ...none, pending: true };
    }
    return { ...outcome, pending: false };
  } catch (err) {
    log.warn(`SEO text for site ${siteId} not written: ${errorMessage(err)}`);
    releaseWithPlainText(siteId, ids);
    return { ...none, pending: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Recipes the guide added to this site that are still held with no title: what
 * a restart or crash in the middle of a write leaves behind. Handing them to
 * the next import's writer repairs them. Restricted keywords are included
 * here and skipped by the writer, so they stay held.
 */
export const leftoverHeldIds = (siteId: number): number[] =>
  all<{ id: number }>(
    `SELECT k.id FROM keywords k
     JOIN keyword_sites ks ON ks.keyword_id = k.id
     WHERE ks.site_id = ? AND ks.status = 'no' AND k.content_type = 'recipe'
       AND k.annotation LIKE 'guide:%' AND trim(k.spy_title) = ''`,
    siteId,
  ).map((r) => r.id);
