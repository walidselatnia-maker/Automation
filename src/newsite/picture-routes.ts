import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TelegramClient } from '../integrations/telegram.js';
import { resolveDataDir } from '../config.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import type { Settings } from '../settings.js';
import { listPlanSeo, getSeoRow } from './seo.js';
import {
  getPicture,
  kickPictureMaker,
  pictureDir,
  queuePictures,
  resetInterruptedPictures,
  flowProjectForSeo,
  NO_PROJECT,
  pausedReason,
  resumePictures,
  retryPicture,
  type PictureDeps,
} from './pictures.js';

const log = createLogger('newsite-pictures');

export interface PictureRouteDeps {
  settings: Settings;
  /** Replaces the Flowkit call in tests. */
  makePicture?: PictureDeps['make'];
  dataDir?: string;
  /** Start the picture maker (and resume it at boot). Tests turn it off. */
  autoPictures?: boolean;
}

const imagesPage = (planId: number, message: string, kind: 'ok' | 'error' = 'ok'): string =>
  `/new-website/keywords/plan/${planId}/images?${kind}=${encodeURIComponent(message)}`;

/** What pressing Make did; while paused, the pictures only wait in the queue. */
const queuedMessage = (settings: Settings, queued: number, what: string): string =>
  !queued
    ? 'Nothing to make: those pictures are done.'
    : pausedReason(settings)
      ? `${queued} picture${queued === 1 ? '' : 's'} added to the queue. Picture making is paused: press Resume to start.`
      : `Making ${queued} picture${queued === 1 ? '' : 's'}${what}, one at a time.`;

export function registerPictureRoutes(app: FastifyInstance, deps: PictureRouteDeps): void {
  const { settings } = deps;
  const dataDir = deps.dataDir ?? resolveDataDir();
  const maker: PictureDeps = {
    settings,
    make: deps.makePicture,
    dataDir,
    notify: async (message) => {
      if (!settings.getBool('telegram_enabled')) return;
      try {
        await new TelegramClient(settings.get('telegram_bot_token'), settings.get('telegram_chat_id')).sendMessage(message);
      } catch (err) {
        log.warn(`could not send a Telegram message: ${errorMessage(err)}`);
      }
    },
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
    if (!flowProjectForSeo(row.id, settings).id) return reply.redirect(imagesPage(row.plan_id, NO_PROJECT, 'error'), 303);
    const queued = queuePictures(row.id, dataDir);
    start();
    return reply.redirect(
      imagesPage(row.plan_id, queuedMessage(settings, queued, ` for “${row.keyword}”`)),
      303,
    );
  });

  /** Make the pictures of every keyword in a plan whose prompts are ready. */
  app.post('/new-website/keywords/plan/:id/pictures/make', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    const first = listPlanSeo(planId)[0];
    if (first && !flowProjectForSeo(first.id, settings).id) return reply.redirect(imagesPage(planId, NO_PROJECT, 'error'), 303);
    const queued = listPlanSeo(planId).reduce((n, r) => n + queuePictures(r.id, dataDir), 0);
    start();
    return reply.redirect(
      imagesPage(planId, queuedMessage(settings, queued, '')),
      303,
    );
  });

  /** Try one failed picture again. */
  app.post('/new-website/pictures/:id/retry', async (request, reply) => {
    const picture = getPicture(Number((request.params as { id: string }).id) || 0);
    const row = picture ? getSeoRow(picture.seo_id) : undefined;
    if (!picture || !row) return reply.redirect('/new-website/keywords', 303);
    retryPicture(picture.id);
    start();
    return reply.redirect(imagesPage(row.plan_id, 'Trying the picture again.'), 303);
  });

  /** Carry on after an emergency stop. */
  app.post('/new-website/pictures/resume', async (request, reply) => {
    const planId = Number((request.body as Record<string, unknown> | undefined)?.planId) || 0;
    resumePictures(settings);
    start();
    return reply.redirect(planId ? imagesPage(planId, 'Picture making resumed.') : '/new-website/keywords', 303);
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
}
