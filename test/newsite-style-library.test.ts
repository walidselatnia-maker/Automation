import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { closeDatabase, getDb, openDatabase } from '../src/db/index.js';
import { MIGRATIONS } from '../src/db/migrations.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import { createNewWebsite, getNewWebsite } from '../src/newsite/repo.js';
import { colorStylesOf } from '../src/newsite/color-styles.js';
import { validate } from '../src/newsite/validate.js';
import { COLOR_LIBRARY, NICHE_PICTURE_STYLES, PICTURE_LIBRARY, pictureStylesOf, styleGroups } from '../src/newsite/style-library.js';
import { styleDropdown } from '../src/newsite/view.js';
import { pictureStyleFor } from '../src/newsite/images.js';

const KEY = randomBytes(32);

describe('Style libraries', () => {
  it('has every niche colour style once, by name, with its first description', () => {
    const names = [...COLOR_LIBRARY.values()].map((s) => s.name);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    expect(COLOR_LIBRARY.get('clean & bright')).toEqual({ name: 'Clean & Bright', description: 'Bright neutral tones, soft daylight, minimal shadows' });
    for (const n of ['Golden Hour', 'Pastel Cottagecore', 'Natural Workshop', 'Luxury Handmade']) expect(COLOR_LIBRARY.has(n.toLowerCase())).toBe(true);
  });

  it('has picture styles for each niche, the recipes ones where the food is shot', () => {
    expect(NICHE_PICTURE_STYLES.recipes.map((s) => s.name)).toEqual([
      'Rustic Wooden Table', 'Marble Kitchen Counter', 'Bright Overhead Flat Lay', 'Cozy Home Kitchen', 'Outdoor Picnic', 'Dark Moody Table',
    ]);
    for (const g of ['pets', 'travel', 'home', 'diy', 'crochet'] as const) expect(NICHE_PICTURE_STYLES[g].length).toBeGreaterThanOrEqual(5);
    expect(PICTURE_LIBRARY.size).toBe(Object.values(NICHE_PICTURE_STYLES).flat().length);
  });

  it('groups the library by niche for the dropdowns, each style once', () => {
    expect(styleGroups('color').map((g) => g.label).slice(0, 6)).toEqual(['Recipes', 'Pets', 'Travel', 'Home & Garden', 'DIY', 'Crochet']);
    expect(styleGroups('picture').map((g) => g.label)).not.toContain('Other');
    const all = styleGroups('color').flatMap((g) => g.styles.map((s) => s.name.toLowerCase()));
    expect(new Set(all).size).toBe(all.length);
    const page = String(styleDropdown('color', 'colorStyles'));
    expect(page).toContain('data-add-to="colorStyles"');
    expect(page).toContain('<optgroup label="Crochet">');
    expect(page).toContain('value="Clean &amp; Bright — Bright neutral tones, soft daylight, minimal shadows"');
    expect(page.match(/value="Clean &amp; Bright/g)).toHaveLength(1);
  });

  it('reads the Picture style field: one direction as it is, several named lines as styles', () => {
    expect(pictureStylesOf({ picture_style: '' })).toEqual([]);
    expect(pictureStylesOf({ picture_style: 'Cats at home only.' })).toEqual([{ name: 'Own style', description: 'Cats at home only.' }]);
    expect(pictureStylesOf({ picture_style: 'Beach Dogs — Dogs on the sand' })).toEqual([{ name: 'Own style', description: 'Beach Dogs — Dogs on the sand' }]);
    expect(pictureStylesOf({ picture_style: 'Beach Dogs — Dogs on the sand at sunset\nJust a sentence with no name\n' })).toEqual([
      { name: 'Beach Dogs', description: 'Dogs on the sand at sunset' },
      { name: 'Own style', description: 'Just a sentence with no name' },
    ]);
    // Lines with no names at all stay one direction.
    expect(pictureStylesOf({ picture_style: 'Dogs at home.\nNever on a table.' })).toHaveLength(1);
  });

  it('saves the fields as typed text', () => {
    const v = validate({ colorStyles: 'Golden Hour — Warm light\nMine — My own look', pictureStyle: ' Rustic Wooden Table — On wood \n\nOutdoor Picnic — Outside ' }, ['colorStyles', 'pictureStyle']);
    expect(v.errors).toEqual({});
    expect(colorStylesOf({ niche: 'Recipes', color_styles: v.clean.colorStyles }).map((s) => s.name)).toEqual(['Golden Hour', 'Mine']);
    expect(v.clean.pictureStyle).toBe('Rustic Wooden Table — On wood\nOutdoor Picnic — Outside');
    expect(validate({ pictureStyle: '' }, ['pictureStyle']).clean.pictureStyle).toBe('');
    expect(validate({ pictureStyle: 'Bad <b>' }, ['pictureStyle']).errors.pictureStyle).toMatch(/plain text/);
  });

  it('asks the AI to pick one picture style when there are several, and follows one as it is', () => {
    const two = ['Rustic Wooden Table', 'Outdoor Picnic'].map((n) => { const s = PICTURE_LIBRARY.get(n.toLowerCase())!; return `${s.name} — ${s.description}`; }).join('\n');
    const direction = pictureStyleFor({ niche: 'Recipes', picture_style: two }, true);
    expect(direction).toMatch(/^Pick ONE of these picture styles/);
    expect(direction).toContain('Outdoor Picnic');
    expect(pictureStyleFor({ niche: 'Pets', picture_style: 'Cats at home only.' }, false)).toBe('Cats at home only.');
  });

  it('turns a picture style saved as a JSON list back into the field’s text', () => {
    openDatabase(':memory:');
    try {
      const db = getDb();
      const id = createNewWebsite(
        {
          name: 'P', domain: 'p.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Pets', nicheContext: '', persona: 'Storyteller', status: 'active',
          autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '', pictureStyle: '',
        },
        KEY,
      );
      const migrate = MIGRATIONS.find((m) => m.id === '057-newsite-picture-style-text')!;
      const set = (v: string) => db.prepare('UPDATE new_websites SET picture_style = ? WHERE id = ?').run(v, id);
      set(JSON.stringify([{ name: 'Own style', description: 'Cats at home only.' }]));
      migrate.up(db);
      expect(getNewWebsite(id)!.picture_style).toBe('Cats at home only.');
      set(JSON.stringify([{ name: 'Cozy Living Room', description: 'On the sofa' }, { name: 'Mine', description: '' }]));
      migrate.up(db);
      expect(getNewWebsite(id)!.picture_style).toBe('Cozy Living Room — On the sofa\nMine');
    } finally {
      closeDatabase();
    }
  });
});

describe('Style fields on the Niche step', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    openDatabase(':memory:');
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, { encryptionKey: KEY, isPlatformReady: () => true, checkSite: async () => ({ ok: true, siteName: 'S', types: ['article'] }) });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  it('shows the saved text in the fields, each with its dropdown', async () => {
    const id = createNewWebsite(
      {
        name: 'Pets', domain: 'p.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Pets', nicheContext: '', persona: 'Storyteller', status: 'active',
        autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '', pictureStyle: 'Cats at home only.',
      },
      KEY,
    );
    const r = await app.inject({ method: 'GET', url: `/new-website/${id}/edit?section=1` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('>Cats at home only.</textarea>');
    expect(r.body).toContain('Natural &amp; Documentary — ');
    expect(r.body).toContain('data-add-to="pictureStyle"');
    expect(r.body).toContain('data-add-to="colorStyles"');
    expect(r.body).not.toContain('wz-chip');
  });
});
