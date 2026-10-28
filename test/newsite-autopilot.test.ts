import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, getNewWebsite, listKeywordPlans, saveKeywordPlan } from '../src/newsite/repo.js';
import { kickSeoWriter, listPlanSeo, queuePlanSeo, requeueSeo } from '../src/newsite/seo.js';
import { activeKeyword, autopilotState, autopilotTick, automationLog, type ConductorDeps } from '../src/newsite/autopilot.js';
import { kickPictureMaker, queuePictures, resetPictureMakerState } from '../src/newsite/pictures.js';
import { publishWhenReady, queuePublish } from '../src/newsite/publish.js';

const KEY = randomBytes(32);
const NOW = Date.parse('2026-10-18T12:00:00Z');
const MIN = 60_000;
const sql = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const IMAGES = JSON.stringify({
  theme: { surface: 's', lighting: 'l', palette: 'p', style: 'st', mood: 'm' },
  images: ['feature', 'overhead'].map((slot) => ({ slot, prompt: `prompt for ${slot}`, alt: `alt for ${slot}` })),
});
const flush = () => new Promise((r) => setTimeout(r, 30));

/**
 * The acceptance tests of Automation (autopilot.ts), lettered as asked:
 * A off, B one at a time, C no overlap, D automatic pictures, E approval,
 * F the gap, G failure, H order, I off and on again. They run the real
 * conductor, the real writer and the real picture maker; only the AI, Flow
 * and the website are fakes.
 */
describe('Automation: one keyword at a time', () => {
  let settings: Settings;
  let siteId: number;
  let ids: number[];
  let writerWakes: number;
  let pictureWakes: number;
  let asked: string[];
  let made: number[];
  let posts: number;
  let dataDir: string;

  const fakeSite = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/api/v1/media')) return new Response(JSON.stringify({ media: { id: 1, url: 'https://g.example.com/m.webp' } }), { status: 201 });
    if (u.endsWith('/api/v1/categories')) return new Response(JSON.stringify({ items: [] }));
    posts += 1;
    return new Response(JSON.stringify({ post: { id: 70 + posts, url: `https://g.example.com/p/${posts}`, status: 'published' } }));
  }) as unknown as typeof fetch;

  const deps = (): ConductorDeps => ({
    settings,
    encryptionKey: KEY,
    dataDir,
    fetchImpl: fakeSite,
    startWriter: () => {
      writerWakes += 1;
    },
    startPictures: () => {
      pictureWakes += 1;
    },
  });
  /** The real writer, with an AI that notes each keyword it is asked about and cannot answer. */
  const writer = () =>
    kickSeoWriter({
      ask: async (_p, v) => {
        asked.push(String(v.keyword));
        throw new Error('AI down');
      },
      suggest: async () => [],
      automationOn: () => settings.get('newsite_automation_enabled') === 'true',
    });
  /** The real picture maker, with a Flow that notes whose picture it made. */
  const maker = () =>
    kickPictureMaker({
      settings,
      dataDir,
      sleep: async () => {},
      make: async (prompt) => {
        made.push(Number(get<{ seo_id: number }>('SELECT seo_id FROM newsite_pictures WHERE prompt = ? AND status = ?', prompt, 'making')!.seo_id));
        return { data: Buffer.from('img'), contentType: 'image/png' };
      },
      automationOn: () => settings.get('newsite_automation_enabled') === 'true',
    });
  const on = (yes: boolean) => settings.set('newsite_automation_enabled', yes ? 'true' : 'false');
  const row = (id: number) => get<Record<string, string | number>>('SELECT * FROM keyword_seo WHERE id = ?', id)!;
  const activeIds = () => all<{ id: number }>('SELECT id FROM keyword_seo WHERE auto_active = 1').map((r) => r.id);
  const pictureSeos = () => [...new Set(all<{ seo_id: number }>('SELECT seo_id FROM newsite_pictures').map((p) => p.seo_id))];
  const started = () => automationLog().filter((l) => l.event === 'started').map((l) => l.seo_id);
  /** Every writing step done, as the writer leaves it. */
  const written = (id: number) =>
    run(
      `UPDATE keyword_seo SET status = 'done', title = 'T', description = 'D', skeleton_status = 'done', article_status = 'done', article_md = 'Text.',
         images_status = 'done', images_json = ? WHERE id = ?`,
      IMAGES,
      id,
    );
  const postedMs = (id: number) => Date.parse(`${String(row(id).posted_at).replace(' ', 'T')}Z`);
  const publishedAt = (id: number, ms: number) =>
    run(`UPDATE keyword_seo SET post_status = 'published', posted_at = ? WHERE id = ?`, sql(ms), id);

  beforeEach(() => {
    openDatabase(':memory:');
    resetPictureMakerState();
    settings = new Settings(KEY);
    settings.set('timezone', 'UTC');
    settings.set('image_gap_seconds', '0');
    settings.set('auto_retry_enabled', 'false');
    on(true);
    writerWakes = 0;
    pictureWakes = 0;
    asked = [];
    made = [];
    posts = 0;
    dataDir = mkdtempSync(join(tmpdir(), 'autopilot-'));
    siteId = createNewWebsite(
      {
        name: 'Garden', domain: 'g.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Home gardening', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 0, intervalMinutes: 240,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    // Five keywords, added in a known order: two main keywords, the first with two sub-keywords.
    const sub = (keyword: string) => ({ keyword, intent: 'yours', reason: '', page: 'article' as const });
    const first = saveKeywordPlan(siteId, 'roses', [sub('pruning roses'), sub('feeding roses')], 'article');
    queuePlanSeo(first, 'roses', [sub('pruning roses'), sub('feeding roses')], 'article');
    const second = saveKeywordPlan(siteId, 'tomatoes', [sub('staking tomatoes')], 'article');
    queuePlanSeo(second, 'tomatoes', [sub('staking tomatoes')], 'article');
    const third = saveKeywordPlan(siteId, 'basil', [], 'article');
    queuePlanSeo(third, 'basil', [], 'article');
    ids = [...listPlanSeo(first), ...listPlanSeo(second), ...listPlanSeo(third)].map((r) => r.id);
  });
  afterEach(() => closeDatabase());

  it('A: with Automation off, no scheduler event starts anything, and the writer writes nothing', async () => {
    on(false);
    for (let i = 0; i < 5; i++) autopilotTick(deps(), NOW + i * MIN);
    await writer();
    expect(activeIds()).toEqual([]);
    expect(asked).toEqual([]);
    expect(pictureSeos()).toEqual([]);
    expect(writerWakes + pictureWakes).toBe(0);
    expect(automationLog()).toEqual([]);
  });

  it('B and H: one keyword at a time, in the order the Keywords page shows; the others wait in line', async () => {
    // The page lists main keywords oldest first, each with its sub-keywords in order: that is the line.
    const shown = listKeywordPlans(siteId).flatMap((p) => [p.pillar, ...p.items.map((i) => i.keyword)]);
    expect(shown).toEqual(['roses', 'pruning roses', 'feeding roses', 'tomatoes', 'staking tomatoes', 'basil']);

    const order: string[] = [];
    let t = NOW;
    for (let n = 0; n < ids.length; n++) {
      autopilotTick(deps(), t);
      expect(activeIds()).toHaveLength(1);
      const id = activeIds()[0]!;
      order.push(String(row(id).keyword));
      // The real writer is asked about this keyword only, never one still waiting.
      asked = [];
      requeueSeo(id);
      await writer();
      expect(new Set(asked)).toEqual(new Set([row(id).keyword]));
      // Written: its pictures, and only its pictures, are made by the real picture maker.
      written(id);
      autopilotTick(deps(), t);
      expect(pictureSeos().every((s) => s === id || row(s).post_status === 'published')).toBe(true);
      made = [];
      await maker();
      expect(new Set(made)).toEqual(new Set([id]));
      // Published by the conductor; the next one only once the gap has passed.
      autopilotTick(deps(), t);
      await flush();
      expect(row(id).post_status).toBe('published');
      publishedAt(id, t); // on the test's clock
      autopilotTick(deps(), t + MIN);
      expect(activeIds()).toEqual([]);
      autopilotTick(deps(), t + 239 * MIN);
      expect(activeIds()).toEqual([]);
      t += 240 * MIN;
    }
    // Processed in exactly the order shown.
    expect(order).toEqual(shown);
    expect(started()).toEqual(ids);
  });

  it('C: scheduler events while a keyword is under way never start a second one or a second publish', async () => {
    autopilotTick(deps(), NOW);
    const [a] = activeIds();
    for (let i = 0; i < 10; i++) autopilotTick(deps(), NOW + i * 1000);
    expect(activeIds()).toEqual([a]);
    expect(started()).toEqual([a]);
    written(a!);
    for (let i = 0; i < 10; i++) autopilotTick(deps(), NOW);
    expect(all('SELECT id FROM newsite_pictures')).toHaveLength(2); // its two main pictures, queued once
    await maker();
    // Ten triggers at once while it is ready, plus its own picture-done hook and a press of Publish.
    for (let i = 0; i < 10; i++) autopilotTick(deps(), NOW);
    void publishWhenReady(a!, deps());
    void queuePublish(a!, deps());
    await flush();
    expect(posts).toBe(1);
    expect(automationLog().filter((l) => l.event === 'publishing')).toHaveLength(1);
    expect(activeIds()).toEqual([a]);
  });

  it('D: on automatic mode the pictures start by themselves once the article is written, and it is published', async () => {
    autopilotTick(deps(), NOW);
    const [a] = activeIds();
    written(a!);
    autopilotTick(deps(), NOW);
    expect(pictureWakes).toBe(1);
    await maker();
    expect(all<{ status: string }>('SELECT status FROM newsite_pictures').map((p) => p.status)).toEqual(['done', 'done']);
    autopilotTick(deps(), NOW);
    await flush();
    expect(row(a!).post_status).toBe('published');
    expect(automationLog().map((l) => l.event)).toEqual(['started', 'pictures', 'publishing']);
  });

  it('E: on "Wait for my approval" the pictures are made, then it waits at publishing, and goes on once approved', async () => {
    run('UPDATE new_websites SET auto_publish = 0');
    autopilotTick(deps(), NOW);
    const [a] = activeIds();
    written(a!);
    autopilotTick(deps(), NOW);
    await maker(); // pictures need no approval
    for (let i = 0; i < 5; i++) autopilotTick(deps(), NOW + i * 600 * MIN);
    await flush();
    expect(row(a!).post_status).toBe('');
    expect(activeIds()).toEqual([a]); // the line waits with it
    expect(autopilotState(getNewWebsite(siteId)!, 'UTC', NOW, 0, settings).next).toBe('“roses” is waiting for your approval: press Publish');
    // The Publish button is the approval.
    await queuePublish(a!, deps());
    expect(row(a!).post_status).toBe('published');
    autopilotTick(deps(), postedMs(a!) + 240 * MIN);
    expect(automationLog().filter((l) => l.event === 'published').map((l) => l.seo_id)).toEqual([a]);
    expect(activeIds()).toEqual([ids[1]]);
  });

  it('F: no keyword starts before the gap since the last article has passed, however often the scheduler fires or the switch is flipped', () => {
    publishedAt(ids[0]!, NOW);
    for (let m = 0; m < 240; m += 7) {
      autopilotTick(deps(), NOW + m * MIN);
      on(false);
      on(true);
      settings.set('newsite_automation_on_at', String(NOW + m * MIN));
    }
    expect(activeIds()).toEqual([]);
    expect(autopilotState(getNewWebsite(siteId)!, 'UTC', NOW + MIN, 0, settings).next).toBe('Next keyword starts at 16:00');
    autopilotTick(deps(), NOW + 240 * MIN);
    expect(activeIds()).toEqual([ids[1]]);

    // Posts per day too: with one a day reached, nothing starts until tomorrow.
    run(`UPDATE keyword_seo SET auto_active = 0`);
    run('UPDATE new_websites SET daily_target = 1');
    autopilotTick(deps(), NOW + 300 * MIN);
    expect(activeIds()).toEqual([]);
    autopilotTick(deps(), Date.parse('2026-10-19T00:01:00Z'));
    expect(activeIds()).toEqual([ids[1]]);
  });

  it('F2: with a random gap set, the next keyword waits a time inside the range, drawn once, instead of the fixed gap', () => {
    run('UPDATE new_websites SET random_gap_from = 60, random_gap_to = 120');
    publishedAt(ids[0]!, NOW);
    let startedAt = 0;
    for (let m = 0; m <= 130 && !startedAt; m++) {
      autopilotTick(deps(), NOW + m * MIN);
      if (activeIds().length) startedAt = m;
    }
    expect(startedAt).toBeGreaterThanOrEqual(60);
    expect(startedAt).toBeLessThanOrEqual(120); // well before the fixed four hours
    expect(activeIds()).toEqual([ids[1]]);
  });

  it('G: a failed keyword is recorded and stopped, and the next keyword goes ahead of it instead of waiting', async () => {
    autopilotTick(deps(), NOW);
    const [a, b] = ids as [number, number];
    await writer(); // the AI cannot be reached: AI#1 fails
    expect(row(a).status).toBe('failed');
    for (let i = 0; i < 5; i++) autopilotTick(deps(), NOW);
    expect(automationLog().find((l) => l.event === 'stopped')).toMatchObject({ seo_id: a, note: 'The seo step failed.' });
    // One failure does not hold up the line: the next keyword gets the turn, still one at a time.
    expect(activeIds()).toEqual([b]);
    expect(started()).toEqual([a, b]);
    expect(autopilotState(getNewWebsite(siteId)!, 'UTC', NOW, 0, settings).next).not.toContain('wait for it');
  });

  it('G2: with tries left a failed step or picture keeps its turn; with none left it is stepped over, and Try again puts it first again', async () => {
    settings.set('auto_retry_enabled', 'true');
    settings.set('auto_retry_max', '1');
    autopilotTick(deps(), NOW);
    const [a, b] = ids as [number, number];
    await writer();
    autopilotTick(deps(), NOW);
    expect(activeIds()).toEqual([a]);

    // A failed picture is tried again by itself while a try is left.
    written(a);
    autopilotTick(deps(), NOW);
    run(`UPDATE newsite_pictures SET status = 'failed' WHERE seo_id = ?`, a);
    autopilotTick(deps(), NOW);
    expect(all<{ status: string }>('SELECT status FROM newsite_pictures WHERE seo_id = ?', a).map((p) => p.status)).toEqual(['queued', 'queued']);
    // Automation's own try is not a button press: it is made only while the keyword has its turn.
    expect(all<{ by_hand: number }>('SELECT by_hand FROM newsite_pictures WHERE seo_id = ?', a).map((p) => p.by_hand)).toEqual([0, 0]);
    expect(activeIds()).toEqual([a]);
    // None left: it stops, and the next keyword goes ahead.
    run(`UPDATE newsite_pictures SET status = 'failed' WHERE seo_id = ?`, a);
    for (let i = 0; i < 3; i++) autopilotTick(deps(), NOW);
    expect(activeIds()).toEqual([b]);
    expect(started()).toEqual([a, b]);
    // An hour after it stopped it gets its turn back by itself, and its pictures are tried again.
    run(`UPDATE newsite_automation_log SET at = datetime('now', '-62 minutes') WHERE seo_id = ? AND event != 'stopped'`, a);
    run(`UPDATE newsite_automation_log SET at = datetime('now', '-61 minutes') WHERE seo_id = ? AND event = 'stopped'`, a);
    publishedAt(b, NOW - 10_000 * MIN);
    autopilotTick(deps(), NOW);
    expect(activeIds()).toEqual([a]);
    autopilotTick(deps(), NOW);
    expect(all<{ status: string }>('SELECT status FROM newsite_pictures WHERE seo_id = ?', a).map((p) => p.status)).toEqual(['queued', 'queued']);
    // Failed again: stopped for another hour, not tried again and again.
    run(`UPDATE newsite_pictures SET status = 'failed' WHERE seo_id = ?`, a);
    for (let i = 0; i < 3; i++) autopilotTick(deps(), NOW);
    expect(all<{ status: string }>('SELECT status FROM newsite_pictures WHERE seo_id = ?', a).map((p) => p.status)).toEqual(['failed', 'failed']);
    const [c] = activeIds();
    expect(c).not.toBe(a); // the next keyword went ahead meanwhile
    // Try again: it is first in line again once that one is out.
    run(`UPDATE newsite_pictures SET status = 'done' WHERE seo_id = ?`, a);
    publishedAt(c!, NOW - 10_000 * MIN);
    autopilotTick(deps(), NOW);
    expect(activeIds()).toEqual([a]);
  });

  it('I: turned off with a keyword under way, nothing more starts; turned on, the same keyword carries on from where it was', async () => {
    autopilotTick(deps(), NOW);
    const [a] = activeIds();
    written(a!);
    autopilotTick(deps(), NOW); // its pictures are queued
    on(false);
    await maker();
    await writer();
    for (let i = 0; i < 5; i++) autopilotTick(deps(), NOW + i * 600 * MIN);
    expect(made).toEqual([]);
    expect(asked).toEqual([]);
    expect(all<{ status: string }>('SELECT status FROM newsite_pictures').map((p) => p.status)).toEqual(['queued', 'queued']);
    expect(started()).toEqual([a]);

    on(true);
    autopilotTick(deps(), NOW + 3000 * MIN);
    expect(activeIds()).toEqual([a]);
    expect(started()).toEqual([a]); // not started again: carried on
    await maker();
    expect(new Set(made)).toEqual(new Set([a]));
    autopilotTick(deps(), NOW + 3000 * MIN);
    await flush();
    expect(row(a!).post_status).toBe('published');
    expect(activeKeyword()?.id).toBe(a);
  });

  it('J: pictures left queued for a later keyword wait for its turn; an article made early waits for the gap, then goes out', async () => {
    const [a, b, c] = ids as [number, number, number];
    // Left by the old day-ahead picture lane: b's pictures queued, a already written and pictured.
    written(a);
    written(b);
    written(c);
    queuePictures(a, dataDir);
    await kickPictureMaker({ settings, dataDir, sleep: async () => {}, make: async () => ({ data: Buffer.from('i'), contentType: 'image/png' }) });
    queuePictures(b, dataDir);
    publishedAt(ids[5]!, NOW - 60 * MIN); // the website posted an hour ago; the gap is four hours
    autopilotTick(deps(), NOW);
    expect(activeIds()).toEqual([]);
    expect(autopilotState(getNewWebsite(siteId)!, 'UTC', NOW, 0, settings).next).toBe('“roses” is ready and goes out at 15:00, when the website’s gap has passed');
    await maker();
    expect(made).toEqual([]); // b's pictures are not made ahead of its turn
    // Pictures someone asks for are made at once.
    queuePictures(c, dataDir, true);
    await maker();
    expect(new Set(made)).toEqual(new Set([c]));
    // The gap passes: a is the one, and goes out straight away.
    autopilotTick(deps(), NOW + 180 * MIN);
    await flush();
    expect(row(a).post_status).toBe('published');
    expect(all<{ status: string }>('SELECT status FROM newsite_pictures WHERE seo_id = ?', b).map((p) => p.status)).toEqual(['queued', 'queued']);
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
      settings.set('newsite_automation_enabled', 'false');
      const dash = (await app.inject({ method: 'GET', url: '/new-website/dashboard' })).body;
      expect(dash.indexOf('aria-label="Automation"')).toBeLessThan(dash.indexOf('class="db-kpis"'));
      expect(dash).toContain('<span class="ap-state">OFF</span>');
      const on = await post('on=1&back=%2Fnew-website%2Fplatform');
      expect(on.headers.location).toMatch(/^\/new-website\/platform\?ok=Automation%20is%20on/);
      expect(settings.get('newsite_automation_enabled') === 'true').toBe(true);
      const page = (await app.inject({ method: 'GET', url: '/new-website/platform' })).body;
      expect(page).toContain('<span class="ap-state">ON</span>');
      expect(page).toContain('<b>Long Livo:</b> No keywords left: add keywords');
      await post('on=0');
      expect(settings.get('newsite_automation_enabled') === 'true').toBe(false);
    } finally {
      await app.close();
      closeDatabase();
    }
  });
});
