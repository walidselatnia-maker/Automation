import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkSite as realCheckSite, type SiteCheck } from './client.js';
import { createNewWebsite, deleteNewWebsite, getNewWebsiteByDomain, listNewWebsites } from './repo.js';
import { newLayout, type NewFlash } from './layout.js';
import { newWebsiteListPage, newWebsiteWizardPage } from './view.js';
import { STEP_FIELDS, stepOf, validate, type CleanWebsite, type Errors } from './validate.js';

/** What the new dashboard needs from the server that hosts it. */
export interface NewWebsiteDeps {
  encryptionKey: Buffer;
  /** Replaceable so tests do not call a real website. */
  checkSite?: (domain: string, apiKey: string) => Promise<SiteCheck>;
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

  /**
   * Everything wrong with the given fields, including the things only the
   * database and the site itself can tell: a domain already added, and an
   * address and key the site does not accept.
   */
  const problems = async (
    raw: Record<string, unknown>,
    fields: string[],
  ): Promise<{ errors: Errors; clean: Partial<CleanWebsite>; siteName?: string; types?: string[] }> => {
    const { errors, clean } = validate(raw, fields as never);

    const siteFields = ['domain', 'apiKey'].every((f) => fields.includes(f));
    if (!siteFields || errors.domain || errors.apiKey) return { errors, clean };

    if (getNewWebsiteByDomain(clean.domain!)) {
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
      body: newWebsiteListPage(listNewWebsites()),
      flash: readFlash(request.query),
    })),
  );

  app.get('/new-website/add', async (_request, reply) =>
    send(reply, newLayout({ title: 'Add website', active: '/new-website/add', body: newWebsiteWizardPage() })),
  );

  /** One wizard step: say what is wrong, or let the browser move on. */
  app.post('/new-website/check', async (request, reply) => {
    const raw = body(request);
    const step = Number(raw.step);
    const fields = STEP_FIELDS[step];
    if (!Number.isInteger(step) || !fields) return reply.code(400).send({ errors: {} });

    const { errors, siteName, types } = await problems(raw, fields);
    return reply.send({ errors, siteName, types });
  });

  /** The last step: everything again, then save. */
  app.post('/new-website/save', async (request, reply) => {
    const raw = body(request);
    const { errors, clean } = await problems(raw, STEP_FIELDS.flat());

    const failed = Object.keys(errors) as (keyof Errors)[];
    if (failed.length) {
      const step = Math.min(...failed.map((f) => stepOf(f)));
      return reply.send({ errors, step });
    }

    try {
      createNewWebsite(clean as CleanWebsite, deps.encryptionKey);
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
