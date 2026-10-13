import type { FastifyInstance } from 'fastify';
import { html, raw, type Html } from '../web/views/layout.js';
import { listChannels, PLATFORMS, type ChannelRow } from './channels.js';
import { newLayout, type NewFlash } from './layout.js';
import { createSocialPosts, getSocialPost, kickSocial, listSocialPosts, releaseHeld, remakeSocialPost, retrySocialPost, type SocialDeps, type SocialPostRow } from './social.js';
import { getSeoRow, listPlanSeo } from './seo.js';
import { approveRules, loadPlatformRules, rulesApproved, type RulesPlatform } from './platform-rules.js';
import { markdownToHtml } from './markdown.js';

/**
 * The Shared content page: everything that went out, organised as platform,
 * then page or board, then item. Named "Shared content" because "Content"
 * already means writing the articles.
 */

const CSS = `
.sc-platform { margin: 0 0 32px; }
.sc-platform > h2 { font-size: 20px; margin: 0 0 12px; }
.sc-channel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); margin: 0 0 16px; overflow: hidden; box-shadow: var(--shadow); }
.sc-channel > h3 { font-size: 15px; padding: 14px 18px; margin: 0; border-bottom: 1px solid var(--line); background: var(--raised); }
.sc-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.sc-item:last-child { border-bottom: 0; }
.sc-item a { color: var(--ink); font-weight: 600; text-decoration: none; }
.sc-item a:hover { color: var(--accent-text); }
.sc-meta { color: var(--faint); font-size: 13px; }
.sc-text { color: var(--soft); font-size: 13px; margin-top: 4px; max-width: 70ch; }
.sc-err { margin-top: 8px; font-size: 13px; padding: 8px 12px; border-left: 4px solid var(--bad); background: var(--bad-tint); color: var(--ink); border-radius: var(--r-ctl); }
.sc-status { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; font: 600 13px/1 var(--body); white-space: nowrap; background: var(--raised); color: var(--soft); border: 1px solid var(--line); }
.sc-status.sent { background: var(--good-tint); color: var(--good); border-color: transparent; }
.sc-status.failed { background: var(--bad-tint); color: var(--bad); border-color: transparent; }
.sc-status.waiting, .sc-status.picture, .sc-status.pending { background: var(--idle); color: var(--idle-ink); border-color: transparent; }
.sc-item form { margin: 6px 0 0; }
.sc-none { color: var(--soft); }
`;

const STATUS: Record<SocialPostRow['status'], string> = {
  pending: 'Queued',
  held: 'Waiting for the rules to be approved',
  picture: 'Making its picture',
  waiting: 'Waiting for room',
  sent: 'Posted',
  failed: 'Failed',
};

const KIND: Record<string, string> = { pin: 'Pin', fb_image: 'Image post' };

type Item = ReturnType<typeof listSocialPosts>[number];

function itemRow(i: Item): Html {
  return html`<div class="sc-item">
    <div>
      ${i.post_url ? html`<a href="${i.post_url}" target="_blank" rel="noopener">${i.title_seo || i.keyword}</a>` : html`<b>${i.title_seo || i.keyword}</b>`}
      <div class="sc-meta">${KIND[i.kind] ?? i.kind}${i.board_name ? ` · board “${i.board_name}”` : ''}${i.template ? ` · template ${i.template}` : ''} · queued ${i.created_at} UTC${i.sent_at ? ` · went out ${i.sent_at} UTC` : ''}</div>
      ${i.text ? html`<div class="sc-text">${i.text}</div>` : raw('')}
      ${i.error ? html`<div class="sc-err">${i.error}</div>` : raw('')}
      ${i.status === 'failed'
        ? html`<form method="post" action="/new-website/shared/${i.id}/retry"><button class="ns-btn small">Try again</button></form>`
        : raw('')}
    </div>
    <span class="sc-status ${i.status}">${STATUS[i.status]}</span>
  </div>`;
}

export function sharedContentPage(channels: ChannelRow[], items: Item[]): Html {
  const byChannel = new Map<number, Item[]>();
  for (const i of items) byChannel.set(i.channel_id, [...(byChannel.get(i.channel_id) ?? []), i]);
  const platforms = PLATFORMS.filter((p) => channels.some((c) => c.platform === p.key));
  return html`
    <style>${raw(CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Shared content</h1>
        <p class="ns-lede">Everything your articles were shared as, by platform and channel. The link to the article is never in the post: a pin carries it as its own link, and on Facebook it is the first comment.</p>
      </div>
    </div>
    ${platforms.length
      ? platforms.map(
          (p) => html`<section class="sc-platform"><h2>${p.label}</h2>
            ${channels
              .filter((c) => c.platform === p.key)
              .map(
                (c) => html`<div class="sc-channel"><h3>${c.name}</h3>
                  ${(byChannel.get(c.id) ?? []).length
                    ? (byChannel.get(c.id) ?? []).map(itemRow)
                    : html`<div class="sc-item"><span class="sc-none">Nothing shared on this channel yet.</span></div>`}
                </div>`,
              )}
          </section>`,
        )
      : html`<p class="sc-none">No channel yet. Add one on the <a href="/new-website/channels">Channels</a> page, then pick it in a website’s setup.</p>`}`;
}

export function registerSocialRoutes(app: FastifyInstance, deps: SocialDeps & { readFlash: (q: unknown) => NewFlash; autoStart?: boolean }): void {
  // Posts left ready or waiting by a restart carry on.
  if (deps.autoStart !== false) void kickSocial(deps);

  app.get('/new-website/shared', async (request, reply) =>
    reply.type('text/html; charset=utf-8').send(
      newLayout({
        title: 'Shared content',
        active: '/new-website/shared',
        body: sharedContentPage(listChannels(), listSocialPosts()),
        flash: deps.readFlash(request.query),
      }),
    ),
  );

  /* -- The Share step of a keyword plan ------------------------------------ */

  const sharePage = (planId: number, message: string, kind: 'ok' | 'error' = 'ok'): string =>
    `/new-website/keywords/plan/${planId}/share?${kind}=${encodeURIComponent(message)}`;
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

  /* -- Each platform's rules file, and the owner's approval ----------------- */

  /** The page has the title already, and a list item wrapped onto the next line is one item. */
  const forDisplay = (text: string): string => text.replace(/^# .*\n+/, '').replace(/\n {2,}/g, ' ');

  const PLATFORM_NAME: Record<RulesPlatform, string> = { pinterest: 'Pinterest', facebook: 'Facebook' };
  const platformOf = (raw: unknown): RulesPlatform | null => (raw === 'pinterest' || raw === 'facebook' ? raw : null);

  app.get('/new-website/channels/rules/:platform', async (request, reply) => {
    const platform = platformOf((request.params as { platform: string }).platform);
    if (!platform) return reply.redirect('/new-website/channels', 303);
    const rules = loadPlatformRules(platform);
    const ok = rulesApproved(rules, deps.settings);
    return reply.type('text/html; charset=utf-8').send(
      newLayout({
        title: `${PLATFORM_NAME[platform]} rules`,
        active: '/new-website/channels',
        flash: deps.readFlash(request.query),
        body: html`
          <style>${raw(CSS)}.rl-body { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 24px 28px; box-shadow: var(--shadow); max-width: 72ch; }
            .rl-body h1 { font-size: 24px; margin: 0 0 12px; } .rl-body h2 { font-size: 18px; margin: 24px 0 8px; } .rl-body ul { padding-left: 20px; display: grid; gap: 4px; }
            .rl-state { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 20px; }</style>
          <div class="ns-head">
            <div>
              <h1 class="ns-title">${PLATFORM_NAME[platform]} rules</h1>
              <p class="ns-lede">What the sharing phase makes for every ${PLATFORM_NAME[platform]} channel, after an article is published. The AI follows this file, and every post is checked against its Limits. Kept in prompts/platforms/${platform}.md.</p>
            </div>
            <a class="ns-btn quiet" href="/new-website/channels">All channels</a>
          </div>
          <div class="rl-state">
            ${ok
              ? html`<span class="ns-badge ok">Approved</span><span class="sc-meta">Posts are made and sent with these rules. If the file changes, it needs approving again.</span>`
              : html`<span class="ns-badge bad">Needs your approval</span><span class="sc-meta">Nothing is made or posted on ${PLATFORM_NAME[platform]} until you approve these rules.</span>
                <form method="post" action="/new-website/channels/rules/${platform}/approve" style="margin:0"><button class="ns-btn primary">Approve these rules</button></form>`}
          </div>
          <div class="rl-body">${raw(markdownToHtml(forDisplay(rules.text)))}</div>`,
      }),
    );
  });

  app.post('/new-website/channels/rules/:platform/approve', async (request, reply) => {
    const platform = platformOf((request.params as { platform: string }).platform);
    if (!platform) return reply.redirect('/new-website/channels', 303);
    approveRules(loadPlatformRules(platform), deps.settings);
    const released = releaseHeld(platform);
    void kickSocial(deps);
    return reply.redirect(
      `/new-website/channels/rules/${platform}?ok=${encodeURIComponent(`${PLATFORM_NAME[platform]} rules approved.${released ? ` ${released} waiting post${released === 1 ? '' : 's'} carry on.` : ''}`)}`,
      303,
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
    return reply.redirect(`/new-website/shared?ok=${encodeURIComponent('Trying it again.')}`, 303);
  });
}
