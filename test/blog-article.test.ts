import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGES,
  MIN_IMAGES,
  articlePayload,
  assembleArticle,
  categoryIdFor,
  marker,
  toSlug,
  type ArticlePlan,
} from '../src/pipeline/steps/blog.js';
import type { Category } from '../src/integrations/site-api.js';

/**
 * Articles carry their pictures inside the HTML, and the addresses do not
 * exist until the files are uploaded. So the writer leaves [IMAGE_n] behind
 * and the real tags go in last.
 *
 * What is pinned here is the assembly, because it is where a mistake reaches
 * a live page: a marker with no picture behind it would print as the literal
 * text "[IMAGE_5]", and a mis-swapped one puts the wrong photograph under the
 * wrong heading.
 */

const plan = (over: Partial<ArticlePlan> = {}): ArticlePlan => ({
  title: 'A Week in Kyoto',
  slug: 'a-week-in-kyoto',
  excerpt: 'What the guidebooks skip.',
  metaTitle: 'A Week in Kyoto',
  metaDescription: 'What the guidebooks skip.',
  focusKeyword: 'kyoto in autumn',
  tags: ['japan', 'travel'],
  category: 'Travel',
  sections: [{ heading: 'Getting there', covers: 'trains and costs' }],
  images: [
    { after: 'top', alt: 'A temple in autumn', brief: 'A temple, low sun' },
    { after: 'Getting there', alt: 'A platform at dusk', brief: 'A station platform' },
  ],
  ...over,
});

const uploaded = [
  { url: '/uploads/articles/one.webp', alt: 'A temple in autumn' },
  { url: '/uploads/articles/two.webp', alt: 'A platform at dusk' },
];

describe('putting the pictures into the article', () => {
  it('swaps each marker for the picture that belongs there', () => {
    const html = `<h2>Getting there</h2>\n${marker(0)}\n<p>Text.</p>\n${marker(1)}`;

    const out = assembleArticle(html, plan(), uploaded);

    expect(out.content).toContain('<img src="/uploads/articles/one.webp" alt="A temple in autumn">');
    expect(out.content).toContain('<img src="/uploads/articles/two.webp" alt="A platform at dusk">');
    expect(out.content).not.toContain('[IMAGE_');
  });

  it('makes the first picture the featured one', () => {
    // It is what the site shows in listings and what the pin is built from.
    const out = assembleArticle(`${marker(0)}${marker(1)}`, plan(), uploaded);

    expect(out.featuredImage).toBe('/uploads/articles/one.webp');
    expect(out.featuredImageAlt).toBe('A temple in autumn');
  });

  it('removes a marker whose picture never arrived', () => {
    // A generation that failed after the prose was written. The alternative is
    // the text "[IMAGE_2]" printed on a live page.
    const html = `<p>One.</p>${marker(0)}<p>Two.</p>${marker(1)}`;

    const out = assembleArticle(html, plan(), [uploaded[0]!]);

    expect(out.content).toContain('one.webp');
    expect(out.content).not.toContain('[IMAGE_2]');
  });

  it('escapes a quote in the alt text rather than breaking the tag', () => {
    const out = assembleArticle(marker(0), plan(), [
      { url: '/uploads/a.webp', alt: 'The 6" bowl & spoon' },
    ]);

    expect(out.content).toBe('<img src="/uploads/a.webp" alt="The 6&quot; bowl &amp; spoon">');
  });

  it('falls back to the title when a picture has no alt text', () => {
    const out = assembleArticle(marker(0), plan(), [{ url: '/uploads/a.webp', alt: '' }]);
    expect(out.featuredImageAlt).toBe('A Week in Kyoto');
  });
});

describe('the body sent to the articles API', () => {
  it('carries the fields the guide requires, published', () => {
    const assembled = assembleArticle(marker(0), plan(), uploaded);
    const body = articlePayload(plan(), assembled, { categoryId: 'cat_1' });

    expect(body).toMatchObject({
      title: 'A Week in Kyoto',
      slug: 'a-week-in-kyoto',
      status: 'published',
      focusKeyword: 'kyoto in autumn',
      categoryId: 'cat_1',
    });
    expect(String(body.content)).toContain('<img');
  });

  it('leaves out a category it could not resolve, rather than sending a wrong one', () => {
    // The guide names a bad categoryId as the usual cause of its 500.
    const body = articlePayload(plan(), assembleArticle('', plan(), uploaded), {});

    expect('categoryId' in body).toBe(false);
    expect('authorId' in body).toBe(false);
  });

  it('never sends an h1, because the site prints the title as one', () => {
    const assembled = assembleArticle('<h2>Getting there</h2><p>Text.</p>', plan(), uploaded);
    expect(assembled.content).not.toMatch(/<h1[\s>]/i);
  });
});

describe('the category the plan picked', () => {
  const categories = [
    { id: 'c1', slug: 'travel', title: 'Travel' },
    { id: 'c2', slug: 'food', title: 'Food & Drink' },
  ] as Category[];

  it('resolves a title to its id, ignoring case and spacing', () => {
    expect(categoryIdFor(categories, ' travel ')).toBe('c1');
    expect(categoryIdFor(categories, 'Food & Drink')).toBe('c2');
  });

  it('answers nothing for a category the site does not have', () => {
    expect(categoryIdFor(categories, 'Motorsport')).toBeUndefined();
    expect(categoryIdFor(categories, '')).toBeUndefined();
  });
});

describe('the slug', () => {
  it('is lowercase words joined by single dashes', () => {
    expect(toSlug('A Week in Kyoto — Autumn 2026!')).toBe('a-week-in-kyoto-autumn-2026');
  });

  it('never ends or starts with a dash, however it was trimmed', () => {
    const long = toSlug('x'.repeat(120));
    expect(long.startsWith('-')).toBe(false);
    expect(long.endsWith('-')).toBe(false);
    expect(long.length).toBeLessThanOrEqual(80);
  });
});

describe('how many photographs', () => {
  it('agrees with what the site guide allows', () => {
    expect(MIN_IMAGES).toBe(4);
    expect(MAX_IMAGES).toBe(7);
  });
});

describe('a keyword only runs where its kind is published', () => {
  it('refuses to pair an article keyword with a recipe site', async () => {
    // The link may exist -- the keyword x site matrix predates content types --
    // but running it would write a recipe pipeline's output at /api/articles.
    const { selectTask } = await import('../src/core/selector.js');

    const site = {
      id: 1, name: 'bitespoon', domain: 'bitespoon.com', status: 'active' as const,
      contentType: 'recipe' as const, dailyTarget: 5, intervalMinutes: 0,
      publishedToday: 0, lastPublishAt: null, lastAttemptAt: null,
    };
    const keyword = {
      id: 1, seedKeyword: 'kyoto', spyTitle: 'Kyoto', status: 'go' as const,
      contentType: 'article' as const,
    };
    const links = [{ keywordId: 1, siteId: 1, status: 'go' as const, blocked: false }];

    const both = { now: new Date('2026-09-25T10:00:00Z'), timezone: 'UTC' };
    expect(selectTask([site], [keyword], links, both).task).toBeFalsy();

    // The same pair runs the moment the site publishes that kind.
    const asArticles = { ...site, contentType: 'article' as const };
    expect(selectTask([asArticles], [keyword], links, both).task).toMatchObject({
      keywordId: 1,
      siteId: 1,
    });
  });
});
