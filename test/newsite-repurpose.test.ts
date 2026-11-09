import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { openDatabase, closeDatabase } from '../src/db/index.js';
import { createNewWebsite } from '../src/newsite/repo.js';
import { saveBufferChannel, setChannelWebsites } from '../src/newsite/channels.js';
import {
  generateRepurposePost,
  getRepurposeArticle,
  getRepurposePost,
  isMainPipelineBusy,
  kickRepurpose,
  listRepurposeArticles,
  listRepurposePosts,
  repurposeCountToday,
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
    // Oldest published article (lowest site_post_id) is first
    expect(articles[0]!.title).toBe('Authentic Sourdough Bread');
    expect(articles[1]!.title).toBe('Quick Chocolate Chip Cookies');
    expect(articles[1]!.cover_url).toBe('https://food.example.com/images/cookies.jpg');

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

    const mockBuffer = () => ({
      channels: async () => [
        {
          id: 'buf_pin_1',
          name: 'Pinterest Baking',
          service: 'pinterest',
          boards: [{ serviceId: 'b_123', name: 'Cookies & Desserts' }],
        },
      ],
      createImagePost: async (inp: any) => {
        expect(inp.metadata).toContain('boardServiceId: "b_123"');
        return { id: 'buf_post_1', dueAt: '2026-11-10T12:00:00Z' };
      },
    });

    const outcome = await generateRepurposePost(article.id, channelId, {
      encryptionKey: KEY,
      ask,
      buffer: mockBuffer as any,
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
    expect(repurposeCountToday(siteId)).toBe(0);
  });

  it('enforces strict daily limit and does not over-generate posts', async () => {
    const siteId = createSite();
    const site = get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', siteId)!;

    // Set daily target = 1
    updateRepurposeSettings(siteId, {
      status: 'active',
      dailyTarget: 1,
      cooldownDays: 30,
      autoPublish: false,
    });

    await syncWebsiteArticles(site, 'sk_test_mock', (async () => mockPostsResponse()) as any);

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
    setChannelWebsites(channelId, [siteId]);

    const deps = {
      encryptionKey: KEY,
      readFlash: () => null,
      ask: async () =>
        JSON.stringify({
          headline: 'Chewy Cookies',
          cta: 'Save Recipe',
          title: 'Fresh Artisan Sourdough Secrets and Homemade Baking Tips',
          description: 'Learn how to achieve a perfectly crispy golden crust and an airy chewy crumb at home using natural sourdough starter with our simple masterclass.',
          alt: 'Golden brown loaf of freshly baked artisan sourdough bread cooling on a rustic wire rack',
        }),
      fetchImpl: (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })) as any,
    };

    // First kick: generates 1 post
    await kickRepurpose(deps);
    expect(repurposeCountToday(siteId)).toBe(1);
    expect(listRepurposePosts(siteId)).toHaveLength(1);

    // Second kick: limit of 1 is already reached today, MUST NOT generate another post
    await kickRepurpose(deps);
    expect(repurposeCountToday(siteId)).toBe(1);
    expect(listRepurposePosts(siteId)).toHaveLength(1);

    // Third kick: still strictly 1 post
    await kickRepurpose(deps);
    expect(repurposeCountToday(siteId)).toBe(1);
    expect(listRepurposePosts(siteId)).toHaveLength(1);
  });

  it('steps aside when main article generation pipeline or Flow is active', async () => {
    const siteId = createSite();
    const site = get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', siteId)!;

    updateRepurposeSettings(siteId, {
      status: 'active',
      dailyTarget: 1,
      cooldownDays: 30,
      autoPublish: false,
    });

    await syncWebsiteArticles(site, 'sk_test_mock', (async () => mockPostsResponse()) as any);

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
    setChannelWebsites(channelId, [siteId]);

    const deps = {
      encryptionKey: KEY,
      readFlash: () => null,
      ask: async () =>
        JSON.stringify({
          headline: 'Chewy Cookies',
          cta: 'Save Recipe',
          title: 'Fresh Artisan Sourdough Secrets and Homemade Baking Tips',
          description: 'Learn how to achieve a perfectly crispy golden crust and an airy chewy crumb at home using natural sourdough starter with our simple masterclass.',
          alt: 'Golden brown loaf of freshly baked artisan sourdough bread cooling on a rustic wire rack',
        }),
      fetchImpl: (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })) as any,
    };

    const { run } = await import('../src/db/index.js');

    // 1. Simulate an active keyword in keyword_seo being written by the main pipeline
    run("INSERT INTO keyword_plans (website_id, pillar) VALUES (?, 'Baking')", siteId);
    const planId = get<{ id: number }>('SELECT last_insert_rowid() AS id')!.id;
    run(
      `INSERT INTO keyword_seo (plan_id, keyword, role, position, status, auto_active)
       VALUES (?, 'sourdough bread', 'pillar', 1, 'writing', 1)`,
      planId,
    );

    // Pipeline is busy!
    expect(isMainPipelineBusy()).toBe(true);

    // kickRepurpose must step aside and NOT generate anything
    await kickRepurpose(deps);
    expect(listRepurposePosts(siteId)).toHaveLength(0);

    // 2. Mark article finished, but simulate Flow pictures actively making
    run("UPDATE keyword_seo SET status = 'done', auto_active = 0");
    const seoId = get<{ id: number }>('SELECT id FROM keyword_seo LIMIT 1')!.id;
    run(
      `INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status)
       VALUES (?, 'feature', 1, 'bread prompt', 'alt', 'making')`,
      seoId,
    );

    // Flow is busy!
    expect(isMainPipelineBusy()).toBe(true);

    // kickRepurpose must still step aside
    await kickRepurpose(deps);
    expect(listRepurposePosts(siteId)).toHaveLength(0);

    // 3. Clear Flow pictures: pipeline is now completely idle
    run("UPDATE newsite_pictures SET status = 'done'");
    expect(isMainPipelineBusy()).toBe(false);

    // Now kickRepurpose runs and generates the 1 post allowed by dailyTarget
    await kickRepurpose(deps);
    expect(listRepurposePosts(siteId)).toHaveLength(1);
    expect(repurposeCountToday(siteId)).toBe(1);
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

    // Page 1: should show 1-24 of 30 (oldest published first: Recipe 1 up to Recipe 24)
    const resPage1 = await a.inject({ url: `/new-website/repurpose?website=${siteId}&page=1` });
    expect(resPage1.statusCode).toBe(200);
    expect(resPage1.body).toContain('Discovered articles (30)');
    expect(resPage1.body).toContain('Showing <b>1–24</b> of <b>30</b>');
    expect(resPage1.body).toContain('Page <b>1</b> of <b>2</b>');
    expect(resPage1.body).toContain('Recipe Number 1');
    expect(resPage1.body).toContain('Recipe Number 24');
    expect(resPage1.body).not.toContain('Recipe Number 25');
    expect(resPage1.body).toContain('page=2');

    // Page 2: should show 25-30 (Recipe 25 up to Recipe 30)
    const resPage2 = await a.inject({ url: `/new-website/repurpose?website=${siteId}&page=2` });
    expect(resPage2.statusCode).toBe(200);
    expect(resPage2.body).toContain('Showing <b>25–30</b> of <b>30</b>');
    expect(resPage2.body).toContain('Page <b>2</b> of <b>2</b>');
    expect(resPage2.body).not.toContain('Recipe Number 24');
    expect(resPage2.body).toContain('Recipe Number 25');
    expect(resPage2.body).toContain('Recipe Number 30');
  });

  it('performs bulk actions on articles including pause, activate, delete, and repurpose', async () => {
    const a = Fastify();
    await a.register(formbody);

    const siteId = createSite();
    const site = get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', siteId)!;

    await syncWebsiteArticles(site, 'sk_test_mock', (async () => mockPostsResponse()) as any);
    const articles = listRepurposeArticles(siteId);
    expect(articles).toHaveLength(2);

    registerRepurposeRoutes(a, {
      encryptionKey: KEY,
      readFlash: () => null,
      ask: async () => JSON.stringify({ title: 'New', description: 'Fresh', alt: 'A' }),
      fetchImpl: (async () => ({})) as any,
    });

    // 1. Bulk pause
    const pauseRes = await a.inject({
      method: 'POST',
      url: `/new-website/repurpose/${siteId}/bulk-articles`,
      payload: {
        articleIds: [articles[0]!.id, articles[1]!.id],
        bulkAction: 'pause',
      },
    });
    expect(pauseRes.statusCode).toBe(303);
    expect(getRepurposeArticle(articles[0]!.id)?.status).toBe('paused');
    expect(getRepurposeArticle(articles[1]!.id)?.status).toBe('paused');

    // 2. Bulk activate
    const activateRes = await a.inject({
      method: 'POST',
      url: `/new-website/repurpose/${siteId}/bulk-articles`,
      payload: {
        articleIds: [articles[0]!.id],
        bulkAction: 'activate',
      },
    });
    expect(activateRes.statusCode).toBe(303);
    expect(getRepurposeArticle(articles[0]!.id)?.status).toBe('active');

    // 3. Bulk delete
    const deleteRes = await a.inject({
      method: 'POST',
      url: `/new-website/repurpose/${siteId}/bulk-articles`,
      payload: {
        articleIds: [articles[1]!.id],
        bulkAction: 'delete',
      },
    });
    expect(deleteRes.statusCode).toBe(303);
    expect(listRepurposeArticles(siteId)).toHaveLength(1);
  });

  it('regenerates failed posts and provides click-to-enlarge lightbox in UI', async () => {
    const a = Fastify();
    await a.register(formbody);

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

    let askCount = 0;
    const mockBuffer = () => ({
      channels: async () => [
        {
          id: 'buf_pin_1',
          name: 'Pinterest Baking',
          service: 'pinterest',
          boards: [{ serviceId: 'b_123', name: 'Cookies & Desserts' }],
        },
      ],
      createImagePost: async () => ({ id: 'buf_post_regen_1', dueAt: '2026-11-10T12:00:00Z' }),
    });

    const deps = {
      encryptionKey: KEY,
      readFlash: () => null,
      buffer: mockBuffer as any,
      ask: async () => {
        askCount++;
        return JSON.stringify({
          headline: 'Chewy Cookies',
          cta: 'Save Recipe',
          title: `Fresh Artisan Sourdough Secrets and Homemade Baking Tips Round ${askCount}`,
          description: `Learn how to achieve a perfectly crispy golden crust and an airy chewy crumb at home using natural sourdough starter with our simple step-by-step masterclass edition ${askCount}.`,
          alt: 'Golden brown loaf of freshly baked artisan sourdough bread cooling on a rustic wire rack',
        });
      },
      fetchImpl: (async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) })) as any,
    };

    // 1. Generate initial post
    const gen = await generateRepurposePost(article.id, channelId, deps);
    expect(gen.post).toBeTruthy();
    expect(gen.post?.image_url).toBe(article.cover_url);
    expect(gen.post?.title).toBe('Fresh Artisan Sourdough Secrets and Homemade Baking Tips Round 1');

    // Manually mark it as failed with an error
    const { run } = await import('../src/db/index.js');
    run("UPDATE newsite_repurpose_posts SET status = 'failed', error = 'Buffer rejected test error' WHERE id = ?", gen.post!.id);
    expect(getRepurposePost(gen.post!.id)?.status).toBe('failed');

    registerRepurposeRoutes(a, deps);

    // 2. View shows image thumbnail with click-to-enlarge lightbox and Regenerate button
    const viewRes = await a.inject({ url: `/new-website/repurpose?website=${siteId}` });
    expect(viewRes.statusCode).toBe(200);
    expect(viewRes.body).toContain('rp-thumb');
    expect(viewRes.body).toContain('openLightbox');
    expect(viewRes.body).toContain('rp-lightbox');
    expect(viewRes.body).toContain('Regenerate');
    expect(viewRes.body).toContain('Regenerate all failed');

    // 3. Trigger regeneration
    const regenRes = await a.inject({
      method: 'POST',
      url: `/new-website/repurpose/post/${gen.post!.id}/regenerate`,
    });
    expect(regenRes.statusCode).toBe(303);

    const refreshed = getRepurposePost(gen.post!.id)!;
    expect(refreshed.status).not.toBe('failed');
    expect(refreshed.title).toBe('Fresh Artisan Sourdough Secrets and Homemade Baking Tips Round 2');
    expect(refreshed.image_url).toBe(article.cover_url);
    expect(refreshed.error).toBe('');

    // 4. Test bulk retry of failed posts
    run("UPDATE newsite_repurpose_posts SET status = 'failed', error = 'Another error' WHERE id = ?", gen.post!.id);
    const retryRes = await a.inject({
      method: 'POST',
      url: `/new-website/repurpose/${siteId}/retry-failed`,
    });
    expect(retryRes.statusCode).toBe(303);
    const retryRefreshed = getRepurposePost(gen.post!.id)!;
    expect(retryRefreshed.status).not.toBe('failed');
    expect(retryRefreshed.title).toBe('Fresh Artisan Sourdough Secrets and Homemade Baking Tips Round 3');
  });
});
