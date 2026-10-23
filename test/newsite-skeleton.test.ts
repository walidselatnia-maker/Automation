import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, get, openDatabase, run } from '../src/db/index.js';
import { setPromptOverride } from '../src/db/repos.js';
import { invalidatePromptCache, readShippedPrompt } from '../src/pipeline/prompts.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { kickSeoWriter, listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { SKELETON_PARTS, articleTypeFor, checkSkeleton, parseSkeleton, pickSkeletonStyles, styleFile, type Skeleton } from '../src/newsite/skeleton.js';

const KEY = randomBytes(32);
const TITLE = 'Pumpkin Chocolate Chip Cookies: Soft, Easy and Spiced';
const FOCUS = 'pumpkin chocolate chip cookies';

/** An outline the AI designed itself: no template headings required. */
const GOOD: Skeleton = {
  h1: TITLE,
  sections: [
    { h2: 'Why These Pumpkin Chocolate Chip Cookies Stay Soft', covers: 'c', keyPoints: ['pumpkin moisture', 'chilling'], words: 180, h3: [] },
    { h2: 'What Goes In the Dough', covers: 'c', keyPoints: ['puree vs pie filling', 'brown sugar'], words: 200, h3: [] },
    {
      h2: 'Mixing and Baking, Step by Step', covers: 'c', keyPoints: ['order of mixing', 'bake time'], words: 0,
      h3: [
        { h3: 'Blot the pumpkin', keyPoints: ['paper towel'], words: 120 },
        { h3: 'Cream, fold, chill', keyPoints: ['30 minutes'], words: 150 },
        { h3: 'Bake until the edges set', keyPoints: ['12 minutes'], words: 130 },
      ],
    },
    { h2: 'Swaps That Still Work', covers: 'c', keyPoints: ['oat flour', 'white chocolate'], words: 160, h3: [] },
    { h2: 'Questions Bakers Ask', covers: 'c', keyPoints: ['freezing', 'cakey cookies'], words: 150, h3: [] },
  ],
};

const ctx = { title: TITLE, focusKeyword: FOCUS, role: 'sub' as const };

/** A pillar outline: longer and deeper, and it touches each sub-topic. */
const PILLAR: Skeleton = {
  h1: TITLE,
  sections: [
    { h2: 'Why Pumpkin Chocolate Chip Cookies Work So Well', covers: 'c', keyPoints: ['moisture', 'spice'], words: 300, h3: [] },
    { h2: 'The Ingredients and What Each One Does', covers: 'c', keyPoints: ['puree', 'flour'], words: 350, h3: [] },
    { h2: 'Mixing and Baking, Step by Step', covers: 'c', keyPoints: ['order', 'time'], words: 450, h3: [] },
    { h2: 'Texture: Soft, Chewy or Cakey', covers: 'c', keyPoints: ['butter', 'chill'], words: 300, h3: [] },
    { h2: 'Diet Versions', covers: 'c', keyPoints: ['A vegan batch with flax eggs', 'gluten-free flour'], words: 300, h3: [] },
    { h2: 'Other Shapes', covers: 'c', keyPoints: ['Cookie bars in one pan', 'mini cookies'], words: 250, h3: [] },
    { h2: 'Storing and Freezing', covers: 'c', keyPoints: ['airtight', 'freeze dough'], words: 200, h3: [] },
    { h2: 'Questions Bakers Ask', covers: 'c', keyPoints: ['cakey', 'swap'], words: 250, h3: [] },
  ],
};
/** A recipe that passes every check, for the recipe-website chain. */
export const RECIPE = {
  prepMinutes: 15, cookMinutes: 12, servings: 24, difficulty: 'easy', cuisine: 'American', course: 'Dessert',
  ingredients: [{ title: 'Dough', items: ['250 g all-purpose flour', '1 tsp baking soda', '200 g pumpkin puree', '150 g chocolate chips'] }],
  steps: [{ text: 'Heat the oven to 175 °C and line two trays.' }, { text: 'Mix the flour and baking soda in a bowl.' }, { text: 'Fold in the pumpkin and chocolate chips, then bake for 12 minutes.' }],
  nutrition: { calories: 140, protein: 2, carbs: 20, fat: 6 },
  notes: 'Blot the pumpkin first.',
};

/** The pillar outline with the full recipe just before the FAQ. */
const PILLAR_WITH_RECIPE: Skeleton = {
  ...PILLAR,
  sections: [
    ...PILLAR.sections.slice(0, -1),
    { h2: 'The Pumpkin Chocolate Chip Cookies Recipe', covers: 'c', keyPoints: ['ingredients', 'steps'], words: 300, h3: [] },
    PILLAR.sections.at(-1)!,
  ],
};

const pillarCtx = {
  title: TITLE,
  focusKeyword: FOCUS,
  role: 'pillar' as const,
  pillar: FOCUS,
  subKeywords: ['vegan pumpkin chocolate chip cookies', 'pumpkin chocolate chip cookie bars'],
};

describe('AI#2 checks', () => {
  it('accepts an outline the AI designed, with no fixed section names', () => {
    expect(checkSkeleton(GOOD, ctx)).toEqual([]);
  });

  it('keeps an outline on what its keyword asks: a decorating keyword is about decorating', () => {
    const decorate = { ...ctx, keyword: 'strawberry cake how to decorate' };
    // GOOD is about making the cookies: for a decorating keyword it drifts.
    expect(checkSkeleton(GOOD, decorate).join(' ')).toMatch(/drifts from the keyword "strawberry cake how to decorate": it is about decorating, but that comes up in only 0 of 5 sections/);
    const onTopic = {
      ...GOOD,
      sections: GOOD.sections.map((s, i) => (i < 3 ? { ...s, keyPoints: [...s.keyPoints, 'decorating with piped cream'] } : s)),
    };
    expect(checkSkeleton(onTopic, decorate).join(' ')).not.toMatch(/drifts/);
    // A keyword that is the dish itself has no such rule.
    expect(checkSkeleton(GOOD, { ...ctx, keyword: FOCUS })).toEqual([]);
  });

  it('keeps the H1 as the SEO title', () => {
    expect(checkSkeleton({ ...GOOD, h1: 'Something else' }, ctx).join(' ')).toMatch(/H1 must be exactly/);
  });

  it('needs an opening and a closing section', () => {
    const s = GOOD.sections;
    expect(checkSkeleton({ ...GOOD, sections: [s[3]!, ...s.slice(1)] }, ctx).join(' ')).toMatch(/first H2/);
    expect(checkSkeleton({ ...GOOD, sections: [...s.slice(0, 4), s[3]!] }, ctx).join(' ')).toMatch(/last H2/);
  });

  it('needs the focus keyword in a heading, without stuffing', () => {
    const none = GOOD.sections.map((s, i) => (i === 0 ? { ...s, h2: 'Why These Cookies Stay Soft' } : s));
    expect(checkSkeleton({ ...GOOD, sections: none }, ctx).join(' ')).toMatch(/Use the focus keyword/);
    const stuffed = GOOD.sections.map((s, i) => (i < 4 && i > 0 ? { ...s, h2: `${s.h2} for Pumpkin Chocolate Chip Cookies` } : s));
    expect(checkSkeleton({ ...GOOD, sections: stuffed }, ctx).join(' ')).toMatch(/in \d headings/);
  });

  it('catches too few sections, thin sections, duplicates and unrealistic length', () => {
    expect(checkSkeleton({ ...GOOD, sections: GOOD.sections.slice(0, 3) }, ctx).join(' ')).toMatch(/3 H2 sections/);
    const thin = GOOD.sections.map((s, i) => (i === 1 ? { ...s, keyPoints: ['one'] } : s));
    expect(checkSkeleton({ ...GOOD, sections: thin }, ctx).join(' ')).toMatch(/at least 2 key points/);
    const dup = GOOD.sections.map((s, i) => (i === 3 ? { ...s, h2: GOOD.sections[1]!.h2 } : s));
    expect(checkSkeleton({ ...GOOD, sections: dup }, ctx).join(' ')).toMatch(/used twice/);
    const huge = GOOD.sections.map((s) => ({ ...s, words: 800 }));
    expect(checkSkeleton({ ...GOOD, sections: huge }, ctx).join(' ')).toMatch(/totals \d+ words/);
  });

  it('holds the pillar to more depth than a sub-page', () => {
    expect(checkSkeleton(PILLAR, pillarCtx)).toEqual([]);
    // The sub-page outline is too short and too thin for a pillar.
    expect(checkSkeleton({ ...GOOD }, pillarCtx).join(' ')).toMatch(/pillar needs 7 to 14|pillar needs 2000 to 4500/);
    // And the pillar outline is too long for a sub-page.
    expect(checkSkeleton(PILLAR, ctx).join(' ')).toMatch(/sub-page needs/);
  });

  it('makes the pillar touch every sub-topic', () => {
    const noBars = PILLAR.sections.map((sec, i) => (i === 5 ? { ...sec, keyPoints: ['mini cookies', 'sandwich cookies'] } : sec));
    expect(checkSkeleton({ ...PILLAR, sections: noBars }, pillarCtx).join(' ')).toMatch(/cover the sub-topic "pumpkin chocolate chip cookie bars"/);
  });

  it('reads a wrapped answer', () => {
    expect(parseSkeleton(`Here: ${JSON.stringify(GOOD)}`)?.sections).toHaveLength(5);
    expect(parseSkeleton('no')).toBeNull();
  });

  it('writes recipes for food niches and guides for the rest', () => {
    expect(articleTypeFor('Recipes')).toBe('recipe');
    expect(articleTypeFor('Home baking')).toBe('recipe');
    expect(articleTypeFor('Gardening')).toBe('guide');
  });
});

describe('AI#2 follows AI#1', () => {
  let planId: number;
  let websiteId: number;

  beforeEach(() => {
    openDatabase(':memory:');
    websiteId = createNewWebsite(
      {
        name: 'Long Livo', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Recipes',
        nicheContext: '', persona: 'Storyteller', status: 'active', autoPublish: true,
        dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    planId = saveKeywordPlan(websiteId, FOCUS, []);
    queuePlanSeo(planId, FOCUS, []);
  });

  afterEach(() => closeDatabase());

  const SEO = {
    title: TITLE,
    description:
      'Soft pumpkin chocolate chip cookies with warm spice and melty chocolate, ready in 30 minutes. Tested again and again at home. Learn how to bake them now.',
    focusKeyword: FOCUS,
    altText: 'Pumpkin chocolate chip cookies stacked on a white plate today',
    eeat: 'Experience',
  };

  it('makes the skeleton once the metadata is done, from that metadata', async () => {
    const asked: { name: string; vars: Record<string, unknown> }[] = [];
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (name, vars) => {
        asked.push({ name, vars });
        return JSON.stringify(name === 'seo-metadata' ? SEO : name === 'recipe-card' ? RECIPE : PILLAR_WITH_RECIPE);
      },
    });
    expect(asked.map((a) => a.name).slice(0, 3)).toEqual(['seo-metadata', 'recipe-card', 'article-skeleton']);
    expect(asked.slice(3).every((a) => a.name === 'article-section' || a.name === 'article-images')).toBe(true);
    expect(String(asked[2]!.vars.depth)).toMatch(/PILLAR/);
    expect(String(asked[2]!.vars.recipeJson)).toContain('250 g all-purpose flour');
    expect(asked[2]!.vars).toMatchObject({ title: TITLE, focusKeyword: FOCUS, articleType: 'recipe', persona: 'Storyteller' });
    const [row] = listPlanSeo(planId);
    expect(row).toMatchObject({ status: 'done', skeleton_status: 'done', article_type: 'recipe' });
    expect(JSON.parse(row!.skeleton_json).sections).toHaveLength(9);
    expect(row).toMatchObject({ recipe_status: 'done' });
  });

  it('sends mistakes back with the previous answer; after every round keeps the best and carries on', async () => {
    const skeletonVars: Record<string, unknown>[] = [];
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (name, vars) => {
        if (name === 'seo-metadata') return JSON.stringify(SEO);
        if (name === 'recipe-card') return JSON.stringify(RECIPE);
        skeletonVars.push(vars);
        return JSON.stringify({ ...GOOD, sections: GOOD.sections.slice(0, 2) });
      },
    });
    const skeletonAsks = skeletonVars.filter((v) => 'depth' in v);
    expect(skeletonAsks).toHaveLength(10);
    expect(String(skeletonAsks[1]!.problemsJson)).toMatch(/H2 sections[\s\S]*Your previous answer:/);
    expect(listPlanSeo(planId)[0]).toMatchObject({ skeleton_status: 'done', skeleton_problems: expect.stringMatching(/Kept after 10 rounds[\s\S]*H2 sections/) });
  });

  it('builds the outline prompt from one version of each part, kept on the keyword, in the website\'s language', async () => {
    run(`UPDATE new_websites SET language = 'French' WHERE id = ?`, websiteId);
    const asked: Record<string, unknown>[] = [];
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (name, vars) => {
        if (name === 'article-skeleton') asked.push(vars);
        return JSON.stringify(name === 'seo-metadata' ? SEO : name === 'recipe-card' ? RECIPE : PILLAR_WITH_RECIPE);
      },
    });
    const styles = JSON.parse(listPlanSeo(planId)[0]!.skeleton_styles) as Record<string, number>;
    for (const { key } of SKELETON_PARTS) {
      expect(styles[key]).toBeGreaterThanOrEqual(1);
      expect(styles[key]).toBeLessThanOrEqual(4);
      expect(asked[0]![`${key}Part`]).toBe(readShippedPrompt(styleFile(key, styles[key]!)).trim());
    }
    expect(asked[0]!.language).toBe('French');
    expect(String(asked[0]!.depth)).toMatch(/PILLAR/);
    expect(get<{ skeleton_last: string }>('SELECT skeleton_last FROM new_websites WHERE id = ?', websiteId)!.skeleton_last).toBe(JSON.stringify(styles));
  });

  it('never gives a website the version of a part it used last, and varies over many articles', () => {
    const seen: Record<string, Set<number>> = { opening: new Set(), body: new Set(), closing: new Set() };
    let last: Record<string, number> | null = null;
    for (let i = 0; i < 40; i++) {
      const picked = pickSkeletonStyles(websiteId);
      for (const { key } of SKELETON_PARTS) {
        if (last) expect(picked[key]).not.toBe(last[key]);
        seen[key]!.add(picked[key]);
      }
      run('UPDATE new_websites SET skeleton_last = ? WHERE id = ?', JSON.stringify(picked), websiteId);
      last = picked;
    }
    for (const { key } of SKELETON_PARTS) expect(seen[key]!.size).toBeGreaterThanOrEqual(3);
  });

  it('skips a version left empty', () => {
    for (const v of [1, 2, 3]) setPromptOverride(styleFile('body', v), ' ');
    invalidatePromptCache();
    expect(pickSkeletonStyles(websiteId).body).toBe(4);
    invalidatePromptCache();
  });

  it('makes no skeleton when the metadata failed for a technical reason', async () => {
    await kickSeoWriter({ suggest: async () => [], ask: async () => { throw new Error('no endpoint'); } });
    expect(listPlanSeo(planId)[0]).toMatchObject({ status: 'failed', skeleton_status: '' });
  });
});
