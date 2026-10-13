import { describe, expect, it } from 'vitest';
import { readyFor } from '../src/newsite/keywords-view.js';
import type { NewWebsiteRow } from '../src/newsite/repo.js';
import type { SeoRow } from '../src/newsite/seo.js';

const site = (niche: string) => ({ niche }) as NewWebsiteRow;
const row = (keyword: string, fields: Partial<SeoRow> = {}) =>
  ({
    keyword,
    page: 'recipe',
    status: 'pending',
    recipe_status: '',
    skeleton_status: '',
    article_status: '',
    images_status: '',
    post_status: '',
    post_url: '',
    ...fields,
  }) as SeoRow;
const names = (rows: SeoRow[]) => rows.map((r) => r.keyword);

describe('Each keyword step shows only the keywords ready for it', () => {
  const rows = [
    row('seo not done', { status: 'failed' }),
    row('seo done', { status: 'done' }),
    row('article page', { status: 'done', page: 'article' }),
    row('recipe done', { status: 'done', recipe_status: 'done' }),
    row('skeleton done', { status: 'done', recipe_status: 'done', skeleton_status: 'done' }),
    row('article done', { status: 'done', recipe_status: 'done', skeleton_status: 'done', article_status: 'done' }),
    row('prompts done', { status: 'done', recipe_status: 'done', skeleton_status: 'done', article_status: 'done', images_status: 'done' }),
    row('published', { status: 'done', recipe_status: 'done', skeleton_status: 'done', article_status: 'done', images_status: 'done', post_status: 'published', post_url: 'https://x/y' }),
  ];

  it('on a recipe website: SEO done for the recipe, recipe done for the skeleton (article pages skip the recipe)', () => {
    const recipes = site('Recipes');
    expect(names(readyFor('recipe', recipes, rows))).not.toContain('seo not done');
    expect(names(readyFor('recipe', recipes, rows))).not.toContain('article page');
    expect(names(readyFor('recipe', recipes, rows))).toContain('seo done');
    expect(names(readyFor('skeleton', recipes, rows))).toEqual(['article page', 'recipe done', 'skeleton done', 'article done', 'prompts done', 'published']);
  });

  it('then each step needs the one before it', () => {
    const recipes = site('Recipes');
    expect(names(readyFor('article', recipes, rows))).toEqual(['skeleton done', 'article done', 'prompts done', 'published']);
    expect(names(readyFor('images', recipes, rows))).toEqual(['article done', 'prompts done', 'published']);
    expect(names(readyFor('publish', recipes, rows))).toEqual(['prompts done', 'published']);
    expect(names(readyFor('share', recipes, rows))).toEqual(['published']);
  });

  it('on an article website there is no recipe: SEO done is enough for the skeleton', () => {
    expect(names(readyFor('skeleton', site('Gardening'), rows))).not.toContain('seo not done');
    expect(names(readyFor('skeleton', site('Gardening'), rows))).toContain('seo done');
  });
});
