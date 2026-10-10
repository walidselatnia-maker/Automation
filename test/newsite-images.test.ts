import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { checkImageSet, imageSlots, type ImageSet, type ImageSlot } from '../src/newsite/images.js';
import type { Recipe } from '../src/newsite/recipe.js';
import { createNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { kickSeoWriter, listPlanSeo, queuePlanSeo, requeueArticle, requeueImages } from '../src/newsite/seo.js';
import type { Skeleton } from '../src/newsite/skeleton.js';

const KEY = randomBytes(32);
const KEYWORD = 'pumpkin chocolate chip cookies';

const RECIPE: Recipe = {
  prepMinutes: 15, cookMinutes: 12, servings: 18, difficulty: 'easy', cuisine: 'American', course: 'Dessert',
  ingredients: [{ title: '', items: ['250 g flour', '200 g pumpkin puree', '150 g chocolate chips', '100 g sugar'] }],
  steps: [{ text: 'Mix the pumpkin and sugar.' }, { text: 'Fold in the flour and chocolate chips.' }, { text: 'Bake at 175 °C for 12 minutes.' }],
  nutrition: { calories: 140, protein: 2, carbs: 20, fat: 6 },
  notes: '',
};

const SKELETON: Skeleton = {
  h1: 'T',
  sections: ['Intro', 'Pick The Pumpkin', 'Chill The Dough', 'Bake Them', 'Store Them', 'Swap Ideas', 'Serve Them', 'Questions'].map((h2) => ({
    h2, covers: `about ${h2}`, keyPoints: ['a', 'b'], words: 100, h3: [],
  })),
};

const THEME = {
  surface: 'matte white ceramic plate on light oak table',
  lighting: 'soft window light from the left',
  palette: 'pumpkin orange and dark chocolate brown',
  style: 'commercial food photography',
  mood: 'warm and homemade',
};

/** A prompt that passes every rule, for one slot. */
const good = (slot: ImageSlot, i: number): { slot: string; prompt: string; alt: string } => ({
  slot: slot.slot,
  prompt:
    `Commercial food photo number ${i + 1} of ${KEYWORD} for ${slot.slot}, on a ${THEME.surface}, ${THEME.lighting}. ` +
    `${['Five', 'Three', 'Two', 'Seven', 'Four', 'Six', 'Eight', 'Nine', 'Ten'][i % 9]} cookies seen from angle ${i * 10} degrees, ` +
    `orange edges and melted chocolate chips in sharp focus, background softly blurred. Shot on a 50mm lens at f/4, 5500K, ` +
    `short shadows falling right. Variation ${'abcdefghij'.slice(0, (i % 9) + 1)} ${slot.shows.split(' ').slice(0, 6).join(' ')}. No text, no labels, no watermarks, no collage.`,
  alt: 'Soft pumpkin chocolate chip cookies cooling on a white ceramic plate',
});

const goodSet = (slots: ImageSlot[]): ImageSet => ({ theme: THEME, images: slots.map(good) });

describe('AI#4 image slots', () => {
  it('gives a recipe page six photos of the dish and one per recipe step', () => {
    const slots = imageSlots(KEYWORD, SKELETON, RECIPE).map((s) => s.slot);
    expect(slots).toEqual(['feature', 'overhead', 'closeup', 'ingredients', 'process', 'serving', 'step-1', 'step-2', 'step-3']);
  });

  it('gives an article page a feature image and one per main section, six at most', () => {
    const slots = imageSlots(KEYWORD, SKELETON, null).map((s) => s.slot);
    expect(slots).toEqual(['feature', 'section-1', 'section-2', 'section-3', 'section-4', 'section-5']);
  });
});

describe('AI#4 checks', () => {
  const slots = imageSlots(KEYWORD, SKELETON, RECIPE);
  const ctx = { keyword: KEYWORD, slots, allowedText: RECIPE.ingredients[0]!.items.join('\n') + '\n' + RECIPE.steps.map((s) => s.text).join('\n') };

  it('passes a set that follows every rule', () => {
    expect(checkImageSet(goodSet(slots), ctx)).toEqual([]);
  });

  it('needs every slot, in order', () => {
    const set = goodSet(slots);
    set.images.pop();
    expect(checkImageSet(set, ctx).join(' ')).toMatch(/one image per slot/);
  });

  it('holds every prompt to the shared look', () => {
    const set = goodSet(slots);
    set.images[1]!.prompt = set.images[1]!.prompt.replace(THEME.surface, 'slate board').replace(THEME.lighting, 'hard flash');
    const problems = checkImageSet(set, ctx).join(' ');
    expect(problems).toMatch(/Image "overhead": repeat the theme's surface/);
    expect(problems).toMatch(/Image "overhead": repeat the theme's lighting/);
  });

  it('needs the camera, the light and no text', () => {
    const set = goodSet(slots);
    set.images[0]!.prompt = set.images[0]!.prompt.replace('50mm lens at f/4, 5500K', 'nice camera').replace('No text, ', '');
    const problems = checkImageSet(set, ctx).join(' ');
    expect(problems).toMatch(/give the lens/);
    expect(problems).toMatch(/give the aperture/);
    expect(problems).toMatch(/light temperature/);
    expect(problems).toMatch(/no text/);
  });

  it('refuses generic words and ingredients the recipe does not have', () => {
    const set = goodSet(slots);
    set.images[0]!.prompt = set.images[0]!.prompt.replace('Five cookies', 'Five stunning cookies with walnuts');
    const problems = checkImageSet(set, ctx).join(' ');
    expect(problems).toMatch(/generic word "stunning"/);
    expect(problems).toMatch(/not in the recipe: walnut/);
  });

  it('refuses two prompts that show the same picture', () => {
    const set = goodSet(slots);
    set.images[1] = { ...set.images[0]!, slot: 'overhead' };
    expect(checkImageSet(set, ctx).join(' ')).toMatch(/too close to image "feature"/);
  });

  it('checks the alt text', () => {
    const set = goodSet(slots);
    set.images[0]!.alt = 'Image of cookies';
    const problems = checkImageSet(set, ctx).join(' ');
    expect(problems).toMatch(/alt text has 3 words/);
    expect(problems).toMatch(/must not start with "image of"/);
  });
});

describe('AI#4 follows the article', () => {
  let planId: number;

  beforeEach(() => {
    openDatabase(':memory:');
    const websiteId = createNewWebsite(
      {
        name: 'Site', domain: 'f.longlivo.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Baking recipes', nicheContext: '',
        persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480,
        bufferToken: '', pinUsername: '', projectId: '',
      },
      KEY,
    );
    planId = saveKeywordPlan(websiteId, KEYWORD, [], 'recipe');
    queuePlanSeo(planId, KEYWORD, [], 'recipe');
    // Everything before the images is done.
    run(
      `UPDATE keyword_seo SET status = 'done', title = 'T', focus_keyword = ?, recipe_status = 'done', recipe_json = ?,
         skeleton_status = 'done', skeleton_json = ?, article_status = 'done', article_md = '## Intro\n\nText.', images_status = 'pending'
       WHERE plan_id = ?`,
      KEYWORD,
      JSON.stringify(RECIPE),
      JSON.stringify(SKELETON),
      planId,
    );
  });

  afterEach(() => closeDatabase());

  it('writes the prompts for every slot in one answer', async () => {
    const asked: Record<string, unknown>[] = [];
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (name, vars) => {
        if (name !== 'article-images') throw new Error(name);
        asked.push(vars);
        return '```json\n' + JSON.stringify(goodSet(JSON.parse(String(vars.slotsJson)) as ImageSlot[])) + '\n```';
      },
    });
    expect(asked).toHaveLength(1);
    expect(String(asked[0]!.article)).toContain('## Intro');
    const [row] = listPlanSeo(planId);
    expect(row).toMatchObject({ images_status: 'done', images_problems: '' });
    expect(JSON.parse(row!.images_json).images).toHaveLength(9);
  });

  it('fails after three rounds with the reasons, and can be written again', async () => {
    let calls = 0;
    await kickSeoWriter({ suggest: async () => [], ask: async () => { calls += 1; return '{"theme":{},"images":[]}'; } });
    expect(calls).toBe(3);
    const [row] = listPlanSeo(planId);
    expect(row).toMatchObject({ images_status: 'failed' });
    expect(row!.images_problems).toMatch(/one image per slot/);
    requeueImages(row!.id);
    expect(listPlanSeo(planId)[0]).toMatchObject({ images_status: 'pending', images_problems: '' });
  });

  it('are cleared when the article is written again', () => {
    run(`UPDATE keyword_seo SET images_status = 'done', images_json = '{}' WHERE plan_id = ?`, planId);
    requeueArticle(listPlanSeo(planId)[0]!.id);
    expect(listPlanSeo(planId)[0]).toMatchObject({ article_status: 'pending', images_status: '', images_json: '' });
  });
});
