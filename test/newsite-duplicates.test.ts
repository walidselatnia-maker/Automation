import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, getNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { getSeoRow, listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { activeKeyword, autopilotTick, automationLog, type ConductorDeps } from '../src/newsite/autopilot.js';
import { DUPLICATE_SIMILARITY, duplicateOf, findDuplicate, normalizeTitle, postsDuplicate, skippedKeywords } from '../src/newsite/duplicates.js';
import { closeness } from '../src/newsite/keywords.js';
import { generateChoices, startGenerateNow } from '../src/newsite/generate-now.js';
import { dashboardData, dashboardPage } from '../src/newsite/dashboard.js';
import { keywordsOverview } from '../src/newsite/keywords-view.js';
import { listKeywordPlans } from '../src/newsite/repo.js';
import type { SitePost } from '../src/newsite/client.js';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';

const KEY = randomBytes(32);
const NOW = Date.parse('2026-10-18T12:00:00Z');
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('Duplicate check: normalizing and comparing', () => {
  it('normalizes a keyword or title: lower case, trimmed, no punctuation or accents', () => {
    expect(normalizeTitle('  Mom’s Best Crème-Brûlée!  ')).toBe('moms best creme brulee');
    expect(normalizeTitle('Strawberry   Cake?')).toBe('strawberry cake');
    expect(normalizeTitle('')).toBe('');
  });

  it('finds the same keyword or title, whatever its case and punctuation', () => {
    const taken = [{ label: '“Strawberry Cake!” (https://f.example.com/p/1)', texts: ['Strawberry Cake!'] }];
    expect(duplicateOf({ keyword: 'strawberry cake' }, taken)).toBe('duplicate of “Strawberry Cake!” (https://f.example.com/p/1)');
    expect(duplicateOf({ keyword: 'berry tart', title: 'STRAWBERRY  cake' }, taken)).toMatch(/^duplicate of/);
  });

  it('finds a very close one, leaving stop words and filler out, at the threshold in one constant', () => {
    expect(DUPLICATE_SIMILARITY).toBe(0.8);
    const taken = [{ label: '“The Best Easy Lemon Drizzle Cake Recipe”', texts: ['The Best Easy Lemon Drizzle Cake Recipe'] }];
    expect(duplicateOf({ keyword: 'lemon drizzle cake' }, taken)).toBe('duplicate of “The Best Easy Lemon Drizzle Cake Recipe”');
    expect(duplicateOf({ keyword: 'how to make a lemon drizzle cake' }, taken)).toMatch(/^duplicate of/);
  });

  it('lets a really different article through, even one sharing most words', () => {
    const taken = [{ label: '“Chocolate Chip Cookies”', texts: ['Chocolate Chip Cookies'] }];
    expect(closeness('vegan chocolate chip cookies', 'Chocolate Chip Cookies')).toBeLessThan(DUPLICATE_SIMILARITY);
    expect(duplicateOf({ keyword: 'vegan chocolate chip cookies' }, taken)).toBe('');
    expect(duplicateOf({ keyword: 'banana bread' }, taken)).toBe('');
  });
});

describe('Duplicate check: the skip path', () => {
  let settings: Settings;
  let siteId: number;
  let posts: SitePost[];

  const keywords = (pillar: string, subs: string[] = []) => {
    const items = subs.map((keyword) => ({ keyword, intent: 'yours', reason: '', page: 'article' as const }));
    const plan = saveKeywordPlan(siteId, pillar, items, 'article');
    queuePlanSeo(plan, pillar, items, 'article');
    return listPlanSeo(plan).map((r) => r.id);
  };
  const listPosts = async () => posts;
  const deps = (checkPosts?: ConductorDeps['checkPosts']): ConductorDeps => ({ settings, encryptionKey: KEY, checkPosts });

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('timezone', 'UTC');
    settings.set('newsite_automation_enabled', 'true');
    siteId = createNewWebsite(
      {
        name: 'Garden', domain: 'g.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Home gardening', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 0, intervalMinutes: 240,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    posts = [];
  });
  afterEach(() => closeDatabase());

  it('skips a keyword that repeats an earlier one of the list, says why, and gives the next one its turn', () => {
    const [roses] = keywords('pruning roses');
    const [again, basil] = keywords('easy tips for pruning roses', ['growing basil']);
    // The first one is under way; then published.
    autopilotTick(deps(), NOW);
    expect(activeKeyword()?.id).toBe(roses);
    run(`UPDATE keyword_seo SET post_status = 'published', posted_at = '2026-10-18 08:00:00', post_url = 'https://g.example.com/p/1', title = 'Pruning Roses' WHERE id = ?`, roses);
    autopilotTick(deps(), NOW);
    expect(getSeoRow(again!)!.skip_reason).toBe('duplicate of “Pruning Roses” (https://g.example.com/p/1)');
    expect(activeKeyword()?.id).toBe(basil);
    expect(automationLog().find((l) => l.event === 'skipped')).toMatchObject({ seo_id: again, note: 'duplicate of “Pruning Roses” (https://g.example.com/p/1)' });
  });

  it('checks a keyword against the website’s published posts before it starts; a duplicate is skipped and the next one checked', async () => {
    const [tomatoes, staking] = keywords('growing tomatoes', ['staking tomatoes']);
    posts = [{ id: 9, slug: 'tomatoes', title: 'Growing Tomatoes!', status: 'published' }, { id: 10, slug: 'x', title: 'Staking Tomatoes', status: 'draft' }];
    const site = getNewWebsite(siteId)!;
    const check: ConductorDeps['checkPosts'] = (row, s) => postsDuplicate(row, s, { encryptionKey: KEY, listPosts });
    autopilotTick(deps(check), NOW);
    expect(activeKeyword()).toBeUndefined(); // waits for the website's answer
    await flush();
    expect(getSeoRow(tomatoes!)!.skip_reason).toBe('duplicate of “Growing Tomatoes!”');
    await flush();
    // A draft is no published article: the next keyword passes, and starts.
    expect(getSeoRow(staking!)).toMatchObject({ skip_reason: '', dup_checked: 1 });
    expect(activeKeyword()?.id).toBe(staking);
    expect(site.domain).toBe('g.example.com');
  });

  it('shows a skipped keyword in the Keywords list and flags it on the Dashboard; Generate now no longer offers it', async () => {
    const [mint] = keywords('growing mint');
    posts = [{ id: 3, slug: 'mint', title: 'Growing Mint', status: 'published' }];
    autopilotTick(deps((row, s) => postsDuplicate(row, s, { encryptionKey: KEY, listPosts })), NOW);
    await flush();
    expect(skippedKeywords().map((k) => [k.id, k.skip_reason])).toEqual([[mint, 'duplicate of “Growing Mint”']]);
    const list = String(keywordsOverview([{ site: getNewWebsite(siteId)!, plans: listKeywordPlans(siteId) }], new Map(), skippedKeywords()));
    expect(list).toContain('Skipped “growing mint”: duplicate of “Growing Mint”');
    const d = dashboardData(30, 'UTC');
    expect(d.notes.map((n) => n.text)).toContain('“growing mint” (Garden) skipped: duplicate of “Growing Mint”');
    expect(String(dashboardPage(d))).toContain('skipped: duplicate of');
    expect(generateChoices()[0]!.keywords).toEqual([]);
    expect(startGenerateNow(mint!)).toBeUndefined();
  });

  it('Generate now checks too; a website that cannot be read only stops nothing', async () => {
    const [mint] = keywords('growing mint');
    const row = getSeoRow(mint!)!;
    const site = getNewWebsite(siteId)!;
    posts = [{ id: 3, slug: 'growing-mint', title: 'Mint, grown easily', status: 'published' }];
    expect(await findDuplicate(row, site, { encryptionKey: KEY, listPosts })).toBe('duplicate of “Mint, grown easily”');
    const down = async (): Promise<SitePost[]> => { throw new Error('down'); };
    expect(await findDuplicate(row, site, { encryptionKey: KEY, listPosts: down })).toBe('');
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM keyword_seo WHERE skip_reason != ''")!.n).toBe(0);
  });

  it('Generate now skips a duplicate with the reason, and starts nothing', async () => {
    const [mint] = keywords('growing mint');
    posts = [{ id: 3, slug: 'growing-mint', title: 'Growing Mint', status: 'published' }];
    const app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, { encryptionKey: KEY, isPlatformReady: () => true, autoSeo: false, listPosts });
    const res = await app.inject({ method: 'POST', url: '/new-website/generate-now', payload: `seo=${mint}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(decodeURIComponent(String(res.headers.location))).toBe('/new-website/dashboard?error="growing mint" is skipped: duplicate of “Growing Mint”.');
    expect(getSeoRow(mint!)).toMatchObject({ generate_now: 0, skip_reason: 'duplicate of “Growing Mint”' });
    await app.close();
  });
});
