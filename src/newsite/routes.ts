import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { askPrompt } from '../llm/ask.js';
import { expandSeeds } from '../integrations/google-suggest.js';
import type { Settings } from '../settings.js';
import { checkSite as realCheckSite, listPosts as realListPosts, type SitePost, type SiteCheck } from './client.js';
import { registerKeywordRoutes } from './keyword-routes.js';
import { registerPictureRoutes, type PictureRouteDeps } from './picture-routes.js';
import { registerImageModelRoutes } from './image-model.js';
import { registerPublishRoutes } from './publish-routes.js';
import { addStepPicture, publishWhenReady, type PublishDeps } from './publish.js';
import { describeProjectId, flowProjectFor, NEXT_STEP_KEY } from './pictures.js';
import { platformReady, registerPlatformRoutes } from './platform-routes.js';
import {
  createNewWebsite,
  deleteNewWebsite,
  getNewWebsite,
  getNewWebsiteByDomain,
  listNewWebsites,
  updateNewWebsite,
  websiteApiKey,
  type NewWebsiteRow,
} from './repo.js';
import { decrypt } from '../lib/crypto.js';
import { newLayout, type NewFlash } from './layout.js';
import { newWebsiteListPage, newWebsiteWizardPage } from './view.js';
import { STEP_FIELDS, stepOf, validate, type CleanWebsite, type Errors } from './validate.js';

/** What the new dashboard needs from the server that hosts it. */
export interface NewWebsiteDeps {
  encryptionKey: Buffer;
  /** For the AI connection (models, keys, endpoints from Settings). */
  settings?: Settings;
  /* Replaceable so tests call no real website, Google or AI. */
  checkSite?: (domain: string, apiKey: string) => Promise<SiteCheck>;
  listPosts?: (domain: string, apiKey: string) => Promise<SitePost[]>;
  suggest?: (pillar: string) => Promise<string[]>;
  ask?: (promptName: string, variables: Record<string, unknown>) => Promise<string>;
  /** Whether websites may be added yet. Defaults to the saved platform setup. */
  isPlatformReady?: () => boolean;
  /** Start AI#1 in the background when plans are saved. Tests turn it off. */
  autoSeo?: boolean;
  /** For the platform setup's live checks (AI provider, Telegram, image service). */
  fetchImpl?: typeof fetch;
  /** Replaces the Flowkit call in tests. */
  makePicture?: PictureRouteDeps['makePicture'];
  /** Where pictures are kept; the platform's data folder unless given. */
  dataDir?: string;
  /** Start the picture maker. Tests turn it off. */
  autoPictures?: boolean;
}

const readFlash = (query: unknown): NewFlash => {
  const q = (query ?? {}) as { ok?: unknown; error?: unknown };
  if (typeof q.ok === 'string') return { kind: 'ok', message: q.ok };
  if (typeof q.error === 'string') return { kind: 'error', message: q.error };
  return null;
};

const send = (reply: FastifyReply, html: string): FastifyReply =>
  reply.type('text/html; charset=utf-8').send(html);

const body = (request: FastifyRequest): Record<string, unknown> =>
  (request.body as Record<string, unknown> | undefined) ?? {};

export function registerNewWebsiteRoutes(app: FastifyInstance, deps: NewWebsiteDeps): void {
  const checkSite = deps.checkSite ?? realCheckSite;
  const ready = deps.isPlatformReady ?? (() => (deps.settings ? platformReady(deps.settings) : false));
  const NOT_READY = 'Set up the platform first: it needs at least one working AI key.';

  const ask =
    deps.ask ??
    (async (promptName: string, variables: Record<string, unknown>) => {
      if (!deps.settings) throw new Error('No AI connection configured.');
      return (await askPrompt(deps.settings, deps.encryptionKey, promptName, variables)).content;
    });

  if (deps.settings) {
    registerPlatformRoutes(app, { settings: deps.settings, encryptionKey: deps.encryptionKey, readFlash, fetchImpl: deps.fetchImpl });
    registerImageModelRoutes(app, { settings: deps.settings, readFlash, fetchImpl: deps.fetchImpl });
    const publish: PublishDeps = { settings: deps.settings, encryptionKey: deps.encryptionKey, fetchImpl: deps.fetchImpl, dataDir: deps.dataDir, ask };
    registerPublishRoutes(app, { ...publish, autoResume: deps.autoPictures });
    publish.startPictures = registerPictureRoutes(app, {
      settings: deps.settings,
      makePicture: deps.makePicture,
      dataDir: deps.dataDir,
      autoPictures: deps.autoPictures,
      afterStep: (pictureId) => addStepPicture(pictureId, publish),
      afterMain: (seoId) => publishWhenReady(seoId, publish),
    });
  }

  registerKeywordRoutes(app, {
    encryptionKey: deps.encryptionKey,
    readFlash,
    isPlatformReady: ready,
    autoSeo: deps.autoSeo,
    settings: deps.settings,
    nextStepAt: () => Number(deps.settings?.get(NEXT_STEP_KEY) || 0),
    flowProject: (site) => (deps.settings ? describeProjectId(flowProjectFor(site.project_id, site.domain, deps.settings), site.domain) : ''),
    dataDir: deps.dataDir,
    listPosts: deps.listPosts ?? ((domain, apiKey) => realListPosts(domain, apiKey)),
    suggest: deps.suggest ?? ((pillar) => expandSeeds([pillar])),
    ask,
  });

  /**
   * Everything wrong with the given fields, including the things only the
   * database and the site itself can tell: a domain already added, and an
   * address and key the site does not accept.
   */
  /**
   * When editing, an empty key or token field means "keep the saved one":
   * the saved secret is put back before checking, so the website is still
   * asked with the key that will actually be used.
   */
  const withSaved = (raw: Record<string, unknown>, site: NewWebsiteRow | undefined): Record<string, unknown> => {
    if (!site) return raw;
    const filled = { ...raw };
    if (!String(raw.apiKey ?? '').trim()) filled.apiKey = websiteApiKey(site, deps.encryptionKey);
    if (!String(raw.bufferToken ?? '').trim() && raw.removeBuffer !== '1') {
      try {
        filled.bufferToken = decrypt(site.buffer_token_encrypted, deps.encryptionKey);
      } catch {
        filled.bufferToken = '';
      }
    }
    return filled;
  };

  const editing = (raw: Record<string, unknown>): NewWebsiteRow | undefined | null => {
    if (raw.id === undefined || raw.id === '') return undefined;
    return getNewWebsite(Number(raw.id) || 0) ?? null; // null: asked to edit one that is gone
  };

  const problems = async (
    raw: Record<string, unknown>,
    fields: string[],
    site?: NewWebsiteRow,
  ): Promise<{ errors: Errors; clean: Partial<CleanWebsite>; siteName?: string; types?: string[] }> => {
    const { errors, clean } = validate(withSaved(raw, site), fields as never);

    const siteFields = ['domain', 'apiKey'].every((f) => fields.includes(f));
    if (!siteFields || errors.domain || errors.apiKey) return { errors, clean };

    const owner = getNewWebsiteByDomain(clean.domain!);
    if (owner && owner.id !== site?.id) {
      errors.domain = 'This website has already been added.';
      return { errors, clean };
    }
    const result = await checkSite(clean.domain!, clean.apiKey!);
    if (!result.ok) {
      errors[result.field] = result.error;
      return { errors, clean };
    }
    return { errors, clean, siteName: result.siteName, types: result.types };
  };

  app.get('/new-website', async (request, reply) =>
    send(reply, newLayout({
      title: 'Websites',
      active: '/new-website',
      body: newWebsiteListPage(listNewWebsites(), ready()),
      flash: readFlash(request.query),
    })),
  );

  app.get('/new-website/add', async (_request, reply) => {
    if (!ready()) return reply.redirect(`/new-website/platform?error=${encodeURIComponent(NOT_READY)}`, 303);
    return send(reply, newLayout({ title: 'Add website', active: '/new-website', body: newWebsiteWizardPage() }));
  });

  app.get('/new-website/:id/edit', async (request, reply) => {
    const site = getNewWebsite(Number((request.params as { id: string }).id) || 0);
    if (!site) return reply.redirect(`/new-website?error=${encodeURIComponent('That website no longer exists.')}`, 303);
    return send(reply, newLayout({ title: `Edit ${site.name}`, active: '/new-website', body: newWebsiteWizardPage(site) }));
  });

  /** One wizard step: say what is wrong, or let the browser move on. */
  app.post('/new-website/check', async (request, reply) => {
    const raw = body(request);
    const step = Number(raw.step);
    const fields = STEP_FIELDS[step];
    if (!Number.isInteger(step) || !fields) return reply.code(400).send({ errors: {} });

    const site = editing(raw);
    if (site === null) return reply.send({ errors: { name: 'That website no longer exists.' } });
    const { errors, siteName, types } = await problems(raw, fields, site);
    return reply.send({ errors, siteName, types });
  });

  /** The last step: everything again, then save. */
  app.post('/new-website/save', async (request, reply) => {
    const raw = body(request);
    const site = editing(raw);
    if (site === null) return reply.send({ errors: { name: 'That website no longer exists.' }, step: 0 });
    if (!site && !ready()) return reply.send({ errors: { name: NOT_READY }, step: 0 });
    const { errors, clean } = await problems(raw, STEP_FIELDS.flat(), site);

    const failed = Object.keys(errors) as (keyof Errors)[];
    if (failed.length) {
      const step = Math.min(...failed.map((f) => stepOf(f)));
      return reply.send({ errors, step });
    }

    try {
      if (site) updateNewWebsite(site.id, clean as CleanWebsite, deps.encryptionKey);
      else createNewWebsite(clean as CleanWebsite, deps.encryptionKey);
    } catch {
      // The unique domain: two saves at once got past the check above.
      return reply.send({ errors: { domain: 'This website has already been added.' }, step: 0 });
    }
    return reply.send({ saved: true, redirect: '/new-website' });
  });

  app.post('/new-website/:id/delete', async (request, reply) => {
    deleteNewWebsite(Number((request.params as { id: string }).id) || 0);
    return reply.redirect(`/new-website?ok=${encodeURIComponent('Website removed.')}`, 303);
  });
}
