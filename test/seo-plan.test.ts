import { describe, expect, it } from 'vitest';
import { MAX_IMAGES, planArticle, planSeoProblems } from '../src/pipeline/steps/blog.js';
import type { PipelineContext } from '../src/pipeline/context.js';

/** What an article plan's search text is held to before the article is written. */

const keyword = 'how to repot a monstera';
const good = {
  metaTitle: 'How to Repot a Monstera Without Killing It',
  metaDescription: 'Learn how to repot a monstera in six steps, from choosing the pot to watering afterwards.',
  slug: 'how-to-repot-a-monstera',
  focusKeyword: 'how to repot a monstera',
  images: [{ alt: 'A monstera lifted out of its old pot with roots showing', brief: 'a monstera' }],
};

describe('planSeoProblems', () => {
  it('passes a plan that follows the rules', () => {
    expect(planSeoProblems(good, keyword)).toEqual([]);
  });

  it('labels each problem with the field it belongs to', () => {
    const bad = {
      ...good,
      metaTitle: 'Monstera',
      metaDescription: 'Repot it.',
      slug: 'Repot_Monstera_2026',
      focusKeyword: 'monstera',
      images: [{ alt: 'x', brief: 'a monstera' }],
    };
    const problems = planSeoProblems(bad, keyword);
    for (const field of ['metaTitle', 'metaDescription', 'slug', 'focusKeyword', 'images[0].alt']) {
      expect(problems.some((p) => p.startsWith(field))).toBe(true);
    }
  });

  it('falls back to the topic when the plan has no focus keyword', () => {
    const { focusKeyword: _omit, ...rest } = good;
    expect(planSeoProblems(rest, keyword)).toEqual([]);
  });

  it('does not penalise a short seed keyword used as the fallback focus', () => {
    const { focusKeyword: _omit, ...rest } = good;
    const plan = {
      ...rest,
      metaTitle: 'Monstera Repotting Made Simple and Safe',
      metaDescription: 'Learn monstera repotting in six steps, from choosing the pot to watering afterwards.',
      slug: 'monstera-repotting',
    };
    expect(planSeoProblems(plan, 'monstera repotting').some((p) => p.startsWith('focusKeyword'))).toBe(false);
  });

  it('still flags a supplied focus keyword that is too short', () => {
    expect(planSeoProblems({ ...good, focusKeyword: 'monstera' }, keyword).some((p) => p.startsWith('focusKeyword'))).toBe(true);
  });

  it('does not apply recipe-site restricted words to articles', () => {
    const plan = {
      metaTitle: 'Best Wine Regions in Italy to Visit',
      metaDescription: 'Explore the best wine regions in italy, from Tuscany to Piedmont, with tips on when to go.',
      slug: 'best-wine-regions-in-italy',
      focusKeyword: 'best wine regions in italy',
      images: [{ alt: 'Vineyards rolling over Tuscan hills at sunset', brief: 'vineyards' }],
    };
    expect(planSeoProblems(plan, 'best wine regions in italy')).toEqual([]);
  });
});

describe('planSeoProblems alt text', () => {
  it('ignores the alt text of pictures the step will drop', () => {
    const plan = {
      ...good,
      images: [
        { alt: 'A monstera lifted out of its old pot with roots showing', brief: 'a monstera' },
        { alt: 'x', brief: '   ' },
        { alt: 'y' },
      ],
    };
    expect(planSeoProblems(plan, keyword)).toEqual([]);
  });

  it('ignores pictures past the cap', () => {
    const fine = { alt: 'A monstera lifted out of its old pot with roots showing', brief: 'b' };
    const plan = { ...good, images: [...Array.from({ length: MAX_IMAGES }, () => fine), { alt: 'x', brief: 'b' }] };
    expect(planSeoProblems(plan, keyword)).toEqual([]);
  });

  it('still checks the alt text of a kept picture', () => {
    const plan = { ...good, images: [{ alt: 'x', brief: 'a monstera' }] };
    expect(planSeoProblems(plan, keyword).some((p) => p.startsWith('images[0].alt'))).toBe(true);
  });
});

describe('planArticle second plan', () => {
  const picture = (n: number) => ({ after: 'top', alt: `A monstera repotting step number ${n} close up`, brief: `step ${n}` });
  const full = {
    title: 'How to Repot a Monstera',
    slug: 'how-to-repot-a-monstera',
    excerpt: 'Repotting, step by step.',
    metaTitle: 'How to Repot a Monstera Without Killing It',
    metaDescription: 'Learn how to repot a monstera in six steps, from choosing the pot to watering afterwards.',
    focusKeyword: 'how to repot a monstera',
    tags: ['plants'],
    category: 'Plants',
    sections: [{ heading: 'Choose a pot', covers: 'size' }],
    images: [1, 2, 3, 4].map(picture),
  };
  const weak = { ...full, metaTitle: 'Monstera', metaDescription: 'Repot it.' };

  const run = (answers: object[]) => {
    const queue = answers.map((a) => JSON.stringify(a));
    const ctx = {
      runId: 1,
      keyword: { seed_keyword: keyword, niche: 'plants', spy_title: '' },
      prompt: async () => ({ content: queue.shift() ?? 'nope', endpoint: 'e', model: 'm' }),
    } as unknown as PipelineContext;
    return planArticle.run(ctx, [{ id: 1, title: 'Plants' }] as never);
  };

  it('ignores a second plan with better text but no pictures', async () => {
    const out = await run([weak, { ...full, images: [] }]);
    expect(out.value.metaTitle).toBe('Monstera');
    expect(out.value.images).toHaveLength(4);
  });

  it('ignores a second plan with no usable sections', async () => {
    const out = await run([weak, { ...full, sections: [{ heading: '  ', covers: '' }] }]);
    expect(out.value.metaTitle).toBe('Monstera');
  });

  it('uses a second plan that is better and complete', async () => {
    const out = await run([weak, full]);
    expect(out.value.metaTitle).toBe(full.metaTitle);
  });
});
