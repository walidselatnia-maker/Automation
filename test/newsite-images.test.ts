import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { checkImageSet, imageSlots, pictureStyleFor, type ImageSet, type ImageSlot } from '../src/newsite/images.js';
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
  dish: 'thick round pumpkin cookies, orange crumb, dotted with melted chocolate chips',
  colorStyle: 'Warm & Appetizing',
};

/** A prompt that passes every rule, for one slot. */
const good = (slot: ImageSlot, i: number): { slot: string; prompt: string; alt: string } => ({
  slot: slot.slot,
  prompt:
    `Commercial food photo number ${i + 1} of ${KEYWORD} for ${slot.slot}, ${THEME.dish}, on a ${THEME.surface}, ${THEME.lighting}. ` +
    `${['Five', 'Three', 'Two', 'Seven', 'Four', 'Six', 'Eight', 'Nine', 'Ten'][i % 9]} cookies seen from angle ${i * 10} degrees, ` +
    `orange edges and melted chocolate chips in sharp focus, background softly blurred. Shot on a 50mm lens at f/4, 5500K, ` +
    `short shadows falling right. Variation ${'abcdefghij'.slice(0, (i % 9) + 1)} ${slot.shows.replace(/PORTRAIT 3:4|SQUARE 1:1|\bperfect\b|mouth-catching/g, '')}. No text, no labels, no watermarks, no collage.`,
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

  it('holds every prompt of a recipe page to the same dish, and needs the dish described', () => {
    const set = goodSet(slots);
    set.images[7]!.prompt = set.images[7]!.prompt.replace(THEME.dish, 'blueberry muffins');
    expect(checkImageSet(set, ctx).join(' ')).toMatch(/Image "step-2": repeat the theme's dish word for word/);
    const noDish = goodSet(slots);
    noDish.theme = { ...THEME, dish: '' };
    expect(checkImageSet(noDish, ctx).join(' ')).toMatch(/The theme needs its dish/);
  });

  it('asks no dish of a page without a recipe', () => {
    const articleSlots = imageSlots(KEYWORD, SKELETON, null);
    const set = goodSet(articleSlots);
    set.theme = { ...THEME, dish: '' };
    set.images.forEach((im) => (im.prompt = im.prompt.replace(`${THEME.dish}, `, '')));
    expect(checkImageSet(set, { keyword: KEYWORD, slots: articleSlots })).toEqual([]);
  });

  it('tells each step picture which step it is and to leave the finished dish out until the end', () => {
    const steps = imageSlots(KEYWORD, SKELETON, RECIPE).filter((s) => s.slot.startsWith('step-'));
    expect(steps[0]!.shows).toMatch(/step 1 of 3 of making the pumpkin chocolate chip cookies/);
    expect(steps[0]!.shows).toMatch(/is not in this picture yet/);
    expect(steps[2]!.shows).not.toMatch(/is not in this picture yet/);
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

  it('picks ONE colour style from the website\'s list for the article, keeps it, and a remake reuses it', async () => {
    const lists: string[] = [];
    let named = 'Sunset Neon';
    const writer = () =>
      kickSeoWriter({
        suggest: async () => [],
        ask: async (_name, vars) => {
          lists.push(String(vars.colorStylesJson));
          const set = goodSet(JSON.parse(String(vars.slotsJson)) as ImageSlot[]);
          return JSON.stringify({ ...set, theme: { ...set.theme, colorStyle: named } });
        },
      });
    named = 'Sunset Neon';
    let round = 0;
    await kickSeoWriter({
      suggest: async () => [],
      ask: async (_name, vars) => {
        lists.push(String(vars.colorStylesJson));
        round += 1;
        const set = goodSet(JSON.parse(String(vars.slotsJson)) as ImageSlot[]);
        // Not one of the list first: sent back, then a real one.
        return JSON.stringify({ ...set, theme: { ...set.theme, colorStyle: round === 1 ? 'Sunset Neon' : 'clean & bright' } });
      },
    });
    // A recipe website: its niche's list, main style first.
    const first = JSON.parse(lists[0]!) as { name: string }[];
    expect(first.slice(0, 2).map((s) => s.name)).toEqual(['Warm & Appetizing', 'Clean & Bright']);
    expect(round).toBe(2);
    const [row] = listPlanSeo(planId);
    expect(JSON.parse(row!.color_style)).toEqual({ name: 'Clean & Bright', description: 'Bright neutral tones, soft daylight, minimal shadows' });
    expect(JSON.parse(row!.images_json).theme.colorStyle).toBe('Clean & Bright');

    // Made again: only the style it has is offered, so the article never mixes two.
    requeueImages(row!.id);
    lists.length = 0;
    named = 'Clean & Bright';
    await writer();
    expect(JSON.parse(lists[0]!)).toEqual([{ name: 'Clean & Bright', description: 'Bright neutral tones, soft daylight, minimal shadows' }]);
    expect(JSON.parse(listPlanSeo(planId)[0]!.color_style).name).toBe('Clean & Bright');
  });

  it('keeps correcting, then keeps the best with what is left noted, and can be written again', async () => {
    let calls = 0;
    await kickSeoWriter({ suggest: async () => [], ask: async () => { calls += 1; return '{"theme":{},"images":[]}'; } });
    expect(calls).toBe(10);
    const [row] = listPlanSeo(planId);
    expect(row).toMatchObject({ images_status: 'done' });
    expect(row!.images_problems).toMatch(/Kept after 10 rounds[\s\S]*one image per slot/);
    requeueImages(row!.id);
    expect(listPlanSeo(planId)[0]).toMatchObject({ images_status: 'pending', images_problems: '' });
  });

  it('are cleared when the article is written again', () => {
    run(`UPDATE keyword_seo SET images_status = 'done', images_json = '{}' WHERE plan_id = ?`, planId);
    requeueArticle(listPlanSeo(planId)[0]!.id);
    expect(listPlanSeo(planId)[0]).toMatchObject({ article_status: 'pending', images_status: '', images_json: '' });
  });
});

describe('AI#4 pictures that fit the niche', () => {
  const PET_SKELETON: Skeleton = {
    h1: 'T',
    sections: ['Intro', 'Brush Weekly', 'Bath Time', 'Questions'].map((h2) => ({ h2, covers: `about ${h2}`, keyPoints: ['a'], words: 100, h3: [] })),
  };
  const slots = imageSlots('golden retriever grooming', PET_SKELETON, null);
  const petTheme = { ...THEME, surface: 'worn oak floorboards in a sunny living room', style: 'candid lifestyle pet photography', dish: '', colorStyle: 'Natural & Documentary' };
  const petPrompt = (slot: ImageSlot, i: number, extra = '') => ({
    slot: slot.slot,
    prompt:
      `Candid photo ${i + 1} of a golden retriever grooming moment for ${slot.slot}, the dog lying on ${petTheme.surface}, ${petTheme.lighting}, ` +
      [`an owner's hands working a slicker brush through the thick golden coat, loose fur drifting across the boards. `, `seen from low at floor level, a wet nose and a wagging tail, a towel rolled beside the water bowl, splashes on tiles. `, `wide view across the room, a sofa and a window behind, the dog stretched out asleep after its bath, a comb left on the rug. `][i % 3] +
      `Shot on an 85mm lens at f/2.8, 5200K, soft shadows to the right, the dog's eyes in focus. ${extra}No text, no labels, no watermarks, no collage.`,
    alt: 'Golden retriever being brushed by its owner on oak floorboards',
  });
  const ctx = { keyword: 'golden retriever grooming', slots, article: '## Brush Weekly\n\nBrush your golden retriever on the floor every week.' };

  it('has no food styling in the default photo direction of a website that is not about food', () => {
    const style = pictureStyleFor({ niche: 'Pets', picture_style: '' }, false);
    expect(style).toContain('Real-life photography for a website about Pets');
    expect(style).toContain('never on a dining table or a plate');
    expect(pictureStyleFor({ niche: 'Recipes' }, true)).toContain('Food photography of this recipe');
    // The website's own Picture style wins.
    expect(pictureStyleFor({ niche: 'Pets', picture_style: 'Cats at home only.' }, false)).toBe('Cats at home only.');
    expect(imageSlots('golden retriever grooming', PET_SKELETON, null)[0]!.shows).not.toMatch(/empty table/);
  });

  it('sends back a pet picture put on a plate or a dining table, unless the article talks about it', () => {
    const fine: ImageSet = { theme: petTheme, images: slots.map((s, i) => petPrompt(s, i)) };
    expect(checkImageSet(fine, ctx)).toEqual([]);
    const onTable: ImageSet = { theme: petTheme, images: slots.map((s, i) => petPrompt(s, i, i === 0 ? 'The dog sits on the dining table next to a plate. ' : '')) };
    const problems = checkImageSet(onTable, ctx);
    expect(problems).toContain('Image "feature": "plate" is food styling and this article never talks about it. Show the subject where it really is in this niche, not on a table or a plate.');
    expect(problems.some((p) => p.includes('"table" is food styling'))).toBe(true);
    // An article about the dog's feeding plate may show one.
    expect(checkImageSet(onTable, { ...ctx, article: `${ctx.article} Put the plate on the dining table.` })).toEqual([]);
  });

  it('gives the AI the website’s own picture style', async () => {
    openDatabase(':memory:');
    try {
      const websiteId = createNewWebsite(
        {
          name: 'Pets', domain: 'p.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Pets', nicheContext: '', pictureStyle: 'Dogs outdoors, on grass or trails.',
          persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '',
        },
        KEY,
      );
      const plan = saveKeywordPlan(websiteId, 'golden retriever grooming', [], 'article');
      queuePlanSeo(plan, 'golden retriever grooming', [], 'article');
      run(
        `UPDATE keyword_seo SET status = 'done', title = 'T', skeleton_status = 'done', skeleton_json = ?, article_status = 'done', article_md = ?, images_status = 'pending' WHERE plan_id = ?`,
        JSON.stringify(PET_SKELETON),
        ctx.article,
        plan,
      );
      const asked: Record<string, unknown>[] = [];
      await kickSeoWriter({ suggest: async () => [], ask: async (_n, vars) => { asked.push(vars); return JSON.stringify({ theme: petTheme, images: slots.map((s, i) => petPrompt(s, i)) }); } });
      expect(asked[0]!.pictureStyle).toBe('Dogs outdoors, on grass or trails.');
      expect(listPlanSeo(plan)[0]).toMatchObject({ images_status: 'done', images_problems: '' });
    } finally {
      closeDatabase();
    }
  });

  it('has the AI pick ONE picture style from several, keeps it on the article and offers only it again', async () => {
    openDatabase(':memory:');
    try {
      const styles = [{ name: 'Cozy Living Room', description: 'Pets at home on the sofa.' }, { name: 'Park & Trail Walks', description: 'Out on a walk in a park.' }];
      const websiteId = createNewWebsite(
        {
          name: 'Pets', domain: 'p.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Pets', nicheContext: '', pictureStyle: JSON.stringify(styles),
          persona: 'Storyteller', status: 'active', autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '',
        },
        KEY,
      );
      const plan = saveKeywordPlan(websiteId, 'golden retriever grooming', [], 'article');
      queuePlanSeo(plan, 'golden retriever grooming', [], 'article');
      run(
        `UPDATE keyword_seo SET status = 'done', title = 'T', skeleton_status = 'done', skeleton_json = ?, article_status = 'done', article_md = ?, images_status = 'pending' WHERE plan_id = ?`,
        JSON.stringify(PET_SKELETON),
        ctx.article,
        plan,
      );
      const asked: Record<string, unknown>[] = [];
      const answers = [{ ...petTheme }, { ...petTheme, pictureStyle: 'park & trail walks' }];
      await kickSeoWriter({ suggest: async () => [], ask: async (_n, vars) => { asked.push(vars); return JSON.stringify({ theme: answers[Math.min(asked.length - 1, 1)], images: slots.map((s, i) => petPrompt(s, i)) }); } });
      expect(String(asked[0]!.pictureStyle)).toMatch(/^Pick ONE of these picture styles/);
      // No pick at first: sent back to name one.
      expect(String(asked[1]!.problemsJson)).toContain('The theme needs its pictureStyle');
      const row = listPlanSeo(plan)[0]!;
      expect(row.images_status).toBe('done');
      expect(JSON.parse(row.picture_style)).toEqual(styles[1]);
      expect(JSON.parse(row.images_json).theme.pictureStyle).toBe('Park & Trail Walks');
      // Made again: only the kept style, followed as it is.
      requeueImages(row.id);
      await kickSeoWriter({ suggest: async () => [], ask: async (_n, vars) => { asked.push(vars); return JSON.stringify({ theme: petTheme, images: slots.map((s, i) => petPrompt(s, i)) }); } });
      expect(asked.at(-1)!.pictureStyle).toBe('Out on a walk in a park.');
      expect(JSON.parse(listPlanSeo(plan)[0]!.picture_style)).toEqual(styles[1]);
    } finally {
      closeDatabase();
    }
  });
});
