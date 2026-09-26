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

describe('what decides which pipeline runs', () => {
  it('is the keyword, whichever site it runs on', async () => {
    // The site serves both endpoints, so it has no say. The first version
    // read only the site's kind, which meant a keyword marked as an article
    // ran the recipe pipeline and posted a recipe -- silently, on a live site.
    const { randomBytes } = await import('node:crypto');
    const { closeDatabase, openDatabase } = await import('../src/db/index.js');
    const repos = await import('../src/db/repos.js');
    const { setLogLevel } = await import('../src/lib/logger.js');

    setLogLevel('error');
    openDatabase(':memory:');
    try {
      const key = randomBytes(32);
      repos.upsertSite(
        { name: 'bitespoon', domain: 'bitespoon.com', status: 'active', daily_target: 1,
          interval_minutes: 0, pin_username: '', project_id: '', paused_reason: '' },
        key,
      );
      const id = repos.insertKeyword({
        seed_keyword: 'pizza dough', content_type: 'article', niche: 'food',
      });

      // What the pipeline branches on, and nothing about the site is read.
      expect(repos.getKeyword(id)!.content_type).toBe('article');
      expect(repos.loadKeywordViews()[0]!.contentType).toBe('article');
    } finally {
      closeDatabase();
    }
  });

  it('keeps a keyword that says nothing writing recipes', async () => {
    const { closeDatabase, openDatabase } = await import('../src/db/index.js');
    const repos = await import('../src/db/repos.js');

    openDatabase(':memory:');
    try {
      const id = repos.insertKeyword({ seed_keyword: 'oven chicken' });
      expect(repos.getKeyword(id)!.content_type).toBe('recipe');
    } finally {
      closeDatabase();
    }
  });
});
