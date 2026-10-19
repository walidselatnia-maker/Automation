import { describe, expect, it } from 'vitest';
import { languageRule } from '../src/llm/ask.js';
import { validate } from '../src/newsite/validate.js';
import { checkRecipe } from '../src/newsite/recipe.js';
import { articleTypeFor } from '../src/newsite/skeleton.js';

describe('a website language', () => {
  it('defaults to English and only takes a listed language', () => {
    expect(validate({ niche: 'Recipes', nicheContext: '' }, ['niche', 'nicheContext', 'language'] as never).clean.language).toBe('English');
    expect(validate({ niche: 'Recipes', nicheContext: '', language: 'French' }, ['language'] as never).clean.language).toBe('French');
    expect(validate({ language: 'Klingon' }, ['language'] as never).errors.language).toMatch(/Pick a language/);
  });

  it('adds one rule to the prompt, none for English, and keeps picture prompts in English', () => {
    expect(languageRule('article-section', 'English')).toBe('');
    expect(languageRule('article-section', 'French')).toMatch(/Write every word a reader sees in French/);
    const pictures = languageRule('article-images', 'Spanish');
    expect(pictures).toMatch(/picture or video prompts and the theme in English/);
    expect(pictures).toMatch(/alt text, caption and on-screen text in Spanish/);
  });

  it('does not hold other languages to the English amount words', () => {
    const recipe = {
      prepMinutes: 10, cookMinutes: 20, servings: 4, difficulty: 'easy', cuisine: 'Française', course: 'Dessert',
      ingredients: [{ group: '', items: ['200 g de farine', 'une pincée de sel', '2 œufs'] }],
      steps: [{ text: 'Mélanger la farine et le sel dans un grand bol.' }, { text: 'Ajouter les œufs un par un en fouettant.' }, { text: 'Cuire au four pendant vingt minutes.' }],
      nutrition: { calories: 250, protein: 6, carbs: 30, fat: 10 },
      notes: '',
    };
    expect(checkRecipe(recipe as never, 'gâteau', 'French').join(' ')).not.toMatch(/exact amount/);
    expect(checkRecipe(recipe as never, 'gâteau', 'English').join(' ')).toMatch(/exact amount for: une pincée de sel/);
  });

  it('knows a recipe niche written in another language', () => {
    expect(articleTypeFor('Recettes')).toBe('recipe');
    expect(articleTypeFor('Recetas')).toBe('recipe');
    expect(articleTypeFor('Jardinage')).toBe('guide');
  });
});
