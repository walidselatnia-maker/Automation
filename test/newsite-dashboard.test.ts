import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { saveBufferChannel } from '../src/newsite/channels.js';
import { dashboardData, dashboardPage } from '../src/newsite/dashboard.js';

const KEY = randomBytes(32);
const NOW = Date.parse('2026-10-17T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

describe('dashboard', () => {
  beforeEach(() => openDatabase(':memory:'));
  afterEach(() => closeDatabase());

  it('starts calm and empty on a fresh install', () => {
    const d = dashboardData(30, 'UTC', NOW);
    expect(d.kpis.map((k) => k.value)).toEqual([0, 0, 0, 0, 0]);
    const page = dashboardPage(d, NOW).value;
    expect(page).toContain('Nothing stopped');
    expect(page).toContain('Nothing was published or shared in this period.');
  });

  it('counts what was published, made and sent in the period, against the period before, per day, website and platform', () => {
    const site = createNewWebsite(
      { name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '', persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '' },
      KEY,
    );
    const plan = saveKeywordPlan(site, 'cakes', [], 'recipe');
    for (const k of ['a', 'b', 'c', 'd']) queuePlanSeo(plan, k, [], 'recipe');
    const [a, b, c, d] = listPlanSeo(plan);
    const publish = (id: number, when: string, words: number) =>
      run(`UPDATE keyword_seo SET status = 'done', title = ?, article_status = 'done', article_words = ?, images_status = 'done', post_status = 'published', posted_at = ? WHERE id = ?`, `Title ${id}`, words, when, id);
    publish(a!.id, daysAgo(1), 1000);
    publish(b!.id, daysAgo(2), 1500);
    publish(c!.id, daysAgo(40), 900); // the 30 days before
    run(`UPDATE keyword_seo SET article_status = 'failed' WHERE id = ?`, d!.id);
    const pin = saveBufferChannel({ platform: 'pinterest', name: 'pins', bufferToken: 't', bufferChannelId: 'p', paidBuffer: false, postImage: true, postReel: false, multiWebsite: false }, KEY);
    run(`INSERT INTO newsite_social_posts (seo_id, channel_id, kind, status, sent_at) VALUES (?, ?, 'pinterest', 'sent', ?)`, a!.id, pin, daysAgo(1));
    run(`INSERT INTO newsite_social_posts (seo_id, channel_id, kind, status) VALUES (?, ?, 'pinterest', 'failed')`, b!.id, pin);
    run(`INSERT INTO newsite_reels (seo_id, platform, status, done_at) VALUES (?, 'all', 'done', ?)`, a!.id, daysAgo(1));

    const data = dashboardData(30, 'UTC', NOW);
    expect(data.kpis.map((k) => [k.label, k.value, k.before])).toEqual([
      ['Articles published', 2, 1],
      ['Words written', 2500, 900],
      ['Pictures made', 0, 0],
      ['Social posts sent', 1, 0],
      ['Reels made', 1, 0],
    ]);
    expect(data.daily).toHaveLength(30);
    expect(data.daily.at(-2)).toMatchObject({ articles: 1, posts: 1, reels: 1 });
    expect(data.funnel.find((f) => f.label === 'Published')!.count).toBe(3);
    expect(data.platforms).toEqual([{ label: 'Pinterest', color: '#e60023', sent: 1, failed: 1 }]);
    expect(data.websites[0]).toMatchObject({ name: 'Long Livo', published: 3, inPeriod: 2, posts: 1 });
    expect(data.problems.map((p) => [p.label, p.count])).toEqual([
      ['article stopped|articles stopped', 1],
      ['social post not sent|social posts not sent', 1],
    ]);
    expect(data.recent.slice(0, 3).map((r) => r.kind).sort()).toEqual(['article', 'post', 'reel']);

    const page = dashboardPage(data, NOW).value;
    expect(page).toContain('1 article stopped');
    expect(page).toContain('▲ 100%');
    expect(page).toContain('aria-label="Activity per day"');
  });
});
