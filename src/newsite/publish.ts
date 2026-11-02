import { readFileSync } from 'node:fs';
import { articleChat } from '../llm/gemini.js';
import { join } from 'node:path';
import { get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { listAuthors, listCategories, patchPost, savePost, uploadMedia, type Fetch } from './client.js';
import { rememberSiteCategories } from './channels.js';
import { parseImageSet } from './images.js';
import { isMainSlot, isStepSlot, listPictures, pictureDir, queueStepPictures, type PictureRow } from './pictures.js';
import { parseRecipe, type Recipe } from './recipe.js';
import { getNewWebsite, websiteApiKey, type NewWebsiteRow } from './repo.js';
import { getSeoRow, type SeoRow } from './seo.js';

/**
 * Publishing one keyword's article to its website (blog-engine /api/v1).
 *
 * The post carries the SEO title and description, the article (Markdown),
 * the feature picture as the cover and the other main pictures as its
 * gallery, which the site spreads between the article's sections itself. A
 * recipe page also carries its recipe card. The post's externalId is
 * "newsite-<keyword id>", so publishing again updates the same post.
 *
 * Its category is one of the website's own, picked by the AI, so the site
 * gives it one of the authors assigned to that category. A category with no
 * author assigned gets one of the site's authors sent along instead. Every
 * article of a plan goes in the same category: the first one picked.
 *
 * The post also says where it sits in its topic cluster: the plan's pillar is
 * marked "pillar", every sub-keyword "sub" with its own plan's pillar (by
 * externalId, so it may even go out before the pillar). The website links
 * them to each other from that; nothing is left to wording or the AI.
 *
 * Once posted, the article's recipe step pictures join the slow queue; each
 * one, as it is made, is uploaded and set on its step of the recipe card.
 */

const log = createLogger('newsite-publish');

export interface PublishDeps {
  settings: Settings;
  encryptionKey: Buffer;
  /** The AI, for picking the website category. */
  ask?: (promptName: string, variables: Record<string, unknown>, chat?: string) => Promise<string>;
  /** Picks one author when the category has none; tests pass their own. */
  random?: () => number;
  /** Wakes the picture maker, so the step pictures just queued get made. */
  startPictures?: () => void;
  /** Called once the article is posted: its social posts are made next. */
  afterPublish?: (seoId: number) => void;
  fetchImpl?: Fetch;
  dataDir?: string;
  now?: () => number;
}

export const externalIdFor = (seoId: number): string => `newsite-${seoId}`;

/** The plan's pillar keyword, if the plan has one. */
export const pillarSeoId = (planId: number): number | null =>
  get<{ id: number }>(`SELECT id FROM keyword_seo WHERE plan_id = ? AND role = 'pillar' ORDER BY id LIMIT 1`, planId)?.id ?? null;

/** Where a keyword's post sits in its topic cluster, as the website takes it. Empty when its plan has no pillar. */
export function clusterFields(row: Pick<SeoRow, 'id' | 'plan_id' | 'role'>): { clusterRole: 'pillar' } | { clusterRole: 'sub'; pillar: string } | Record<string, never> {
  if (row.role === 'pillar') return { clusterRole: 'pillar' };
  const pillar = pillarSeoId(row.plan_id);
  return pillar && pillar !== row.id ? { clusterRole: 'sub', pillar: `ext:${externalIdFor(pillar)}` } : {};
}

interface Target {
  row: SeoRow;
  site: NewWebsiteRow;
  apiKey: string;
  pillar: string;
}

/**
 * The post's link on the website. The site builds the link it sends back
 * from the address it believes it has, which can be wrong behind a proxy;
 * its path is right, so the link is the website's own domain and that path.
 */
export function postLink(domain: string, siteUrl: string): string {
  try {
    const { pathname } = new URL(siteUrl);
    return `https://${domain}${pathname}`;
  } catch {
    return siteUrl;
  }
}

/** The JSON object in an AI answer, whatever wrapper it came in. */
const parseJson = (raw: string): Record<string, unknown> | null => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  try {
    return start >= 0 && end > start ? (JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * Which of the website's categories the article goes in, and an author when
 * that category has none assigned. The pick is kept, so publishing again
 * asks nobody. A site with no categories gets one named after its niche, a
 * broad topic: never after the pillar, which would compete with the pillar
 * article for the same search.
 */
async function categoryAndAuthor(t: Target, deps: PublishDeps): Promise<{ category: number | string; author?: number }> {
  const categories = await listCategories(t.site.domain, t.apiKey, deps.fetchImpl);
  rememberSiteCategories(t.site.id, categories.map((c) => c.name));
  if (!categories.length) {
    const niche = get<{ niche: string }>('SELECT niche FROM new_websites WHERE id = ?', t.site.id)?.niche ?? '';
    const name = titleCase(niche.split(/\s+/).filter(Boolean).slice(0, 3).join(' ') || t.row.keyword);
    run('UPDATE keyword_seo SET post_category = ? WHERE id = ?', name, t.row.id);
    return { category: name };
  }

  let chosen = categories.find((c) => c.name.toLowerCase() === t.row.post_category.toLowerCase());
  // the plan's other articles already have one: the whole cluster stays together, the pillar's first
  if (!chosen) {
    const planCategory = get<{ post_category: string }>(
      `SELECT post_category FROM keyword_seo WHERE plan_id = ? AND id <> ? AND post_category <> ''
        ORDER BY role = 'pillar' DESC, id LIMIT 1`,
      t.row.plan_id,
      t.row.id,
    )?.post_category;
    if (planCategory) chosen = categories.find((c) => c.name.toLowerCase() === planCategory.toLowerCase());
  }
  if (!chosen && deps.ask) {
    const niche = get<{ niche: string }>('SELECT niche FROM new_websites WHERE id = ?', t.site.id)?.niche ?? '';
    const raw = await deps.ask('pick-category', {
      title: t.row.title,
      keyword: t.row.keyword,
      pillar: t.pillar,
      niche,
      categoriesJson: JSON.stringify(categories.map((c) => c.name)),
    }, articleChat(t.row.id)).catch(() => '');
    const name = String(parseJson(raw)?.category ?? '').trim().toLowerCase();
    chosen = categories.find((c) => c.name.toLowerCase() === name);
  }
  // No AI answer that names one of the site's categories: the one sharing the
  // most words with the article, else the first.
  if (!chosen) {
    const have = new Set(`${t.row.keyword} ${t.pillar} ${t.row.title}`.toLowerCase().split(/\W+/));
    const score = (c: { name: string }) => c.name.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && (have.has(w) || have.has(`${w}s`) || have.has(w.replace(/s$/, '')))).length;
    chosen = [...categories].sort((a, b) => score(b) - score(a))[0]!;
  }
  run('UPDATE keyword_seo SET post_category = ? WHERE id = ?', chosen.name, t.row.id);

  if (chosen.authorIds.length) return { category: chosen.id };
  const authors = await listAuthors(t.site.domain, t.apiKey, deps.fetchImpl);
  if (!authors.length) return { category: chosen.id };
  const author = authors[Math.floor((deps.random ?? Math.random)() * authors.length)]!;
  return { category: chosen.id, author: author.id };
}

function target(seoId: number, encryptionKey: Buffer): Target | null {
  const row = getSeoRow(seoId);
  if (!row) return null;
  const plan = get<{ website_id: number; pillar: string }>('SELECT website_id, pillar FROM keyword_plans WHERE id = ?', row.plan_id);
  const site = plan ? getNewWebsite(plan.website_id) : undefined;
  if (!plan || !site) return null;
  return { row, site, apiKey: websiteApiKey(site, encryptionKey), pillar: plan.pillar };
}

/** What still stands between a keyword and publishing, in plain words. Empty when it is ready. */
export function notReadyReason(row: SeoRow, pictures: PictureRow[]): string {
  if (row.article_status !== 'done') return 'Needs its article first.';
  if (row.images_status !== 'done') return 'Needs its image prompts first.';
  const main = (parseImageSet(row.images_json)?.images ?? []).filter((im) => !isStepSlot(im.slot));
  const made = new Set(pictures.filter((p) => p.status === 'done').map((p) => p.slot));
  const missing = main.filter((im) => !made.has(im.slot)).length;
  return missing ? `Needs its main pictures first (${missing} not made yet).` : '';
}

const typeOf = (file: string): string => (file.endsWith('.png') ? 'image/png' : file.endsWith('.jpg') ? 'image/jpeg' : 'image/webp');

/** Upload one made picture to the website once; its media id is kept for every later publish. */
async function mediaIdFor(picture: PictureRow, t: Target, deps: PublishDeps): Promise<number> {
  if (picture.media_id) return picture.media_id;
  const data = readFileSync(join(pictureDir(picture.seo_id, deps.dataDir ?? resolveDataDir()), picture.file));
  // Its title and description, written with its prompt; the alt text stands in for a set written before they were.
  const written = parseImageSet(t.row.images_json)?.images.find((im) => im.slot === picture.slot && im.prompt === picture.prompt);
  const media = await uploadMedia(
    t.site.domain,
    t.apiKey,
    { data, name: picture.file, type: typeOf(picture.file), alt: picture.alt, title: written?.title || picture.alt, description: written?.description || picture.alt },
    deps.fetchImpl,
  );
  run('UPDATE newsite_pictures SET media_id = ? WHERE id = ?', media.id, picture.id);
  return media.id;
}

/** The recipe card as the site takes it, with every step picture already on the site. */
function recipeDetails(recipe: Recipe, stepMedia: Map<number, number>): Record<string, unknown> {
  return {
    ...recipe,
    steps: recipe.steps.map((s, i) => (stepMedia.has(i + 1) ? { text: s.text, image: stepMedia.get(i + 1) } : { text: s.text })),
  };
}

const stepNumber = (slot: string): number => Number(slot.replace('step-', '')) || 0;

/** Step pictures already uploaded, by step number. */
const uploadedSteps = (pictures: PictureRow[]): Map<number, number> =>
  new Map(pictures.filter((p) => isStepSlot(p.slot) && p.media_id).map((p) => [stepNumber(p.slot), p.media_id!]));

const titleCase = (s: string): string => s.replace(/\b\w/g, (c) => c.toUpperCase());

/** Publish one keyword's article (or update its post). Never throws: the outcome is stored on the keyword. */
export async function publishKeyword(seoId: number, deps: PublishDeps): Promise<void> {
  const t = target(seoId, deps.encryptionKey);
  if (!t) return;
  const pictures = listPictures(seoId);
  const reason = notReadyReason(t.row, pictures);
  if (reason) {
    run(`UPDATE keyword_seo SET post_status = 'failed', post_error = ? WHERE id = ?`, reason, seoId);
    return;
  }
  run(`UPDATE keyword_seo SET post_status = 'publishing', post_error = '' WHERE id = ?`, seoId);
  try {
    const set = parseImageSet(t.row.images_json)!;
    const bySlot = new Map(pictures.filter((p) => p.status === 'done').map((p) => [p.slot, p]));
    const main = set.images.filter((im) => !isStepSlot(im.slot)).map((im) => bySlot.get(im.slot)!);
    const cover = main.find((p) => p.slot === 'feature') ?? main[0]!;
    const coverId = await mediaIdFor(cover, t, deps);
    const gallery: number[] = [];
    for (const p of main) if (p !== cover) gallery.push(await mediaIdFor(p, t, deps));
    // Step pictures made before this publish go on the recipe card straight away.
    for (const p of pictures) if (isStepSlot(p.slot) && p.status === 'done') await mediaIdFor(p, t, deps);

    const recipe = t.row.page !== 'article' && t.row.recipe_json ? parseRecipe(t.row.recipe_json) : null;
    const placed = await categoryAndAuthor(t, deps);
    const post = await savePost(
      t.site.domain,
      t.apiKey,
      {
        externalId: externalIdFor(seoId),
        type: recipe ? 'recipe' : 'article',
        title: t.row.title,
        excerpt: t.row.description,
        content: t.row.article_md,
        contentFormat: 'markdown',
        // Publishing is the approval: a post sent here goes live.
        status: 'published',
        cover: coverId,
        coverAlt: cover.alt,
        gallery,
        category: placed.category,
        ...(placed.author ? { author: placed.author } : {}),
        seo: { metaTitle: t.row.title, metaDescription: t.row.description, focusKeyword: t.row.focus_keyword },
        ...clusterFields(t.row),
        ...(recipe ? { details: recipeDetails(recipe, uploadedSteps(listPictures(seoId))) } : {}),
      },
      deps.fetchImpl,
    );
    run(
      `UPDATE keyword_seo SET post_status = 'published', post_id = ?, post_url = ?, post_state = ?, post_error = '', posted_at = datetime('now') WHERE id = ?`,
      post.id,
      postLink(t.site.domain, post.url),
      post.status,
      seoId,
    );
    // Posted: the recipe's step pictures now join the slow queue.
    if (recipe && queueStepPictures(seoId, deps.settings, (deps.now ?? Date.now)(), Math.random, deps.dataDir ?? resolveDataDir())) {
      // Without this the queue would sit until the next press or restart.
      deps.startPictures?.();
    }
    deps.afterPublish?.(seoId);
  } catch (err) {
    const message = errorMessage(err).slice(0, 600);
    log.warn(`Publishing "${t.row.keyword}" failed: ${message}`);
    run(`UPDATE keyword_seo SET post_status = 'failed', post_error = ? WHERE id = ?`, message, seoId);
  }
}

/**
 * A step picture was just made: upload it and put it on its step of the
 * posted recipe card. The card is sent whole, with every step picture so far,
 * because the site replaces the card rather than merging it.
 */
export async function addStepPicture(pictureId: number, deps: PublishDeps): Promise<void> {
  const picture = get<PictureRow>('SELECT * FROM newsite_pictures WHERE id = ?', pictureId);
  if (!picture || picture.status !== 'done' || !isStepSlot(picture.slot)) return;
  const t = target(picture.seo_id, deps.encryptionKey);
  if (!t || !t.row.post_id || !t.row.recipe_json) return;
  const recipe = parseRecipe(t.row.recipe_json);
  if (!recipe) return;
  try {
    await mediaIdFor(picture, t, deps);
    await patchPost(t.site.domain, t.apiKey, t.row.post_id, { details: recipeDetails(recipe, uploadedSteps(listPictures(picture.seo_id))) }, deps.fetchImpl);
  } catch (err) {
    // The picture stays made; the next publish or step picture sends it again.
    log.warn(`Adding ${picture.slot} to "${t.row.keyword}" failed: ${errorMessage(err)}`);
    run('UPDATE newsite_pictures SET error = ? WHERE id = ?', `Made, but not added to the post yet: ${errorMessage(err).slice(0, 300)}`, picture.id);
  }
}

/**
 * One publish at a time, so two triggers never post the same article twice at
 * once. An article already waiting in line, or being sent, is not added again.
 */
let chain: Promise<void> = Promise.resolve();
const inLine = new Map<number, Promise<void>>();
export function queuePublish(seoId: number, deps: PublishDeps): Promise<void> {
  const waiting = inLine.get(seoId);
  if (waiting) return waiting;
  const mine: Promise<void> = chain.then(() => publishKeyword(seoId, deps)).catch(() => {}).finally(() => inLine.delete(seoId));
  inLine.set(seoId, mine);
  chain = mine;
  return mine;
}

/** Whether an article is waiting in line to be published, or being sent. */
export const publishQueued = (seoId: number): boolean => inLine.has(seoId);

/**
 * An article's main pictures are all made. Only an article started with
 * Generate now goes out here, as soon as it is ready. Every other article
 * is published by Automation (autopilot.ts), by the website's gap and posts
 * per day, or by its Publish button; never just because its pictures are done.
 */
export function publishWhenReady(seoId: number, deps: PublishDeps): Promise<void> {
  const t = target(seoId, deps.encryptionKey);
  if (!t || !t.row.generate_now || t.row.post_status === 'published' || t.row.post_status === 'publishing') return Promise.resolve();
  if (notReadyReason(t.row, listPictures(seoId))) return Promise.resolve();
  log.info(`Main pictures of "${t.row.keyword}" are made: publishing it automatically.`);
  return queuePublish(seoId, deps);
}

/** A restart mid-publish: the keyword can be published again. */
export function resetInterruptedPublishing(): void {
  run(`UPDATE keyword_seo SET post_status = 'failed', post_error = 'Publishing was cut off by a restart. Publish again.' WHERE post_status = 'publishing'`);
}
