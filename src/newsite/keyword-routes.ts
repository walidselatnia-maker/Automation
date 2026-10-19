import { randomBytes } from 'node:crypto';
import { autopilotState, automationOn, automationOnAt } from './autopilot.js';
import { get } from '../db/index.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkImport, importRows, kickSubFinder, planStats, type ImportRow } from './keyword-import.js';
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
  getKeywordPlan,
  getNewWebsite,
  listKeywordPlans,
  listNewWebsites,
  saveKeywordPlan,
  websiteApiKey,
  type NewWebsiteRow,
  type PlanItem,
} from './repo.js';
import { listChannels, websiteChannels } from './channels.js';
import { listPlanSocialPosts } from './social.js';
import { addKeywordsStep, importCheckStep, importFileStep, keywordsOverview, articleStepPage, imagesStepPage, publishStepPage, keywordsPage, recipeStepPage, seoStepPage, skeletonStepPage } from './keywords-view.js';
import { articleTypeFor } from './skeleton.js';
import { clearPictures, isMainSlot, listPictures, listPlanPictures, listPlanSocialPictures } from './pictures.js';
import { sweepRetries } from './retries.js';
import type { Settings } from '../settings.js';
import { asPage } from './keywords.js';
import { getSeoRow, kickSeoWriter, listPlanSeo, queuePlanSeo, requeueArticle, requeueImages, requeueRecipe, requeueSeo, requeueSkeleton, resetInterruptedSeo, queueNotStartedSteps } from './seo.js';

export interface KeywordRouteDeps extends FindDeps {
  encryptionKey: Buffer;
  listPosts: (domain: string, apiKey: string) => Promise<SitePost[]>;
  readFlash: (query: unknown) => NewFlash;
  isPlatformReady: () => boolean;
  /** Start AI#1 after a plan is saved (and resume it at boot). Tests turn it off. */
  autoSeo?: boolean;
  /** Why picture making is paused, or '' when it is not. */
  /** The platform settings, for automatic retries of the AI steps. */
  settings?: Settings;
  /** When the slow queue makes its next step picture (ms since 1970). */
  nextStepAt?: () => number;
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

/** Returns what starts the writer, for Generate now on the Dashboard. */
export function registerKeywordRoutes(app: FastifyInstance, deps: KeywordRouteDeps): () => void {
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
  // Imported keywords without sub-keywords: found one plan at a time, then on to the SEO step.
  const startFinder = () => {
    if (deps.autoSeo !== false) {
      void kickSubFinder({ suggest: deps.suggest, ask: deps.ask, listPosts: deps.listPosts, encryptionKey: deps.encryptionKey, startSeo });
    }
  };
  // Anything a restart interrupted goes back in the queue and carries on.
  if (deps.autoSeo !== false) {
    resetInterruptedSeo();
    queueNotStartedSteps();
    startSeo();
    startFinder();
    // Failed AI steps are tried again by themselves, as the platform's retry
    // settings say. Checked every minute; a due try restarts the writer.
    const settings = deps.settings;
    if (settings) {
      setInterval(() => {
        // A pending step with the writer idle (a missed kick) starts it too: kicking a busy writer does nothing.
        if (queueNotStartedSteps() || sweepRetries(settings) || hasPendingWriting()) startSeo();
      }, 60_000).unref();
    }
  }

  /** Is any keyword waiting for one of its writing steps? */
  const hasPendingWriting = (): boolean =>
    Boolean(get(`SELECT 1 AS x FROM keyword_seo WHERE 'pending' IN (status, recipe_status, skeleton_status, article_status, images_status) LIMIT 1`));

  /** The Keywords page: a card per website, each with a table of its keyword plans. */
  app.get('/new-website/keywords', async (request, reply) => {
    if (!deps.isPlatformReady()) return reply.redirect(`/new-website/platform?error=${encodeURIComponent(NOT_READY)}`, 303);
    // An old address with ?website= opens that website's card.
    const wanted = Number((request.query as { website?: string }).website) || 0;
    if (wanted) return reply.redirect(`/new-website/keywords#website-${wanted}`, 303);
    const plans = listKeywordPlans();
    const tz = deps.settings?.get('timezone') || 'UTC';
    const sites = listNewWebsites().map((site) => ({
      site,
      plans: plans.filter((p) => p.website_id === site.id),
      autopilot: deps.settings && automationOn(deps.settings) && site.status === 'active' ? autopilotState(site, tz, Date.now(), automationOnAt(deps.settings)).next : '',
    }));
    return reply.type('text/html; charset=utf-8').send(
      newLayout({ title: 'Keywords', active: '/new-website/keywords', body: keywordsOverview(sites, planStats()), flash: deps.readFlash(request.query) }),
    );
  });

  /* -- Add keywords: one by hand, or a CSV file ------------------------------ */

  const wizardPage = (title: string, body: ReturnType<typeof addKeywordsStep>, request: FastifyRequest) =>
    newLayout({ title, active: '/new-website/keywords', body, flash: deps.readFlash(request.query) });

  app.get('/new-website/keywords/add', async (request, reply) => {
    if (!deps.isPlatformReady()) return reply.redirect(`/new-website/platform?error=${encodeURIComponent(NOT_READY)}`, 303);
    return reply.type('text/html; charset=utf-8').send(wizardPage('Add keywords', addKeywordsStep(), request));
  });

  app.post('/new-website/keywords/add', async (request, reply) => {
    const raw = body(request);
    if (raw.how === 'csv') return reply.redirect('/new-website/keywords/import', 303);
    return reply.redirect('/new-website/keywords/new', 303);
  });

  /** One main keyword, by hand: the finder and its sub-keyword list. */
  app.get('/new-website/keywords/new', async (request, reply) => {
    if (!deps.isPlatformReady()) return reply.redirect(`/new-website/platform?error=${encodeURIComponent(NOT_READY)}`, 303);
    const websites = listNewWebsites();
    const wanted = Number((request.query as { website?: string }).website) || 0;
    const current = websites.find((w) => w.id === wanted) ?? websites[0];
    return reply.type('text/html; charset=utf-8').send(
      newLayout({ title: 'Add a keyword', active: '/new-website/keywords', body: keywordsPage(websites, current, []), flash: deps.readFlash(request.query) }),
    );
  });

  /** A checked CSV file, kept here between the check and the import (an hour at most). */
  const imports = new Map<string, { rows: ImportRow[]; expires: number }>();

  app.get('/new-website/keywords/import', async (request, reply) => {
    if (!deps.isPlatformReady()) return reply.redirect(`/new-website/platform?error=${encodeURIComponent(NOT_READY)}`, 303);
    return reply.type('text/html; charset=utf-8').send(wizardPage('Import keywords', importFileStep(listNewWebsites()), request));
  });

  /** A CSV template to fill in: the columns, and an example row for each website. */
  app.get('/new-website/keywords/import/template.csv', async (_request, reply) => {
    const sites = listNewWebsites();
    const cell = (v: string) => (/[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = [
      'Main Keyword,Target Website,Niche,Subkeywords',
      ...(sites.length ? sites : [{ domain: 'example.com', niche: '' }]).flatMap((w, i) => [
        [i ? 'banana bread' : 'strawberry cake', w.domain, '', ''].map(cell).join(','),
        [i ? 'lemon tart' : 'chocolate mousse', w.domain, w.niche, i ? 'mini lemon tarts; lemon tart filling' : 'easy chocolate mousse; vegan chocolate mousse'].map(cell).join(','),
      ]),
    ];
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="keywords-template.csv"')
      .send('﻿' +lines.join('\r\n') + '\r\n');
  });

  app.post('/new-website/keywords/import/check', async (request, reply) => {
    const csv = String(body(request).csv ?? '');
    const websites = listNewWebsites();
    const page = (b: ReturnType<typeof addKeywordsStep>) => reply.type('text/html; charset=utf-8').send(wizardPage('Import keywords', b, request));
    if (!csv.trim()) return page(importFileStep(websites, '', 'Choose a CSV file, or paste its text.'));
    if (csv.length > 5_000_000) return page(importFileStep(websites, '', 'That file is too big (over 5 MB). Split it in parts.'));
    const check = await checkImport(csv, {
      websites,
      listPosts: (site) => deps.listPosts(site.domain, websiteApiKey(site, deps.encryptionKey)),
    });
    if (check.fileError) return page(importFileStep(websites, csv.slice(0, 20_000), check.fileError));
    const now = Date.now();
    for (const [k, v] of imports) if (v.expires < now) imports.delete(k);
    const draft = randomBytes(12).toString('hex');
    imports.set(draft, { rows: check.rows, expires: now + 60 * 60_000 });
    return page(importCheckStep(check, draft));
  });

  app.post('/new-website/keywords/import/save', async (request, reply) => {
    const draft = imports.get(String(body(request).draft ?? ''));
    if (!draft) return reply.redirect(`/new-website/keywords/import?error=${encodeURIComponent('That check expired. Choose the file again.')}`, 303);
    imports.delete(String(body(request).draft));
    const { plans, finding } = importRows(draft.rows);
    startSeo();
    startFinder();
    const msg = `Imported ${plans} keyword${plans === 1 ? '' : 's'}.${finding ? ` The platform is finding sub-keywords for ${finding} of them; each goes on to the SEO step as soon as they are found.` : ''}`;
    return reply.redirect(`/new-website/keywords?ok=${encodeURIComponent(msg)}`, 303);
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
      { pillar, niche: site.niche, nicheContext: site.niche_context, existing, language: site.language },
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
  /** A plan's last step is the Sharing page, showing that plan's articles. */
  app.get('/new-website/keywords/plan/:id/share', async (request, reply) => {
    const plan = getKeywordPlan(Number((request.params as { id: string }).id) || 0);
    if (!plan) return reply.redirect('/new-website/sharing', 303);
    const q = new URLSearchParams(request.query as Record<string, string>);
    q.set('plan', String(plan.id));
    return reply.redirect(`/new-website/sharing?${q.toString()}#website-${plan.website_id}`, 303);
  });

  for (const step of ['seo', 'recipe', 'skeleton', 'article', 'images', 'publish'] as const) {
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
          title: `${plan.pillar} · ${{ seo: 'SEO', recipe: 'Recipes', skeleton: 'Skeletons', article: 'Articles', images: 'Images', publish: 'Publish', share: 'Share' }[step]}`,
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
                    : step === 'publish'
                      ? publishStepPage(site, plan, rows, listPlanPictures(plan.id))
                      : imagesStepPage(site, plan, rows, listPlanPictures(plan.id), deps.nextStepAt?.() ?? 0),
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
      social: listPlanSocialPosts(Number((request.params as { id: string }).id) || 0).map((p) => ({ id: p.id, status: p.status })),
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
    if (listPictures(row.id).some((p) => p.status === 'making' || (p.status === 'queued' && isMainSlot(p.slot)))) {
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
    const planId = Number((request.params as { id: string }).id) || 0;
    const website = getKeywordPlan(planId)?.website_id ?? (Number(body(request).websiteId) || 0);
    // The plan's pictures are files in the data folder: they go with it.
    for (const row of listPlanSeo(planId)) clearPictures(row.id, deps.dataDir);
    deleteKeywordPlan(planId);
    return reply.redirect(`/new-website/keywords?ok=${encodeURIComponent('Keyword plan deleted.')}#website-${website}`, 303);
  });
  return startSeo;
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
