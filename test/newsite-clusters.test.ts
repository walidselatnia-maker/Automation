import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { pictureDir } from '../src/newsite/pictures.js';
import { clusterFields, publishKeyword } from '../src/newsite/publish.js';
import { syncClusters } from '../src/newsite/clusters.js';

const KEY = randomBytes(32);
const SLOTS = ['feature', 'overhead'];

describe('Topic clusters (pillar and sub-articles)', () => {
  let settings: Settings;
  let pillarId: number;
  let subId: number;
  let dataDir: string;
  let calls: { method: string; url: string; body: unknown }[];
  let sitePosts: Record<string, unknown>[];
  let asked: number;

  const fakeSite = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.endsWith('/api/v1/media')) return new Response(JSON.stringify({ media: { id: 100, url: 'x' } }), { status: 201 });
    if (u.endsWith('/api/v1/categories')) {
      return new Response(JSON.stringify({ items: [{ id: 3, name: 'Desserts', authorIds: [9] }, { id: 5, name: 'Cakes', authorIds: [9] }] }));
    }
    if (u.includes('/api/v1/posts?')) return new Response(JSON.stringify({ items: sitePosts, pages: 1 }));
    calls.push({ method, url: u, body: JSON.parse(String(init!.body)) });
    return new Response(JSON.stringify({ post: { id: 70 + calls.length, url: 'https://f.longlivo.com/recipes/x', status: 'published' } }));
  }) as unknown as typeof fetch;

  const deps = () => ({
    settings, encryptionKey: KEY, fetchImpl: fakeSite, dataDir, now: () => 1_000_000, random: () => 0,
    ask: async () => { asked += 1; return '{"category": "Cakes"}'; },
  });

  /** A keyword ready to publish: article done, main pictures made. */
  const ready = (id: number, title: string) => {
    run(
      `UPDATE keyword_seo SET status = 'done', title = ?, description = 'D', focus_keyword = ?, article_status = 'done', article_md = 'Text.',
         images_status = 'done', images_json = ?, page = 'article' WHERE id = ?`,
      title, title.toLowerCase(),
      JSON.stringify({ theme: {}, images: SLOTS.map((slot) => ({ slot, prompt: 'p', alt: 'a' })) }),
      id,
    );
    SLOTS.forEach((slot, i) => {
      run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, file) VALUES (?, ?, ?, 'p', 'a', 'done', ?)`, id, slot, i, `${slot}.png`);
      mkdirSync(pictureDir(id, dataDir), { recursive: true });
      writeFileSync(join(pictureDir(id, dataDir), `${slot}.png`), 'img');
    });
  };

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    const websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    const planId = saveKeywordPlan(websiteId, 'strawberry cake', [], 'article');
    queuePlanSeo(planId, 'strawberry cake', ['strawberry cake for kids'], 'article');
    [pillarId, subId] = listPlanSeo(planId).map((r) => r.id) as [number, number];
    dataDir = mkdtempSync(join(tmpdir(), 'clusters-'));
    calls = [];
    sitePosts = [];
    asked = 0;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('labels the pillar, and points each sub-keyword at its own plan\'s pillar', () => {
    expect(clusterFields({ id: pillarId, plan_id: 1, role: 'pillar' })).toEqual({ clusterRole: 'pillar' });
    expect(clusterFields({ id: subId, plan_id: 1, role: 'sub' })).toEqual({ clusterRole: 'sub', pillar: `ext:newsite-${pillarId}` });
  });

  it('publishes the cluster label, and the sub-article goes in its pillar\'s category without asking the AI', async () => {
    ready(pillarId, 'Strawberry Cake');
    ready(subId, 'Strawberry Cake for Kids');
    await publishKeyword(pillarId, deps());
    expect(asked).toBe(1);
    await publishKeyword(subId, deps());
    expect(asked).toBe(1);
    const [pillar, sub] = calls.filter((c) => c.url.endsWith('/api/v1/posts')).map((c) => c.body as Record<string, unknown>);
    expect(pillar).toMatchObject({ externalId: `newsite-${pillarId}`, clusterRole: 'pillar', category: 5 });
    expect(pillar).not.toHaveProperty('pillar');
    expect(sub).toMatchObject({ externalId: `newsite-${subId}`, clusterRole: 'sub', pillar: `ext:newsite-${pillarId}`, category: 5 });
  });

  it('marks articles published before the site knew clusters, pillar first, and leaves right ones alone', async () => {
    run(`UPDATE keyword_seo SET post_status = 'published', post_id = 11 WHERE id = ?`, pillarId);
    run(`UPDATE keyword_seo SET post_status = 'published', post_id = 12 WHERE id = ?`, subId);
    sitePosts = [
      { id: 12, slug: 'kids', title: 'Kids', clusterRole: null, pillarId: null, pillarRef: null },
      { id: 11, slug: 'cake', title: 'Cake', clusterRole: null, pillarId: null, pillarRef: null },
    ];
    expect(await syncClusters({ encryptionKey: KEY, fetchImpl: fakeSite })).toEqual({ marked: 2, failed: 0 });
    expect(calls.map((c) => [c.method, c.url.replace(/.*\/posts/, ''), c.body])).toEqual([
      ['PATCH', '/11', { clusterRole: 'pillar' }],
      ['PATCH', '/12', { clusterRole: 'sub', pillar: `ext:newsite-${pillarId}` }],
    ]);

    calls = [];
    sitePosts = [
      { id: 11, slug: 'cake', title: 'Cake', clusterRole: 'pillar', pillarId: null, pillarRef: null },
      { id: 12, slug: 'kids', title: 'Kids', clusterRole: 'sub', pillarId: 11, pillarRef: null },
    ];
    expect(await syncClusters({ encryptionKey: KEY, fetchImpl: fakeSite })).toEqual({ marked: 0, failed: 0 });
    expect(calls).toEqual([]);
  });

  it('leaves a website that does not know clusters yet alone', async () => {
    run(`UPDATE keyword_seo SET post_status = 'published', post_id = 11 WHERE id = ?`, pillarId);
    sitePosts = [{ id: 11, slug: 'cake', title: 'Cake' }];
    expect(await syncClusters({ encryptionKey: KEY, fetchImpl: fakeSite })).toEqual({ marked: 0, failed: 0 });
    expect(calls).toEqual([]);
  });
});
