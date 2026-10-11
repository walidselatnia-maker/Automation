import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { registerImageModelRoutes } from '../src/newsite/image-model.js';

const KEY = randomBytes(32);

describe('New dashboard: image model page', () => {
  let settings: Settings;

  const app = async () => {
    const a = Fastify();
    await a.register(formbody);
    registerImageModelRoutes(a, {
      settings,
      readFlash: () => null,
      fetchImpl: (async () =>
        new Response(JSON.stringify({
          discovered: false,
          models: [
            { key: 'NANO_BANANA_PRO', label: 'Nano Banana Pro', wire: 'GEM_PIX_2', discovered: false, outcome: 'refused', at: null, error: 'USER_QUOTA_REACHED' },
            { key: 'NANO_BANANA_2_1', label: 'Nano Banana 2.1', wire: 'BELUGA', discovered: false, outcome: 'accepted', at: null, error: null },
          ],
        }))) as unknown as typeof fetch,
    });
    return a;
  };

  beforeEach(() => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
  });
  afterEach(() => closeDatabase());

  it('shows a card per model, the one in use marked, and what Google last said', async () => {
    const res = await (await app()).inject({ url: '/new-website/image-model' });
    expect(res.statusCode).toBe(200);
    for (const label of ['Automatic', 'Nano Banana Pro', 'Nano Banana 2.1', 'Nano Banana 2 Lite']) expect(res.body).toContain(label);
    expect(res.body).toMatch(/im-card on[^>]*value="auto"/);
    expect(res.body).toContain('Refused by Google');
    expect(res.body).toContain('Working');
    for (const wire of ['GEM_PIX_2', 'BELUGA', 'HARBOR_SEAL']) expect(res.body).toContain(wire);
  });

  it('saves the picked model for the whole platform', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/new-website/image-model', payload: 'image_model=NANO_BANANA_2_1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(res.statusCode).toBe(303);
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
