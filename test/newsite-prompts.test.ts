import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { getPromptOverride, listPromptVersions } from '../src/db/repos.js';
import { loadPrompt, readShippedPrompt } from '../src/pipeline/prompts.js';
import { Settings } from '../src/settings.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import { PROMPT_STAGES } from '../src/newsite/prompts-page.js';
import { designText, listPinDesigns, pickedPinDesigns } from '../src/newsite/pin-designs.js';

const KEY = randomBytes(32);
const FILE = 'seo-metadata.system.txt';

describe('Prompts page', () => {
  let app: FastifyInstance;
  const post = (url: string, fields: Record<string, string>) =>
    app.inject({ method: 'POST', url, payload: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

  beforeEach(async () => {
    openDatabase(':memory:');
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, { encryptionKey: KEY, settings: new Settings(KEY) });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  it('lists only prompts that ship with the platform, grouped by step, under Set up', async () => {
    for (const stage of PROMPT_STAGES) {
      for (const p of stage.prompts.filter((x) => !x.href)) {
        const files = p.template ? [`${p.key}.txt`] : [`${p.key}.system.txt`, `${p.key}.user.txt`];
        for (const f of files) expect(readShippedPrompt(f).trim(), f).not.toBe('');
      }
    }
    const page = (await app.inject({ method: 'GET', url: '/new-website/prompts' })).body;
    expect(page).toContain('<h2>Article</h2>');
    expect(page).toContain('href="/new-website/prompts/seo-metadata"');
    expect(page).toMatch(/Social channels<\/span>.*Prompts<\/span>.*Keywords &amp; articles<\/span>/s);
    expect(page).toContain('aria-current="page"><svg');
  });

  it('saves an edit that the next AI call reads, keeps the old text as a version, and goes back to the default', async () => {
    const shipped = readShippedPrompt(FILE);
    const user = readShippedPrompt('seo-metadata.user.txt');
    const saved = await post('/new-website/prompts/seo-metadata', { part0: 'Be brief.', part1: user });
    expect(saved.headers.location).toContain('ok=Saved');
    expect(getPromptOverride(FILE)).toBe('Be brief.');
    expect(getPromptOverride('seo-metadata.user.txt')).toBeUndefined();
    expect(loadPrompt('seo-metadata', {}).system).toBe('Be brief.');
    expect(listPromptVersions(FILE).map((v) => v.body)).toEqual([shipped]);

    const edit = (await app.inject({ method: 'GET', url: '/new-website/prompts/seo-metadata' })).body;
    expect(edit).toContain('Changed');
    expect(edit).toContain('Use the default');

    await post('/new-website/prompts/seo-metadata', { reset: '1' });
    expect(getPromptOverride(FILE)).toBeUndefined();
    expect(loadPrompt('seo-metadata', {}).system).toBe(shipped);

    const versionId = listPromptVersions(FILE)[0]!.id;
    await post('/new-website/prompts/seo-metadata/restore', { version: String(versionId) });
    expect(getPromptOverride(FILE)).toBe('Be brief.');
  });

  it('refuses an empty prompt and unknown names, and warns about words the step does not fill in', async () => {
    const empty = await post('/new-website/prompts/seo-metadata', { part0: ' ', part1: 'x' });
    expect(empty.body).toContain('is empty');
    expect(getPromptOverride(FILE)).toBeUndefined();

    const odd = await post('/new-website/prompts/seo-metadata', { part0: 'Write for {{nope}}.', part1: readShippedPrompt('seo-metadata.user.txt') });
    expect(decodeURIComponent(odd.headers.location as string)).toContain('{{nope}} is not one of the words');

    const missing = await app.inject({ method: 'GET', url: '/new-website/prompts/..%2Fpackage.json' });
    expect(missing.headers.location).toContain('/new-website/prompts?error=');
  });

  it('Pinterest pin designs: adds a design without touching the others, and picks which ones pins use', async () => {
    const list = (await app.inject({ method: 'GET', url: '/new-website/pin-designs' })).body;
    expect(list).toContain('<b>4 of 4</b>');
    expect(list).toContain('href="/new-website/pin-designs/new"');

    const before = listPinDesigns().map(designText);
    const bad = await post('/new-website/pin-designs/new', { name: 'Bold', text: 'A pin with {{title}}', picked: '1' });
    expect(bad.body).toContain('{{title}} is not one of the words');
    await post('/new-website/pin-designs/new', { name: 'Bold', text: 'A bold pin of {{scene}}, headline "{{headline}}".', picked: '1' });
    const designs = listPinDesigns();
    expect(designs).toHaveLength(5);
    expect(designs.slice(0, 4).map(designText)).toEqual(before);
    expect(designs[4]).toMatchObject({ name: 'Bold', picked: 1 });

    for (const id of [1, 2, 4]) await post(`/new-website/pin-designs/${id}/pick`, { picked: '0' });
    expect(pickedPinDesigns().map((d) => d.name)).toEqual(['Design 3', 'Bold']);
    await post('/new-website/pin-designs/3/pick', { picked: '0' });
    const last = await post(`/new-website/pin-designs/${designs[4]!.id}/pick`, { picked: '0' });
    expect(decodeURIComponent(last.headers.location as string)).toContain('at least one design');
    expect(pickedPinDesigns().map((d) => d.name)).toEqual(['Bold']);

    const shipped = await post('/new-website/pin-designs/1/remove', {});
    expect(decodeURIComponent(shipped.headers.location as string)).toContain('stay');
  });
});
