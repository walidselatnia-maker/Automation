import { describe, expect, it } from 'vitest';
import {
  filterPicks,
  findSubKeywords,
  parsePicks,
  pillarProblem,
  subProblem,
  type Existing,
} from '../src/newsite/keywords.js';

const PILLAR = 'pumpkin chocolate chip cookies';

const SEARCHES = [
  'vegan pumpkin chocolate chip cookies',
  'gluten free pumpkin chocolate chip cookies',
  'pumpkin chocolate chip cookies with cake mix',
  'brown butter pumpkin chocolate chip cookies',
  'pumpkin oatmeal chocolate chip cookies',
  'pumpkin chocolate chip cookie bars',
  'easy pumpkin chocolate chip cookies',
  'best pumpkin chocolate chip cookies recipe',
  'pumpkin bread',
  'chewy pumpkin chocolate chip cookies',
];

describe('sub-keyword rules', () => {
  it.each([
    'vegan pumpkin chocolate chip cookies',
    'gluten free pumpkin chocolate chip cookies',
    'pumpkin chocolate chip cookies with cake mix',
    'pumpkin chocolate chip cookie bars',
  ])('accepts a real different intent: %s', (keyword) => {
    expect(subProblem(keyword, PILLAR, [], [])).toBeNull();
  });

  it.each([
    'easy pumpkin chocolate chip cookies',
    'best pumpkin chocolate chip cookies recipe',
    'chewy pumpkin chocolate chip cookies',
    'how to make pumpkin chocolate chip cookies',
  ])('drops adjective-only variants: %s', (keyword) => {
    expect(subProblem(keyword, PILLAR, [], [])).toMatch(/only words like/);
  });

  it('drops keywords that are not about the pillar', () => {
    expect(subProblem('pumpkin bread', PILLAR, [], [])).toBe('Not about the pillar.');
  });

  it('drops a keyword already covered by a post on the site', () => {
    const existing: Existing[] = [{ label: 'the post “Vegan Pumpkin Chocolate Chip Cookies”', text: 'Vegan Pumpkin Chocolate Chip Cookies' }];
    expect(subProblem('easy vegan pumpkin chocolate chip cookies', PILLAR, existing, [])).toMatch(/Too close to the post/);
  });

  it('drops a near twin of an earlier pick', () => {
    expect(
      subProblem('vegan pumpkin chocolate chip cookie', PILLAR, [], ['vegan pumpkin chocolate chip cookies']),
    ).toMatch(/already in this list/);
  });

  it('blocks a pillar the site already has', () => {
    const existing: Existing[] = [{ label: 'the post “Best Pumpkin Chocolate Chip Cookies”', text: 'Best Pumpkin Chocolate Chip Cookies' }];
    expect(pillarProblem(PILLAR, existing)).toMatch(/Already covered by the post/);
    expect(pillarProblem(PILLAR, [])).toBeNull();
    expect(pillarProblem('easy best', [])).toBeTruthy();
  });
});

describe('filtering the AI picks', () => {
  it('keeps real, different picks and explains every drop', () => {
    const raw = [
      { keyword: 'Vegan pumpkin chocolate chip cookies', intent: 'diet', reason: 'No eggs or butter.' },
      { keyword: 'easy pumpkin chocolate chip cookies', intent: 'method', reason: 'x' },
      { keyword: 'pumpkin chocolate chip cookies air fryer', intent: 'method', reason: 'made up' },
      { keyword: 'pumpkin chocolate chip cookie bars', intent: 'nonsense', reason: 'Baked in a pan.' },
    ];
    const { kept, dropped } = filterPicks(raw, PILLAR, SEARCHES, []);
    expect(kept).toMatchObject([
      { keyword: 'vegan pumpkin chocolate chip cookies', intent: 'diet', reason: 'No eggs or butter.' },
      { keyword: 'pumpkin chocolate chip cookie bars', intent: 'format', reason: 'Baked in a pan.' },
    ]);
    expect(dropped.map((d) => d.keyword)).toEqual([
      'easy pumpkin chocolate chip cookies',
      'pumpkin chocolate chip cookies air fryer',
    ]);
    expect(dropped[1]!.reason).toMatch(/Not a real Google search/);
  });

  it('keeps at most six', () => {
    const many = Array.from({ length: 8 }, (_, i) => `pumpkin chocolate chip cookies variation${i}`);
    const { kept, dropped } = filterPicks(many.map((keyword) => ({ keyword })), PILLAR, many, []);
    expect(kept).toHaveLength(6);
    expect(dropped.at(-1)!.reason).toMatch(/Only the best 6/);
  });

  it('reads the picks out of a wrapped or chatty answer', () => {
    expect(parsePicks('{"picks":[{"keyword":"a"}]}')).toEqual([{ keyword: 'a' }]);
    expect(parsePicks('Here you go: {"picks":[{"keyword":"b"}]} done')).toEqual([{ keyword: 'b' }]);
    expect(parsePicks('[{"keyword":"c"}]')).toEqual([{ keyword: 'c' }]);
    expect(parsePicks('nonsense')).toEqual([]);
  });
});

describe('the whole search', () => {
  const input = { pillar: PILLAR, niche: 'Recipes', nicheContext: '', existing: [] };

  it('asks Google, then the AI with only real searches, then filters', async () => {
    let sent: Record<string, unknown> | undefined;
    const result = await findSubKeywords(input, {
      suggest: async () => [PILLAR, ...SEARCHES],
      ask: async (_name, vars) => {
        sent = vars;
        return JSON.stringify({ picks: [{ keyword: 'vegan pumpkin chocolate chip cookies', intent: 'diet', reason: 'r' }] });
      },
    });
    expect(result).toMatchObject({ ok: true, searches: SEARCHES.length });
    expect(JSON.parse(String(sent!.searchesJson))).toEqual(SEARCHES);
  });

  it('stops and never invents keywords when Google is unreachable', async () => {
    let asked = false;
    const result = await findSubKeywords(input, {
      suggest: async () => [],
      ask: async () => { asked = true; return '{}'; },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Google/) });
    expect(asked).toBe(false);
  });

  it('stops before searching when the pillar is already on the site', async () => {
    let searched = false;
    const result = await findSubKeywords(
      { ...input, existing: [{ label: 'the post “Pumpkin Chocolate Chip Cookies”', text: 'Pumpkin Chocolate Chip Cookies' }] },
      { suggest: async () => { searched = true; return SEARCHES; }, ask: async () => '{}' },
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Already covered/) });
    expect(searched).toBe(false);
  });

  it('only adds picks like the given ones, up to six in all, never repeating them', async () => {
    const given = ['vegan pumpkin chocolate chip cookies', 'pumpkin chocolate chip cookie bars', 'pumpkin oatmeal chocolate chip cookies', 'brown butter pumpkin chocolate chip cookies'];
    const result = await findSubKeywords({ ...input, given }, {
      suggest: async () => SEARCHES,
      ask: async () => JSON.stringify({
        picks: [
          { keyword: 'vegan pumpkin chocolate chip cookies', intent: 'diet', reason: 'r' },
          { keyword: 'gluten free pumpkin chocolate chip cookies', intent: 'diet', reason: 'r' },
          { keyword: 'pumpkin chocolate chip cookies with cake mix', intent: 'method', reason: 'r' },
          { keyword: 'chewy pumpkin chocolate chip cookies', intent: 'method', reason: 'r' },
        ],
      }),
    });
    expect(result.ok && result.kept.map((k) => k.keyword)).toEqual(['gluten free pumpkin chocolate chip cookies', 'pumpkin chocolate chip cookies with cake mix']);
  });

  it('says so when the AI is down', async () => {
    const result = await findSubKeywords(input, {
      suggest: async () => SEARCHES,
      ask: async () => { throw new Error('no endpoint'); },
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/AI could not be reached/) });
  });
});

describe('recipe page or article page', () => {
  it('carries the AI suggestion for each pick and for the pillar', async () => {
    const { parsePillarPage } = await import('../src/newsite/keywords.js');
    const raw = [
      { keyword: 'vegan pumpkin chocolate chip cookies', intent: 'diet', reason: 'r', page: 'recipe', pageReason: 'a dish to bake' },
      { keyword: 'pumpkin chocolate chip cookie bars', intent: 'format', reason: 'r', page: 'article', pageReason: 'test' },
    ];
    const { kept } = filterPicks(raw, PILLAR, SEARCHES, []);
    expect(kept.map((k) => k.page)).toEqual(['recipe', 'article']);
    expect(kept[0]!.pageReason).toBe('a dish to bake');
    expect(parsePillarPage('{"pillarPage":"article","pillarPageReason":"a category","picks":[]}')).toEqual({ page: 'article', reason: 'a category' });
    expect(parsePillarPage('nonsense').page).toBe('recipe');
  });
});
