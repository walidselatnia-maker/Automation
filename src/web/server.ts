import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeHtml } from './views/layout.js';
import { passwordAccepted, registerAuth, type AuthOptions } from './auth.js';
import { registerBrowserProxy } from './browser-proxy.js';
import { registerMedia } from './media.js';
import { resolveDataDir } from '../config.js';
import type { Settings } from '../settings.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { registerNewWebsiteRoutes } from '../newsite/routes.js';
import { automationOn } from '../newsite/autopilot.js';
import { configureGemini } from '../llm/gemini.js';
import { geminiAccount } from '../newsite/gemini.js';

/**
 * The web server: sign-in, the Article Platform (src/newsite, all under
 * /new-website), the signed media links Buffer and Facebook fetch, and the
 * live Chrome session of the image service. The old dashboard is gone; its
 * address, /, opens the Dashboard.
 */

const log = createLogger('web');

const asNumber = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export function buildServer(
  settings: Settings,
  encryptionKey: Buffer,
  auth: AuthOptions,
): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });

  void app.register(formbody);
  void app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  void app.register(fastifyStatic, {
    root: resolve(dirname(fileURLToPath(import.meta.url)), 'public'),
    prefix: '/static/',
  });

  // Must come after formbody so the login form body is parsed.
  registerAuth(app, auth);

  // Reel videos, for the fetchers that cannot log in. Registered after the
  // auth hook on purpose: the hook still runs, and still refuses anything
  // under /media that is not a signed read.
  registerMedia(app, {
    secret: auth.secret,
    clipsDir: join(resolveDataDir(), 'reels'),
  });

  // The live Chrome session, behind the same login as everything else.
  registerBrowserProxy(app, {
    targetUrl: process.env.IMAGEGEN_VNC_URL ?? 'http://imagegen:6080',
    secret: auth.secret,

    // Chrome is no longer running just because the container is: its GPU
    // process costs 170% of a 185% container with nothing loaded, so the agent
    // starts it for a job and stops it afterwards. Opening this page is the
    // other reason to want one — signing in to Google needs a window — and
    // without this the page would come up on an empty display and look broken.
    //
    // Failure is deliberately not fatal. If the image service cannot be
    // reached, showing the viewer and letting it say so beats refusing to
    // render the page someone opened to find out what is wrong.
    onOpen: async () => {
      const base = settings.get('image_base_url').replace(/\/+$/, '');
      if (!base) return;
      try {
        await fetch(`${base}/flow/chrome/start`, {
          method: 'POST',
          headers: { 'X-API-Key': settings.get('image_api_key') },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        // The viewer will show an empty display; /browser/procs says why.
      }
    },

    // Closing the tab is what says nobody is watching. Without it the hold has
    // to be guessed at, and the guess was fifteen minutes: every visit to this
    // page cost eighteen minutes of a browser at 170%, so checking whether the
    // CPU had come down was itself what kept it up.
    onViewerGone: async () => {
      const base = settings.get('image_base_url').replace(/\/+$/, '');
      if (!base) return;
      try {
        await fetch(`${base}/flow/chrome/stop`, {
          method: 'POST',
          headers: { 'X-API-Key': settings.get('image_api_key') },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        // It stops on the idle timer anyway; this only makes it prompt.
      }
    },
  });

  // Prompts switched to Gemini reach it through chat(), which is not handed Settings.
  configureGemini({ settings, account: geminiAccount });

  registerNewWebsiteRoutes(app, {
    encryptionKey,
    settings,
    account: { generated: auth.generated, accepts: (password) => passwordAccepted(password, auth) },
  });

  app.get('/', async (_request, reply) => reply.redirect('/new-website/dashboard', 303));

  /**
   * What is using the CPU inside the image container, as plain text.
   *
   * Deployment is Dokploy and there is no shell on the box, so `docker exec
   * ... top` is not available when that container starts burning cores. This
   * is the substitute: the agent samples /proc for a second and this renders
   * it. Behind the session cookie like every other page, and read-only.
   */
  app.get('/browser/procs', async (_request, reply) => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) return reply.type('text/plain').send('No image service URL is set.');

    try {
      const response = await fetch(`${base}/flow/procs`, {
        headers: { 'X-API-Key': settings.get('image_api_key') },
        // The endpoint samples for a second before it answers.
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return reply.type('text/plain').send(`Image service answered HTTP ${response.status}.`);
      }

      const body = (await response.json()) as {
        total_cpu_percent: number;
        processes: { pid: number; cpu_percent: number; memory_mb: number; command: string }[];
      };

      const lines = [
        `total ${body.total_cpu_percent}% CPU`,
        '',
        `${'PID'.padStart(7)}  ${'CPU%'.padStart(7)}  ${'MEM MB'.padStart(8)}  COMMAND`,
        ...body.processes.map(
          (p) =>
            `${String(p.pid).padStart(7)}  ${p.cpu_percent.toFixed(1).padStart(7)}  ` +
            `${p.memory_mb.toFixed(1).padStart(8)}  ${p.command}`,
        ),
      ];
      return reply.type('text/plain').send(lines.join('\n'));
    } catch (err) {
      return reply.type('text/plain').send(`Could not reach the image service: ${errorMessage(err)}`);
    }
  });

  /**
   * Per-thread CPU inside one process in the image container.
   *
   * /browser/procs says which process; this says which thread inside it, and
   * Chrome's thread names (VizCompositorThread, swiftshader, GpuWatchdog) are
   * specific enough to point at a fix. Two rounds of plausible-sounding Chrome
   * flags were spent not knowing this.
   */
  app.get('/browser/threads/:pid', async (request, reply) => {
    const base = settings.get('image_base_url').replace(/\/+$/, '');
    if (!base) return reply.type('text/plain').send('No image service URL is set.');
    const pid = asNumber((request.params as { pid: string }).pid, 0);

    try {
      const response = await fetch(`${base}/flow/threads/${pid}`, {
        headers: { 'X-API-Key': settings.get('image_api_key') },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return reply.type('text/plain').send(`Image service answered HTTP ${response.status}.`);
      }

      const body = (await response.json()) as {
        pid: number;
        thread_count: number;
        total_cpu_percent: number;
        threads: { tid: number; cpu_percent: number; name: string }[];
      };

      const lines = [
        `pid ${body.pid} — ${body.thread_count} threads, ${body.total_cpu_percent}% CPU total`,
        '',
        `${'TID'.padStart(7)}  ${'CPU%'.padStart(7)}  THREAD`,
        ...body.threads.map(
          (t) =>
            `${String(t.tid).padStart(7)}  ${t.cpu_percent.toFixed(1).padStart(7)}  ${t.name}`,
        ),
      ];
      return reply.type('text/plain').send(lines.join('\n'));
    } catch (err) {
      return reply.type('text/plain').send(`Could not reach the image service: ${errorMessage(err)}`);
    }
  });

  app.get('/healthz', async (_request, reply) => reply.send({ ok: true, automation: automationOn(settings) }));

  app.setErrorHandler((error, _request, reply) => {
    log.error('unhandled request error', errorMessage(error));
    void reply
      .status(500)
      .type('text/html')
      .send(`<!doctype html><meta charset="utf-8"><title>Error</title><h1>Something went wrong</h1><pre>${escapeHtml(errorMessage(error))}</pre><p><a href="/new-website/dashboard">Back to the Dashboard</a></p>`);
  });

  return app;
}
