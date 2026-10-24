import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, openDatabase, run } from '../src/db/index.js';
import { createNewWebsite, listKeywordPlans, saveKeywordPlan } from '../src/newsite/repo.js';
import { queuePlanSeo } from '../src/newsite/seo.js';
import { dashboardData } from '../src/newsite/dashboard.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import {
  RETRY_MS,
  addSearchKeys,
  allSearchKeysFailed,
  askSearch,
  listSearchKeys,
  parseKeyLine,
  type SearchPage,
} from '../src/newsite/search-keys.js';
import { EXPAND, approveResearch, createResearch, editPlan, getResearch, runResearch, stateOf, type ResearchDeps } from '../src/newsite/research.js';
import { researchPage, searchKeysSection } from '../src/newsite/research-view.js';

const KEY = randomBytes(32);
const TOPIC = 'sourdough bread';

/** Google, as the search APIs answer it: a few searches for each query. */
const AUTOCOMPLETE: Record<string, string[]> = {
  [TOPIC]: ['sourdough bread recipe', 'sourdough bread starter', 'sourdough bread machine', 'sourdough bread flour', 'sourdough discard recipes'],
  'sourdough bread recipe': ['sourdough bread recipe for beginners', 'sourdough bread recipe no knead'],
  'sourdough bread starter': ['sourdough starter from scratch', 'sourdough starter feeding schedule'],
};
const PAGE: SearchPage = {
  results: [{ title: 'The Best Sourdough Bread Recipe', url: 'https://example.com/a' }],
  questions: ['Why is my sourdough bread so dense?', 'How long does sourdough bread last?'],
  related: ['sourdough bread recipe', 'sourdough sandwich bread'],
};

interface Call {
  provider: 'serper' | 'serpapi';
  kind: 'autocomplete' | 'search';
  q: string;
  key: string;
}

describe('Content research', () => {
  let calls: Call[];
  /** Keys that answer "no credit", and after how many good answers a key stops. */
  let broke: Set<string>;
  let budget: Record<string, number>;
  let asked: Record<string, unknown>[];
  let aiAnswer: string;
  let siteId: number;

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    let call: Call;
    if (u.host === 'google.serper.dev') {
      const body = JSON.parse(String(init?.body)) as { q: string };
      call = { provider: 'serper', kind: u.pathname === '/autocomplete' ? 'autocomplete' : 'search', q: body.q, key: String((init?.headers as Record<string, string>)['X-API-KEY']) };
    } else {
      call = { provider: 'serpapi', kind: u.searchParams.get('engine') === 'google_autocomplete' ? 'autocomplete' : 'search', q: u.searchParams.get('q')!, key: u.searchParams.get('api_key')! };
    }
    calls.push(call);
    if (broke.has(call.key) || (budget[call.key] !== undefined && budget[call.key]-- <= 0)) {
      return new Response(JSON.stringify({ message: 'Not enough credits' }), { status: 400 });
    }
    const suggestions = AUTOCOMPLETE[call.q.toLowerCase()] ?? [];
    if (call.provider === 'serper') {
      return Response.json(
        call.kind === 'autocomplete'
          ? { suggestions: suggestions.map((value) => ({ value })) }
          : { organic: PAGE.results.map((r) => ({ title: r.title, link: r.url })), peopleAlsoAsk: PAGE.questions.map((question) => ({ question })), relatedSearches: PAGE.related.map((query) => ({ query })) },
      );
    }
    return Response.json(
      call.kind === 'autocomplete'
        ? { suggestions: suggestions.map((value) => ({ value })) }
        : { organic_results: PAGE.results.map((r) => ({ title: r.title, link: r.url })), related_questions: PAGE.questions.map((question) => ({ question })), related_searches: PAGE.related.map((query) => ({ query })) },
    );
  }) as unknown as typeof fetch;

  let clock: number;
  const deps = (): ResearchDeps => ({
    encryptionKey: KEY,
    fetchImpl,
    now: () => clock,
    listPosts: async () => [{ id: 1, title: 'Sourdough Starter From Scratch', slug: 'sourdough-starter-from-scratch', status: 'published' } as never],
    ask: async (_name, vars) => {
      asked.push(vars);
      return aiAnswer;
    },
  });

  beforeEach(() => {
    openDatabase(':memory:');
    calls = [];
    broke = new Set();
    budget = {};
    asked = [];
    clock = Date.parse('2026-10-23T12:00:00Z');
    aiAnswer = JSON.stringify({
      pillars: [
        { pillar: 'sourdough bread recipe', page: 'recipe', subs: ['sourdough bread recipe for beginners', 'Sourdough Bread Recipe No Knead', 'why is my sourdough bread so dense?', 'sourdough bread with olives'] },
        // A repeat across pillars, and one the website has (a published post): both left out.
        { pillar: 'sourdough bread starter', page: 'article', subs: ['sourdough bread recipe for beginners', 'sourdough starter from scratch', 'sourdough starter feeding schedule'] },
      ],
    });
    siteId = createNewWebsite(
      {
        name: 'Bread Home', domain: 'b.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking recipes', nicheContext: '', persona: 'Storyteller',
        status: 'active', autoPublish: true, dailyTarget: 0, intervalMinutes: 60, bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    // A keyword the website has already.
    const plan = saveKeywordPlan(siteId, 'sourdough bread machine', [], 'recipe');
    queuePlanSeo(plan, 'sourdough bread machine', [], 'recipe');
  });
  afterEach(() => closeDatabase());

  const queriesOf = (list = calls) => list.map((c) => `${c.kind}:${c.q}`);

  describe('search keys', () => {
    it('adds keys in bulk, in order: Serper as they are, other providers by name; repeats and junk are not added', () => {
      expect(parseKeyLine('serpapi: abcdefgh1234')).toEqual({ provider: 'serpapi', key: 'abcdefgh1234' });
      expect(addSearchKeys('key-one-111111\nserpapi: key-two-222222\n\nkey-one-111111\nno', KEY)).toEqual({ added: 2, bad: ['no'] });
      expect(listSearchKeys().map((k) => [k.provider, k.position, k.status])).toEqual([['serper', 1, ''], ['serpapi', 2, '']]);
    });

    it('tries keys in order, never rotating: a failed key is marked with why and skipped until it is tried again later', async () => {
      addSearchKeys('first-key-1111\nsecond-key-2222', KEY);
      broke.add('first-key-1111');
      const a = await askSearch('autocomplete', TOPIC, {}, deps());
      expect(a.answer).toEqual(AUTOCOMPLETE[TOPIC]);
      const [first, second] = listSearchKeys();
      expect(first).toMatchObject({ status: 'failed', error: 'No credit left: Not enough credits' });
      expect(second).toMatchObject({ status: 'working', error: '' });

      // The next question goes straight to the second key: the failed one rests.
      calls = [];
      await askSearch('autocomplete', 'x', {}, deps());
      expect(calls.map((c) => c.key)).toEqual(['second-key-2222']);
      // Again the next one, also when it keeps working: no rotation.
      await askSearch('autocomplete', 'y', {}, deps());
      expect(calls.map((c) => c.key)).toEqual(['second-key-2222', 'second-key-2222']);

      // Once its rest is over the first key is tried again, first; it has credit again.
      broke.clear();
      clock += RETRY_MS;
      calls = [];
      await askSearch('autocomplete', 'z', {}, deps());
      expect(calls.map((c) => c.key)).toEqual(['first-key-1111']);
      expect(listSearchKeys()[0]).toMatchObject({ status: 'working' });
    });

    it('says so on the Dashboard when every key failed', async () => {
      addSearchKeys('first-key-1111\nsecond-key-2222', KEY);
      broke.add('first-key-1111').add('second-key-2222');
      await expect(askSearch('search', TOPIC, {}, deps())).rejects.toThrow(/No search key could answer/);
      expect(allSearchKeysFailed()).toBe(true);
      expect(dashboardData(7, 'UTC').problems.find((p) => p.href === '/new-website/research/keys')).toMatchObject({ count: 2 });
    });
  });

  it('reads real Google data, expands a bounded number of searches, leaves out what the website has, and marks Google vs AI', async () => {
    addSearchKeys('serper-key-1111', KEY);
    const id = createResearch(siteId, TOPIC);
    await runResearch(id, deps());
    const r = getResearch(id)!;
    expect(r.status).toBe('ready');
    const s = stateOf(r);
    // The topic's autocomplete and results page, then one autocomplete per discovered search, at most EXPAND.
    expect(queriesOf()[0]).toBe(`autocomplete:${TOPIC}`);
    expect(queriesOf()[1]).toBe(`search:${TOPIC}`);
    expect(calls.length).toBe(2 + Math.min(EXPAND, 6));
    expect(s.made).toEqual({ serper: calls.length });
    // Every search once; the website's own keyword and post are dropped, with why.
    const found = s.found.map((f) => f.keyword);
    expect(found).toContain('Why is my sourdough bread so dense?');
    expect(found).toContain('sourdough sandwich bread');
    expect(found.filter((k) => k === 'sourdough bread recipe')).toHaveLength(1);
    expect(s.found.find((f) => f.keyword === 'sourdough bread recipe')!.sources.sort()).toEqual(['autocomplete', 'related']);
    expect(s.dropped.map((d) => d.keyword)).toEqual(expect.arrayContaining(['sourdough bread machine', 'sourdough starter from scratch']));
    // The AI got the real searches only, and what the website has.
    expect(String(asked[0]!.searchesJson)).not.toContain('sourdough bread machine');
    expect(String(asked[0]!.existingJson)).toContain('sourdough bread machine');

    expect(s.plan).toEqual([
      {
        pillar: 'sourdough bread recipe', origin: 'real', page: 'recipe',
        subs: [
          { keyword: 'sourdough bread recipe for beginners', origin: 'real' },
          { keyword: 'sourdough bread recipe no knead', origin: 'real' },
          { keyword: 'Why is my sourdough bread so dense?', origin: 'real' },
          { keyword: 'sourdough bread with olives', origin: 'ai' },
        ],
      },
      { pillar: 'sourdough bread starter', origin: 'real', page: 'article', subs: [{ keyword: 'sourdough starter feeding schedule', origin: 'real' }] },
    ]);
    // What was left out of the plan says why.
    expect(s.left).toEqual([
      { keyword: 'sourdough bread recipe for beginners', reason: 'already in the plan' },
      { keyword: 'sourdough starter from scratch', reason: 'duplicate of the post “Sourdough Starter From Scratch”' },
    ]);
  });

  it('switching to another key or provider mid-way repeats no call and loses nothing; Resume carries on after every key failed', async () => {
    addSearchKeys('serper-key-1111', KEY);
    budget['serper-key-1111'] = 3;
    const id = createResearch(siteId, TOPIC);
    await runResearch(id, deps());
    // The only key ran out after 3 answers: stopped, with the 3 answers kept.
    let r = getResearch(id)!;
    expect(r.status).toBe('failed');
    expect(stateOf(r).error).toMatch(/No credit left/);
    expect(Object.keys(stateOf(r).calls)).toHaveLength(3);

    // A SerpAPI key is added: Resume asks only what was not answered yet.
    addSearchKeys('serpapi: serpapi-key-2222', KEY);
    const before = calls.length;
    await runResearch(id, deps());
    r = getResearch(id)!;
    expect(r.status).toBe('ready');
    const answered = queriesOf(calls.filter((c) => !(c.key === 'serper-key-1111' && budget['serper-key-1111']! < 0)));
    expect(new Set(answered).size).toBe(answered.length); // each question answered once
    expect(calls.slice(before).filter((c) => c.provider === 'serpapi')).toHaveLength(Object.keys(stateOf(r).calls).length - 3);
    expect(stateOf(r).made).toEqual({ serper: 3, serpapi: Object.keys(stateOf(r).calls).length - 3 });

    // Running it again asks Google nothing more.
    const done = calls.length;
    run(`UPDATE newsite_research SET status = 'failed' WHERE id = ?`, id);
    await runResearch(id, deps());
    expect(calls.length).toBe(done);
  });

  it('the tree is edited (rename, move, remove, add), then approved into the Keywords list like a CSV import', async () => {
    addSearchKeys('serper-key-1111', KEY);
    const id = createResearch(siteId, TOPIC);
    await runResearch(id, deps());
    await editPlan(
      id,
      {
        pillars: [
          { pillar: 'sourdough bread recipe', remove: false, page: 'recipe' },
          { pillar: 'sourdough starter care', remove: false, page: 'article' },
        ],
        subs: [
          { keyword: 'sourdough bread recipe for beginners', from: 0, to: 0, remove: false },
          { keyword: 'sourdough bread recipe no knead', from: 0, to: 0, remove: true },
          { keyword: 'Why is my sourdough bread so dense?', from: 0, to: 1, remove: false },
          { keyword: 'sourdough bread with olives', from: 0, to: 0, remove: false },
          { keyword: 'sourdough starter feeding schedule', from: 1, to: 1, remove: false },
        ],
        // A repeat of one in the plan is left out.
        added: [{ keyword: 'sourdough starter jar', to: 1 }, { keyword: 'sourdough bread with olives', to: 1 }],
      },
      deps(),
    );
    const plan = stateOf(getResearch(id)!).plan;
    expect(plan.map((p) => [p.pillar, p.origin, p.subs.map((s) => `${s.keyword} (${s.origin})`)])).toEqual([
      ['sourdough bread recipe', 'real', ['sourdough bread recipe for beginners (real)', 'sourdough bread with olives (ai)']],
      ['sourdough starter care', 'yours', ['Why is my sourdough bread so dense? (real)', 'sourdough starter feeding schedule (real)', 'sourdough starter jar (yours)']],
    ]);

    expect(approveResearch(id)).toEqual({ plans: 2, skipped: [] });
    const plans = listKeywordPlans(siteId).filter((p) => p.source === 'research');
    expect(plans.map((p) => [p.pillar, p.items.map((i) => i.keyword), p.subs_status])).toEqual([
      ['sourdough bread recipe', ['sourdough bread recipe for beginners', 'sourdough bread with olives'], 'finding'],
      ['sourdough starter care', ['Why is my sourdough bread so dense?', 'sourdough starter feeding schedule', 'sourdough starter jar'], 'finding'],
    ]);
    expect(plans[0]!.items[0]!.reason).toBe('From Content research');
    expect(getResearch(id)!.status).toBe('approved');
    // Approving twice adds nothing.
    expect(approveResearch(id)).toBeNull();
    expect(listKeywordPlans(siteId)).toHaveLength(3);
  });

  it('shows each step while it runs: Google, the deeper searches, the website check, then the AI', async () => {
    addSearchKeys('serper-key-1111', KEY);
    const id = createResearch(siteId, TOPIC);
    const seen: string[] = [];
    const watch = () => {
      const p = stateOf(getResearch(id)!).progress;
      if (p && seen.at(-1) !== `${p.phase} ${p.text}`) seen.push(`${p.phase} ${p.text}`);
    };
    const d = deps();
    await runResearch(id, {
      ...d,
      fetchImpl: (async (url: string, init?: RequestInit) => { watch(); return fetchImpl(url, init); }) as unknown as typeof fetch,
      listPosts: async (domain, key) => { watch(); return d.listPosts(domain, key); },
      ask: async (name, vars) => { watch(); return d.ask(name, vars); },
    });
    expect(seen[0]).toBe('1 Google’s suggestions for “sourdough bread”');
    expect(seen[1]).toBe('1 Top results, People Also Ask and related searches');
    expect(seen[2]).toMatch(/^2 1 of \d+: “sourdough bread recipe”$/);
    expect(seen.at(-2)).toBe('3 The keywords and articles of Bread Home');
    expect(seen.at(-1)).toMatch(/^4 \d+ searches into pillar articles and their sub-articles$/);
    // Ready: the steps are gone and the tree is there.
    expect(getResearch(id)!.status).toBe('ready');
    expect(stateOf(getResearch(id)!).progress).toBeUndefined();
    const page = String(researchPage({ ...getResearch(id)!, status: 'fetching' }, undefined, true));
    expect(page).toContain('class="rs-progress"');
  });

  describe('pages', () => {
    let app: FastifyInstance;
    const post = (url: string, fields: Record<string, string>) =>
      app.inject({ method: 'POST', url, payload: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

    beforeEach(async () => {
      app = Fastify();
      await app.register(formbody);
      registerNewWebsiteRoutes(app, {
        encryptionKey: KEY, isPlatformReady: () => true, autoSeo: false, autoPictures: false, fetchImpl,
        listPosts: async () => [], ask: async () => aiAnswer,
      });
      await app.ready();
    });
    afterEach(async () => app.close());

    it('asks only for a website and a niche or topic, and shows the short no-key note instead of starting without one', async () => {
      const without = (await app.inject({ method: 'GET', url: '/new-website/research' })).body;
      expect(without).toContain('<p class="rs-note">No search key. Add one in <a href="/new-website/platform#search-keys">Platform settings</a>.</p>');
      expect(without).not.toContain('Discover topics');
      await post('/new-website/research', { website: String(siteId), topic: TOPIC });
      expect(all('SELECT id FROM newsite_research')).toEqual([]);

      addSearchKeys('serper-key-1111', KEY);
      const page = (await app.inject({ method: 'GET', url: '/new-website/research' })).body;
      const form = /<form class="rs-form"[\s\S]*?<\/form>/.exec(page)![0];
      expect(form.match(/name="[^"]+"/g)).toEqual(['name="website"', 'name="topic"']);
      expect(form).toContain('<button class="ns-btn primary">Discover topics</button>');
      expect(page).not.toContain('<p class="rs-note">');
    });

    it('a research is started, shown as a tree with Google/AI marks, saved, and approved; keys show their status', async () => {
      expect((await app.inject({ method: 'GET', url: '/new-website/research' })).body).toContain('Content research');
      await post('/new-website/research/keys', { keys: 'serper-key-1111\nbad-key-0000' });
      broke.add('bad-key-0000');
      await post('/new-website/platform/search-keys/2/up', {});
      const checked = await post('/new-website/platform/search-keys/check', {});
      expect(checked.headers.location).toBe('/new-website/platform#search-keys');
      // The keys moved to Platform settings: the old page leads there.
      const moved = await app.inject({ method: 'GET', url: '/new-website/research/keys' });
      expect([moved.statusCode, moved.headers.location]).toEqual([301, '/new-website/platform#search-keys']);
      const keys = String(searchKeysSection(listSearchKeys(), () => '…'));
      expect(keys).toMatch(/Failed: No credit left[\s\S]*Working/);
      expect(keys).toContain('id="search-keys"');

      const started = await post('/new-website/research', { website: String(siteId), topic: TOPIC });
      const at = String(started.headers.location);
      for (let i = 0; i < 50 && getResearch(1)!.status !== 'ready'; i++) await new Promise((r) => setTimeout(r, 10));
      const page = (await app.inject({ method: 'GET', url: at })).body;
      expect(page).toContain('name="p-0" value="sourdough bread recipe"');
      expect(page).toContain('<span class="rs-tag ai"');
      expect(page).toContain('<span class="rs-tag real"');
      expect(page).toContain('Approve');

      const approved = await post(`${at}/approve`, {
        'p-0': 'sourdough bread recipe', 'page-0': 'recipe', 's-0-0': 'sourdough bread recipe for beginners', 'm-0-0': '0',
        'p-1': 'sourdough bread starter', 'page-1': 'article', 'rp-1': '1', 's-1-0': 'sourdough starter feeding schedule', 'm-1-0': '0',
      });
      expect(decodeURIComponent(String(approved.headers.location))).toContain('1 pillars added');
      expect(listKeywordPlans(siteId).find((p) => p.source === 'research')!.items.map((i) => i.keyword)).toEqual([
        'sourdough bread recipe for beginners',
        'sourdough starter feeding schedule',
      ]);
      expect(all('SELECT status FROM newsite_research')).toEqual([{ status: 'approved' }]);
    });
  });
});
