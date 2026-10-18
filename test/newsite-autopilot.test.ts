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
  const site = (active: boolean) =>
    createNewWebsite(
      {
        name: 'Site', domain: active ? 'a.example.com' : 'b.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking recipes', nicheContext: '',
        persona: 'Storyteller', status: active ? 'active' : 'paused', autoPublish: true, dailyTarget: 2, intervalMinutes: 60,
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
    settings.set('automation_enabled', 'true');
    started = 0;
    ids = keywords(site(true));
    keywords(site(false));
  });
  afterEach(() => closeDatabase());

  it('makes main pictures one day ahead, publishes by posts per day and the gap, and stops when keywords run out', async () => {
    const [a, b, c, d] = ids as [number, number, number, number];
    // The platform's Automation switch off: nothing happens.
    settings.set('automation_enabled', 'false');
    autopilotTick(deps(), NOW);
    expect(queuedFor()).toEqual([]);
    settings.set('automation_enabled', 'true');
    autopilotTick(deps(), NOW);
    // Two articles a day: the main pictures (not the steps) of the first two, and only on the active website.
    expect(queuedFor()).toEqual([a, a, b, b].map((seo_id, i) => ({ seo_id, slot: i % 2 ? 'overhead' : 'feature' })));
    expect(started).toBe(1);
    expect(autopilotState(getNewWebsite(1)!, 'UTC', NOW).next).toBe('Making the pictures of 2 articles');

    run(`UPDATE newsite_pictures SET status = 'done'`);
    run(`UPDATE keyword_seo SET post_status = 'published', posted_at = ? WHERE id = ?`, sql(NOW - 30 * 60_000), a);
    // With Automation on, publishing right when pictures are made is the schedule's job, not the picture maker's.
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

describe('Automation switch', () => {
  it('shows ON or OFF at the top of the Dashboard and Platform settings, and turns the whole platform on and off', async () => {
    const Fastify = (await import('fastify')).default;
    const formbody = (await import('@fastify/formbody')).default;
    const { registerNewWebsiteRoutes } = await import('../src/newsite/routes.js');
    openDatabase(':memory:');
    const settings = new Settings(KEY);
    const app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, { encryptionKey: KEY, settings, autoSeo: false, autoPictures: false });
    await app.ready();
    const post = (payload: string) =>
      app.inject({ method: 'POST', url: '/new-website/platform/automation', payload, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    try {
      createNewWebsite(
        { name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '', persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '' },
        KEY,
      );
      settings.set('automation_enabled', 'false');
      const dash = (await app.inject({ method: 'GET', url: '/new-website/dashboard' })).body;
      expect(dash.indexOf('aria-label="Automation"')).toBeLessThan(dash.indexOf('class="db-kpis"'));
      expect(dash).toContain('<span class="ap-state">OFF</span>');
      const on = await post('on=1&back=%2Fnew-website%2Fplatform');
      expect(on.headers.location).toBe('/new-website/platform?ok=Automation%20is%20on.');
      expect(settings.getBool('automation_enabled')).toBe(true);
      const page = (await app.inject({ method: 'GET', url: '/new-website/platform' })).body;
      expect(page).toContain('<span class="ap-state">ON</span>');
      expect(page).toContain('<b>Long Livo:</b> No keywords left: add keywords');
      await post('on=0');
      expect(settings.getBool('automation_enabled')).toBe(false);
    } finally {
      await app.close();
      closeDatabase();
    }
  });
});
