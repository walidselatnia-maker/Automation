import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, getNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { saveBufferChannel, setWebsiteChannels } from '../src/newsite/channels.js';
import { socialSentToday } from '../src/newsite/gaps.js';
import { createSocialPosts, getSocialPost, kickSocial, type BufferApi, type SocialDeps } from '../src/newsite/social.js';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { registerSocialRoutes } from '../src/newsite/social-routes.js';

const KEY = randomBytes(32);
const POST_URL = 'https://site-a.com/recipes/pasta';

describe('Per-website social controls', () => {
  let settings: Settings;
  let dataDir: string;
  let bufferPosts: any[];

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('public_base_url', 'https://platform.test');
    dataDir = mkdtempSync(join(tmpdir(), 'social-controls-test-'));
    bufferPosts = [];
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function setupSiteAndPost(siteOverrides: Partial<Parameters<typeof createNewWebsite>[0]> = {}) {
    const websiteId = createNewWebsite(
      {
        name: 'Site A',
        domain: 'site-a.com',
        apiKey: 'key',
        niche: 'food',
        nicheContext: '',
        persona: 'chef',
        status: 'active',
        autoPublish: true,
        dailyTarget: 3,
        intervalMinutes: 60,
        bufferToken: 'buff',
        pinUsername: 'pin',
        projectId: '',
        socialStatus: 'active',
        socialDailyTarget: 0,
        socialAutoPublish: true,
        ...siteOverrides,
      },
      KEY,
    );

    const planId = saveKeywordPlan(websiteId, 'Pasta', [{ keyword: 'fresh pasta', intent: 'make', reason: '', page: 'recipe' }]);
    queuePlanSeo(planId, 'Pasta', ['fresh pasta']);
    const [row] = listPlanSeo(planId);
    run(
      `UPDATE keyword_seo SET post_status = 'published', post_url = ?, posted_at = datetime('now') WHERE id = ?`,
      POST_URL,
      row.id,
    );

    const chId = saveBufferChannel(
      {
        platform: 'pinterest',
        name: 'Pinterest A',
        bufferToken: 'tok',
        bufferChannelId: 'buf-ch-1',
        paidBuffer: false,
        postImage: true,
        postReel: false,
        multiWebsite: true,
      },
      KEY,
    );
    setWebsiteChannels(websiteId, [chId]);

    createSocialPosts(row.id);
    const post = getSocialPost(1)!;

    // Simulate pre-made words & picture so we test the dispatch/hold gating
    const picFile = join(dataDir, 'p.png');
    writeFileSync(picFile, 'fake-image');
    const picId = Number(
      run(
        `INSERT INTO newsite_pictures (seo_id, slot, prompt, status, file, made_at) VALUES (?, 'pin-1', 'prompt', 'done', ?, datetime('now'))`,
        row.id,
        picFile,
      ).lastInsertRowid,
    );

    run(
      `UPDATE newsite_social_posts SET status = 'pending', text = 'Tasty pasta', title = 'Fresh Pasta', picture_id = ? WHERE id = ?`,
      picId,
      post.id,
    );

    return { websiteId, seoId: row.id, postId: post.id, planId };
  }

  const mockDeps = (): SocialDeps => ({
    settings,
    encryptionKey: KEY,
    dataDir,
    ask: async () => JSON.stringify({ title: 'T', description: 'D', headline: 'H', cta: 'C', alt: 'A' }),
    fetchImpl: (async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }) })) as any,
    buffer: () => ({
      channels: async () => [{ id: 'buf-ch-1', service: 'pinterest', name: 'Pin', formattedService: 'Pinterest', default: true, boards: [{ serviceId: 'b1', name: 'general' }] }],
      createImagePost: async (p) => {
        bufferPosts.push(p);
        return { id: 'buf-post-1', dueAt: '2026-11-09T10:00:00Z' };
      },
    }),
  });

  it('holds social posts when a website has social_status = paused', async () => {
    const { postId } = setupSiteAndPost({ socialStatus: 'paused' });
    await kickSocial(mockDeps());

    // Should not post to buffer because this site has social_status paused
    expect(bufferPosts).toHaveLength(0);
    const post = getSocialPost(postId)!;
    expect(post.status).not.toBe('sent');
  });

  it('posts to buffer when social_status is active', async () => {
    const { postId } = setupSiteAndPost({ socialStatus: 'active' });
    await kickSocial(mockDeps());

    const post = getSocialPost(postId)!;
    expect(post.error).toBe('');
    expect(bufferPosts).toHaveLength(1);
    expect(post.status).toBe('sent');
  });

  it('respects per-website social_daily_target limit', async () => {
    const { websiteId, postId, planId } = setupSiteAndPost({ socialDailyTarget: 1 });
    // First post goes through
    await kickSocial(mockDeps());
    expect(bufferPosts).toHaveLength(1);

    // Verify socialSentToday is 1
    expect(socialSentToday(websiteId, 'UTC')).toBe(1);

    // Create a second article and post for this site
    const [row1, row2] = listPlanSeo(planId);
    run(
      `UPDATE keyword_seo SET post_status = 'published', post_url = 'https://site-a.com/recipes/pasta-2', posted_at = datetime('now') WHERE id = ?`,
      row2.id,
    );

    const picFile = join(dataDir, 'p2.png');
    writeFileSync(picFile, 'fake-image');
    const picId2 = Number(
      run(`INSERT INTO newsite_pictures (seo_id, slot, prompt, status, file, made_at) VALUES (?, 'pin-1', 'prompt', 'done', ?, datetime('now'))`, row2.id, picFile).lastInsertRowid,
    );
    const post2Id = Number(
      run(
        `INSERT INTO newsite_social_posts (seo_id, channel_id, kind, status, text, title, picture_id)
         VALUES (?, 1, 'pinterest', 'pending', 'Second post', 'Title 2', ?)`,
        row2.id,
        picId2,
      ).lastInsertRowid,
    );

    // Running kickSocial again should hit the daily target cap and hold
    await kickSocial(mockDeps());
    expect(bufferPosts).toHaveLength(1); // still only 1 sent!
    const post2 = getSocialPost(post2Id)!;
    expect(post2.status).not.toBe('sent');
  });

  it('holds social posts when social_auto_publish = false (waits for approval)', async () => {
    const { postId } = setupSiteAndPost({ socialAutoPublish: false });
    await kickSocial(mockDeps());

    // Should not dispatch automatically
    expect(bufferPosts).toHaveLength(0);
    const post = getSocialPost(postId)!;
    expect(post.status).not.toBe('sent');
  });

  it('toggles social status via POST /new-website/sharing/site/:id/toggle-social', async () => {
    const { websiteId } = setupSiteAndPost({ socialStatus: 'active' });
    const app = Fastify();
    await app.register(formbody);
    registerSocialRoutes(app, {
      ...mockDeps(),
      readFlash: () => null,
      autoStart: false,
    });

    const res1 = await app.inject({
      method: 'POST',
      url: `/new-website/sharing/site/${websiteId}/toggle-social`,
    });
    expect(res1.statusCode).toBe(303);
    expect(getNewWebsite(websiteId)?.social_status).toBe('paused');

    const res2 = await app.inject({
      method: 'POST',
      url: `/new-website/sharing/site/${websiteId}/toggle-social`,
    });
    expect(res2.statusCode).toBe(303);
    expect(getNewWebsite(websiteId)?.social_status).toBe('active');
  });
});
