import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger, errorMessage } from '../lib/logger.js';
import { asPage } from './keywords.js';
import { newLayout, type NewFlash } from './layout.js';
import { getNewWebsite, listNewWebsites } from './repo.js';
import {
  approveResearch,
  createResearch,
  deleteResearch,
  editPlan,
  getResearch,
  isRunning,
  listResearch,
  runResearch,
  stateOf,
  type ResearchDeps,
  type TreeEdit,
} from './research.js';
import { researchListPage, researchPage } from './research-view.js';
import { RETRY_MS, addSearchKeys, checkSearchKeys, deleteSearchKey, listSearchKeys, moveSearchKey } from './search-keys.js';
import { PAGE_KEYS, keyLines, keyLinesFor } from './key-status.js';

const log = createLogger('newsite-research-routes');

export interface ResearchRouteDeps extends ResearchDeps {
  readFlash: (query: unknown) => NewFlash;
  /** Wakes the sub-keyword finder and the writer once a plan is approved. */
  startWriter: () => void;
  /** Look at failed keys again every hour; tests turn it off. */
  autoStart?: boolean;
}

const send = (reply: FastifyReply, title: string, body: Parameters<typeof newLayout>[0]['body'], flash: NewFlash): FastifyReply =>
  reply.type('text/html; charset=utf-8').send(newLayout({ title, active: '/new-website/research', body, flash }));

const form = (request: FastifyRequest): Record<string, string | string[] | undefined> =>
  (request.body as Record<string, string | string[] | undefined> | undefined) ?? {};
const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '');
const idOf = (request: FastifyRequest): number => Number((request.params as { id?: string }).id) || 0;

/** The tree as posted by the project page. */
export function readTree(b: Record<string, string | string[] | undefined>): TreeEdit {
  const edit: TreeEdit = { pillars: [], subs: [], added: [] };
  for (let i = 0; b[`p-${i}`] !== undefined; i++) {
    edit.pillars.push({ pillar: one(b[`p-${i}`]), remove: one(b[`rp-${i}`]) === '1', page: asPage(one(b[`page-${i}`])) });
    for (let j = 0; b[`s-${i}-${j}`] !== undefined; j++) {
      const to = Number(one(b[`m-${i}-${j}`]));
      edit.subs.push({ keyword: one(b[`s-${i}-${j}`]), from: i, to: Number.isInteger(to) ? to : i, remove: one(b[`rs-${i}-${j}`]) === '1' });
    }
    if (one(b[`new-${i}`]).trim()) edit.added.push({ keyword: one(b[`new-${i}`]), to: i });
  }
  return edit;
}

export function registerResearchRoutes(app: FastifyInstance, deps: ResearchRouteDeps): void {
  const start = (id: number) => void runResearch(id, deps).catch((err) => log.error(`Research ${id}: ${errorMessage(err)}`));
  const at = (id: number, msg = '', kind: 'ok' | 'error' = 'ok') => `/new-website/research/${id}${msg ? `?${kind}=${encodeURIComponent(msg)}` : ''}`;

  if (deps.autoStart !== false) {
    // A failed key is looked at again once its rest is over, so a key that recovers is seen even without a research running.
    setInterval(() => {
      const due = listSearchKeys().some((k) => k.status === 'failed' && Date.now() - k.failed_at >= RETRY_MS);
      if (due) void checkSearchKeys(deps).catch(() => {});
    }, RETRY_MS).unref();
  }

  app.get('/new-website/research', async (request, reply) =>
    send(reply, 'Content research', researchListPage(listResearch(), listNewWebsites(), keyLines(keyLinesFor(PAGE_KEYS.research))), deps.readFlash(request.query)),
  );

  app.post('/new-website/research', async (request, reply) => {
    const b = form(request);
    const site = getNewWebsite(Number(one(b.website)) || 0);
    const topic = one(b.topic).replace(/\s+/g, ' ').trim();
    if (!site || topic.length < 2) return reply.redirect(`/new-website/research?error=${encodeURIComponent('Pick a website and type a niche or topic.')}`, 303);
    const id = createResearch(site.id, topic);
    start(id);
    return reply.redirect(at(id), 303);
  });

  // The search keys live in Platform settings; the old addresses still lead there.
  const KEYS_AT = '/new-website/platform#search-keys';
  const keysBack = (msg = '', kind: 'ok' | 'error' = 'ok') => (msg ? `/new-website/platform?${kind}=${encodeURIComponent(msg)}#search-keys` : KEYS_AT);
  app.get('/new-website/research/keys', async (_request, reply) => reply.redirect(KEYS_AT, 301));

  for (const base of ['/new-website/platform/search-keys', '/new-website/research/keys']) {
    app.post(base, async (request, reply) => {
      const { added, bad } = addSearchKeys(one(form(request).keys), deps.encryptionKey);
      const msg = `${added} key${added === 1 ? '' : 's'} added.${bad.length ? ` Not keys: ${bad.join(', ')}.` : ''}`;
      return reply.redirect(keysBack(msg, bad.length && !added ? 'error' : 'ok'), 303);
    });

    app.post(`${base}/check`, async (_request, reply) => {
      await checkSearchKeys(deps);
      return reply.redirect(KEYS_AT, 303);
    });

    app.post(`${base}/:id/:what`, async (request, reply) => {
      const { what } = request.params as { what: string };
      const id = idOf(request);
      if (what === 'delete') deleteSearchKey(id);
      else if (what === 'up' || what === 'down') moveSearchKey(id, what === 'up');
      return reply.redirect(KEYS_AT, 303);
    });
  }

  app.get('/new-website/research/:id', async (request, reply) => {
    const r = getResearch(idOf(request));
    if (!r) return reply.redirect(`/new-website/research?error=${encodeURIComponent('That research no longer exists.')}`, 303);
    return send(reply, r.topic, researchPage(r, getNewWebsite(r.website_id), isRunning(r.id)), deps.readFlash(request.query));
  });

  app.post('/new-website/research/:id/run', async (request, reply) => {
    const id = idOf(request);
    if (getResearch(id)) start(id);
    return reply.redirect(at(id), 303);
  });

  app.post('/new-website/research/:id/plan', async (request, reply) => {
    const id = idOf(request);
    await editPlan(id, readTree(form(request)), deps);
    return reply.redirect(at(id, 'Saved.'), 303);
  });

  app.post('/new-website/research/:id/approve', async (request, reply) => {
    const id = idOf(request);
    // What is on the page is what is approved: the edits first.
    await editPlan(id, readTree(form(request)), deps);
    const r = getResearch(id);
    if (!r || !stateOf(r).plan.length) return reply.redirect(at(id, 'There is nothing to approve.', 'error'), 303);
    const done = approveResearch(id);
    if (!done) return reply.redirect(at(id, 'Only a plan ready for review can be approved.', 'error'), 303);
    deps.startWriter();
    return reply.redirect(at(id, `${done.plans} pillars added to the Keywords list.`), 303);
  });

  app.post('/new-website/research/:id/delete', async (request, reply) => {
    deleteResearch(idOf(request));
    return reply.redirect('/new-website/research?ok=' + encodeURIComponent('Research deleted.'), 303);
  });
}
