import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { checkRecipe, parseRecipe, type Recipe } from '../src/newsite/recipe.js';
import { kickSeoWriter, listPlanSeo, queuePlanSeo, requeueRecipe } from '../src/newsite/seo.js';
import { checkSkeleton } from '../src/newsite/skeleton.js';

const KEY = randomBytes(32);

const GOOD: Recipe = {
  prepMinutes: 15, cookMinutes: 12, servings: 24, difficulty: 'easy', cuisine: 'American', course: 'Dessert',
  ingredients: [
    { title: 'Dough', items: ['250 g all-purpose flour', '1 tsp baking soda', '2 large eggs', '115 g butter, softened'] },
    { title: '', items: ['150 g chocolate chips', 'a pinch of salt'] },
  ],
  steps: [
    { text: 'Heat the oven to 175 °C and line two trays.' },
    { text: 'Cream the butter, then beat in the eggs one at a time.' },
    { text: 'Fold in the flour, soda, salt and chips, then bake for 12 minutes.' },
  ],
  nutrition: { calories: 140, protein: 2, carbs: 20, fat: 6 },
  notes: 'Chill the dough for thicker cookies.',
};

describe('recipe checks', () => {
  it('passes a complete recipe', () => {
    expect(checkRecipe(GOOD, 'pumpkin chocolate chip cookies')).toEqual([]);
  });

  it('needs exact amounts', () => {
    const vague = { ...GOOD, ingredients: [{ title: '', items: ['flour', 'sugar', '2 eggs'] }] };
    expect(checkRecipe(vague, 'cookies').join(' ')).toMatch(/exact amount for: flour; sugar/);
  });

  it('keeps a vegan keyword vegan', () => {
    expect(checkRecipe(GOOD, 'vegan pumpkin chocolate chip cookies').join(' ')).toMatch(/promises vegan.*2 large eggs.*butter/);
    const vegan = {
      ...GOOD,
      ingredients: [{ title: '', items: ['250 g all-purpose flour', '1 tbsp flax egg', '115 g vegan butter', '150 g dairy-free chocolate chips'] }],
    };
    expect(checkRecipe(vegan, 'vegan pumpkin chocolate chip cookies')).toEqual([]);
  });

  it('keeps gluten-free and egg-free promises', () => {
    expect(checkRecipe(GOOD, 'gluten free pumpkin cookies').join(' ')).toMatch(/promises gluten-free.*all-purpose flour/);
    expect(checkRecipe(GOOD, 'pumpkin cookies without eggs').join(' ')).toMatch(/promises egg-free.*eggs/);
  });

  it('catches impossible numbers and missing parts', () => {
    const bad = { ...GOOD, servings: 0, prepMinutes: 0, cookMinutes: 0, difficulty: '' as never, steps: [{ text: 'Bake.' }],
      nutrition: { calories: 9000, protein: 2, carbs: 20, fat: 6 } };
    const problems = checkRecipe(bad, 'cookies').join(' ');
    for (const p of [/Servings/, /prep or cook time/, /Difficulty/, /1 steps/, /Calories/]) expect(problems).toMatch(p);
  });

  it('reads the card shape the website expects, from a wrapped answer', () => {
    const r = parseRecipe(`Here: ${JSON.stringify({ ...GOOD, steps: ['Plain string step that is long enough.'], difficulty: 'Easy' })}`);
    expect(r?.difficulty).toBe('easy');
    expect(r?.steps[0]).toEqual({ text: 'Plain string step that is long enough.' });
  });
});

describe('the recipe step on a recipe website', () => {
  let planId: number;
  const SEO = {
    title: 'Pumpkin Chocolate Chip Cookies: Soft, Easy and Spiced',
    description: 'Soft pumpkin chocolate chip cookies with warm spice and melty chocolate, ready in 30 minutes. Tested again and again at home. Learn how to bake them now.',
    focusKeyword: 'pumpkin chocolate chip cookies',
    altText: 'Pumpkin chocolate chip cookies stacked on a white plate today',
    eeat: 'Experience',
  };

  const setup = (niche: string) => {
    openDatabase(':memory:');
    const websiteId = createNewWebsite(
      {
        name: 'Site', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche, nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    planId = saveKeywordPlan(websiteId, 'pumpkin chocolate chip cookies', []);
    queuePlanSeo(planId, 'pumpkin chocolate chip cookies', []);
  };

  afterEach(() => closeDatabase());

  it('comes after SEO and before the skeleton, which waits for it', async () => {
    setup('Recipes');
    const order: string[] = [];
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (name) => {
        order.push(name);
        return JSON.stringify(name === 'seo-metadata' ? SEO : name === 'recipe-card' ? { ...GOOD, notes: 'x' } : { h1: 'x', sections: [] });
      },
    });
    expect(order.slice(0, 3)).toEqual(['seo-metadata', 'recipe-card', 'article-skeleton']);
    // An outline with no sections is corrected round after round; kept after every round, it gives the
    // article nothing to write, which stops there instead of looping.
    expect(order.filter((n) => n === 'article-skeleton')).toHaveLength(10);
    expect(listPlanSeo(planId)[0]).toMatchObject({ recipe_status: 'done', skeleton_status: 'done', article_status: 'failed' });
  });

  it('holds the skeleton back while the recipe fails for a technical reason', async () => {
    setup('Recipes');
    const order: string[] = [];
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (name) => {
        order.push(name);
        if (name === 'recipe-card') throw new Error('no endpoint');
        return JSON.stringify(SEO);
      },
    });
    expect(order).toEqual(['seo-metadata', 'recipe-card']);
    expect(listPlanSeo(planId)[0]).toMatchObject({ recipe_status: 'failed', skeleton_status: '', recipe_problems: expect.stringMatching(/could not be reached/) });
  });

  it('skips the recipe on a non-recipe website', async () => {
    setup('Gardening');
    const order: string[] = [];
    await kickSeoWriter({ suggest: async () => [], ask: async (name) => { order.push(name); return JSON.stringify(SEO); } });
    expect(order[1]).toBe('article-skeleton');
    expect(listPlanSeo(planId)[0]!.recipe_status).toBe('');
  });

  it('remakes the skeleton when the recipe is made again', async () => {
    setup('Recipes');
    const ask = async (name: string) => JSON.stringify(name === 'seo-metadata' ? SEO : name === 'recipe-card' ? GOOD : { h1: 'x', sections: [] });
    await kickSeoWriter({ suggest: async () => [], ask });
    const row = listPlanSeo(planId)[0]!;
    requeueRecipe(row.id);
    expect(listPlanSeo(planId)[0]).toMatchObject({ recipe_status: 'pending', skeleton_status: '' });
  });
});

describe('the pillar carries its recipe', () => {
  it('needs a recipe section just before the FAQ when it has a recipe', () => {
    const sections = [
      'Why Pumpkin Chocolate Chip Cookies Work', 'Ingredients Explained', 'Method', 'Texture', 'Vegan pumpkin chocolate chip cookies',
      'Storage', 'Serving Ideas', 'Questions Bakers Ask',
    ].map((h2) => ({ h2, covers: 'c', keyPoints: ['a', 'b'], words: 320, h3: [] }));
    const ctx = { title: 'T', focusKeyword: 'pumpkin chocolate chip cookies', role: 'pillar' as const, recipe: GOOD };
    expect(checkSkeleton({ h1: 'T', sections }, ctx).join(' ')).toMatch(/full recipe as its second-to-last H2/);
    const withRecipe = [...sections.slice(0, -1), { ...sections[0]!, h2: 'The Full Recipe' }, sections.at(-1)!];
    expect(checkSkeleton({ h1: 'T', sections: withRecipe }, ctx).join(' ')).not.toMatch(/second-to-last/);
  });
});

describe('recipe pages and article pages', () => {
  afterEach(() => closeDatabase());

  it('gives a recipe only to recipe pages', async () => {
    openDatabase(':memory:');
    const websiteId = createNewWebsite(
      {
        name: 'Site', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    const planId = saveKeywordPlan(websiteId, 'strawberry desserts', [], 'article');
    queuePlanSeo(planId, 'strawberry desserts', [
      { keyword: 'strawberry cake with cake mix', page: 'recipe' },
      { keyword: 'strawberry cake vs shortcake', page: 'article' },
    ], 'article');
    const SEO = {
      title: 'Strawberry Desserts: Easy Ideas for Every Season Now', // checks fail but status is what matters below
      description: 'x', focusKeyword: 'x', altText: 'x', eeat: 'Experience',
    };
    // Mark every keyword's metadata done directly, then let the writer decide what follows.
    const rows = listPlanSeo(planId);
    const { run } = await import('../src/db/index.js');
    for (const r of rows) run(`UPDATE keyword_seo SET status = 'done', title = ?, recipe_status = CASE WHEN page = 'recipe' THEN 'pending' ELSE '' END, skeleton_status = CASE WHEN page = 'recipe' THEN '' ELSE 'pending' END WHERE id = ?`, SEO.title, r.id);
    const asked: { name: string; keyword: unknown }[] = [];
    await kickSeoWriter({ suggest: async () => [], ask: async (name, vars) => { asked.push({ name, keyword: vars.keyword }); return '{}'; } });
    const recipeCalls = asked.filter((a) => a.name === 'recipe-card').map((a) => a.keyword);
    expect(recipeCalls.every((k) => k === 'strawberry cake with cake mix')).toBe(true);
    expect(recipeCalls.length).toBeGreaterThan(0);
    const skeletonFor = asked.filter((a) => a.name === 'article-skeleton').map((a) => a.keyword);
    expect(skeletonFor).toContain('strawberry cake vs shortcake');
    expect(skeletonFor).toContain('strawberry desserts');
  });
});
