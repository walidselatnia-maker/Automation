import type { FastifyInstance } from 'fastify';
import { html, raw, type Html } from '../web/views/layout.js';
import { listChannels, PLATFORMS, type ChannelRow } from './channels.js';
import { newLayout, type NewFlash } from './layout.js';
import { kickSocial, listSocialPosts, retrySocialPost, type SocialDeps, type SocialPostRow } from './social.js';

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

  app.post('/new-website/shared/:id/retry', async (request, reply) => {
    retrySocialPost(Number((request.params as { id: string }).id) || 0);
    void kickSocial(deps);
    return reply.redirect(`/new-website/shared?ok=${encodeURIComponent('Trying it again.')}`, 303);
  });
}
