import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get, run } from '../db/index.js';
import { resolveDataDir } from '../config.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { patchPost, savePost, uploadMedia, type Fetch } from './client.js';
import { parseImageSet } from './images.js';
import { isStepSlot, listPictures, pictureDir, queueStepPictures, type PictureRow } from './pictures.js';
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
 * Once posted, the article's recipe step pictures join the slow queue; each
 * one, as it is made, is uploaded and set on its step of the recipe card.
 */

const log = createLogger('newsite-publish');

export interface PublishDeps {
  settings: Settings;
  encryptionKey: Buffer;
  fetchImpl?: Fetch;
  dataDir?: string;
  now?: () => number;
}

export const externalIdFor = (seoId: number): string => `newsite-${seoId}`;

interface Target {
  row: SeoRow;
  site: NewWebsiteRow;
  apiKey: string;
  pillar: string;
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
  const media = await uploadMedia(
    t.site.domain,
    t.apiKey,
    { data, name: picture.file, type: typeOf(picture.file), alt: picture.alt },
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
        status: t.site.auto_publish ? 'published' : 'draft',
        cover: coverId,
        coverAlt: cover.alt,
        gallery,
        category: titleCase(t.pillar),
        seo: { metaTitle: t.row.title, metaDescription: t.row.description, focusKeyword: t.row.focus_keyword },
        ...(recipe ? { details: recipeDetails(recipe, uploadedSteps(listPictures(seoId))) } : {}),
      },
      deps.fetchImpl,
    );
    run(
      `UPDATE keyword_seo SET post_status = 'published', post_id = ?, post_url = ?, post_state = ?, post_error = '', posted_at = datetime('now') WHERE id = ?`,
      post.id,
      post.url,
      post.status,
      seoId,
    );
    // Posted: the recipe's step pictures now join the slow queue.
    if (recipe) queueStepPictures(seoId, deps.settings, (deps.now ?? Date.now)(), Math.random, deps.dataDir ?? resolveDataDir());
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

/** A restart mid-publish: the keyword can be published again. */
export function resetInterruptedPublishing(): void {
  run(`UPDATE keyword_seo SET post_status = 'failed', post_error = 'Publishing was cut off by a restart. Publish again.' WHERE post_status = 'publishing'`);
}
