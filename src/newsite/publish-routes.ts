import type { FastifyInstance } from 'fastify';
import { listPictures } from './pictures.js';
import { notReadyReason, publishKeyword, resetInterruptedPublishing, type PublishDeps } from './publish.js';
import { getSeoRow, listPlanSeo } from './seo.js';

const publishPage = (planId: number, message: string, kind: 'ok' | 'error' = 'ok'): string =>
  `/new-website/keywords/plan/${planId}/publish?${kind}=${encodeURIComponent(message)}`;

/** One publish at a time, so two clicks never post the same article twice at once. */
let chain: Promise<void> = Promise.resolve();
const enqueue = (work: () => Promise<void>): void => {
  chain = chain.then(work).catch(() => {});
};

export function registerPublishRoutes(app: FastifyInstance, deps: PublishDeps & { autoResume?: boolean }): void {
  if (deps.autoResume !== false) resetInterruptedPublishing();

  /** Publish one keyword's article (or update its post). */
  app.post('/new-website/keywords/publish/:id', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    const reason = notReadyReason(row, listPictures(row.id));
    if (reason) return reply.redirect(publishPage(row.plan_id, `“${row.keyword}”: ${reason}`, 'error'), 303);
    enqueue(() => publishKeyword(row.id, deps));
    return reply.redirect(publishPage(row.plan_id, `Publishing “${row.keyword}”.`), 303);
  });

  /** Publish every keyword of a plan that is ready and not posted yet. */
  app.post('/new-website/keywords/plan/:id/publish', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    const ready = listPlanSeo(planId).filter((r) => r.post_status !== 'published' && !notReadyReason(r, listPictures(r.id)));
    for (const r of ready) enqueue(() => publishKeyword(r.id, deps));
    return reply.redirect(
      publishPage(planId, ready.length ? `Publishing ${ready.length} article${ready.length === 1 ? '' : 's'}, one after the other.` : 'Nothing ready to publish.'),
      303,
    );
  });
}
