import { describe, expect, it } from 'vitest';
import { planSeoProblems } from '../src/pipeline/steps/blog.js';

/** What an article plan's search text is held to before the article is written. */

const keyword = 'how to repot a monstera';
const good = {
  metaTitle: 'How to Repot a Monstera Without Killing It',
  metaDescription: 'Learn how to repot a monstera in six steps, from choosing the pot to watering afterwards.',
  slug: 'how-to-repot-a-monstera',
  focusKeyword: 'how to repot a monstera',
  images: [{ alt: 'A monstera lifted out of its old pot with roots showing' }],
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
      images: [{ alt: 'x' }],
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
});
