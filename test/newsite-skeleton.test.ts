import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { kickSeoWriter, listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { articleTypeFor, checkSkeleton, parseSkeleton, type Skeleton } from '../src/newsite/skeleton.js';

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

const ctx = { title: TITLE, focusKeyword: FOCUS };

describe('AI#2 checks', () => {
  it('accepts an outline the AI designed, with no fixed section names', () => {
    expect(checkSkeleton(GOOD, ctx)).toEqual([]);
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

  beforeEach(() => {
    openDatabase(':memory:');
    const websiteId = createNewWebsite(
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
        return JSON.stringify(name === 'seo-metadata' ? SEO : GOOD);
      },
    });
    expect(asked.map((a) => a.name)).toEqual(['seo-metadata', 'article-skeleton']);
    expect(asked[1]!.vars).toMatchObject({ title: TITLE, focusKeyword: FOCUS, articleType: 'recipe', persona: 'Storyteller' });
    const [row] = listPlanSeo(planId);
    expect(row).toMatchObject({ status: 'done', skeleton_status: 'done', article_type: 'recipe' });
    expect(JSON.parse(row!.skeleton_json).sections).toHaveLength(5);
  });

  it('retries with the problems, then fails with them', async () => {
    const skeletonVars: Record<string, unknown>[] = [];
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (name, vars) => {
        if (name === 'seo-metadata') return JSON.stringify(SEO);
        skeletonVars.push(vars);
        return JSON.stringify({ ...GOOD, sections: GOOD.sections.slice(0, 2) });
      },
    });
    expect(skeletonVars).toHaveLength(3);
    expect(String(skeletonVars[1]!.problemsJson)).toMatch(/H2 sections/);
    expect(listPlanSeo(planId)[0]).toMatchObject({ skeleton_status: 'failed', skeleton_problems: expect.stringMatching(/H2 sections/) });
  });

  it('makes no skeleton when the metadata failed', async () => {
    await kickSeoWriter({ suggest: async () => [], ask: async () => '{}' });
    expect(listPlanSeo(planId)[0]).toMatchObject({ status: 'failed', skeleton_status: '' });
  });
});
