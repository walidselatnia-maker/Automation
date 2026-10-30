import type { FastifyInstance, FastifyRequest } from 'fastify';
import { html, raw, type Html } from '../web/views/layout.js';
import { listChannels, websiteChannels } from './channels.js';
import { newLayout, type NewFlash } from './layout.js';
import { createSocialPosts, getSocialPost, kickSocial, listPlanSocialPosts, remakeSocialPost, retrySocialPost, type SocialDeps } from './social.js';
import { getSeoRow, listPlanSeo } from './seo.js';
import { getKeywordPlan, listKeywordPlans, listNewWebsites } from './repo.js';
import { listPlanSocialPictures } from './pictures.js';
import { createReels, getReel, kickReels, listPlanReels, onReelMade, REEL_RULES_KEY, reelDir, reelRules, remakeReel, resetInterruptedReels, resumeStoppedLongReels, type ReelDeps } from './reels.js';
import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readyFor } from './keywords-view.js';
import { musicPage, reelsPage, shareArticlesStep, sharingChannelPage, sharingSitePage, sharingSitesPage, shareWebsiteStep, reelRulesPage, type ChannelTab, type SharingSite } from './sharing-view.js';
import { checkPlatformRules, listPlatformRules } from './platform-rules.js';
import { refreshPostLinks, refreshPostLinksSoon, type PostLinkDeps } from './post-links.js';
import { onSharingChanged, syncSharing } from './sharing-sync.js';
import { renewThreadsTokens } from './threads-token.js';
import { createReelShares, getReelShare, kickReelShares, listPlanReelShares, retryReelShare, shareReelOn, type ReelShareDeps } from './reel-shares.js';
import { markdownToHtml } from './markdown.js';
import { LONG_REEL_SECONDS, reelKindFor, reelKindKey, reelSecondsFor, reelSecondsKey } from './long-reels.js';
import { MUSIC_TYPES, addMusic, deleteMusic, getMusic, listMusic, musicDir, setMusicUsed } from './music.js';

export function registerSocialRoutes(
  app: FastifyInstance,
  deps: SocialDeps & { readFlash: (q: unknown) => NewFlash; autoStart?: boolean; reelShares?: Partial<ReelShareDeps>; postLinks?: Partial<PostLinkDeps> },
): void {
  // Posts left ready or waiting by a restart carry on.
  const shares: ReelShareDeps = { settings: deps.settings, encryptionKey: deps.encryptionKey, dataDir: deps.dataDir, ask: deps.ask, ...deps.reelShares };
  const reels: ReelDeps = {
    settings: deps.settings,
    encryptionKey: deps.encryptionKey,
    dataDir: deps.dataDir,
    ask: deps.ask,
  };
  // A reel made, however it was started, goes to its channels set to post reels.
  onReelMade((id) => {
    if (createReelShares(id)) void kickReelShares(shares);
  });
  // Links to posts Buffer has sent since: asked for now and then, and when a Sharing page is opened.
  const links: PostLinkDeps = { encryptionKey: deps.encryptionKey, ...deps.postLinks };
  const linksOnView = (): void => {
    if (deps.autoStart !== false) refreshPostLinksSoon(links);
  };
  // A website's or channel's sharing choice saved: the posters get to work on what it added.
  const kickAll = (): void => {
    void kickSocial(deps);
    void kickReels(reels);
    void kickReelShares(shares);
  };
  if (deps.autoStart !== false) {
    onSharingChanged(kickAll);
    void refreshPostLinks(links).catch(() => {});
    resetInterruptedReels();
    syncSharing();
    kickAll();
    setInterval(() => {
      void refreshPostLinks(links).catch(() => {});
      // A long reel an image service deploy stopped goes on without a restart here.
      if (syncSharing().added || resumeStoppedLongReels()) kickAll();
      void renewThreadsTokens(deps.encryptionKey);
    }, 15 * 60_000).unref();
  }

  /* -- The Sharing page ---------------------------------------------------- */

  /** Every website, with its published articles and the posts made from them. */
  const sharingSites = (): SharingSite[] => {
    const plans = listKeywordPlans();
    return listNewWebsites().map((site) => {
      const own = plans.filter((p) => p.website_id === site.id).sort((x, y) => x.id - y.id);
      const out: SharingSite = { site, channels: websiteChannels(site.id), articles: [], posts: [], pictures: [], reels: [], reelShares: [], unpublished: 0 };
      for (const plan of own) {
        const rows = listPlanSeo(plan.id);
        const published = readyFor('share', site, rows);
        const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
        out.articles.push(...published.map((row) => ({ row, intent: intentOf.get(row.keyword) ?? '', planId: plan.id, pillar: plan.pillar })));
        out.unpublished += rows.length - published.length;
        out.posts.push(...listPlanSocialPosts(plan.id));
        out.pictures.push(...listPlanSocialPictures(plan.id));
        out.reels.push(...listPlanReels(plan.id));
        out.reelShares.push(...listPlanReelShares(plan.id));
      }
      return out;
    });
  };
  const page = (title: string, body: ReturnType<typeof sharingSitesPage>, query: unknown): string =>
    newLayout({ title, active: /^Reel/.test(title) ? '/new-website/sharing/reels' : '/new-website/sharing', body, flash: deps.readFlash(query) });

  /** A website's page on Sharing, with a message. */
  const sharingAt = (websiteId: number, message: string, kind: 'ok' | 'error' = 'ok'): string =>
    `/new-website/sharing/site/${websiteId}?${kind}=${encodeURIComponent(message)}`;
  /**
   * After an action, back to the Sharing page it was clicked on (a channel's
   * tab, say), with the message; otherwise the article's website page.
   */
  const sharePage = (request: FastifyRequest, planId: number, message: string, kind: 'ok' | 'error' = 'ok'): string => {
    try {
      const from = new URL(String(request.headers.referer ?? ''));
      if (from.pathname.startsWith('/new-website/sharing/site/') || from.pathname === '/new-website/sharing/reels') {
        from.searchParams.delete('ok');
        from.searchParams.delete('error');
        from.searchParams.set(kind, message);
        return `${from.pathname}?${from.searchParams.toString()}`;
      }
    } catch {
      /* no usable referer */
    }
    return sharingAt(getKeywordPlan(planId)?.website_id ?? 0, message, kind);
  };

  const planFilter = (query: unknown) => {
    const plan = getKeywordPlan(Number((query as { plan?: string }).plan) || 0);
    return plan ? { id: plan.id, pillar: plan.pillar, websiteId: plan.website_id } : null;
  };

  /** Level 1: the websites. A keyword plan's link goes straight to its website. */
  app.get('/new-website/sharing', async (request, reply) => {
    linksOnView();
    const plan = planFilter(request.query);
    if (plan) return reply.redirect(`/new-website/sharing/site/${plan.websiteId}?plan=${plan.id}`, 303);
    return reply.type('text/html; charset=utf-8').send(page('Social posts', sharingSitesPage(sharingSites()), request.query));
  });

  /** Level 2: one website's channels. */
  app.get('/new-website/sharing/site/:id', async (request, reply) => {
    linksOnView();
    const s = sharingSites().find((x) => x.site.id === Number((request.params as { id: string }).id));
    if (!s) return reply.redirect('/new-website/sharing', 303);
    const plan = planFilter(request.query);
    return reply.type('text/html; charset=utf-8').send(page(`Social posts · ${s.site.name}`, sharingSitePage(s, plan?.websiteId === s.site.id ? plan : null), request.query));
  });

  /** Level 3: one channel of that website: its posts, reels and problems. */
  app.get('/new-website/sharing/site/:id/channel/:channel', async (request, reply) => {
    linksOnView();
    const params = request.params as { id: string; channel: string };
    const s = sharingSites().find((x) => x.site.id === Number(params.id));
    const ch = s?.channels.find((c) => c.id === Number(params.channel));
    if (!s || !ch) return reply.redirect(s ? `/new-website/sharing/site/${s.site.id}` : '/new-website/sharing', 303);
    const q = request.query as { tab?: string };
    const tab: ChannelTab = q.tab === 'reels' || q.tab === 'problems' ? q.tab : 'posts';
    const plan = planFilter(request.query);
    return reply.type('text/html; charset=utf-8').send(
      page(`${ch.name} · ${s.site.name}`, sharingChannelPage(s, ch, tab, plan?.websiteId === s.site.id ? plan : null), request.query),
    );
  });

  /** What changed, for the page to reload itself while posts are being made. */
  app.get('/new-website/sharing/state', async () => ({
    key: sharingSites()
      .flatMap((s) => [...s.posts.map((p) => `${p.id}${p.status}`), ...s.pictures.map((x) => `p${x.id}${x.status}`), ...s.articles.map((a) => `a${a.row.id}`), ...s.reels.map((r) => `r${r.id}${r.status}`), ...s.reelShares.map((x) => `rs${x.id}${x.status}`)])
      .join(','),
  }));

  /** The Share articles wizard: the website, then its articles. */
  app.get('/new-website/sharing/new', async (request, reply) => {
    const chosen = Number((request.query as { website?: string }).website) || 0;
    return reply.type('text/html; charset=utf-8').send(page('Share articles', shareWebsiteStep(sharingSites(), chosen), request.query));
  });

  app.get('/new-website/sharing/new/articles', async (request, reply) => {
    const id = Number((request.query as { website?: string }).website) || 0;
    const site = sharingSites().find((s) => s.site.id === id);
    if (!site) return reply.redirect('/new-website/sharing/new', 303);
    return reply.type('text/html; charset=utf-8').send(page('Share articles', shareArticlesStep(site), request.query));
  });

  app.post('/new-website/sharing/share', async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, string | string[] | undefined>;
    const websiteId = Number(b.websiteId) || 0;
    const ids = (Array.isArray(b.seo) ? b.seo : b.seo ? [b.seo] : []).map(Number).filter(Boolean);
    const site = sharingSites().find((s) => s.site.id === websiteId);
    if (!site) return reply.redirect('/new-website/sharing', 303);
    if (!ids.length) {
      return reply.redirect(`/new-website/sharing/new/articles?website=${websiteId}&error=${encodeURIComponent('Tick at least one article.')}`, 303);
    }
    // Only this website's published articles.
    const allowed = new Set(site.articles.map((a) => a.row.id));
    let added = 0;
    let madeReels = 0;
    for (const id of ids.filter((i) => allowed.has(i))) {
      added += createSocialPosts(id);
      madeReels += createReels(id);
    }
    void kickReels(reels);
    void kickSocial(deps);
    const parts = [added ? `${added} post${added === 1 ? '' : 's'}` : '', madeReels ? `${madeReels} reel${madeReels === 1 ? '' : 's'}` : ''].filter(Boolean);
    return reply.redirect(sharingAt(websiteId, parts.length ? `Sharing ${parts.join(' and ')}, one after the other.` : 'Those articles are already on every channel.'), 303);
  });

  /** The old Shared content page is now part of Sharing. */
  app.get('/new-website/shared', async (_request, reply) => reply.redirect('/new-website/sharing', 303));

  /* -- Reels ---------------------------------------------------------------- */

  const isPublished = (r: { post_status: string; post_url: string }) => r.post_status === 'published' && Boolean(r.post_url);

  app.get('/new-website/reels/:id/file', async (request, reply) => {
    const reel = getReel(Number((request.params as { id: string }).id) || 0);
    // The file name is the platform's own (reel-<id>.mp4), never a request's.
    const path = reel?.file ? join(reelDir(deps.dataDir), reel.file) : '';
    if (!path || !existsSync(path)) return reply.code(404).send('Not found');
    return reply.type('video/mp4').header('Cache-Control', 'private, max-age=86400').send(createReadStream(path));
  });

  /** The Reels page: each article's one reel, made and managed here, then sent to channels. */
  app.get('/new-website/sharing/reels', async (request, reply) => {
    linksOnView();
    const websiteId = Number((request.query as { website?: string }).website) || 0;
    return reply.type('text/html; charset=utf-8').send(page('Reels', reelsPage(sharingSites(), websiteId, choiceOf), request.query));
  });

  const choiceOf = (id: number) => ({ kind: reelKindFor(deps.settings, id), seconds: reelSecondsFor(deps.settings, id) });
  const reelsBack = (v: unknown): string => {
    const s = String(v ?? '');
    return s.startsWith('/new-website/sharing/reels') ? s : '/new-website/sharing/reels';
  };
  const withMessage = (back: string, kind: 'ok' | 'error', msg: string) => `${back}${back.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(msg)}`;

  /** A website's reel type (10 seconds or long) and a long reel's length, for its next reels. */
  app.post('/new-website/sharing/reels/kind/:id', async (request, reply) => {
    const id = Number((request.params as { id: string }).id) || 0;
    const b = (request.body ?? {}) as { kind?: string; seconds?: string; back?: string };
    const back = reelsBack(b.back);
    if (!listNewWebsites().some((s) => s.id === id)) return reply.redirect(back, 303);
    deps.settings.set(reelKindKey(id), b.kind === 'long' ? 'long' : 'short');
    const seconds = Number(b.seconds);
    if ((LONG_REEL_SECONDS as readonly number[]).includes(seconds)) deps.settings.set(reelSecondsKey(id), String(seconds));
    return reply.redirect(withMessage(back, 'ok', 'Saved.'), 303);
  });

  /* -- Music for long reels ---------------------------------------------------- */

  app.get('/new-website/sharing/music', async (request, reply) =>
    reply.type('text/html; charset=utf-8').send(page('Reels: music', musicPage(listMusic()), request.query)));

  app.get('/new-website/sharing/music/:id/file', async (request, reply) => {
    const track = getMusic(Number((request.params as { id: string }).id) || 0);
    // The file name is the platform's own (track-<id>.<ext>), never a request's.
    const path = track?.file && !/[\\/]/.test(track.file) ? join(musicDir(deps.dataDir), track.file) : '';
    if (!path || !existsSync(path)) return reply.code(404).send('Not found');
    const type = MUSIC_TYPES[track!.file.split('.').pop() ?? ''] ?? 'application/octet-stream';
    return reply.type(type).header('Cache-Control', 'private, max-age=86400').send(createReadStream(path));
  });

  app.post('/new-website/sharing/music/upload', async (request, reply) => {
    const added: string[] = [];
    const refused: string[] = [];
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file' || !part.filename) continue;
        const data = await part.toBuffer();
        try {
          addMusic(part.filename, data, deps.dataDir);
          added.push(part.filename);
        } catch {
          refused.push(part.filename);
        }
      }
    } catch (err) {
      return reply.redirect(withMessage('/new-website/sharing/music', 'error', `The upload stopped: ${(err as Error).message}`), 303);
    }
    const msg = [added.length ? `${added.length} added.` : '', refused.length ? `Not music: ${refused.join(', ')}.` : ''].filter(Boolean).join(' ') || 'Nothing uploaded.';
    return reply.redirect(withMessage('/new-website/sharing/music', refused.length && !added.length ? 'error' : 'ok', msg), 303);
  });

  app.post('/new-website/sharing/music/bulk', async (request, reply) => {
    const b = (request.body ?? {}) as { id?: string | string[]; action?: string };
    const ids = (Array.isArray(b.id) ? b.id : b.id ? [b.id] : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return reply.redirect(withMessage('/new-website/sharing/music', 'error', 'Tick at least one track.'), 303);
    const n = b.action === 'delete' ? deleteMusic(ids, deps.dataDir) : setMusicUsed(ids, b.action === 'use');
    const word = b.action === 'delete' ? 'deleted' : b.action === 'use' ? 'used' : 'not used';
    return reply.redirect(withMessage('/new-website/sharing/music', 'ok', `${n} ${word}.`), 303);
  });

  /** The reel rules: edited in place, saved for the next reel. */
  const backOf = (v: unknown): string => {
    const s = String(v ?? '');
    return s.startsWith('/new-website/sharing') || s === '/new-website/prompts' ? s : '/new-website/sharing/reels';
  };
  // Old per-platform links land on the one set of rules.
  app.get('/new-website/sharing/reel-rules/:platform', async (request, reply) => reply.redirect('/new-website/sharing/reel-rules', 303));

  app.get('/new-website/sharing/reel-rules', async (request, reply) => {
    const own = deps.settings.get(REEL_RULES_KEY).trim();
    const body = reelRulesPage(reelRules(deps.settings), !own, backOf((request.query as { back?: string }).back));
    return reply.type('text/html; charset=utf-8').send(page('Reel rules', body, request.query));
  });

  app.post('/new-website/sharing/reel-rules', async (request, reply) => {
    const b = (request.body ?? {}) as { text?: string; reset?: string; back?: string };
    const back = backOf(b.back);
    const join = (msg: string) => `${back}${back.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}`;
    if (b.reset) {
      deps.settings.set(REEL_RULES_KEY, '');
      return reply.redirect(join('The reel rules are back to the defaults.'), 303);
    }
    const text = String(b.text ?? '').replace(/\r\n/g, '\n').trim();
    const problems = [
      !/^- \d+-\d+s:/m.test(text) ? 'Keep at least one time mark line, like “- 0-2s: …”.' : '',
      !/hook line[^\n]*at most \d+ words/i.test(text) ? 'Keep the hook line limit, like “The hook line: at most 9 words.”' : '',
    ].filter(Boolean);
    if (problems.length) {
      return reply.type('text/html; charset=utf-8').send(page('Reel rules', reelRulesPage(text, false, back, problems.join(' ')), request.query));
    }
    deps.settings.set(REEL_RULES_KEY, text);
    return reply.redirect(join('Reel rules saved. The next reel uses them.'), 303);
  });

  /** Make the reel of a published article that has none (the Reels page). */
  app.post('/new-website/reels/make/:seoId', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { seoId: string }).seoId) || 0);
    if (!row) return reply.redirect('/new-website/sharing/reels', 303);
    const ok = isPublished(row) && createReels(row.id, true) > 0;
    void kickReels(reels);
    return reply.redirect(sharePage(request, row.plan_id, ok ? `Making the reel of “${row.keyword}”.` : `“${row.keyword}” is not published, or has its reel already.`, ok ? 'ok' : 'error'), 303);
  });

  app.post('/new-website/reels/:id/remake', async (request, reply) => {
    const reel = getReel(Number((request.params as { id: string }).id) || 0);
    const row = reel ? getSeoRow(reel.seo_id) : undefined;
    if (!reel || !row) return reply.redirect('/new-website/sharing/reels', 303);
    const ok = remakeReel(reel.id);
    void kickReels(reels);
    return reply.redirect(sharePage(request, row.plan_id, ok ? 'Making the reel again.' : 'That reel is being made right now.', ok ? 'ok' : 'error'), 303);
  });

  /** Send a made reel to the channels ticked on its card (or put failed ones back to work). */
  app.post('/new-website/reels/:id/share', async (request, reply) => {
    const reel = getReel(Number((request.params as { id: string }).id) || 0);
    const row = reel ? getSeoRow(reel.seo_id) : undefined;
    if (!reel || !row) return reply.redirect('/new-website/sharing/reels', 303);
    const raw = (request.body as { channel?: string | string[] } | undefined)?.channel;
    const ids = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(Number).filter(Boolean);
    if (!ids.length) return reply.redirect(sharePage(request, row.plan_id, 'Tick at least one channel.', 'error'), 303);
    let sent = 0;
    for (const id of ids) sent += shareReelOn(reel.id, id);
    void kickReelShares(shares);
    return reply.redirect(
      sharePage(request, row.plan_id, sent ? `Sending the reel to ${sent} channel${sent === 1 ? '' : 's'}.` : 'That reel is not made yet, or is already on those channels.', sent ? 'ok' : 'error'),
      303,
    );
  });

  app.post('/new-website/reels/shares/:id/retry', async (request, reply) => {
    const share = getReelShare(Number((request.params as { id: string }).id) || 0);
    const reel = share ? getReel(share.reel_id) : undefined;
    const row = reel ? getSeoRow(reel.seo_id) : undefined;
    if (!share || !row) return reply.redirect('/new-website/sharing', 303);
    retryReelShare(share.id);
    void kickReelShares(shares);
    return reply.redirect(sharePage(request, row.plan_id, 'Trying it again.'), 303);
  });

  /** Share one published article on every channel it is not on yet. */
  app.post('/new-website/keywords/share/:id', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    if (!isPublished(row)) return reply.redirect(sharePage(request, row.plan_id, `“${row.keyword}” is not published yet.`, 'error'), 303);
    const added = createSocialPosts(row.id);
    void kickSocial(deps);
    return reply.redirect(
      sharePage(request, row.plan_id, added ? `Sharing “${row.keyword}” on ${added} channel${added === 1 ? '' : 's'}.` : `“${row.keyword}” is already on every channel.`),
      303,
    );
  });

  /** Share every published article of a plan on the channels it is not on yet. */
  app.post('/new-website/keywords/plan/:id/share', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    let added = 0;
    for (const r of listPlanSeo(planId).filter(isPublished)) added += createSocialPosts(r.id);
    void kickSocial(deps);
    return reply.redirect(sharePage(request, planId, added ? `Sharing ${added} post${added === 1 ? '' : 's'}, one after the other.` : 'Everything published is already shared.'), 303);
  });

  /** Make a post's words and picture again from the article. */
  app.post('/new-website/keywords/share/post/:id/remake', async (request, reply) => {
    const post = getSocialPost(Number((request.params as { id: string }).id) || 0);
    const row = post ? getSeoRow(post.seo_id) : undefined;
    if (!post || !row) return reply.redirect('/new-website/keywords', 303);
    const ok = remakeSocialPost(post.id);
    void kickSocial(deps);
    return reply.redirect(sharePage(request, row.plan_id, ok ? 'Making it again from the article.' : 'It already went out, or its picture is being made.', ok ? 'ok' : 'error'), 303);
  });

  /* -- Each platform's rules file ------------------------------------------ */

  /** The page has the title already, and a list item wrapped onto the next line is one item. */
  const forDisplay = (text: string): string => text.replace(/^# .*\n+/, '').replace(/\n {2,}/g, ' ');

  app.get('/new-website/channels/rules/:platform', async (request, reply) => {
    const platform = String((request.params as { platform: string }).platform ?? '');
    if (!/^[a-z0-9-]+$/.test(platform)) return reply.redirect('/new-website/channels', 303);
    const check = checkPlatformRules(platform);
    const others = listPlatformRules().filter((r) => r.platform !== platform);
    return reply.type('text/html; charset=utf-8').send(
      newLayout({
        title: `${check.rules?.label ?? platform} rules`,
        active: '/new-website/channels',
        flash: deps.readFlash(request.query),
        body: html`
          <style>.sc-meta { color: var(--faint); font-size: 13px; } .rl-body { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 24px 28px; box-shadow: var(--shadow); max-width: 72ch; }
            .rl-body h2 { font-size: 18px; margin: 24px 0 8px; } .rl-body ul { padding-left: 20px; display: grid; gap: 4px; }
            .rl-state { display: grid; gap: 8px; margin: 0 0 20px; } .rl-facts { display: grid; grid-template-columns: 170px 1fr; gap: 6px 16px; margin: 0 0 20px; font-size: 14px; }
            .rl-facts dt { color: var(--faint); } .rl-facts dd { margin: 0; font-weight: 500; }</style>
          <div class="ns-head">
            <div>
              <h1 class="ns-title">${check.rules?.label ?? platform} rules</h1>
              <p class="ns-lede">What the sharing phase makes for every ${check.rules?.label ?? platform} channel after an article is published. Edit prompts/${check.file} to change it: the next post uses the new rules. Add a file to that folder for another platform; remove it to stop one.</p>
            </div>
            <a class="ns-btn quiet" href="/new-website/channels">All channels</a>
          </div>
          <div class="rl-state">
            ${check.rules
              ? html`<div><span class="ns-badge ok">This rules file is valid</span></div>`
              : html`<div class="ns-alert bad"><b>This rules file has problems, so nothing is made for ${platform} until they are fixed:</b>
                  <ul>${check.errors.map((e) => html`<li>${e}</li>`)}</ul></div>`}
          </div>
          ${check.rules
            ? html`<dl class="rl-facts">
                <dt>Each post</dt><dd>${check.rules.postLabel}</dd>
                <dt>Fields the AI writes</dt><dd>${check.rules.fields.join(', ')}</dd>
                <dt>Post text</dt><dd>${check.rules.postText}</dd>
                <dt>Picture</dt><dd>${check.rules.pictureShape === 'PORTRAIT_3_4' ? '3:4 portrait' : '16:9 wide'}, from ${check.rules.pictureTemplates.join(', ')}</dd>
                <dt>The article link</dt><dd>${{ pin_link: 'The post’s own link', first_comment: 'The first comment', none: 'Not added' }[check.rules.link]}</dd>
                <dt>Limits</dt><dd>${Object.entries(check.rules.limits).map(([k, [a, b]]) => `${k} ${a}–${b}`).join(' · ') || 'None'}</dd>
              </dl>
              <div class="rl-body">${raw(markdownToHtml(forDisplay(check.rules.text)))}</div>`
            : raw('')}
          ${others.length ? html`<p class="sc-meta" style="margin-top:20px">Other rules files: ${others.map((r) => html`<a href="/new-website/channels/rules/${r.platform}">${r.platform}</a> `)}</p>` : raw('')}`,
      }),
    );
  });

  /** Try a failed post again, from the Share step. */
  app.post('/new-website/keywords/share/post/:id/retry', async (request, reply) => {
    const post = getSocialPost(Number((request.params as { id: string }).id) || 0);
    const row = post ? getSeoRow(post.seo_id) : undefined;
    if (!post || !row) return reply.redirect('/new-website/keywords', 303);
    retrySocialPost(post.id);
    void kickSocial(deps);
    return reply.redirect(sharePage(request, row.plan_id, 'Trying it again.'), 303);
  });

  app.post('/new-website/shared/:id/retry', async (request, reply) => {
    retrySocialPost(Number((request.params as { id: string }).id) || 0);
    void kickSocial(deps);
    return reply.redirect(`/new-website/sharing?ok=${encodeURIComponent('Trying it again.')}`, 303);
  });
}
