import { describe, expect, it } from 'vitest';
import { findTopics } from '../src/newsite/top-lists.js';

const posts = (titles: string[]) => titles.map((title, i) => ({ id: i + 1, title }));

describe('Top list topics', () => {
  it('finds the phrase many titles share, not its lone words', () => {
    const topics = findTopics(
      posts([
        'Easy Zucchini Bread',
        'Chocolate Zucchini Bread Recipe',
        'Healthy Zucchini Bread with Honey',
        'Lemon Zucchini Breads',
        'Banana Bread',
        'Grilled Chicken Salad',
      ]),
      4,
    );
    expect(topics.map((t) => t.topic)).toEqual(['zucchini bread']);
    expect(topics[0]!.postIds).toEqual([1, 2, 3, 4]);
  });

  it('skips filler words like easy and recipe', () => {
    const topics = findTopics(posts(['Easy Recipe One', 'Easy Recipe Two', 'Easy Recipe Three']), 3);
    expect(topics).toEqual([]);
  });
});
