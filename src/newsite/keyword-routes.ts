import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SitePost } from './client.js';
import {
  findSubKeywords,
  INTENTS,
  MAX_SUBS,
  pillarProblem,
  subProblem,
  type Existing,
  type FindDeps,
} from './keywords.js';
import { newLayout, type NewFlash } from './layout.js';
import {
  deleteKeywordPlan,
  getNewWebsite,
  listKeywordPlans,
  listNewWebsites,
  saveKeywordPlan,
  websiteApiKey,
  type NewWebsiteRow,
  type PlanItem,
} from './repo.js';
import { keywordsPage } from './keywords-view.js';
import { getSeoRow, kickSeoWriter, listPlanSeo, queuePlanSeo, requeueSeo, requeueSkeleton, resetInterruptedSeo } from './seo.js';

export interface KeywordRouteDeps extends FindDeps {
  encryptionKey: Buffer;
  listPosts: (domain: string, apiKey: string) => Promise<SitePost[]>;
  readFlash: (query: unknown) => NewFlash;
  isPlatformReady: () => boolean;
  /** Start AI#1 after a plan is saved (and resume it at boot). Tests turn it off. */
  autoSeo?: boolean;
}

const body = (request: FastifyRequest): Record<string, unknown> =>
  (request.body as Record<string, unknown> | undefined) ?? {};

const text = (value: unknown, max = 200): string =>
  (typeof value === 'string' ? value : '').replace(/[\u0000-\u001f<>{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** A pillar worth searching: plain text, at least one letter, not too long. */
function pillarInputProblem(pillar: string): string | null {
  if (!pillar) return 'Type the pillar keyword.';
  if (pillar.length < 3 || pillar.length > 80) return 'The pillar keyword must be 3 to 80 characters.';
  if (!/\p{L}/u.test(pillar)) return 'The pillar keyword must contain words.';
  return null;
}

export function registerKeywordRoutes(app: FastifyInstance, deps: KeywordRouteDeps): void {
  /**
   * What a new keyword must not repeat: every post on the website (any
   * status) and every keyword already saved in a plan for it.
   */
  const existingFor = async (site: NewWebsiteRow): Promise<Existing[]> => {
    const posts = await deps.listPosts(site.domain, websiteApiKey(site, deps.encryptionKey));
    const saved = listKeywordPlans(site.id).flatMap((plan) => [
      { label: `the saved plan “${plan.pillar}”`, text: plan.pillar },
      ...plan.items.map((i) => ({ label: `“${i.keyword}” in the plan for “${plan.pillar}”`, text: i.keyword })),
    ]);
    return [
      ...posts.filter((p) => p.title).map((p) => ({ label: `the post “${p.title}”`, text: p.title })),
      ...saved,
    ];
  };

  const siteFrom = (raw: Record<string, unknown>): NewWebsiteRow | undefined =>
    getNewWebsite(Number(raw.websiteId) || 0);

  const fail = (reply: FastifyReply, error: string) => reply.send({ ok: false, error });

  const NOT_READY = 'Set up the platform first: keywords need a working AI key.';
  const writer = { ask: deps.ask, suggest: deps.suggest };
  const startSeo = () => {
    if (deps.autoSeo !== false) void kickSeoWriter(writer);
  };
  // Anything a restart interrupted goes back in the queue and carries on.
  if (deps.autoSeo !== false) {
    resetInterruptedSeo();
    startSeo();
  }

  app.get('/new-website/keywords', async (request, reply) => {
    if (!deps.isPlatformReady()) return reply.redirect(`/new-website/platform?error=${encodeURIComponent(NOT_READY)}`, 303);
    const websites = listNewWebsites();
    const wanted = Number((request.query as { website?: string }).website) || 0;
    const current = websites.find((w) => w.id === wanted) ?? websites[0];
    return reply.type('text/html; charset=utf-8').send(
      newLayout({
        title: 'Keywords',
        active: '/new-website/keywords',
        body: (() => {
          const plans = current ? listKeywordPlans(current.id) : [];
          return keywordsPage(websites, current, plans, new Map(plans.map((p) => [p.id, listPlanSeo(p.id)])));
        })(),
        flash: deps.readFlash(request.query),
      }),
    );
  });

  /** Search: pillar check, Google, the AI, the filters. */
  app.post('/new-website/keywords/find', async (request, reply) => {
    const raw = body(request);
    if (!deps.isPlatformReady()) return fail(reply, NOT_READY);
    const site = siteFrom(raw);
    if (!site) return fail(reply, 'Pick a website first.');
    const pillar = text(raw.pillar, 80);
    const bad = pillarInputProblem(pillar);
    if (bad) return fail(reply, bad);

    let existing: Existing[];
    try {
      existing = await existingFor(site);
    } catch (err) {
      return fail(reply, `${(err as Error).message} The duplicate check needs the full list, so nothing was searched.`);
    }
    return reply.send(
      await findSubKeywords(
        { pillar, niche: site.niche, nicheContext: site.niche_context, existing },
        { suggest: deps.suggest, ask: deps.ask },
      ),
    );
  });

  /** One keyword you typed yourself, against the pillar, the site and the list so far. */
  app.post('/new-website/keywords/check', async (request, reply) => {
    const raw = body(request);
    const site = siteFrom(raw);
    if (!site) return fail(reply, 'Pick a website first.');
    const pillar = text(raw.pillar, 80);
    const keyword = text(raw.keyword, 100);
    if (!keyword || !/\p{L}/u.test(keyword)) return fail(reply, 'Type a keyword.');
    const others = parseList(raw.others).map((o) => text(o, 100));

    let existing: Existing[];
    try {
      existing = await existingFor(site);
    } catch (err) {
      return fail(reply, (err as Error).message);
    }
    const problem = subProblem(keyword, pillar, existing, others);
    return problem ? fail(reply, problem) : reply.send({ ok: true, keyword });
  });

  /** Save the plan, after checking every keyword again. */
  app.post('/new-website/keywords/save', async (request, reply) => {
    const raw = body(request);
    const site = siteFrom(raw);
    if (!site) return fail(reply, 'Pick a website first.');
    const pillar = text(raw.pillar, 80);
    const bad = pillarInputProblem(pillar);
    if (bad) return fail(reply, bad);

    const items: PlanItem[] = parseList(raw.items).map((item) => {
      const i = (item ?? {}) as Record<string, unknown>;
      const intent = text(i.intent, 20).toLowerCase();
      return {
        keyword: text(i.keyword, 100),
        intent: (INTENTS as readonly string[]).includes(intent) ? intent : 'yours',
        reason: text(i.reason, 200),
      };
    }).filter((i) => i.keyword);

    if (items.length === 0) return fail(reply, 'Keep at least one sub-keyword.');
    if (items.length > MAX_SUBS) return fail(reply, `Keep at most ${MAX_SUBS} sub-keywords.`);

    let existing: Existing[];
    try {
      existing = await existingFor(site);
    } catch (err) {
      return fail(reply, (err as Error).message);
    }
    const blocked = pillarProblem(pillar, existing);
    if (blocked) return fail(reply, blocked);
    const accepted: string[] = [];
    for (const item of items) {
      const problem = subProblem(item.keyword, pillar, existing, accepted);
      if (problem) return fail(reply, `“${item.keyword}”: ${problem}`);
      accepted.push(item.keyword);
    }

    const planId = saveKeywordPlan(site.id, pillar, items);
    queuePlanSeo(planId, pillar, items.map((i) => i.keyword));
    startSeo();
    return reply.send({
      ok: true,
      redirect: `/new-website/keywords?website=${site.id}&ok=${encodeURIComponent('Keyword plan saved.')}`,
    });
  });

  /** AI#1 progress for one plan, so the page can update without a reload. */
  app.get('/new-website/keywords/:id/seo', async (request, reply) =>
    reply.send({ rows: listPlanSeo(Number((request.params as { id: string }).id) || 0) }),
  );

  /** A plan saved before AI#1 existed: queue its keywords now. */
  app.post('/new-website/keywords/:id/seo/start', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    const website = Number(body(request).websiteId) || 0;
    const plan = listKeywordPlans(website).find((p) => p.id === planId);
    if (plan && listPlanSeo(planId).length === 0) {
      queuePlanSeo(planId, plan.pillar, plan.items.map((i) => i.keyword));
      startSeo();
    }
    return reply.redirect(`/new-website/keywords?website=${website}&ok=${encodeURIComponent('Writing the SEO metadata.')}`, 303);
  });

  /** Make one keyword's skeleton again, from its current metadata. */
  app.post('/new-website/keywords/skeleton/:id/retry', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    const website = Number(body(request).websiteId) || 0;
    if (row) {
      requeueSkeleton(row.id);
      startSeo();
    }
    return reply.redirect(`/new-website/keywords?website=${website}&ok=${encodeURIComponent('Making the skeleton again.')}`, 303);
  });

  /** Write one keyword's metadata again. */
  app.post('/new-website/keywords/seo/:id/retry', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    const website = Number(body(request).websiteId) || 0;
    if (row) {
      requeueSeo(row.id);
      startSeo();
    }
    return reply.redirect(`/new-website/keywords?website=${website}&ok=${encodeURIComponent('Writing it again.')}`, 303);
  });

  app.post('/new-website/keywords/:id/delete', async (request, reply) => {
    const website = Number(body(request).websiteId) || 0;
    deleteKeywordPlan(Number((request.params as { id: string }).id) || 0);
    return reply.redirect(
      `/new-website/keywords?website=${website}&ok=${encodeURIComponent('Keyword plan deleted.')}`,
      303,
    );
  });
}

/** A JSON array sent as one form field. Anything else is an empty list. */
function parseList(value: unknown): unknown[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
