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
import { articleStepPage, imagesStepPage, keywordsPage, recipeStepPage, seoStepPage, skeletonStepPage } from './keywords-view.js';
import { articleTypeFor } from './skeleton.js';
import { clearPictures, listPictures, listPlanPictures, type FlowProject } from './pictures.js';
import { asPage } from './keywords.js';
import { getSeoRow, kickSeoWriter, listPlanSeo, queuePlanSeo, requeueArticle, requeueImages, requeueRecipe, requeueSeo, requeueSkeleton, resetInterruptedSeo } from './seo.js';

export interface KeywordRouteDeps extends FindDeps {
  encryptionKey: Buffer;
  listPosts: (domain: string, apiKey: string) => Promise<SitePost[]>;
  readFlash: (query: unknown) => NewFlash;
  isPlatformReady: () => boolean;
  /** Start AI#1 after a plan is saved (and resume it at boot). Tests turn it off. */
  autoSeo?: boolean;
  /** Why picture making is paused, or '' when it is not. */
  picturesPaused?: () => string;
  /** Which Flow project a website's pictures go into. */
  flowProject?: (siteProjectId: string) => FlowProject;
  dataDir?: string;
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
    const found = await findSubKeywords(
      { pillar, niche: site.niche, nicheContext: site.niche_context, existing },
      { suggest: deps.suggest, ask: deps.ask },
    );
    // Only recipe websites have recipe pages.
    if (found.ok && articleTypeFor(site.niche) !== 'recipe') {
      found.pillarPage = 'article';
      found.kept = found.kept.map((k) => ({ ...k, page: 'article' }));
    }
    return reply.send(found);
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

    const recipeSite = articleTypeFor(site.niche) === 'recipe';
    const pillarPage = recipeSite ? asPage(raw.pillarPage) : 'article';
    const items: PlanItem[] = parseList(raw.items).map((item) => {
      const i = (item ?? {}) as Record<string, unknown>;
      const intent = text(i.intent, 20).toLowerCase();
      return {
        keyword: text(i.keyword, 100),
        intent: (INTENTS as readonly string[]).includes(intent) ? intent : 'yours',
        reason: text(i.reason, 200),
        page: recipeSite ? asPage(i.page) : 'article',
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

    const planId = saveKeywordPlan(site.id, pillar, items, pillarPage);
    queuePlanSeo(planId, pillar, items, pillarPage);
    startSeo();
    return reply.send({
      ok: true,
      redirect: `/new-website/keywords/plan/${planId}/seo?ok=${encodeURIComponent('Keyword plan saved. The AI is writing the SEO metadata.')}`,
    });
  });

  /** Steps 2 and 3 of one plan: its SEO metadata, then its skeletons. */
  for (const step of ['seo', 'recipe', 'skeleton', 'article', 'images'] as const) {
    app.get(`/new-website/keywords/plan/:id/${step}`, async (request, reply) => {
      if (!deps.isPlatformReady()) return reply.redirect(`/new-website/platform?error=${encodeURIComponent(NOT_READY)}`, 303);
      const planId = Number((request.params as { id: string }).id) || 0;
      const plan = listKeywordPlans().find((p) => p.id === planId);
      const site = plan ? getNewWebsite(plan.website_id) : undefined;
      if (!plan || !site) {
        return reply.redirect(`/new-website/keywords?error=${encodeURIComponent('That keyword plan no longer exists.')}`, 303);
      }
      const rows = listPlanSeo(plan.id);
      return reply.type('text/html; charset=utf-8').send(
        newLayout({
          title: `${plan.pillar} · ${{ seo: 'SEO', recipe: 'Recipes', skeleton: 'Skeletons', article: 'Articles', images: 'Images' }[step]}`,
          active: '/new-website/keywords',
          body:
            step === 'seo'
              ? seoStepPage(site, plan, rows)
              : step === 'recipe'
                ? recipeStepPage(site, plan, rows)
                : step === 'skeleton'
                  ? skeletonStepPage(site, plan, rows)
                  : step === 'article'
                    ? articleStepPage(site, plan, rows)
                    : imagesStepPage(site, plan, rows, listPlanPictures(plan.id), deps.picturesPaused?.() ?? '', deps.flowProject?.(site.project_id)),
          flash: deps.readFlash(request.query),
        }),
      );
    });
  }

  /** AI#1 progress for one plan, so the page can update without a reload. */
  app.get('/new-website/keywords/:id/seo', async (request, reply) =>
    reply.send({
      rows: listPlanSeo(Number((request.params as { id: string }).id) || 0),
      pictures: listPlanPictures(Number((request.params as { id: string }).id) || 0).map((p) => ({ id: p.id, status: p.status })),
    }),
  );

  /** A plan saved before AI#1 existed: queue its keywords now. */
  app.post('/new-website/keywords/:id/seo/start', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    const website = Number(body(request).websiteId) || 0;
    const plan = listKeywordPlans(website).find((p) => p.id === planId);
    if (plan && listPlanSeo(planId).length === 0) {
      queuePlanSeo(planId, plan.pillar, plan.items, plan.pillar_page);
      startSeo();
    }
    return reply.redirect(`/new-website/keywords/plan/${planId}/seo?ok=${encodeURIComponent('Writing the SEO metadata.')}`, 303);
  });

  /** Write one keyword's image prompts again, from its article. */
  app.post('/new-website/keywords/images/:id/retry', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    if (listPictures(row.id).some((p) => p.status === 'queued' || p.status === 'making')) {
      return reply.redirect(
        `/new-website/keywords/plan/${row.plan_id}/images?error=${encodeURIComponent('Its pictures are being made. Wait for them to finish first.')}`,
        303,
      );
    }
    requeueImages(row.id);
    // New prompts, new pictures: the old ones would not match them.
    clearPictures(row.id, deps.dataDir);
    startSeo();
    return reply.redirect(`/new-website/keywords/plan/${row.plan_id}/images?ok=${encodeURIComponent('Writing the image prompts again.')}`, 303);
  });

  /** Write one keyword's article again, from its skeleton. */
  app.post('/new-website/keywords/article/:id/retry', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    requeueArticle(row.id);
    startSeo();
    return reply.redirect(`/new-website/keywords/plan/${row.plan_id}/article?ok=${encodeURIComponent('Writing the article again.')}`, 303);
  });

  /** Make one keyword's recipe (again); its skeleton is remade from it. */
  app.post('/new-website/keywords/recipe/:id/retry', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    requeueRecipe(row.id);
    startSeo();
    return reply.redirect(`/new-website/keywords/plan/${row.plan_id}/recipe?ok=${encodeURIComponent('Making the recipe.')}`, 303);
  });

  /** Make one keyword's skeleton again, from its current metadata. */
  app.post('/new-website/keywords/skeleton/:id/retry', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    requeueSkeleton(row.id);
    startSeo();
    return reply.redirect(`/new-website/keywords/plan/${row.plan_id}/skeleton?ok=${encodeURIComponent('Making the skeleton again.')}`, 303);
  });

  /** Write one keyword's metadata again. */
  app.post('/new-website/keywords/seo/:id/retry', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    requeueSeo(row.id);
    startSeo();
    return reply.redirect(`/new-website/keywords/plan/${row.plan_id}/seo?ok=${encodeURIComponent('Writing it again.')}`, 303);
  });

  app.post('/new-website/keywords/:id/delete', async (request, reply) => {
    const website = Number(body(request).websiteId) || 0;
    const planId = Number((request.params as { id: string }).id) || 0;
    // The plan's pictures are files in the data folder: they go with it.
    for (const row of listPlanSeo(planId)) clearPictures(row.id, deps.dataDir);
    deleteKeywordPlan(planId);
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
