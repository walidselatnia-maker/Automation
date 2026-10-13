import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { imageModelCards, registerImageModelRoutes } from '../src/newsite/image-model.js';

const KEY = randomBytes(32);

describe('New dashboard: image model cards', () => {
  let settings: Settings;

  const app = async () => {
    const a = Fastify();
    await a.register(formbody);
    registerImageModelRoutes(a, settings);
    return a;
  };

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
  });
  afterEach(() => closeDatabase());

  it('shows a card per model, the one in use marked, and what Google last said', () => {
    const out = imageModelCards('auto', {
      discovered: false,
      models: [
        { key: 'NANO_BANANA_PRO', label: 'Nano Banana Pro', wire: 'GEM_PIX_2', discovered: false, outcome: 'refused', at: null, error: 'USER_QUOTA_REACHED' },
        { key: 'NANO_BANANA_2_1', label: 'Nano Banana 2.1', wire: 'BELUGA', discovered: false, outcome: 'accepted', at: null, error: null },
      ],
    } as never).value;
    for (const label of ['Automatic', 'Nano Banana Pro', 'Nano Banana 2.1', 'Nano Banana 2 Lite']) expect(out).toContain(label);
    expect(out).toMatch(/im-card on[^>]*value="auto"/);
    expect(out).toContain('Refused by Google');
    expect(out).toContain('Working');
    for (const wire of ['GEM_PIX_2', 'BELUGA', 'HARBOR_SEAL']) expect(out).toContain(wire);
  });

  it('has no page of its own any more: the old address goes to Platform settings', async () => {
    const res = await (await app()).inject({ url: '/new-website/image-model' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/new-website/platform#images');
  });

  it('saves the picked model for the whole platform', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/new-website/image-model', payload: 'image_model=NANO_BANANA_2_1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toMatch(/^\/new-website\/platform\?ok=/);
    expect(settings.get('image_model')).toBe('NANO_BANANA_2_1');
    const bad = await a.inject({ method: 'POST', url: '/new-website/image-model', payload: 'image_model=NARWHAL', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(bad.headers.location).toMatch(/error=/);
    expect(settings.get('image_model')).toBe('NANO_BANANA_2_1');
  });

  it('reads a pick saved as Nano Banana 2 as 2.1', () => {
    settings.set('image_model', 'NANO_BANANA_2');
    expect(settings.get('image_model')).toBe('NANO_BANANA_2_1');
  });
});
