import { describe, expect, it } from 'vitest';
import {
  checkAlt,
  checkDescription,
  checkFocusKeyword,
  checkSlug,
  checkTitle,
  restrictedWords,
  rulesPrompt,
  similarity,
  words,
} from '../src/seo/rules.js';

/**
 * Google gives no hard length limits, only "unique, descriptive, not stuffed".
 * These tests pin the stricter rules this platform applies on top, so a model
 * can be held to them in plain code instead of being trusted.
 */

const keyword = 'honey garlic chicken thighs';
const goodTitle = 'Honey Garlic Chicken Thighs With Crispy Skin';
const goodDescription =
  'Sticky honey garlic chicken thighs baked until the skin crisps, ready in under an hour.';

describe('words and similarity', () => {
  it('drops filler words and plural s', () => {
    expect(words('The Best Chicken Thighs for Dinner')).toEqual(['best', 'chicken', 'thigh', 'dinner']);
  });

  it('scores overlap from 0 to 1', () => {
    expect(similarity('honey garlic chicken', 'Honey Garlic Chicken')).toBe(1);
    expect(similarity('honey garlic chicken', 'lemon herb salmon')).toBe(0);
    expect(similarity('', '')).toBe(0);
  });
});

describe('restrictedWords', () => {
  it('flags pork, alcohol and holiday words', () => {
    expect(restrictedWords('Christmas ham with wine')).toEqual(['Christmas', 'ham', 'wine']);
  });

  it('lets turkey bacon, beef ham and wine vinegar through', () => {
    expect(restrictedWords('turkey bacon wrap with red wine vinegar and beef ham')).toEqual([]);
  });

  it('does not match inside other words', () => {
    expect(restrictedWords('eastern hamburger')).toEqual([]);
  });
});

describe('checkTitle', () => {
  it('accepts a good title', () => {
    expect(checkTitle(goodTitle, { keyword })).toEqual([]);
  });

  it('rejects one that is too long, too short or all caps', () => {
    expect(checkTitle(goodTitle + ' That Everyone Will Absolutely Love', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('characters')]),
    );
    expect(checkTitle('Chicken', { keyword }).length).toBeGreaterThan(0);
    expect(checkTitle('HONEY GARLIC CHICKEN THIGHS RECIPE', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('capitals')]),
    );
  });

  it('wants every keyword word, near the front', () => {
    expect(checkTitle('Crispy Skin Chicken Thighs', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('missing')]),
    );
    expect(
      checkTitle('A Weeknight Favourite You Will Absolutely Love: Honey Garlic Chicken Thighs', { keyword }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('start')]));
  });

  it('rejects stuffing and lists', () => {
    expect(
      checkTitle('Chicken Chicken Chicken Honey Garlic Thighs', { keyword }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('repeated')]));
    expect(checkTitle('Honey Garlic Chicken Thighs, Easy, Quick, Best', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('list')]),
    );
  });

  it('rejects restricted words and near-duplicates of other titles', () => {
    expect(checkTitle('Honey Garlic Chicken Thighs With Bacon', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('Bacon')]),
    );
    expect(
      checkTitle(goodTitle, { keyword, others: ['Honey Garlic Chicken Thighs With Crispy Skin'] }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('similar')]));
  });
});

describe('checkDescription', () => {
  it('accepts a good description', () => {
    expect(checkDescription(goodDescription, { keyword })).toEqual([]);
  });

  it('wants 70 to 160 characters ending like a sentence', () => {
    expect(checkDescription('Honey garlic chicken thighs.', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('characters')]),
    );
    expect(checkDescription(goodDescription.slice(0, -1), { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('sentence')]),
    );
    expect(checkDescription(goodDescription + ' ' + 'More words here. '.repeat(10), { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('characters')]),
    );
  });

  it('wants the keyword words, once, and not a keyword list', () => {
    expect(
      checkDescription('Sticky glazed poultry baked until the skin crisps, ready in under an hour.', { keyword }),
    ).toEqual(expect.arrayContaining([expect.stringContaining('keyword')]));
    expect(
      checkDescription(
        'Honey garlic chicken thighs are the best honey garlic chicken thighs you will bake this week.',
        { keyword },
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('once')]));
    expect(
      checkDescription(
        'Honey garlic chicken thighs, easy, quick, best, juicy, crispy, sticky dinner for busy people.',
        { keyword },
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('list')]));
  });

  it('rejects a description too like another one', () => {
    expect(checkDescription(goodDescription, { keyword, others: [goodDescription] })).toEqual(
      expect.arrayContaining([expect.stringContaining('similar')]),
    );
  });
});

describe('checkSlug', () => {
  it('accepts short descriptive words', () => {
    expect(checkSlug('honey-garlic-chicken-thighs', { keyword })).toEqual([]);
  });

  it('rejects bad characters, length, years and missing keyword words', () => {
    expect(checkSlug('Honey_Garlic', { keyword }).length).toBeGreaterThan(0);
    expect(checkSlug('honey-garlic-chicken-thighs-with-crispy-skin-and-more', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('words')]),
    );
    expect(checkSlug('honey-garlic-chicken-thighs-2026', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('year')]),
    );
    expect(checkSlug('crispy-chicken', { keyword })).toEqual(
      expect.arrayContaining([expect.stringContaining('missing')]),
    );
  });

  it('rejects a slug another page already has', () => {
    expect(checkSlug('honey-garlic-chicken-thighs', { keyword, others: ['honey-garlic-chicken-thighs'] })).toEqual(
      expect.arrayContaining([expect.stringContaining('already')]),
    );
  });
});

describe('focus keyword and alt text', () => {
  it('wants three or more words', () => {
    expect(checkFocusKeyword('chicken thighs')).toHaveLength(1);
    expect(checkFocusKeyword('honey garlic chicken thighs')).toEqual([]);
  });

  it('wants alt text of a sensible length', () => {
    expect(checkAlt('Sliced thighs on a plate')).toEqual([]);
    expect(checkAlt('Plate')).toHaveLength(1);
    expect(checkAlt('x'.repeat(130))).toHaveLength(1);
  });
});

describe('rulesPrompt', () => {
  it('tells the model the caps that will be checked', () => {
    const text = rulesPrompt();
    expect(text).toContain('60');
    expect(text).toContain('160');
    expect(text).toContain('keyword');
  });
});
