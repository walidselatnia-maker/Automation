import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, getNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { autopilotState, autopilotTick } from '../src/newsite/autopilot.js';
import { publishWhenReady } from '../src/newsite/publish.js';

const KEY = randomBytes(32);
const NOW = Date.parse('2026-10-18T12:00:00Z');
const sql = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const images = JSON.stringify({
  theme: { surface: 's', lighting: 'l', palette: 'p', style: 'st', mood: 'm' },
  images: ['feature', 'overhead', 'step-1'].map((slot) => ({ slot, prompt: `prompt for ${slot}`, alt: `alt for ${slot}` })),
});

describe('Autopilot', () => {
  let settings: Settings;
  let ids: number[];
  let started: number;
  const deps = () => ({
    settings,
    encryptionKey: KEY,
    dataDir: mkdtempSync(join(tmpdir(), 'autopilot-')),
    fetchImpl: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
    startPictures: () => {
      started += 1;
    },
  });
  const site = (autopilot: boolean) =>
    createNewWebsite(
      {
        name: 'Site', domain: autopilot ? 'a.example.com' : 'b.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, autopilot, dailyTarget: 2, intervalMinutes: 60,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
  const keywords = (websiteId: number) => {
    const plan = saveKeywordPlan(websiteId, 'cakes', [], 'recipe');
    for (const k of ['a', 'b', 'c', 'd']) queuePlanSeo(plan, k, [], 'recipe');
    const rows = listPlanSeo(plan);
    for (const r of rows) run(`UPDATE keyword_seo SET status = 'done', article_status = 'done', images_status = 'done', images_json = ? WHERE id = ?`, images, r.id);
    return rows.map((r) => r.id);
  };
  const queuedFor = () => all<{ seo_id: number; slot: string }>(`SELECT seo_id, slot FROM newsite_pictures ORDER BY seo_id, position`);
  const publishState = (id: number) => get<{ post_status: string }>('SELECT post_status FROM keyword_seo WHERE id = ?', id)!.post_status;
  const flush = () => new Promise((r) => setTimeout(r, 20));

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('timezone', 'UTC');
    started = 0;
    ids = keywords(site(true));
    keywords(site(false));
  });
  afterEach(() => closeDatabase());

  it('makes main pictures one day ahead, publishes by posts per day and the gap, and stops when keywords run out', async () => {
    const [a, b, c, d] = ids as [number, number, number, number];
    autopilotTick(deps(), NOW);
    // Two articles a day: the main pictures (not the steps) of the first two, and only on the Autopilot website.
    expect(queuedFor()).toEqual([a, a, b, b].map((seo_id, i) => ({ seo_id, slot: i % 2 ? 'overhead' : 'feature' })));
    expect(started).toBe(1);
    expect(autopilotState(getNewWebsite(1)!, 'UTC', NOW).next).toBe('Next article is being prepared');

    run(`UPDATE newsite_pictures SET status = 'done'`);
    run(`UPDATE keyword_seo SET post_status = 'published', posted_at = ? WHERE id = ?`, sql(NOW - 30 * 60_000), a);
    // Publishing right when pictures are made is Autopilot's job, not the picture maker's.
    await publishWhenReady(b, deps());
    expect(publishState(b)).toBe('');

    autopilotTick(deps(), NOW);
    expect(queuedFor().filter((p) => p.seo_id === c)).toHaveLength(2);
    await flush();
    expect(publishState(b)).toBe('');
    expect(autopilotState(getNewWebsite(1)!, 'UTC', NOW)).toMatchObject({ ready: 1, today: 1, next: 'Next article at 12:30' });

    autopilotTick(deps(), NOW + 31 * 60_000);
    await flush();
    expect(publishState(b)).not.toBe('');

    run(`UPDATE keyword_seo SET post_status = 'published', posted_at = ? WHERE id = ?`, sql(NOW), b);
    run(`UPDATE newsite_pictures SET status = 'done'`);
    expect(autopilotState(getNewWebsite(1)!, 'UTC', NOW + 2 * 3_600_000).next).toBe('Next article tomorrow');
    autopilotTick(deps(), NOW + 2 * 3_600_000);
    await flush();
    expect(publishState(c)).toBe('');

    run(`UPDATE keyword_seo SET post_status = 'published' WHERE id IN (?, ?)`, c, d);
    expect(autopilotState(getNewWebsite(1)!, 'UTC', NOW).next).toBe('No keywords left: add keywords');
  });
});
