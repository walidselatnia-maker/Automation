import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { closeDatabase, openDatabase, run } from '../src/db/index.js';
import { Settings } from '../src/settings.js';
import { registerNewWebsiteRoutes } from '../src/newsite/routes.js';
import {
  accountTrouble,
  addGoogleAccount,
  GOOGLE_ACCOUNT_BLOCKED_COOLDOWN_MS,
  GOOGLE_ACCOUNT_COOLDOWN_MS,
  listGoogleAccounts,
  needsProject,
  NO_WORKING_ACCOUNT,
  noWorkingAccount,
  withGoogleAccount,
} from '../src/newsite/google-accounts.js';

const KEY = randomBytes(32);
const P2 = 'https://flow.google.com/u/1/project/22222222-2222-4222-8222-222222222222';
const P3 = 'https://flow.google.com/u/2/project/33333333-3333-4333-8333-333333333333';

describe('Google accounts: Flow jobs move to the next working account', () => {
  beforeEach(() => {
    openDatabase(':memory:');
  });
  afterEach(() => closeDatabase());

  it('starts with the account already signed in, which keeps the websites’ own projects', async () => {
    const accounts = listGoogleAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ email: '', flow_project: '', status: 'working' });
    const used: string[] = [];
    await withGoogleAccount('site-project', async (p) => used.push(p));
    expect(used).toEqual(['site-project']);
    expect(listGoogleAccounts()[0]!.last_used_at).toBeTruthy();
  });

  it('retries the same job on the next account when one is limited or signed out', async () => {
    addGoogleAccount('two@gmail.com', P2);
    addGoogleAccount('three@gmail.com', P3);
    const used: string[] = [];
    const errors = ['RESOURCE_EXHAUSTED', 'Image job x failed with status FAILED: SESSION_EXPIRED'];
    const result = await withGoogleAccount('site-project', async (p) => {
      used.push(p);
      const e = errors.shift();
      if (e) throw new Error(e);
      return 'made';
    });
    expect(result).toBe('made');
    expect(used).toEqual(['site-project', P2, P3]);
    const [one, two, three] = listGoogleAccounts();
    expect(one).toMatchObject({ status: 'limited', last_error: 'RESOURCE_EXHAUSTED' });
    expect(two).toMatchObject({ status: 'signed_out' });
    expect(two!.retry_at).toBeGreaterThan(0); // rests like the others, then is tried again
    expect(three).toMatchObject({ status: 'working' });
    expect(three!.last_used_at).toBeTruthy();
  });

  it('stops on unusual activity instead of moving to the next account, and rests the flagged one an hour', async () => {
    run(`DELETE FROM google_accounts`);
    addGoogleAccount('one@gmail.com', P2);
    addGoogleAccount('two@gmail.com', P3);
    const now = 1_000_000;
    const used: string[] = [];
    await expect(withGoogleAccount('x', async (p) => {
      used.push(p);
      throw new Error('PUBLIC_ERROR_UNUSUAL_ACTIVITY');
    }, () => now)).rejects.toThrow('UNUSUAL_ACTIVITY');
    expect(used).toEqual([P2]);
    expect(listGoogleAccounts()[0]).toMatchObject({ status: 'blocked', retry_at: now + GOOGLE_ACCOUNT_BLOCKED_COOLDOWN_MS });
    expect(listGoogleAccounts()[1]).toMatchObject({ status: 'working' });
  });

  it('marks an account out of credits, rests it, and uses it again after the cooldown', async () => {
    run(`DELETE FROM google_accounts`);
    addGoogleAccount('one@gmail.com', P2);
    addGoogleAccount('two@gmail.com', P3);
    let now = 1_000_000;
    const used: string[] = [];
    await withGoogleAccount('x', async (p) => {
      used.push(p);
      if (p === P2) throw new Error('PUBLIC_ERROR_USER_QUOTA_REACHED: This Google account has no video credits left on Flow.');
    }, () => now);
    expect(listGoogleAccounts()[0]).toMatchObject({ status: 'limited', credits: '0', retry_at: now + GOOGLE_ACCOUNT_COOLDOWN_MS });

    used.length = 0;
    await withGoogleAccount('x', async (p) => used.push(p), () => now);
    expect(used).toEqual([P3]);

    now += GOOGLE_ACCOUNT_COOLDOWN_MS;
    used.length = 0;
    await withGoogleAccount('x', async (p) => used.push(p), () => now);
    expect(used).toEqual([P2]);
    expect(listGoogleAccounts()[0]).toMatchObject({ status: 'working', credits: '' });
  });

  it('does not move on for an error that is not about the account', async () => {
    addGoogleAccount('two@gmail.com', P2);
    const used: string[] = [];
    await expect(withGoogleAccount('x', async (p) => {
      used.push(p);
      throw new Error('policy: the prompt was refused');
    })).rejects.toThrow('policy');
    expect(used).toEqual(['x']);
    expect(listGoogleAccounts()[0]).toMatchObject({ status: 'working', last_error: 'policy: the prompt was refused' });
  });

  it('gives Google’s own error when every account failed, then says no account works', async () => {
    await expect(withGoogleAccount('x', async () => {
      throw new Error('RESOURCE_EXHAUSTED');
    })).rejects.toThrow('RESOURCE_EXHAUSTED');
    expect(noWorkingAccount()).toBe(true);
    let called = false;
    await expect(withGoogleAccount('x', async () => {
      called = true;
    })).rejects.toThrow(NO_WORKING_ACCOUNT);
    expect(called).toBe(false);
  });

  it('marks an account only on Google’s own error codes, never on loose wording', () => {
    expect(accountTrouble('Flow answered HTTP 401: UNAUTHENTICATED')).toBe('signed_out');
    expect(accountTrouble('Image job x failed with status FAILED: SESSION_EXPIRED')).toBe('signed_out');
    expect(accountTrouble('PUBLIC_ERROR_UNUSUAL_ACTIVITY')).toBe('blocked');
    expect(accountTrouble('PUBLIC_ERROR_USER_QUOTA_REACHED')).toBe('limited');
    expect(accountTrouble('RESOURCE_EXHAUSTED')).toBe('limited');
    expect(accountTrouble('FLOW_UI_ERROR: PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED: Google refused the picture')).toBe('limited');
    // Not codes: a failed picture, and the account is left as it is.
    for (const words of ['HTTP 403: reCAPTCHA evaluation failed', 'please sign in again', 'HTTP 401', 'daily quota', 'rate limit 429',
      'FLOW_UI_ERROR: unusual activity', 'the composer took the prompt but no image appeared in 300s']) {
      expect(accountTrouble(words)).toBeNull();
    }
  });

  it('skips a later account with no Flow project address, since it would only repeat the first', async () => {
    const extra = addGoogleAccount('two@gmail.com', '');
    addGoogleAccount('three@gmail.com', P3);
    const accounts = listGoogleAccounts();
    expect(needsProject(accounts[0]!, accounts)).toBe(false);
    expect(needsProject(accounts.find((a) => a.id === extra)!, accounts)).toBe(true);
    const used: string[] = [];
    await withGoogleAccount('site-project', async (p) => {
      used.push(p);
      if (used.length === 1) throw new Error('RESOURCE_EXHAUSTED');
    });
    expect(used).toEqual(['site-project', P3]);
  });
});

describe('Google accounts: Platform settings and the dashboard', () => {
  let app: FastifyInstance;
  let settings: Settings;
  let calls: { url: string; body?: string }[];

  const post = (url: string, fields: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      payload: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

  beforeEach(async () => {
    openDatabase(':memory:');
    settings = new Settings(KEY);
    settings.set('image_base_url', 'http://imagegen:8100');
    calls = [];
    app = Fastify();
    await app.register(formbody);
    registerNewWebsiteRoutes(app, {
      encryptionKey: KEY,
      settings,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body as string | undefined });
        if (String(url).endsWith('/flow/sign-in')) return new Response('{"ok":true}', { status: 200 });
        return new Response('{}', { status: 503 });
      }) as unknown as typeof fetch,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
  });

  it('lists the accounts in a plain table', async () => {
    const page = await app.inject({ method: 'GET', url: '/new-website/platform' });
    expect(page.body).toContain('id="google-accounts"');
    expect(page.body).toContain('<th>#</th><th>Email</th><th>Status</th><th>Credits left</th><th>Last used</th><th>Last error</th>');
    expect(page.body).toContain('Current account');
    expect(page.body).toContain('Add account');
  });

  it('adds, changes, orders and removes accounts', async () => {
    expect((await post('/new-website/platform/google-accounts/add', { email: 'nope', flow_project: '' })).body).toContain('Enter the Google email address.');
    expect((await post('/new-website/platform/google-accounts/add', { email: 'two@gmail.com', flow_project: 'https://example.com/x' })).body).toContain('Paste the project address from Flow');
    const added = await post('/new-website/platform/google-accounts/add', { email: 'two@gmail.com', flow_project: P2 });
    expect(added.statusCode).toBe(303);
    expect((await post('/new-website/platform/google-accounts/add', { email: 'TWO@gmail.com', flow_project: '' })).body).toContain('already in the list');

    const [first, second] = listGoogleAccounts();
    await post(`/new-website/platform/google-accounts/${second!.id}/up`);
    expect(listGoogleAccounts().map((a) => a.email)).toEqual(['two@gmail.com', '']);
    await post(`/new-website/platform/google-accounts/${second!.id}/down`);
    expect(listGoogleAccounts().map((a) => a.email)).toEqual(['', 'two@gmail.com']);

    await post(`/new-website/platform/google-accounts/${first!.id}/change`, { email: 'one@gmail.com', flow_project: '' });
    expect(listGoogleAccounts()[0]).toMatchObject({ email: 'one@gmail.com', flow_project: '' });

    await post(`/new-website/platform/google-accounts/${first!.id}/remove`);
    expect(listGoogleAccounts().map((a) => a.email)).toEqual(['two@gmail.com']);
  });

  it('Sign in asks the image service to open Google’s sign-in for that email, then shows the Browser page', async () => {
    addGoogleAccount('two@gmail.com', P2);
    const two = listGoogleAccounts()[1]!;
    run(`UPDATE google_accounts SET status = 'signed_out' WHERE id = ?`, two.id);
    const res = await post(`/new-website/platform/google-accounts/${two.id}/sign-in`);
    expect(res.headers.location).toBe('/browser');
    expect(calls.at(-1)).toEqual({ url: 'http://imagegen:8100/flow/sign-in', body: JSON.stringify({ email: 'two@gmail.com' }) });
    expect(listGoogleAccounts()[1]!.status).toBe('working');
  });

  it('shows one line on the dashboard only when no account works', async () => {
    const before = await app.inject({ method: 'GET', url: '/new-website/dashboard' });
    expect(before.body).not.toContain(NO_WORKING_ACCOUNT);
    run(`UPDATE google_accounts SET status = 'signed_out', retry_at = ${Date.now() + 60_000}`);
    const after = await app.inject({ method: 'GET', url: '/new-website/dashboard' });
    expect(after.body).toContain(NO_WORKING_ACCOUNT);
  });
});
