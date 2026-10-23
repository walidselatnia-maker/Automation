import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { all, closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { createNewWebsite, getNewWebsite, saveKeywordPlan } from '../src/newsite/repo.js';
import { listPlanSeo, queuePlanSeo } from '../src/newsite/seo.js';
import { kickPictureMaker, resetPictureMakerState } from '../src/newsite/pictures.js';
import { validate } from '../src/newsite/validate.js';
import { COLOR_RULE, NICHE_COLOR_STYLES, colorStylesOf, nicheGroup, parseColorStyles } from '../src/newsite/color-styles.js';

const KEY = randomBytes(32);

describe('Colour styles', () => {
  it('seeds each niche with its list, the main style first and the second one next', () => {
    const main = (niche: string) => colorStylesOf({ niche }).slice(0, 2).map((s) => s.name);
    expect(main('Recipes')).toEqual(['Warm & Appetizing', 'Clean & Bright']);
    expect(main('Easy dinner recipes')).toEqual(['Warm & Appetizing', 'Clean & Bright']);
    expect(main('Pets')).toEqual(['Natural & Documentary', 'Warm & Cozy']);
    expect(main('Dog training')).toEqual(['Natural & Documentary', 'Warm & Cozy']);
    expect(main('Travel')).toEqual(['Golden Hour', 'Natural Documentary']);
    expect(main('Home & Garden')).toEqual(['Clean & Airy', 'Warm & Cozy']);
    expect(main('DIY')).toEqual(['Clean & Bright', 'Natural Workshop']);
    expect(main('Crochet patterns')).toEqual(['Soft & Dreamy', 'Warm & Cozy']);
    expect(nicheGroup('Education')).toBe('other');
    expect(NICHE_COLOR_STYLES.travel).toHaveLength(7);
    expect(NICHE_COLOR_STYLES.recipes![2]).toEqual({ name: 'Luxury & Elegant', description: 'Deep shadows, warm highlights, rich contrast' });
  });

  it('reads the list as typed, one per line, and the website\'s own list replaces the niche\'s', () => {
    expect(parseColorStyles('Golden Hour — Warm amber light\n\nMoody: dark shadows\nPlain\ngolden hour - again')).toEqual([
      { name: 'Golden Hour', description: 'Warm amber light' },
      { name: 'Moody', description: 'dark shadows' },
      { name: 'Plain', description: '' },
    ]);
    const typed = validate({ colorStyles: 'Mine — My own look\nSecond — Another' }, ['colorStyles']);
    expect(typed.errors).toEqual({});
    const own = typed.clean.colorStyles!;
    expect(colorStylesOf({ niche: 'Pets', color_styles: own }).map((s) => s.name)).toEqual(['Mine', 'Second']);
    expect(validate({ colorStyles: '' }, ['colorStyles']).clean.colorStyles).toBe('');
    expect(validate({ colorStyles: 'Bad <b>' }, ['colorStyles']).errors.colorStyles).toMatch(/plain text/);
  });

  describe('every picture of an article', () => {
    let dataDir: string;
    let settings: Settings;
    let seoId: number;

    beforeEach(() => {
      openDatabase(':memory:');
      resetPictureMakerState();
      dataDir = mkdtempSync(join(tmpdir(), 'colors-'));
      settings = new Settings(KEY);
      settings.set('image_gap_seconds', '0');
      const site = createNewWebsite(
        {
          name: 'Pets', domain: 'p.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Pets', nicheContext: '', persona: 'Storyteller',
          status: 'active', autoPublish: true, dailyTarget: 0, intervalMinutes: 60, bufferToken: '', pinUsername: '', projectId: '',
          colorStyles: JSON.stringify(parseColorStyles('Warm & Cozy — Warm highlights, soft shadows\nCool Blue — Cold tones')),
        },
        KEY,
      );
      expect(getNewWebsite(site)!.color_styles).toContain('Cool Blue');
      const plan = saveKeywordPlan(site, 'dog brushing', [], 'article');
      queuePlanSeo(plan, 'dog brushing', [], 'article');
      seoId = listPlanSeo(plan)[0]!.id;
      const images = { theme: {}, images: [{ slot: 'feature', prompt: 'FEATURE PROMPT', alt: 'a' }, { slot: 'step-1', prompt: 'STEP PROMPT', alt: 'b' }] };
      run(`UPDATE keyword_seo SET images_status = 'done', images_json = ?, color_style = ? WHERE id = ?`, JSON.stringify(images), JSON.stringify({ name: 'Cool Blue', description: 'Cold tones' }), seoId);
      for (const [slot, prompt] of [['feature', 'FEATURE PROMPT'], ['step-1', 'STEP PROMPT'], ['pin-1', 'PIN PROMPT']]) {
        run(`INSERT INTO newsite_pictures (seo_id, slot, position, prompt, alt, status, by_hand) VALUES (?, ?, 0, ?, '', 'queued', 1)`, seoId, slot, prompt);
      }
    });
    afterEach(() => {
      closeDatabase();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('main and step pictures get the article\'s one style and the colour rule; a pin keeps its own prompt', async () => {
      const sent: string[] = [];
      await kickPictureMaker({
        settings, dataDir, sleep: async () => {},
        make: async (prompt) => {
          sent.push(prompt);
          return { data: Buffer.from('img'), contentType: 'image/png' };
        },
      });
      const style = `Color grading: Cool Blue — Cold tones. ${COLOR_RULE}`;
      expect(sent).toContain(`FEATURE PROMPT ${style}`);
      expect(sent).toContain(`STEP PROMPT ${style}`);
      expect(sent).toContain('PIN PROMPT');
      // What is kept is the prompt as written: the style is added each time a picture is made.
      expect(all<{ prompt: string }>('SELECT prompt FROM newsite_pictures ORDER BY id').map((p) => p.prompt)).toEqual(['FEATURE PROMPT', 'STEP PROMPT', 'PIN PROMPT']);
    });
  });
});
