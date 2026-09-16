import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import {
  insertFbToken,
  insertKeyword,
  insertPresenter,
  listPresenters,
  presenterForPage,
  upsertFbPage,
} from '../src/db/repos.js';
import { idFromFlowUrl } from '../src/reels/ids.js';
import { Settings } from '../src/settings.js';
import { buildServer } from '../src/web/server.js';
import { setLogLevel } from '../src/lib/logger.js';

/**
 * A presenter is made from two ids pasted off Flow's address bar, named
 * here, and picked per Facebook page.
 */

const KEY = randomBytes(32);
const PASSWORD = 'correct-horse-battery-staple';
const CHARACTER = 'f346cb5a-ec29-4143-a87d-b13d70729bf5';
const VOICE = '509a1ad4-e08a-4a9d-87ba-afc4af20a0c1';

describe('a Flow id pasted by hand', () => {
  it('takes a bare id, or the id off the end of the character page url', () => {
    expect(idFromFlowUrl(CHARACTER)).toBe(CHARACTER);
    expect(
      idFromFlowUrl(`https://flow.google.com/u/4/project/559dd649-1000-4947-aaa5-e08ae6515705/character/${CHARACTER}`),
    ).toBe(CHARACTER);
    expect(idFromFlowUrl(`  ${CHARACTER.toUpperCase()}/ `)).toBe(CHARACTER);
  });

  it('refuses anything that is not an id', () => {
    expect(() => idFromFlowUrl('Rima')).toThrow(/address bar/);
  });
});

describe('presenters', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    setLogLevel('error');
    openDatabase(':memory:');
    app = buildServer(new Settings(KEY), KEY, { password: PASSWORD, secret: KEY, generated: false });
    await app.ready();
    const login = await app.inject({
      method: 'POST',
      url: '/login',
      payload: new URLSearchParams({ password: PASSWORD }).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const header = login.headers['set-cookie'];
    cookie = Array.isArray(header) ? header[0]! : String(header);
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  const get = (url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (url: string, fields: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    });

  it('adds one from pasted ids and lists it', async () => {
    await post('/settings/presenters', {
      name: 'Rima',
      character: `https://flow.google.com/u/4/project/p/character/${CHARACTER}`,
      voice: VOICE,
      voice_description: 'warm',
    });
    expect(listPresenters()[0]).toMatchObject({
      name: 'Rima', flow_character_id: CHARACTER, flow_voice_id: VOICE, voice_description: 'warm',
    });
    expect((await get('/settings/presenters')).body).toContain('Rima');
  });

  it('refuses a character that is not an id, and says where to find one', async () => {
    const r = await post('/settings/presenters', { name: 'Rima', character: 'rima', voice: '', voice_description: '' });
    expect(decodeURIComponent(String(r.headers.location))).toMatch(/address bar/);
    expect(listPresenters()).toEqual([]);
  });

  it('lets a Facebook page pick a presenter, and forget it when the presenter goes', async () => {
    const tokenId = insertFbToken('App', 'tok', KEY);
    const pageId = upsertFbPage({ pageId: '1', name: 'Page', tokenId });
    insertKeyword({ seed_keyword: 'soup' });
    const presenterId = insertPresenter({ name: 'Rima', flowCharacterId: CHARACTER, flowVoiceId: '',
      voiceDescription: '', portraitUrl: '' });

    await post(`/settings/facebook/pages/${pageId}`, {
      niche: 'soup', enabled: 'on', autoPublish: 'on', presenter_id: String(presenterId),
    });
    expect(presenterForPage(pageId)?.name).toBe('Rima');
    expect((await get('/settings/facebook')).body).toMatch(/value="\d+"\s+selected>Rima/);

    await post(`/settings/presenters/${presenterId}/delete`, {});
    expect(presenterForPage(pageId)).toBeUndefined();
  });
});
