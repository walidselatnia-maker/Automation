import type { FastifyInstance } from 'fastify';
import { html, raw, type Html } from '../web/views/layout.js';
import { listChannels, websiteChannels } from './channels.js';
import { newLayout, type NewFlash } from './layout.js';
import { createSocialPosts, getSocialPost, kickSocial, listPlanSocialPosts, remakeSocialPost, retrySocialPost, type SocialDeps } from './social.js';
import { getSeoRow, listPlanSeo } from './seo.js';
import { getKeywordPlan, listKeywordPlans, listNewWebsites } from './repo.js';
import { listPlanSocialPictures } from './pictures.js';
import { readyFor } from './keywords-view.js';
import { shareArticlesStep, sharingPage, shareWebsiteStep, type SharingSite } from './sharing-view.js';
import { checkPlatformRules, listPlatformRules } from './platform-rules.js';
import { markdownToHtml } from './markdown.js';

export function registerSocialRoutes(app: FastifyInstance, deps: SocialDeps & { readFlash: (q: unknown) => NewFlash; autoStart?: boolean }): void {
  // Posts left ready or waiting by a restart carry on.
  if (deps.autoStart !== false) void kickSocial(deps);

  /* -- The Sharing page ---------------------------------------------------- */

  /** Every website, with its published articles and the posts made from them. */
  const sharingSites = (): SharingSite[] => {
    const plans = listKeywordPlans();
    return listNewWebsites().map((site) => {
      const own = plans.filter((p) => p.website_id === site.id).sort((x, y) => x.id - y.id);
      const out: SharingSite = { site, channels: websiteChannels(site.id), articles: [], posts: [], pictures: [], unpublished: 0 };
      for (const plan of own) {
        const rows = listPlanSeo(plan.id);
        const published = readyFor('share', site, rows);
        const intentOf = new Map(plan.items.map((i) => [i.keyword, i.intent]));
        out.articles.push(...published.map((row) => ({ row, intent: intentOf.get(row.keyword) ?? '', planId: plan.id, pillar: plan.pillar })));
        out.unpublished += rows.length - published.length;
        out.posts.push(...listPlanSocialPosts(plan.id));
        out.pictures.push(...listPlanSocialPictures(plan.id));
      }
      return out;
    });
  };
  const page = (title: string, body: ReturnType<typeof sharingPage>, query: unknown): string =>
    newLayout({ title, active: '/new-website/sharing', body, flash: deps.readFlash(query) });

  /** Back to a website's card on the Sharing page, with a message. */
  const sharingAt = (websiteId: number, message: string, kind: 'ok' | 'error' = 'ok'): string =>
    `/new-website/sharing?${kind}=${encodeURIComponent(message)}#website-${websiteId}`;
  const sharePage = (planId: number, message: string, kind: 'ok' | 'error' = 'ok'): string =>
    sharingAt(getKeywordPlan(planId)?.website_id ?? 0, message, kind);

  app.get('/new-website/sharing', async (request, reply) => {
    const planId = Number((request.query as { plan?: string }).plan) || 0;
    const plan = planId ? getKeywordPlan(planId) : undefined;
    const filter = plan ? { id: plan.id, pillar: plan.pillar, websiteId: plan.website_id } : null;
    return reply.type('text/html; charset=utf-8').send(page('Sharing', sharingPage(sharingSites(), listChannels(), filter), request.query));
  });

  /** What changed, for the page to reload itself while posts are being made. */
  app.get('/new-website/sharing/state', async () => ({
    key: sharingSites()
      .flatMap((s) => [...s.posts.map((p) => `${p.id}${p.status}`), ...s.pictures.map((x) => `p${x.id}${x.status}`), ...s.articles.map((a) => `a${a.row.id}`)])
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
    for (const id of ids.filter((i) => allowed.has(i))) added += createSocialPosts(id);
    void kickSocial(deps);
    return reply.redirect(sharingAt(websiteId, added ? `Sharing ${added} post${added === 1 ? '' : 's'}, one after the other.` : 'Those articles are already on every channel.'), 303);
  });

  /** The old Shared content page is now part of Sharing. */
  app.get('/new-website/shared', async (_request, reply) => reply.redirect('/new-website/sharing', 303));
  const isPublished = (r: { post_status: string; post_url: string }) => r.post_status === 'published' && Boolean(r.post_url);

  /** Share one published article on every channel it is not on yet. */
  app.post('/new-website/keywords/share/:id', async (request, reply) => {
    const row = getSeoRow(Number((request.params as { id: string }).id) || 0);
    if (!row) return reply.redirect('/new-website/keywords', 303);
    if (!isPublished(row)) return reply.redirect(sharePage(row.plan_id, `“${row.keyword}” is not published yet.`, 'error'), 303);
    const added = createSocialPosts(row.id);
    void kickSocial(deps);
    return reply.redirect(
      sharePage(row.plan_id, added ? `Sharing “${row.keyword}” on ${added} channel${added === 1 ? '' : 's'}.` : `“${row.keyword}” is already on every channel.`),
      303,
    );
  });

  /** Share every published article of a plan on the channels it is not on yet. */
  app.post('/new-website/keywords/plan/:id/share', async (request, reply) => {
    const planId = Number((request.params as { id: string }).id) || 0;
    let added = 0;
    for (const r of listPlanSeo(planId).filter(isPublished)) added += createSocialPosts(r.id);
    void kickSocial(deps);
    return reply.redirect(sharePage(planId, added ? `Sharing ${added} post${added === 1 ? '' : 's'}, one after the other.` : 'Everything published is already shared.'), 303);
  });

  /** Make a post's words and picture again from the article. */
  app.post('/new-website/keywords/share/post/:id/remake', async (request, reply) => {
    const post = getSocialPost(Number((request.params as { id: string }).id) || 0);
    const row = post ? getSeoRow(post.seo_id) : undefined;
    if (!post || !row) return reply.redirect('/new-website/keywords', 303);
    const ok = remakeSocialPost(post.id);
    void kickSocial(deps);
    return reply.redirect(sharePage(row.plan_id, ok ? 'Making it again from the article.' : 'It already went out, or its picture is being made.', ok ? 'ok' : 'error'), 303);
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
    return reply.redirect(sharePage(row.plan_id, 'Trying it again.'), 303);
  });

  app.post('/new-website/shared/:id/retry', async (request, reply) => {
    retrySocialPost(Number((request.params as { id: string }).id) || 0);
    void kickSocial(deps);
    return reply.redirect(`/new-website/sharing?ok=${encodeURIComponent('Trying it again.')}`, 303);
  });
}
