import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { generateChoices, generateNowLines, generateNowTick, startGenerateNow } from '../src/newsite/generate-now.js';
import { publishWhenReady } from '../src/newsite/publish.js';

const KEY = randomBytes(32);
const images = JSON.stringify({
  theme: { surface: 's', lighting: 'l', palette: 'p', style: 'st', mood: 'm' },
  images: ['feature', 'overhead', 'step-1'].map((slot) => ({ slot, prompt: `prompt for ${slot}`, alt: `alt for ${slot}` })),
});

describe('Generate now', () => {
  let settings: Settings;
  let started: number;
  const deps = () => ({
    settings,
    encryptionKey: KEY,
    dataDir: mkdtempSync(join(tmpdir(), 'generate-')),
    fetchImpl: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
    startPictures: () => {
      started += 1;
    },
  });
  const row = (id: number) => get<{ status: string; article_status: string; post_status: string; generate_now: number }>('SELECT * FROM keyword_seo WHERE id = ?', id)!;

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    // Automation off, and the website waits for approval: Generate now still publishes.
    settings.set('newsite_automation_enabled', 'false');
    started = 0;
    const site = createNewWebsite(
      { name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking recipes', nicheContext: '', persona: 'Storyteller', status: 'active', autoPublish: false, dailyTarget: 2, intervalMinutes: 60, bufferToken: '', pinUsername: '', projectId: '' },
      KEY,
    );
    const plan = saveKeywordPlan(site, 'cakes', [], 'recipe');
    queuePlanSeo(plan, 'cakes', ['lemon cake', 'carrot cake'], 'recipe');
  });
  afterEach(() => closeDatabase());

  it('lists the keywords and sub-keywords of each website, and carries the chosen one to publishing ahead of the rest', async () => {
    const [choice] = generateChoices();
    expect(choice!.websiteName).toBe('Long Livo');
    expect(choice!.keywords.map((k) => `${k.keyword}:${k.role}`)).toEqual(['cakes:pillar', 'lemon cake:sub', 'carrot cake:sub']);
    const carrot = choice!.keywords[2]!.id;

    // A failed step is tried again, and the writer takes this keyword first.
    run(`UPDATE keyword_seo SET status = 'failed' WHERE id = ?`, carrot);
    expect(startGenerateNow(carrot)!.keyword).toBe('carrot cake');
    expect(row(carrot)).toMatchObject({ status: 'pending', generate_now: 1 });
    expect(get<{ id: number }>(`SELECT id FROM keyword_seo WHERE status = 'pending' ORDER BY generate_now DESC, plan_id, position LIMIT 1`)!.id).toBe(carrot);
    expect(generateNowLines()).toEqual([{ keyword: 'carrot cake', site: 'Long Livo', step: 'writing' }]);

    // Written: its main pictures are queued (not the steps).
    run(`UPDATE keyword_seo SET status = 'done', skeleton_status = 'done', article_status = 'done', article_md = '# A', images_status = 'done', images_json = ? WHERE id = ?`, images, carrot);
    generateNowTick(deps());
    expect(all<{ slot: string }>('SELECT slot FROM newsite_pictures WHERE seo_id = ? ORDER BY position', carrot).map((p) => p.slot)).toEqual(['feature', 'overhead']);
    expect(started).toBe(1);
    expect(generateNowLines()[0]!.step).toBe('making the pictures');

    // Pictures made: published even though the website waits for approval.
    run(`UPDATE newsite_pictures SET status = 'done'`);
    await publishWhenReady(carrot, deps());
    expect(row(carrot).post_status).not.toBe('');

    run(`UPDATE keyword_seo SET post_status = 'published' WHERE id = ?`, carrot);
    generateNowTick(deps());
    expect(row(carrot).generate_now).toBe(0);
    expect(generateChoices()[0]!.keywords.map((k) => k.keyword)).toEqual(['cakes', 'lemon cake']);
    expect(startGenerateNow(carrot)).toBeUndefined();
    expect(listPlanSeo(1)).toHaveLength(3);
  });
});
