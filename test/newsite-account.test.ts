import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { closeDatabase, openDatabase } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import { passwordAccepted } from '../src/web/auth.js';

const KEY = randomBytes(32);
const auth = { password: 'generated-pass-123', secret: KEY, generated: true, encryptionKey: KEY };

describe('new dashboard: password and browser', () => {
  let app: FastifyInstance;
  const post = (fields: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/new-website/platform/password', payload: new URLSearchParams(fields).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

  beforeEach(async () => {
    openDatabase(':memory:');
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, {
      encryptionKey: KEY,
      settings: new Settings(KEY),
      account: { generated: auth.generated, accepts: (p) => passwordAccepted(p, auth) },
      fetchImpl: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  it('shows the generated password on Platform settings and the Browser link in the sidebar', async () => {
    const page = (await app.inject({ method: 'GET', url: '/new-website/platform' })).body;
    expect(page).toContain('Generated one');
    expect(page).toContain('href="/new-website/platform/password"');
    expect(page).toContain('href="/browser" target="_blank"');
  });

  it('changes the generated password to your own, only with the current one', async () => {
    expect((await post({ current: 'wrong', next: 'my-own-password', confirm: 'my-own-password' })).body).toContain('not the current password');
    expect((await post({ current: auth.password, next: 'short', confirm: 'short' })).body).toContain('at least 10');
    const ok = await post({ current: auth.password, next: 'my-own-password', confirm: 'my-own-password' });
    expect(ok.headers.location).toContain('Password%20changed');
    expect(passwordAccepted('my-own-password', auth)).toBe(true);
    expect(passwordAccepted(auth.password, auth)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/new-website/platform' })).body).toContain('Your own');
  });
});
