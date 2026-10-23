import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, getNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { activeKeyword, autopilotTick, type ConductorDeps } from '../src/newsite/autopilot.js';
import { saveBufferChannel } from '../src/newsite/channels.js';
import { resetSocialSlots } from '../src/newsite/gaps.js';
import { holdForSocialGap } from '../src/newsite/social.js';

const KEY = randomBytes(32);
const START = Date.parse('2026-10-18T00:00:00Z');
const MIN = 60_000;
const DAY_MINUTES = 24 * 60;
const sql = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const gapsOf = (times: number[]) => times.slice(1).map((t, i) => (t - times[i]!) / MIN);

/**
 * A day of Automation and of the social senders, minute by minute on a fake
 * clock. Writing, pictures and sending take no time here: what is checked is
 * when each one is given its turn by the gaps (gaps.ts).
 */
describe('Random gaps over a simulated day', () => {
  let settings: Settings;
  let siteId: number;

  beforeEach(() => {
    openDatabase(':memory:');
    resetSocialSlots();

    settings = new Settings(KEY);
    settings.set('timezone', 'UTC');
    settings.set('auto_retry_enabled', 'false');
    settings.set('newsite_automation_enabled', 'true');
    siteId = createNewWebsite(
      {
        name: 'Garden', domain: 'g.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Home gardening', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 4, intervalMinutes: 240,
        randomGapFrom: 60, randomGapTo: 120, bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
  });
  afterEach(() => closeDatabase());

  /** Runs Automation for `minutes`; each keyword is published the minute it gets its turn. */
  const runArticles = (minutes: number): number[] => {
    const words = ['roses', 'tulips', 'basil', 'mint', 'ferns', 'cacti', 'orchids', 'lilies', 'peonies', 'dahlias', 'lavender', 'thyme', 'sage', 'ivy', 'moss', 'clover', 'daisies', 'irises', 'poppies', 'violets'];
    for (const w of words) queuePlanSeo(saveKeywordPlan(siteId, w, [], 'article'), w, [], 'article');
    const deps: ConductorDeps = { settings, encryptionKey: KEY, startWriter: () => {}, startPictures: () => {} };
    const published: number[] = [];
    for (let m = 0; m <= minutes; m++) {
      const t = START + m * MIN;
      autopilotTick(deps, t);
      const active = activeKeyword();
      if (active && active.post_status !== 'published') {
        run(`UPDATE keyword_seo SET post_status = 'published', posted_at = ? WHERE id = ?`, sql(t), active.id);
        published.push(t);
        autopilotTick(deps, t); // its turn ends
      }
    }
    return published;
  };

  it('articles: 4 posts per day, each gap a random time from 60 to 120 minutes, never more than 4 in the day', () => {
    const published = runArticles(DAY_MINUTES - 1);
    const gaps = gapsOf(published);
    console.log(`[simulation] articles, posts per day 4, fixed gap 240 min, random 60–120 min:\n  published at ${published.map(hhmm).join(', ')}\n  gaps (min) ${gaps.join(', ')}`);
    expect(published).toHaveLength(4);
    expect(published[0]).toBe(START);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(60);
      expect(g).toBeLessThanOrEqual(120);
    }
  });

  it('articles: with no daily cap, every gap of the day falls in the range, and the draws vary', () => {
    run('UPDATE new_websites SET daily_target = 0 WHERE id = ?', siteId);
    const published = runArticles(DAY_MINUTES - 1);
    const gaps = gapsOf(published);
    console.log(`[simulation] articles, no daily cap, random 60–120 min:\n  published at ${published.map(hhmm).join(', ')}\n  gaps (min) ${gaps.join(', ')}`);
    expect(published.length).toBeGreaterThanOrEqual(12);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(60);
      expect(g).toBeLessThanOrEqual(120);
    }
    expect(new Set(gaps).size).toBeGreaterThan(3);
  });

  it('articles: the fixed gap alone, as before, when no random gap is set', () => {
    run('UPDATE new_websites SET random_gap_from = 0, random_gap_to = 0 WHERE id = ?', siteId);
    const published = runArticles(DAY_MINUTES - 1);
    expect(gapsOf(published)).toEqual([240, 240, 240]);
  });

  it('social: image posts and reels to one channel, from two senders side by side, each gap 60 to 120 minutes', () => {
    run('UPDATE new_websites SET social_gap_from = 60, social_gap_to = 120 WHERE id = ?', siteId);
    const channel = saveBufferChannel(
      { platform: 'pinterest', name: 'pins', bufferToken: 'tok', bufferChannelId: 'ch-pin', paidBuffer: false, postImage: true, postReel: true, multiWebsite: false },
      KEY,
    );
    const plan = saveKeywordPlan(siteId, 'roses', [], 'article');
    queuePlanSeo(plan, 'roses', [], 'article');
    const seo = listPlanSeo(plan)[0]!.id;
    for (let i = 1; i <= 7; i++) {
      run(`INSERT INTO newsite_social_posts (seo_id, channel_id, kind) VALUES (?, ?, ?)`, seo, channel, `pin-${i}`);
      const reel = Number(run(`INSERT INTO newsite_reels (seo_id, platform, status) VALUES (?, ?, 'done')`, seo, `reel-${i}`).lastInsertRowid);
      run('INSERT INTO newsite_reel_shares (reel_id, channel_id) VALUES (?, ?)', reel, channel);
    }
    const site = getNewWebsite(siteId)!;
    const sent: { at: number; what: string }[] = [];
    const tables = ['newsite_social_posts', 'newsite_reel_shares'] as const;
    for (let m = 0; m < DAY_MINUTES; m++) {
      const t = START + m * MIN;
      // Both senders look in the same minute, before either has recorded its send: the race the gap must survive.
      const going = tables.flatMap((table) => {
        const item = get<{ id: number }>(`SELECT id FROM ${table} WHERE status = 'pending' OR (status = 'waiting' AND retry_at <= ?) ORDER BY id LIMIT 1`, t);
        return item && !holdForSocialGap(table, item.id, site, channel, t) ? [{ table, id: item.id }] : [];
      });
      for (const g of going) {
        run(`UPDATE ${g.table} SET status = 'sent', sent_at = ? WHERE id = ?`, sql(t), g.id);
        sent.push({ at: t, what: g.table === 'newsite_social_posts' ? 'image' : 'reel' });
      }
    }
    const gaps = gapsOf(sent.map((s) => s.at));
    console.log(`[simulation] social, one channel, random 60–120 min:\n  sent ${sent.map((s) => `${hhmm(s.at)} ${s.what}`).join(', ')}\n  gaps (min) ${gaps.join(', ')}`);
    expect(sent.length).toBeGreaterThanOrEqual(12);
    expect(new Set(sent.map((s) => s.what))).toEqual(new Set(['image', 'reel']));
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(60);
      expect(g).toBeLessThanOrEqual(120);
    }
    const left = all<{ n: number }>(`SELECT COUNT(*) AS n FROM newsite_social_posts WHERE status <> 'sent' UNION ALL SELECT COUNT(*) FROM newsite_reel_shares WHERE status <> 'sent'`);
    expect(left.reduce((a, r) => a + r.n, 0)).toBe(14 - sent.length);
  });
});
