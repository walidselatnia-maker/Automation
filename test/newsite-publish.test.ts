import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo, getSeoRow } from '../src/newsite/seo.js';
import { listPictures, NEXT_STEP_KEY, pictureDir } from '../src/newsite/pictures.js';
import { addStepPicture, notReadyReason, publishKeyword } from '../src/newsite/publish.js';
import type { Recipe } from '../src/newsite/recipe.js';

const KEY = randomBytes(32);

const RECIPE: Recipe = {
  prepMinutes: 15, cookMinutes: 30, servings: 8, difficulty: 'easy', cuisine: 'American', course: 'Dessert',
  ingredients: [{ title: '', items: ['250 g flour', '200 g strawberries'] }],
  steps: [{ text: 'Mix.' }, { text: 'Bake.' }],
  nutrition: { calories: 300, protein: 4, carbs: 40, fat: 12 },
  notes: 'Keep cold.',
};

const SLOTS = ['feature', 'overhead', 'closeup', 'step-1', 'step-2'];

describe('Publishing to the website', () => {
  let settings: Settings;
  let seoId: number;
  let dataDir: string;
  let calls: { method: string; url: string; body: unknown }[];
  let nextMedia: number;

  const fakeSite = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.endsWith('/api/v1/media')) {
      const form = init!.body as FormData;
      calls.push({ method, url: u, body: { alt: form.get('alt'), name: (form.get('file') as File).name } });
      nextMedia += 1;
      return new Response(JSON.stringify({ media: { id: nextMedia, url: `https://f.longlivo.com/media/${nextMedia}.webp` } }), { status: 201 });
    }
    if (u.endsWith('/api/v1/categories')) {
      calls.push({ method, url: u, body: null });
      return new Response(JSON.stringify({ items: [
        { id: 3, name: 'Desserts', authorIds: [9] },
        { id: 5, name: 'Cakes', authorIds: [] },
      ] }));
    }
    if (u.endsWith('/api/v1/authors')) {
      calls.push({ method, url: u, body: null });
      return new Response(JSON.stringify({ items: [{ id: 9, name: 'Mia' }, { id: 12, name: 'Sam' }] }));
    }
    calls.push({ method, url: u, body: JSON.parse(String(init!.body)) });
    // The site builds its link from the address it believes it has.
    return new Response(JSON.stringify({ post: { id: 77, url: 'http://localhost:4321/recipes/strawberry-cake', status: 'published' } }), { status: 200 });
  }) as unknown as typeof fetch;

  let asked: Record<string, unknown>[];
  const deps = () => ({
    settings, encryptionKey: KEY, fetchImpl: fakeSite, dataDir, now: () => 1_000_000, random: () => 0.9,
    ask: async (_name: string, vars: Record<string, unknown>) => { asked.push(vars); return '{"category": "Cakes"}'; },
  });

  /** A made picture: a row and its file. */
  const made = (slot: string, i: number) => {
    run(
      `INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, file) VALUES (?, ?, ?, ?, ?, 'done', ?)`,
      seoId, slot, i, `prompt ${slot}`, `alt ${slot}`, `${slot}.png`,
    );
    mkdirSync(pictureDir(seoId, dataDir), { recursive: true });
    writeFileSync(join(pictureDir(seoId, dataDir), `${slot}.png`), 'img');
  };

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    const websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    const planId = saveKeywordPlan(websiteId, 'strawberry cake', [], 'recipe');
    queuePlanSeo(planId, 'strawberry cake', [], 'recipe');
    seoId = listPlanSeo(planId)[0]!.id;
    run(
      `UPDATE keyword_seo SET status = 'done', title = 'Strawberry Cake With Fresh Berries', description = 'D', focus_keyword = 'strawberry cake',
         recipe_status = 'done', recipe_json = ?, article_status = 'done', article_md = '## Why it works\n\nText.',
         images_status = 'done', images_json = ? WHERE id = ?`,
      JSON.stringify(RECIPE),
      JSON.stringify({ theme: {}, images: SLOTS.map((slot) => ({ slot, prompt: `prompt ${slot}`, alt: `alt ${slot}` })) }),
      seoId,
    );
    dataDir = mkdtempSync(join(tmpdir(), 'publish-'));
    calls = [];
    asked = [];
    nextMedia = 100;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('waits for the main pictures', () => {
    expect(notReadyReason(getSeoRow(seoId)!, listPictures(seoId))).toMatch(/main pictures first \(3 not made yet\)/);
    ['feature', 'overhead', 'closeup'].forEach(made);
    expect(notReadyReason(getSeoRow(seoId)!, listPictures(seoId))).toBe('');
  });

  it('posts the article with its cover, gallery, recipe card and SEO, then starts the step pictures', async () => {
    ['feature', 'overhead', 'closeup'].forEach(made);
    await publishKeyword(seoId, deps());

    const uploads = calls.filter((c) => c.url.endsWith('/media'));
    expect(uploads.map((c) => (c.body as { alt: string }).alt)).toEqual(['alt feature', 'alt overhead', 'alt closeup']);
    const post = calls.find((c) => c.url.endsWith('/api/v1/posts'))!;
    expect(post.method).toBe('POST');
    expect(post.body).toMatchObject({
      externalId: `newsite-${seoId}`,
      type: 'recipe',
      title: 'Strawberry Cake With Fresh Berries',
      content: '## Why it works\n\nText.',
      contentFormat: 'markdown',
      status: 'published',
      cover: 101,
      gallery: [102, 103],
      // The AI picked one of the site's own categories; it has no author, so one is sent.
      category: 5,
      author: 12,
      seo: { metaTitle: 'Strawberry Cake With Fresh Berries', metaDescription: 'D', focusKeyword: 'strawberry cake' },
      details: { ...RECIPE, steps: [{ text: 'Mix.' }, { text: 'Bake.' }] },
    });
    expect(String(asked[0]!.categoriesJson)).toBe('["Desserts","Cakes"]');
    // The link is the website's own domain with the post's path.
    expect(getSeoRow(seoId)).toMatchObject({ post_status: 'published', post_id: 77, post_url: 'https://f.longlivo.com/recipes/strawberry-cake', post_category: 'Cakes' });
    // The step pictures joined the slow queue, the first one 15 to 30 minutes out.
    expect(listPictures(seoId).filter((p) => p.slot.startsWith('step-')).map((p) => p.status)).toEqual(['queued', 'queued']);
    expect(Number(settings.get(NEXT_STEP_KEY))).toBeGreaterThanOrEqual(1_000_000 + 15 * 60_000);
  });

  it('adds each step picture to its step of the posted recipe card', async () => {
    ['feature', 'overhead', 'closeup'].forEach(made);
    await publishKeyword(seoId, deps());
    calls = [];
    // The slow queue made step 2's picture.
    const step2 = listPictures(seoId).find((p) => p.slot === 'step-2')!;
    run(`UPDATE newsite_pictures SET status = 'done', file = 'step-2.png' WHERE id = ?`, step2.id);
    writeFileSync(join(pictureDir(seoId, dataDir), 'step-2.png'), 'img');
    await addStepPicture(step2.id, deps());

    expect(calls[0]!.url).toMatch(/\/media$/);
    expect(calls[1]).toMatchObject({
      method: 'PATCH',
      url: 'https://f.longlivo.com/api/v1/posts/77',
      body: { details: { ...RECIPE, steps: [{ text: 'Mix.' }, { text: 'Bake.', image: 104 }] } },
    });
  });

  it('publishes again as an update, without uploading the pictures again', async () => {
    ['feature', 'overhead', 'closeup'].forEach(made);
    await publishKeyword(seoId, deps());
    calls = [];
    await publishKeyword(seoId, deps());
    expect(calls.filter((c) => c.url.endsWith('/media'))).toEqual([]);
    // The category picked the first time is kept: the AI is not asked again.
    expect(asked).toHaveLength(1);
    const post = calls.find((c) => c.url.endsWith('/api/v1/posts'))!;
    expect(post.body).toMatchObject({ externalId: `newsite-${seoId}`, cover: 101, gallery: [102, 103], category: 5 });
  });

  it('keeps what the website said when it refuses', async () => {
    ['feature', 'overhead', 'closeup'].forEach(made);
    const refusing = (async () =>
      new Response(JSON.stringify({ error: 'Some fields are not valid.', details: ['details.steps.0.text: required'] }), { status: 422 })) as unknown as typeof fetch;
    await publishKeyword(seoId, { ...deps(), fetchImpl: refusing });
    expect(getSeoRow(seoId)).toMatchObject({ post_status: 'failed' });
    expect(getSeoRow(seoId)!.post_error).toMatch(/Some fields are not valid\. \(details\.steps\.0\.text: required\)/);
  });
});
