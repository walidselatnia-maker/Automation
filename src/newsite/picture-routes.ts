import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { resolveDataDir } from '../config.js';
import type { Settings } from '../settings.js';
import { listPlanSeo, getSeoRow } from './seo.js';
import {
  getPicture,
  kickPictureMaker,
  pictureDir,
  queuePictures,
  resetInterruptedPictures,
  restartPictureMaker,
  retryFailedPictures,
  stopPictureMaker,
  type PictureDeps,
} from './pictures.js';

export interface PictureRouteDeps {
  settings: Settings;
  /** Replaces the Flowkit call in tests. */
  makePicture?: PictureDeps['make'];
  dataDir?: string;
  /** Start the picture maker (and resume it at boot). Tests turn it off. */
  autoPictures?: boolean;
  /** Called with each step picture once it is made: publishing adds it to the post. */
  afterStep?: PictureDeps['afterStep'];
  afterMain?: PictureDeps['afterMain'];
  afterPin?: PictureDeps['afterPin'];
  automationOn?: PictureDeps['automationOn'];
}

const imagesPage = (planId: number, message: string, kind: 'ok' | 'error' = 'ok'): string =>
  `/new-website/keywords/plan/${planId}/images?${kind}=${encodeURIComponent(message)}`;

const queuedMessage = (queued: number, what: string): string =>
  queued ? `Making ${queued} picture${queued === 1 ? '' : 's'}${what}, one at a time.` : 'Nothing to make: those pictures are done.';

/** Registers the routes; returns what wakes the picture maker. */
export function registerPictureRoutes(app: FastifyInstance, deps: PictureRouteDeps): () => void {
  const { settings } = deps;
  const dataDir = deps.dataDir ?? resolveDataDir();
  const queueAll = (seoId: number): number => queuePictures(seoId, dataDir, true);
  const maker: PictureDeps = {
    settings,
    make: deps.makePicture,
    dataDir,
    afterStep: deps.afterStep,
    afterMain: deps.afterMain,
    afterPin: deps.afterPin,
    automationOn: deps.automationOn,
  };
  const start = () => {
    if (deps.autoPictures !== false) void kickPictureMaker(maker);
  };
  // Pictures a restart cut off go back in the queue and carry on.
  if (deps.autoPictures !== false) {
    resetInterruptedPictures();
    start();
  }

  /** Make one keyword's pictures. */
  app.post('/new-website/keywords/pictures/:id/make', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    const queued = queueAll(row.id);
    start();
    return reply.redirect(
      imagesPage(row.plan_id, queuedMessage(queued, ` for “${row.keyword}”`)),
      303,
    );
  });

  /** Make the pictures of every keyword in a plan whose prompts are ready. */
  app.post('/new-website/keywords/plan/:id/pictures/make', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    const queued = listPlanSeo(planId).reduce((n, r) => n + queueAll(r.id), 0);
    start();
    return reply.redirect(
      imagesPage(planId, queuedMessage(queued, '')),
      303,
    );
  });

  /**
   * Drop the image service's unfinished image jobs and reload its Flow tab, so
   * nothing half-done carries on there. Best effort: the platform side stops
   * either way.
   */
  const stopImageService = async (): Promise<void> => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) return;
    await fetch(`${base}/v1/jobs/stop-images`, {
      method: 'POST',
      headers: { 'X-API-Key': settings.get('image_api_key') },
      signal: AbortSignal.timeout(60_000),
    }).catch(() => undefined);
  };

  /** Stop making pictures until Restart. */
  app.post('/new-website/keywords/plan/:id/pictures/stop', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    stopPictureMaker(settings);
    await stopImageService();
    return reply.redirect(imagesPage(planId, 'Pictures stopped.'), 303);
  });

  /** Drop what is in hand, refresh Flow, and carry on with the queue. */
  app.post('/new-website/keywords/plan/:id/pictures/restart', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    stopPictureMaker(settings);
    await stopImageService();
    if (deps.autoPictures !== false) void restartPictureMaker(maker);
    else settings.set('newsite_pictures_stopped', '0');
    return reply.redirect(imagesPage(planId, 'Pictures restarted.'), 303);
  });

  const retried = (n: number, what: string): string =>
    n ? `Trying ${n} failed picture${n === 1 ? '' : 's'} again${what}, one at a time.` : 'No failed picture to try again.';

  /** One failed picture, made again. */
  app.post('/new-website/pictures/:id/retry', async (request, reply) => {
    const picture = getPicture(Number((request.params as { id: string }).id) || 0);
    const row = picture ? getSeoRow(picture.seo_id) : undefined;
    if (!picture || !row) return reply.redirect('/new-website/keywords', 303);
    const n = retryFailedPictures({ pictureId: picture.id });
    start();
    return reply.redirect(imagesPage(row.plan_id, retried(n, ` for “${row.keyword}”`)) + `#kw-${row.id}`, 303);
  });

  /** Every failed picture of one keyword, made again. */
  app.post('/new-website/keywords/pictures/:id/retry-failed', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    const n = retryFailedPictures({ seoId: row.id });
    start();
    return reply.redirect(imagesPage(row.plan_id, retried(n, ` for “${row.keyword}”`)), 303);
  });

  /** Every failed picture of a plan, made again. */
  app.post('/new-website/keywords/plan/:id/pictures/retry-failed', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    const n = retryFailedPictures({ planId });
    start();
    return reply.redirect(imagesPage(planId, retried(n, '')), 303);
  });

  /** One finished picture, from the platform's data folder. */
  app.get('/new-website/pictures/:id/file', async (request, reply) => {
    const picture = getPicture(Number((request.params as { id: string }).id) || 0);
    // The file name is the platform's own (slot-id.ext), never a request's.
    const path = picture?.file ? join(pictureDir(picture.seo_id, dataDir), picture.file) : '';
    if (!path || !existsSync(path)) return reply.code(404).send('Not found');
    const type = picture!.file.endsWith('.png') ? 'image/png' : picture!.file.endsWith('.jpg') ? 'image/jpeg' : 'image/webp';
    return reply.type(type).header('Cache-Control', 'private, max-age=86400').send(createReadStream(path));
  });
  return start;
}
