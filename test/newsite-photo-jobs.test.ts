import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { beforeEach, describe, expect, it } from 'vitest';
import { all, openDatabase, run } from '../src/db/index.js';
import { encrypt } from '../src/lib/crypto.js';
import { Settings } from '../src/settings.js';
import { photoJobTick, registerPhotoJobRoutes } from '../src/newsite/photo-jobs.js';
import { registerTopListRoutes, writeTopList } from '../src/newsite/top-lists.js';

const KEY = randomBytes(32);
const readFlash = () => null;

function addSite(): number {
  return run(
    `INSERT INTO new_websites (name, domain, niche, niche_context, persona, api_key_encrypted, status) VALUES ('Bakes', 'bakes.example.com', 'baking', '', 'Practical Helper', ?, 'active')`,
    encrypt('site-key', KEY),
  ).lastInsertRowid as number;
}

describe('Photo jobs and top lists', () => {
  let app: FastifyInstance;
  let calls: { url: string; method: string; body: unknown }[];
  let site: (url: string, init: RequestInit) => Response;

  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    return site(String(url), init);
  }) as unknown as typeof fetch;

  beforeEach(async () => {
    openDatabase(':memory:');
    calls = [];
    app = Fastify();
    await app.register(formbody);
  });

  it('takes a job, makes each photo, uploads it and hands the job back', async () => {
    addSite();
    const settings = new Settings();
    settings.set('image_gap_seconds', '0');
    let mediaId = 100;
    let handed = false;
    site = (url) => {
      if (url.endsWith('/photo-jobs/next')) {
        if (handed) return Response.json({ job: null, waitSeconds: 60 });
        handed = true;
        return Response.json({
          job: {
            id: 7,
            post: { id: 3, title: 'Zucchini Bread', url: 'https://bakes.example.com/zucchini-bread' },
            photos: [
              { slot: 'cover', kind: 'cover', text: 'the loaf' },
              { slot: 'step-0', kind: 'step', index: 0, text: 'Grate the zucchini.' },
              { slot: 'gallery-0', kind: 'gallery', text: 'a slice' },
            ],
          },
          waitSeconds: 0,
        });
      }
      if (url.endsWith('/media')) return Response.json({ media: { id: ++mediaId } });
      if (url.endsWith('/photo-jobs/7/done')) return Response.json({ placed: 3, stillMissing: [] });
      if (url.endsWith('/missing-photos')) return Response.json({ totals: { noImages: 1, anyMissing: 2 }, queue: {}, posts: [{ id: 3, title: 'Zucchini Bread', noImages: true, missing: ['cover'] }] });
      return new Response('', { status: 404 });
    };
    const shapes: string[] = [];
    const deps = {
      settings,
      encryptionKey: KEY,
      readFlash,
      fetchImpl,
      dataDir: mkdtempSync(join(tmpdir(), 'pj-')),
      autoStart: false,
      make: async (_prompt: string, _project: string, shape: string) => {
        shapes.push(shape);
        return { data: Buffer.from('img'), contentType: 'image/png' };
      },
    };
    registerPhotoJobRoutes(app, deps);
    await photoJobTick(deps);

    expect(shapes).toEqual(['PORTRAIT_3_4', 'SQUARE', 'PORTRAIT_3_4']);
    // Each photo goes on the post the moment it is made, one call each.
    expect(calls.filter((c) => c.url.endsWith('/photo-jobs/7/done')).map((c) => c.body)).toEqual([
      { photos: [{ slot: 'cover', mediaId: 101 }] },
      { photos: [{ slot: 'step-0', mediaId: 102 }] },
      { photos: [{ slot: 'gallery-0', mediaId: 103 }] },
    ]);
    expect(all<{ status: string }>('SELECT status FROM photo_jobs')).toEqual([{ status: 'done' }]);

    const page = await app.inject({ url: '/new-website/photo-jobs' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Zucchini Bread');
    expect(page.body).toContain('Queue all with no photos');
  });

  it('stops after the photo in hand when paused, and waits while article pictures are made', async () => {
    addSite();
    const settings = new Settings();
    settings.set('image_gap_seconds', '0');
    let mediaId = 100;
    site = (url) => {
      if (url.endsWith('/photo-jobs/next')) {
        return Response.json({
          job: { id: 8, post: { id: 4, title: 'Rye' }, photos: [{ slot: 'cover', kind: 'cover', text: 'a' }, { slot: 'gallery-0', kind: 'gallery', text: 'b' }] },
        });
      }
      if (url.endsWith('/media')) return Response.json({ media: { id: ++mediaId } });
      return Response.json({});
    };
    let articlesBusy = true;
    let made = 0;
    const deps = {
      settings, encryptionKey: KEY, readFlash, fetchImpl, autoStart: false,
      dataDir: mkdtempSync(join(tmpdir(), 'pj-')),
      mainBusy: () => articlesBusy,
      make: async () => {
        made++;
        settings.set('photo_jobs_paused', '1'); // Pause pressed while this photo is being made
        return { data: Buffer.from('img'), contentType: 'image/png' };
      },
    };
    registerPhotoJobRoutes(app, deps);

    await photoJobTick(deps);
    expect(calls).toEqual([]); // article pictures first: not even asked for a job

    articlesBusy = false;
    await photoJobTick(deps);
    expect(made).toBe(1);
    // The photo in hand is already on the post; the next one waits for Start.
    expect(calls.filter((c) => c.url.endsWith('/done')).map((c) => c.body)).toEqual([{ photos: [{ slot: 'cover', mediaId: 101 }] }]);
    expect(all<{ status: string }>('SELECT status FROM photo_jobs')).toEqual([{ status: 'making' }]);

    settings.set('photo_jobs_paused', '0');
    deps.make = async () => ({ data: Buffer.from('img'), contentType: 'image/png' });
    await photoJobTick(deps);
    expect(all<{ status: string }>('SELECT status FROM photo_jobs')).toEqual([{ status: 'done' }]);
  });

  describe('a photo that fails', () => {
    const job = {
      id: 8,
      post: { id: 4, title: 'Lemon Tart' },
      photos: [
        { slot: 'cover', kind: 'cover', text: 'the tart' },
        { slot: 'step-0', kind: 'step', index: 0, text: 'Roll the dough.' },
        { slot: 'step-1', kind: 'step', index: 1, text: 'Fill the shell.' },
      ],
    };
    let made: string[];
    let failSlot: string;
    let refuseSlot: string;
    let mainBusy: boolean;
    const setup = () => {
      addSite();
      const settings = new Settings();
      settings.set('image_gap_seconds', '0');
      let handed = false;
      let mediaId = 200;
      made = [];
      failSlot = '';
      refuseSlot = '';
      mainBusy = false;
      site = (url, init) => {
        if (url.endsWith('/photo-jobs/next')) {
          if (handed) return Response.json({ job: null, waitSeconds: 60 });
          handed = true;
          return Response.json({ job, waitSeconds: 0 });
        }
        if (url.endsWith('/media')) return Response.json({ media: { id: ++mediaId } });
        if (url.endsWith('/photo-jobs/8/done')) {
          const slot = (JSON.parse(String(init.body)) as { photos: { slot: string }[] }).photos[0]!.slot;
          if (slot === refuseSlot) return Response.json({ error: `Unknown slot "${slot}" for this post.` }, { status: 422 });
          return Response.json({ placed: [slot], stillMissing: [] });
        }
        return Response.json({});
      };
      const deps = {
        settings,
        encryptionKey: KEY,
        readFlash,
        fetchImpl,
        dataDir: mkdtempSync(join(tmpdir(), 'pj-')),
        autoStart: false,
        mainBusy: () => mainBusy,
        make: async (prompt: string) => {
          const slot = prompt.startsWith('Hero') ? 'cover' : job.photos.find((p) => prompt.includes(p.text))!.slot;
          made.push(slot);
          if (slot === failSlot) throw new Error('Flow said no');
          return { data: Buffer.from('img'), contentType: 'image/png' };
        },
      };
      registerPhotoJobRoutes(app, deps);
      return deps;
    };
    const placedSlots = () =>
      calls.filter((c) => c.url.endsWith('/photo-jobs/8/done')).map((c) => (c.body as { photos: { slot: string }[] }).photos[0]!.slot);

    it('does not hold back the others, and Try again makes only that one', async () => {
      const deps = setup();
      failSlot = 'step-0';
      await photoJobTick(deps);
      expect(placedSlots()).toEqual(['cover', 'step-1']);
      expect(all<{ status: string }>('SELECT status FROM photo_jobs')).toEqual([{ status: 'failed' }]);
      expect(calls.some((c) => c.url.endsWith('/failed'))).toBe(false);

      failSlot = '';
      made = [];
      await app.inject({ method: 'POST', url: '/new-website/photo-jobs/1/retry' });
      await new Promise((r) => setTimeout(r, 20));
      expect(made).toEqual(['step-0']);
      expect(placedSlots()).toEqual(['cover', 'step-1', 'step-0']);
      expect(all<{ status: string }>('SELECT status FROM photo_jobs')).toEqual([{ status: 'done' }]);
    });

    it('keeps going when the website refuses one photo, and places it again on Try again', async () => {
      const deps = setup();
      refuseSlot = 'cover';
      await photoJobTick(deps);
      expect(placedSlots()).toEqual(['cover', 'step-0', 'step-1']);
      const job = all<{ status: string; error: string }>('SELECT status, error FROM photo_jobs')[0]!;
      expect(job.status).toBe('failed');
      expect(job.error).toContain('Unknown slot');

      refuseSlot = '';
      made = [];
      await app.inject({ method: 'POST', url: '/new-website/photo-jobs/1/retry' });
      await new Promise((r) => setTimeout(r, 20));
      expect(made).toEqual([]);
      expect(all<{ status: string }>('SELECT status FROM photo_jobs')).toEqual([{ status: 'done' }]);
    });

    it('places photos made before, even while article pictures are being made', async () => {
      const deps = setup();
      refuseSlot = 'step-1';
      await photoJobTick(deps);
      // As an older job was left: made, never placed.
      run('UPDATE photo_job_photos SET placed = 0');
      refuseSlot = '';
      mainBusy = true;
      calls = [];
      made = [];
      await photoJobTick(deps);
      expect(made).toEqual([]);
      expect(placedSlots()).toEqual(['cover', 'step-0', 'step-1']);
      expect(all<{ status: string }>('SELECT status FROM photo_jobs')).toEqual([{ status: 'done' }]);
    });
  });

  it('suggests a topic from the posts and publishes the approved top list', async () => {
    addSite();
    const items = ['Zucchini Bread', 'Chocolate Zucchini Bread', 'Lemon Zucchini Bread', 'Banana Bread'].map((title, i) => ({
      id: i + 1, title, slug: `p${i + 1}`, status: 'published', url: `https://bakes.example.com/p${i + 1}`, excerpt: 'x', category: { name: 'Breads', slug: 'breads' }, coverUrl: `https://bakes.example.com/c${i}.webp`,
    }));
    site = (url) => {
      if (url.includes('/api/v1/posts?')) return Response.json({ items, pages: 1 });
      if (url.endsWith('/api/v1/media')) return Response.json({ media: { id: 51 } });
      if (url.endsWith('/api/v1/posts')) return Response.json({ post: { id: 99, url: 'https://bakes.example.com/top', status: 'published' } });
      return new Response('', { status: 404 });
    };
    const deps = {
      encryptionKey: KEY,
      readFlash,
      fetchImpl,
      ask: async () => JSON.stringify({ title: '3 Zucchini Bread Recipes', excerpt: 'e', intro: 'i', items: [{ id: 2, blurb: 'b2' }, { id: 1, blurb: 'b1' }, { id: 3, blurb: 'b3' }], outro: 'o' }),
    };
    registerTopListRoutes(app, deps);
    const scan = await app.inject({ method: 'POST', url: '/new-website/top-lists/scan', payload: 'site=1&min=3', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(scan.statusCode).toBe(303);
    const rows = all<{ id: number; topic: string }>('SELECT id, topic FROM top_list_suggestions');
    // "bread" (4 posts) stays too: "zucchini bread" holds only 3 of them.
    expect(rows.map((r) => r.topic).sort()).toEqual(['bread', 'zucchini bread']);

    await writeTopList(rows.find((r) => r.topic === 'zucchini bread')!.id, deps);
    const saved = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/v1/posts'))!.body as Record<string, unknown>;
    expect(saved.category).toBe('Top lists');
    expect(saved.cover).toBe(51);
    expect(calls.find((c) => c.url.endsWith('/api/v1/media'))!.body).toEqual({ url: 'https://bakes.example.com/c1.webp', alt: 'Chocolate Zucchini Bread' });
    expect(String(saved.content)).toContain('](https://bakes.example.com/c1.webp)');
    expect(String(saved.content)).toContain('## 1. [Chocolate Zucchini Bread](https://bakes.example.com/p2)');
    const page = await app.inject({ url: '/new-website/top-lists' });
    expect(page.body).toContain('Published');
  });
});
