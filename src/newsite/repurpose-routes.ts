import type { FastifyInstance, FastifyRequest } from 'fastify';
import { run } from '../db/index.js';
import { newLayout, type NewFlash } from './layout.js';
import { getNewWebsite, listNewWebsites, websiteApiKey } from './repo.js';
import { websiteChannels } from './channels.js';
import {
  generateRepurposePost,
  getRepurposeArticle,
  getRepurposePost,
  kickRepurpose,
  listRepurposeArticles,
  listRepurposePosts,
  repurposeSentToday,
  sendRepurposePost,
  syncWebsiteArticles,
  updateRepurposeSettings,
  type RepurposeDeps,
} from './repurpose.js';
import { repurposePage } from './repurpose-view.js';

export function registerRepurposeRoutes(
  app: FastifyInstance,
  deps: RepurposeDeps & { readFlash: (q: unknown) => NewFlash; autoStart?: boolean },
): void {
  const send = (reply: any, s: string) => reply.type('text/html; charset=utf-8').send(s);

  if (deps.autoStart !== false) {
    const kick = () => void kickRepurpose(deps).catch(() => {});
    setTimeout(kick, 15_000).unref();
    setInterval(kick, 15 * 60_000).unref();
  }

  app.get('/new-website/repurpose', async (request, reply) => {
    const websites = listNewWebsites();
    const q = (request.query as Record<string, unknown>) ?? {};
    const selectedSiteId = q.website ? Number(q.website) : undefined;
    const page = Math.max(1, Number(q.page) || 1);

    const articlesOf = new Map(websites.map((s) => [s.id, listRepurposeArticles(s.id)]));
    const postsOf = new Map(websites.map((s) => [s.id, listRepurposePosts(s.id)]));
    const channelsOf = new Map(websites.map((s) => [s.id, websiteChannels(s.id)]));
    const sentTodayOf = new Map(websites.map((s) => [s.id, repurposeSentToday(s.id)]));

    const body = repurposePage(websites, selectedSiteId, articlesOf, postsOf, channelsOf, sentTodayOf, page);

    return send(
      reply,
      newLayout({
        title: 'Repurpose content',
        active: '/new-website/repurpose',
        body,
        flash: deps.readFlash(request.query),
      }),
    );
  });

  app.post('/new-website/repurpose/:siteId/sync', async (request, reply) => {
    const siteId = Number((request.params as { siteId: string }).siteId);
    const site = getNewWebsite(siteId);
    if (!site) return reply.redirect('/new-website/repurpose', 303);

    const apiKey = websiteApiKey(site, deps.encryptionKey);
    try {
      const { found, added, updated } = await syncWebsiteArticles(site, apiKey, deps.fetchImpl);
      return reply.redirect(
        `/new-website/repurpose?website=${siteId}&ok=${encodeURIComponent(
          `Discovered ${found} articles from ${site.domain} (${added} new, ${updated} refreshed).`,
        )}`,
        303,
      );
    } catch (err) {
      return reply.redirect(
        `/new-website/repurpose?website=${siteId}&error=${encodeURIComponent(
          `Could not sync from ${site.domain}: ${String(err)}`,
        )}`,
        303,
      );
    }
  });

  app.post('/new-website/repurpose/:siteId/toggle', async (request, reply) => {
    const siteId = Number((request.params as { siteId: string }).siteId);
    const site = getNewWebsite(siteId);
    if (!site) return reply.redirect('/new-website/repurpose', 303);

    const b = (request.body as Record<string, unknown>) ?? {};
    const pageParam = b.page ? `&page=${encodeURIComponent(String(b.page))}` : '';

    const nextStatus = site.repurpose_status === 'active' ? 'paused' : 'active';
    updateRepurposeSettings(siteId, { status: nextStatus });

    if (nextStatus === 'active') {
      void kickRepurpose(deps);
    }

    return reply.redirect(
      `/new-website/repurpose?website=${siteId}${pageParam}&ok=${encodeURIComponent(
        `Repurposing is now ${nextStatus === 'active' ? 'Active' : 'Paused'} for ${site.name}.`,
      )}`,
      303,
    );
  });

  app.post('/new-website/repurpose/:siteId/settings', async (request, reply) => {
    const siteId = Number((request.params as { siteId: string }).siteId);
    const site = getNewWebsite(siteId);
    if (!site) return reply.redirect('/new-website/repurpose', 303);

    const b = (request.body as Record<string, unknown>) ?? {};
    const dailyTarget = Number(b.dailyTarget) || 1;
    const cooldownDays = Number(b.cooldownDays) || 30;
    const autoPublish = b.autoPublish === '1' || b.autoPublish === 'on' || b.autoPublish === true;
    const pageParam = b.page ? `&page=${encodeURIComponent(String(b.page))}` : '';

    updateRepurposeSettings(siteId, { dailyTarget, cooldownDays, autoPublish });

    return reply.redirect(
      `/new-website/repurpose?website=${siteId}${pageParam}&ok=${encodeURIComponent('Repurposing settings saved.')}`,
      303,
    );
  });

  app.post('/new-website/repurpose/article/:articleId/generate', async (request, reply) => {
    const articleId = Number((request.params as { articleId: string }).articleId);
    const b = (request.body as Record<string, unknown>) ?? {};
    const channelId = Number(b.channelId);
    const pageParam = b.page ? `&page=${encodeURIComponent(String(b.page))}` : '';

    const article = getRepurposeArticle(articleId);
    if (!article) return reply.redirect('/new-website/repurpose', 303);

    const res = await generateRepurposePost(articleId, channelId, deps);
    if (!res.post) {
      return reply.redirect(
        `/new-website/repurpose?website=${article.website_id}${pageParam}&error=${encodeURIComponent(
          `Could not generate post: ${res.problems.join(' ')}`,
        )}#discovered-articles`,
        303,
      );
    }

    return reply.redirect(
      `/new-website/repurpose?website=${article.website_id}${pageParam}&ok=${encodeURIComponent('Fresh post generated.')}#discovered-articles`,
      303,
    );
  });

  app.post('/new-website/repurpose/post/:postId/send', async (request, reply) => {
    const postId = Number((request.params as { postId: string }).postId);
    const post = getRepurposePost(postId);
    if (!post) return reply.redirect('/new-website/repurpose', 303);

    const res = await sendRepurposePost(postId, deps);
    if (!res.ok) {
      return reply.redirect(
        `/new-website/repurpose?website=${post.website_id}&error=${encodeURIComponent(`Send failed: ${res.error ?? ''}`)}`,
        303,
      );
    }

    return reply.redirect(
      `/new-website/repurpose?website=${post.website_id}&ok=${encodeURIComponent('Post sent successfully.')}`,
      303,
    );
  });

  app.post('/new-website/repurpose/post/:postId/delete', async (request, reply) => {
    const postId = Number((request.params as { postId: string }).postId);
    const post = getRepurposePost(postId);
    if (!post) return reply.redirect('/new-website/repurpose', 303);

    run('DELETE FROM newsite_repurpose_posts WHERE id = ?', postId);
    return reply.redirect(
      `/new-website/repurpose?website=${post.website_id}&ok=${encodeURIComponent('Post deleted.')}`,
      303,
    );
  });
}
