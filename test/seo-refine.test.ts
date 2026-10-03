import { describe, expect, it } from 'vitest';
import { refineOnce } from '../src/seo/refine.js';

/**
 * SEO wording should be corrected when it can be, and never stop a run when
 * it cannot: one more try with the exact problems, then keep the best answer.
 */

const lengthProblems = (s: string): string[] => (s.length > 5 ? [`"${s}" is too long`] : []);

describe('refineOnce', () => {
  it('leaves a passing answer alone and never asks again', async () => {
    let asked = 0;
    const out = await refineOnce('ok', lengthProblems, async () => {
      asked += 1;
      return 'x';
    });
    expect(out).toEqual({ value: 'ok', problems: [] });
    expect(asked).toBe(0);
  });

  it('asks once with the problems and takes a better answer', async () => {
    const seen: string[][] = [];
    const out = await refineOnce('far too long', lengthProblems, async (problems) => {
      seen.push(problems);
      return 'short';
    });
    expect(seen).toEqual([['"far too long" is too long']]);
    expect(out).toEqual({ value: 'short', problems: [] });
  });

  it('keeps the first answer when the second is no better', async () => {
    const out = await refineOnce('far too long', lengthProblems, async () => 'also far too long');
    expect(out.value).toBe('far too long');
    expect(out.problems).toHaveLength(1);
  });

  it('keeps the first answer when asking again fails or returns nothing', async () => {
    const thrown = await refineOnce('far too long', lengthProblems, async () => {
      throw new Error('down');
    });
    expect(thrown.value).toBe('far too long');
    const none = await refineOnce('far too long', lengthProblems, async () => null);
    expect(none.value).toBe('far too long');
  });
});
