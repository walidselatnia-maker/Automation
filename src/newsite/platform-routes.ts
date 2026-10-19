import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deleteEndpoint, listEndpointRows, listEndpoints, upsertEndpoint } from '../llm/pool.js';
import type { Settings } from '../settings.js';
import { newLayout, type NewFlash } from './layout.js';
import {
  checkImageService,
  PLATFORM_STEPS,
  SETUP_DONE_KEY,
  testAiKey,
  testTelegram,
  validatePlatform,
  type Fetch,
  type PlatformContext,
} from './platform.js';
import { imageCatalogue } from './image-model.js';
import { automationBar } from './autopilot-view.js';
import { automationOn, automationOnAt } from './autopilot.js';
import { listNewWebsites } from './repo.js';
import { passwordPage, platformPage, platformWizardPage, type PlatformView } from './platform-view.js';
import { rejectionReason, storePassword, storedPasswordHash } from '../web/password.js';

export interface PlatformRouteDeps {
  settings: Settings;
  encryptionKey: Buffer;
  readFlash: (query: unknown) => NewFlash;
  /** Replaceable so tests call no real AI provider, Telegram or image service. */
  fetchImpl?: Fetch;
  /** The sign-in password, when this server has one to change. */
  account?: PasswordAccount;
}

export interface PasswordAccount {
  /** Whether the fallback password was generated on first start. */
  generated: boolean;
  /** Whether a submitted password is the one in force now. */
  accepts: (password: string) => boolean;
}

/** Ready for websites: the setup was saved and at least one AI key is on. */
export function platformReady(settings: Settings): boolean {
  return settings.get(SETUP_DONE_KEY) === 'true' && listEndpointRows().some((r) => r.enabled === 1);
}

const body = (request: FastifyRequest): Record<string, unknown> =>
  (request.body as Record<string, unknown> | undefined) ?? {};

export function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRouteDeps): void {
  const { settings } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const context = (): PlatformContext => ({
    keys: listEndpointRows().map((r) => ({ id: r.id, name: r.name })),
    hasTelegramToken: settings.has('telegram_bot_token'),
    savedApiKeys: new Map(listEndpoints(deps.encryptionKey).map((e) => [e.id, e.apiKey])),
  });

  const view = async (): Promise<PlatformView> => ({
    ready: platformReady(settings),
    done: settings.get(SETUP_DONE_KEY) === 'true',
    keys: listEndpointRows().map((r) => {
      let models: string[] = [];
      try {
        models = JSON.parse(r.models) as string[];
      } catch {
        /* shown as none */
      }
      return { id: r.id, name: r.name, models, enabled: r.enabled === 1, lastError: r.last_error ?? '' };
    }),
    value: (key: string) => settings.get(key),
    hasTelegramToken: settings.has('telegram_bot_token'),
    imageProblem: await checkImageService(settings.get('image_base_url'), settings.get('image_api_key'), fetchImpl),
    catalogue: await imageCatalogue(settings, fetchImpl),
    password: deps.account ? (storedPasswordHash(deps.encryptionKey) ? 'own' : deps.account.generated ? 'generated' : 'server') : undefined,
  });

  /** The AI step's live part: a new key must answer before it is accepted. */
  const testNewKey = async (raw: Record<string, unknown>) => {
    const { errors, clean } = validatePlatform(raw, context(), [0]);
    if (Object.keys(errors).length) return errors;
    const out: Record<string, string> = {};
    if (clean.newKey) {
      const problem = await testAiKey(clean.settings.llm_base_url!, clean.newKey.apiKey, clean.newKey.models, fetchImpl);
      if (problem) out.newKeyValue = problem;
    }
    // Pasted keys: one tiny request each, with the first ticked model, four at a time.
    const failed: string[] = [];
    const queue = [...clean.bulkKeys];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let k = queue.shift(); k; k = queue.shift()) {
        const problem = await testAiKey(clean.settings.llm_base_url!, k.apiKey, k.models.slice(0, 1), fetchImpl);
        if (problem) failed.push(`${k.name} (…${k.apiKey.slice(-4)}): ${problem}`);
      }
    }));
    if (failed.length) out.bulkKeys = `${failed.length} of ${clean.bulkKeys.length} keys failed. Remove them and try again. ${failed.join(' ')}`;
    return out;
  };

  app.get('/new-website/platform', async (request, reply) =>
    reply.type('text/html; charset=utf-8').send(
      newLayout({
        title: 'Platform settings',
        active: '/new-website/platform',
        body: platformPage(
          await view(),
          automationBar(automationOn(deps.settings), listNewWebsites(), deps.settings.get('timezone') || 'UTC', '/new-website/platform', Date.now(), automationOnAt(deps.settings)),
        ),
        flash: deps.readFlash(request.query),
      }),
    ),
  );

  /** The sign-in password, changed here instead of on the old dashboard. */
  const account = deps.account;
  if (account) {
    const showPassword = (error = '') =>
      newLayout({ title: 'Change the password', active: '/new-website/platform', body: passwordPage(account.generated && !storedPasswordHash(deps.encryptionKey), error), flash: null });
    app.get('/new-website/platform/password', async (_request, reply) => reply.type('text/html; charset=utf-8').send(showPassword()));
    app.post('/new-website/platform/password', async (request, reply) => {
      const b = body(request);
      const send = (error: string) => reply.type('text/html; charset=utf-8').send(showPassword(error));
      // Asked even inside a session: a session left open on a shared machine must not lock the owner out.
      if (!account.accepts(String(b.current ?? ''))) {
        await new Promise((r) => setTimeout(r, 400));
        return send('That is not the current password.');
      }
      const reason = rejectionReason(String(b.next ?? ''), String(b.confirm ?? ''));
      if (reason) return send(reason);
      storePassword(String(b.next), deps.encryptionKey);
      return reply.redirect('/new-website/platform?ok=' + encodeURIComponent('Password changed. Use it from the next sign-in; this session stays open.'), 303);
    });
  }

  app.get('/new-website/platform/setup', async (request, reply) => {
    const v = await view();
    // One part alone, once the platform is set up; the full walk-through the first time.
    const section = v.done ? Number((request.query as { section?: string } | undefined)?.section ?? -1) : -1;
    return reply.type('text/html; charset=utf-8').send(
      newLayout({ title: 'Platform settings', active: '/new-website/platform', body: platformWizardPage(v, Number.isInteger(section) ? section : -1) }),
    );
  });

  app.post('/new-website/platform/check', async (request, reply) => {
    const raw = body(request);
    const step = Number(raw.step);
    if (!Number.isInteger(step) || !PLATFORM_STEPS[step]) return reply.code(400).send({ errors: {} });
    if (step === 0) return reply.send({ errors: await testNewKey(raw) });
    return reply.send({ errors: validatePlatform(raw, context(), [step]).errors });
  });

  app.post('/new-website/platform/telegram-test', async (request, reply) => {
    const raw = body(request);
    const token = String(raw.telegram_bot_token ?? '').trim() || settings.get('telegram_bot_token');
    const chat = String(raw.telegram_chat_id ?? '').trim();
    const { errors } = validatePlatform(
      { ...raw, telegram_enabled: 'true', telegram_bot_token: token },
      context(),
      [4],
    );
    if (errors.telegram_bot_token || errors.telegram_chat_id) {
      return reply.send({ ok: false, error: errors.telegram_bot_token ?? errors.telegram_chat_id });
    }
    const problem = await testTelegram(token, chat, fetchImpl);
    return reply.send(problem ? { ok: false, error: problem } : { ok: true });
  });

  app.post('/new-website/platform/save', async (request, reply) => {
    const raw = body(request);
    const { errors, clean } = validatePlatform(raw, context());
    const failed = Object.keys(errors);
    if (failed.length) {
      const step = Math.min(...failed.map((f) => PLATFORM_STEPS.findIndex((s) => s.includes(f))));
      return reply.send({ errors, step });
    }
    const skipped = clean.skippedKeys;
    if (clean.newKey || clean.bulkKeys.length) {
      const keyErrors = await testNewKey(raw);
      if (Object.keys(keyErrors).length) return reply.send({ errors: keyErrors, step: 0 });
    }

    for (const [key, value] of Object.entries(clean.settings)) settings.set(key, value);
    for (const id of clean.removeKeyIds) deleteEndpoint(id);
    if (clean.newKey) {
      // Blank base URL: the key uses the provider address saved above.
      upsertEndpoint({ name: clean.newKey.name, baseUrl: '', apiKey: clean.newKey.apiKey, models: clean.newKey.models, enabled: true }, deps.encryptionKey);
    }
    for (const k of clean.bulkKeys) upsertEndpoint({ name: k.name, baseUrl: '', apiKey: k.apiKey, models: k.models, enabled: true }, deps.encryptionKey);
    settings.set(SETUP_DONE_KEY, 'true');
    const note = skipped ? ` ${skipped} pasted key${skipped > 1 ? 's were' : ' was'} already saved, so ${skipped > 1 ? 'they were' : 'it was'} skipped.` : '';
    return reply.send({ saved: true, redirect: '/new-website/platform', message: 'Platform settings saved.' + note });
  });
}
