import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deleteEndpoint, listEndpointRows, upsertEndpoint } from '../llm/pool.js';
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
import { platformPage, platformWizardPage, type PlatformView } from './platform-view.js';

export interface PlatformRouteDeps {
  settings: Settings;
  encryptionKey: Buffer;
  readFlash: (query: unknown) => NewFlash;
  /** Replaceable so tests call no real AI provider, Telegram or image service. */
  fetchImpl?: Fetch;
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
  });

  /** The AI step's live part: a new key must answer before it is accepted. */
  const testNewKey = async (raw: Record<string, unknown>) => {
    const { errors, clean } = validatePlatform(raw, context(), [0]);
    if (Object.keys(errors).length || !clean.newKey) return errors;
    const problem = await testAiKey(clean.settings.llm_base_url!, clean.newKey.apiKey, clean.newKey.models, fetchImpl);
    return problem ? { newKeyValue: problem } : {};
  };

  app.get('/new-website/platform', async (request, reply) =>
    reply.type('text/html; charset=utf-8').send(
      newLayout({
        title: 'Platform',
        active: '/new-website/platform',
        body: platformPage(await view()),
        flash: deps.readFlash(request.query),
      }),
    ),
  );

  app.get('/new-website/platform/setup', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(
      newLayout({ title: 'Platform setup', active: '/new-website/platform', body: platformWizardPage(await view()) }),
    ),
  );

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
    if (clean.newKey) {
      const keyErrors = await testNewKey(raw);
      if (Object.keys(keyErrors).length) return reply.send({ errors: keyErrors, step: 0 });
    }

    for (const [key, value] of Object.entries(clean.settings)) settings.set(key, value);
    for (const id of clean.removeKeyIds) deleteEndpoint(id);
    if (clean.newKey) {
      // Blank base URL: the key uses the provider address saved above.
      upsertEndpoint({ name: clean.newKey.name, baseUrl: '', apiKey: clean.newKey.apiKey, models: clean.newKey.models, enabled: true }, deps.encryptionKey);
    }
    settings.set(SETUP_DONE_KEY, 'true');
    return reply.send({ saved: true, redirect: '/new-website/platform' });
  });
}
