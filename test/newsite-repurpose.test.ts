import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { openDatabase, closeDatabase } from '../src/db/index.js';
import { createNewWebsite } from '../src/newsite/repo.js';
import { saveBufferChannel } from '../src/newsite/channels.js';
import {
  generateRepurposePost,
  getRepurposeArticle,
  getRepurposePost,
  kickRepurpose,
  listRepurposeArticles,
  listRepurposePosts,
  repurposeSentToday,
  syncWebsiteArticles,
  updateRepurposeSettings,
} from '../src/newsite/repurpose.js';
import { registerRepurposeRoutes } from '../src/newsite/repurpose-routes.js';
import type { NewWebsiteRow } from '../src/newsite/repo.js';
import { get } from '../src/db/index.js';

const KEY = Buffer.alloc(32, 7);

describe('New dashboard: content repurposing', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  const createSite = (name = 'Food Blog', domain = 'food.example.com') =>
    createNewWebsite(
      {
        name,
        domain,
        apiKey: 'sk_test_ABCDEFGHIJKLMNOP',
        niche: 'Baking & Desserts',
        nicheContext: '',
        persona: 'Friendly baker',
        status: 'active',
        autoPublish: true,
        dailyTarget: 3,
        intervalMinutes: 480,
        bufferToken: '',
        pinUsername: '',
        projectId: '',
      },
      KEY,
    );

  const mockPostsResponse = () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({
      pages: 1,
      items: [
        {
          id: 101,
          title: 'Authentic Sourdough Bread',
          slug: 'authentic-sourdough-bread',
          status: 'published',
          excerpt: 'Crispy crust and chewy crumb recipe made with wild yeast.',
          content: 'Here is the complete guide to making sourdough bread at home with wild yeast...',
          cover: { url: 'https://food.example.com/images/sourdough.jpg' },
          category: { name: 'Bread' },
        },
        {
          id: 102,
          title: 'Quick Chocolate Chip Cookies',
          slug: 'quick-chocolate-chip-cookies',
          status: 'published',
          excerpt: 'Warm and gooey cookies in under thirty minutes.',
          content: 'The secret to chewy cookies is melted butter and brown sugar...',
          cover: { url: 'https://food.example.com/images/cookies.jpg' },
          category: { name: 'Cookies' },
        },
      ],
    }),
  });

  it('syncs articles directly from connected website API without duplicates', async () => {
    const siteId = createSite();
    const site = get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', siteId)!;

    const mockFetch = async () => mockPostsResponse() as any;

    const result = await syncWebsiteArticles(site, 'sk_test_mock', mockFetch);
    expect(result.found).toBe(2);
    expect(result.added).toBe(2);

    const articles = listRepurposeArticles(siteId);
    expect(articles).toHaveLength(2);
    expect(articles[0]!.title).toBe('Quick Chocolate Chip Cookies');
    expect(articles[0]!.cover_url).toBe('https://food.example.com/images/cookies.jpg');
    expect(articles[1]!.title).toBe('Authentic Sourdough Bread');

    // Running sync again updates existing articles without adding duplicates
    const resync = await syncWebsiteArticles(site, 'sk_test_mock', mockFetch);
    expect(resync.found).toBe(2);
    expect(resync.added).toBe(0);
    expect(resync.updated).toBe(2);
    expect(listRepurposeArticles(siteId)).toHaveLength(2);
  });

  it('generates 100% fresh social posts and rejects verbatim original titles', async () => {
    const siteId = createSite();
    const site = get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', siteId)!;

    await syncWebsiteArticles(site, 'sk_test_mock', (async () => mockPostsResponse()) as any);
    const articles = listRepurposeArticles(siteId);
    const article = articles[0]!;

    const channelId = saveBufferChannel(
      {
        platform: 'pinterest',
        name: 'Baking Inspiration',
        bufferToken: 'buf_test',
        bufferChannelId: 'buf_pin_1',
        postImage: true,
        postReel: false,
        multiWebsite: false,
      },
      KEY,
    );

    let askAttempts = 0;
    const ask = async (_prompt: string, vars: Record<string, unknown>) => {
      askAttempts++;
      // First attempt tries reusing original title (which must be rejected)
      if (askAttempts === 1) {
        return JSON.stringify({
          title: article.title, // original title
          description: 'A lovely fresh description about quick chocolate chip cookies for pinners.',
          alt: 'Warm cookies on a baking sheet',
        });
      }
      // Second attempt generates fresh hook/title
      return JSON.stringify({
        title: '30-Minute Chewy Cookie Secret',
        description: 'Discover how brown sugar and melted butter make the ultimate chewy cookies in under 30 minutes!',
        alt: 'Freshly baked chocolate chip cookies',
      });
    };

    const outcome = await generateRepurposePost(article.id, channelId, {
      encryptionKey: KEY,
      ask,
    });

    expect(outcome.post).not.toBeNull();
    expect(outcome.post!.title).toBe('30-Minute Chewy Cookie Secret');
    expect(outcome.post!.title).not.toBe(article.title);
    expect(askAttempts).toBeGreaterThanOrEqual(2); // Retried after rejecting identical title

    // Verifies last_repurposed_at was updated
    const updatedArt = getRepurposeArticle(article.id)!;
    expect(updatedArt.last_repurposed_at).toBeGreaterThan(0);
  });

  it('updates repurposing settings and enforces cooldowns in scheduler', async () => {
    const siteId = createSite();
    updateRepurposeSettings(siteId, {
      status: 'active',
      dailyTarget: 2,
      cooldownDays: 60,
      autoPublish: false,
    });

    const site = get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', siteId)!;
    expect(site.repurpose_status).toBe('active');
    expect(site.repurpose_daily_target).toBe(2);
    expect(site.repurpose_cooldown_days).toBe(60);
    expect(site.repurpose_auto_publish).toBe(0);

    // Initial sent today is 0
    expect(repurposeSentToday(siteId)).toBe(0);
  });

  it('provides web routes for repurposing management', async () => {
    const a = Fastify();
    await a.register(formbody);

    const siteId = createSite();
    const site = get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', siteId)!;

    registerRepurposeRoutes(a, {
      encryptionKey: KEY,
      readFlash: () => null,
      ask: async () => JSON.stringify({ title: 'New Secret', description: 'Fresh text', alt: 'Alt' }),
      fetchImpl: (async () => mockPostsResponse()) as any,
    });

    // 1. Visit /new-website/repurpose
    const page = await a.inject({ url: '/new-website/repurpose' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Repurpose old content');
    expect(page.body).toContain(site.domain);

    // 2. Sync articles from website
    const syncRes = await a.inject({
      method: 'POST',
      url: `/new-website/repurpose/${siteId}/sync`,
    });
    expect(syncRes.statusCode).toBe(303);
    expect(syncRes.headers.location).toMatch(/Discovered%202%20articles/);

    // 3. Toggle status
    const toggleRes = await a.inject({
      method: 'POST',
      url: `/new-website/repurpose/${siteId}/toggle`,
    });
    expect(toggleRes.statusCode).toBe(303);
    expect(toggleRes.headers.location).toMatch(/Active/);
  });

  it('paginates discovered articles with navigation controls and page slicing', async () => {
    const a = Fastify();
    await a.register(formbody);

    const siteId = createSite();
    const site = get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', siteId)!;

    // Create 30 articles
    const manyArticles = Array.from({ length: 30 }, (_, i) => ({
      id: 200 + i,
      title: `Recipe Number ${i + 1}`,
      slug: `recipe-number-${i + 1}`,
      status: 'published',
      excerpt: `Excerpt for recipe ${i + 1}`,
      content: `Content for recipe ${i + 1}`,
      category: 'Baking',
      cover: { url: 'https://example.com/cover.jpg' },
    }));

    await syncWebsiteArticles(site, 'sk_test_mock', (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ pages: 1, items: manyArticles }),
    })) as any);

    registerRepurposeRoutes(a, {
      encryptionKey: KEY,
      readFlash: () => null,
      ask: async () => JSON.stringify({ title: 'T', description: 'D', alt: 'A' }),
      fetchImpl: (async () => ({})) as any,
    });

    // Page 1: should show 1-24 of 30 (newest first, so Recipe 30 down to 7)
    const resPage1 = await a.inject({ url: `/new-website/repurpose?website=${siteId}&page=1` });
    expect(resPage1.statusCode).toBe(200);
    expect(resPage1.body).toContain('Discovered articles (30)');
    expect(resPage1.body).toContain('Showing <b>1–24</b> of <b>30</b>');
    expect(resPage1.body).toContain('Page <b>1</b> of <b>2</b>');
    expect(resPage1.body).toContain('Recipe Number 30');
    expect(resPage1.body).toContain('Recipe Number 7');
    expect(resPage1.body).not.toContain('Recipe Number 6');
    expect(resPage1.body).toContain('page=2');

    // Page 2: should show 25-30 (Recipe 6 down to 1)
    const resPage2 = await a.inject({ url: `/new-website/repurpose?website=${siteId}&page=2` });
    expect(resPage2.statusCode).toBe(200);
    expect(resPage2.body).toContain('Showing <b>25–30</b> of <b>30</b>');
    expect(resPage2.body).toContain('Page <b>2</b> of <b>2</b>');
    expect(resPage2.body).not.toContain('Recipe Number 7');
    expect(resPage2.body).toContain('Recipe Number 6');
    expect(resPage2.body).toContain('Recipe Number 1');
  });
});
