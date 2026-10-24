import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import { createNewWebsite, getNewWebsite, listNewWebsites } from '../src/newsite/repo.js';
import { colorStylesOf } from '../src/newsite/color-styles.js';
import { validate } from '../src/newsite/validate.js';
import {
  COLOR_LIBRARY,
  NICHE_PICTURE_STYLES,
  PICTURE_LIBRARY,
  defaultPicks,
  joinPicks,
  parseOwnPictureStyles,
  pictureStylesOf,
  splitSaved,
  styleGroups,
} from '../src/newsite/style-library.js';
import { stylePicker } from '../src/newsite/view.js';
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

  it('shows the website’s niche group first and starts a new website on its two main styles', () => {
    expect(styleGroups('color', 'Crochet patterns').map((g) => g.label)).toEqual(['Crochet', 'Recipes', 'Pets', 'Travel', 'Home & Garden', 'DIY', 'Other']);
    expect(styleGroups('picture', 'Dog training')[0]!.label).toBe('Pets');
    expect(styleGroups('picture', 'Education').map((g) => g.label)).not.toContain('Other');
    expect(defaultPicks('color', 'Travel')).toEqual(['Golden Hour', 'Natural Documentary']);
    expect(defaultPicks('picture', 'Easy recipes')).toEqual(['Rustic Wooden Table', 'Marble Kitchen Counter']);
    expect(defaultPicks('picture', 'Education')).toEqual([]);
  });

  it('keeps a saved list: library names ticked, unknown ones as the website’s own', () => {
    const saved = [{ name: 'golden hour', description: 'x' }, { name: 'Mine', description: 'My own look' }];
    expect(splitSaved('color', saved)).toEqual({ picked: ['Golden Hour'], own: [{ name: 'Mine', description: 'My own look' }] });
    expect(joinPicks('color', ['Golden Hour', 'Nope', 'golden hour'], [{ name: 'Mine', description: 'd' }, { name: 'GOLDEN HOUR', description: 'again' }]).map((s) => s.name)).toEqual(['Golden Hour', 'Mine']);
    // Before the library: one typed direction, kept as the website's own style.
    expect(pictureStylesOf({ picture_style: 'Cats at home only.' })).toEqual([{ name: 'Own style', description: 'Cats at home only.' }]);
    expect(pictureStylesOf({ picture_style: '' })).toEqual([]);
    expect(parseOwnPictureStyles('Beach Dogs — Dogs on the sand at sunset\nJust a sentence with no name\n')).toEqual([
      { name: 'Beach Dogs', description: 'Dogs on the sand at sunset' },
      { name: 'Own style', description: 'Just a sentence with no name' },
    ]);
  });

  it('saves the ticked styles and the own lines', () => {
    const v = validate({ colorPick: ['Golden Hour', 'Cool Alpine'], colorStyles: 'Mine — My own look', picturePick: 'Rustic Wooden Table', pictureStyle: '' }, ['colorStyles', 'pictureStyle']);
    expect(v.errors).toEqual({});
    expect(colorStylesOf({ niche: 'Recipes', color_styles: v.clean.colorStyles }).map((s) => s.name)).toEqual(['Golden Hour', 'Cool Alpine', 'Mine']);
    expect(pictureStylesOf({ picture_style: v.clean.pictureStyle })).toEqual([PICTURE_LIBRARY.get('rustic wooden table')]);
    // Nothing ticked: the niche decides, as before.
    expect(validate({ pictureStyle: '' }, ['pictureStyle']).clean.pictureStyle).toBe('');
    expect(validate({ pictureStyle: 'Bad <b>' }, ['pictureStyle']).errors.pictureStyle).toMatch(/plain text/);
  });

  it('asks the AI to pick one picture style when there are several, and follows one as it is', () => {
    const two = JSON.stringify(joinPicks('picture', ['Rustic Wooden Table', 'Outdoor Picnic'], []));
    const direction = pictureStyleFor({ niche: 'Recipes', picture_style: two }, true);
    expect(direction).toMatch(/^Pick ONE of these picture styles/);
    expect(direction).toContain('Outdoor Picnic');
    expect(pictureStyleFor({ niche: 'Recipes', picture_style: JSON.stringify(joinPicks('picture', ['Outdoor Picnic'], [])) }, true)).toBe(PICTURE_LIBRARY.get('outdoor picnic')!.description);
  });

  it('renders the library as ticks, grouped, each style once', () => {
    const page = String(stylePicker('color', 'Colour styles', 'Crochet', null));
    expect(page.indexOf('data-group="crochet"')).toBeLessThan(page.indexOf('data-group="recipes"'));
    expect(page.match(/value="Clean &amp; Bright"/g)).toHaveLength(1);
    expect(page).toMatch(/value="Soft &amp; Dreamy" checked/);
    expect(page).toMatch(/value="Warm &amp; Cozy" checked/);
    expect(page).not.toMatch(/value="Golden Hour" checked/);
    const saved = String(stylePicker('color', 'Colour styles', 'Travel', [{ name: 'Cool Alpine', description: '' }, { name: 'Mine', description: 'My look' }]));
    expect(saved).toMatch(/value="Cool Alpine" checked/);
    expect(saved).not.toMatch(/value="Golden Hour" checked/);
    expect(saved).toContain('Mine — My look</textarea>');
  });
});

describe('Style library routes', () => {
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

  it('gives the groups and the main styles for a niche as it is typed', async () => {
    const r = await app.inject({ method: 'GET', url: '/new-website/styles?niche=Dog%20training' });
    const body = r.json() as { color: { groups: { label: string }[]; defaults: string[] }; picture: { defaults: string[] } };
    expect(body.color.groups[0]!.label).toBe('Pets');
    expect(body.color.defaults).toEqual(['Natural & Documentary', 'Warm & Cozy']);
    expect(body.picture.defaults).toEqual(['Cozy Living Room', 'Garden & Backyard']);
  });

  it('shows a saved website’s styles ticked on its Niche step', async () => {
    const id = createNewWebsite(
      {
        name: 'Pets', domain: 'p.example.com', apiKey: 'sk_test_ABCDEFGHIJKLMNOP', niche: 'Pets', nicheContext: '', persona: 'Storyteller', status: 'active',
        autoPublish: true, dailyTarget: 3, intervalMinutes: 480, bufferToken: '', pinUsername: '', projectId: '', pictureStyle: 'Cats at home only.',
      },
      KEY,
    );
    expect(getNewWebsite(id)).toBeTruthy();
    const r = await app.inject({ method: 'GET', url: `/new-website/${id}/edit?section=1` });
    expect(r.statusCode).toBe(200);
    // No list of its own: the niche's list, all ticked.
    expect(r.body).toMatch(/value="Natural &amp; Documentary" checked/);
    expect(r.body).toMatch(/value="Cinematic &amp; Emotional" checked/);
    // The typed picture direction is kept as its own style.
    expect(r.body).toContain('Own style — Cats at home only.</textarea>');
    expect(listNewWebsites()).toHaveLength(1);
  });
});
