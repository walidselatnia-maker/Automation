import { html, raw, type Html } from '../web/views/layout.js';
import type { NewWebsiteRow } from './repo.js';
import type { RepurposeArticleRow, RepurposePostRow } from './repurpose.js';
import { channelColor, platformName as platformLabel, type ChannelRow } from './channels.js';

const CSS = `
.rp-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 24px; }
.rp-tab { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 16px; border-radius: 999px; text-decoration: none; font-weight: 600; font-size: 14px; background: var(--idle); color: var(--idle-ink); border: 1px solid var(--idle-line); }
.rp-tab:hover { background: var(--idle-hover); }
.rp-tab.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.rp-site-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 22px 24px; margin-bottom: 30px; box-shadow: var(--shadow); }
details.rp-site-card summary::-webkit-details-marker { display: none; }
details.rp-site-card .rp-toggle-arrow { font-size: 14px; transition: transform .15s ease; display: inline-block; color: var(--soft); margin-right: 4px; }
details.rp-site-card:not([open]) .rp-toggle-arrow { transform: rotate(-90deg); }
.rp-head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.rp-site-info { display: flex; flex-direction: column; gap: 6px; }
.rp-title { margin: 0; font: 700 22px/1.25 var(--display); color: var(--ink); display: flex; align-items: center; gap: 12px; }
.rp-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; font-size: 13px; color: var(--soft); }
.rp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rp-art-title { font-weight: 600; font-size: 14px; line-height: 1.35; color: var(--ink); text-decoration: none; }
.rp-art-title:hover { color: var(--accent-text); text-decoration: underline; }
.rp-cat-tag { display: inline-block; font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--idle); color: var(--soft); margin-left: 8px; vertical-align: middle; }
.rp-articles-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; background: var(--raised); border-radius: var(--r-ctl); overflow: hidden; border: 1px solid var(--line); }
.rp-articles-table th, .rp-articles-table td { padding: 10px 14px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: middle; }
.rp-articles-table th { background: var(--surface); color: var(--soft); font-weight: 600; font-size: 13px; }
.rp-articles-table tbody tr:hover { background: var(--idle-hover); }
.rp-bulk-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 14px; background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-ctl); margin: 12px 0 10px; }
.rp-bulk-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rp-bulk-label { font-size: 13px; color: var(--soft); display: flex; align-items: center; gap: 6px; margin: 0; }
.rp-bulk-count { font-size: 13px; font-weight: 600; color: var(--ink); }
.rp-select { padding: 6px 10px; border-radius: var(--r-ctl); border: 1px solid var(--line); background: var(--surface); color: var(--ink); font-size: 13px; }
.rp-select.small { padding: 4px 8px; font-size: 12px; max-width: 140px; }
.rp-channel-row { display: flex; align-items: center; gap: 8px; }
.rp-thumb-box { display: inline-block; position: relative; }
.rp-thumb { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); cursor: pointer; display: block; transition: transform .15s ease, box-shadow .15s ease; background: var(--surface); }
.rp-thumb:hover { transform: scale(1.08); box-shadow: 0 4px 14px rgba(0,0,0,0.3); }
.rp-lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 9999; align-items: center; justify-content: center; padding: 24px; }
.rp-lightbox.open { display: flex; }
.rp-lightbox-inner { position: relative; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column; align-items: center; }
.rp-lightbox-inner img { max-width: 90vw; max-height: 85vh; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); object-fit: contain; }
.rp-lightbox-close { position: absolute; top: -38px; right: 0; font-size: 32px; color: #fff; cursor: pointer; line-height: 1; user-select: none; }
.rp-lightbox-close:hover { color: #f87171; }
.rp-posts-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 14px; }
.rp-posts-table th, .rp-posts-table td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--line); }
.rp-posts-table th { color: var(--soft); font-weight: 600; font-size: 13px; }
.rp-post-text { font-family: var(--mono); font-size: 13px; color: var(--ink); max-height: 60px; overflow: hidden; text-overflow: ellipsis; white-space: pre-wrap; }
.rp-empty { border: 1px dashed var(--line); border-radius: var(--r-ctl); padding: 32px; text-align: center; color: var(--soft); font-size: 14px; }
.rp-pagination { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 6px; margin: 24px 0 16px; }
.rp-page-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 36px; height: 36px; padding: 0 10px; border-radius: var(--r-ctl); font-size: 13px; font-weight: 500; text-decoration: none; background: var(--raised); color: var(--ink); border: 1px solid var(--line); transition: all .15s ease; }
.rp-page-btn:hover:not(.disabled):not(.active) { background: var(--idle-hover); border-color: var(--soft); }
.rp-page-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 700; }
.rp-page-btn.disabled { opacity: 0.35; cursor: not-allowed; pointer-events: none; }
.rp-page-ellipsis { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 36px; color: var(--soft); font-size: 13px; }
.rp-page-jump { display: inline-flex; align-items: center; gap: 6px; margin-left: 10px; }
.rp-page-jump input { width: 64px; height: 36px; padding: 0 8px; border-radius: var(--r-ctl); border: 1px solid var(--line); background: var(--raised); color: var(--ink); font-size: 13px; text-align: center; }
`;

function paginationWindow(current: number, total: number): (number | '...')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  if (current <= 4) {
    return [1, 2, 3, 4, 5, '...', total];
  }
  if (current >= total - 3) {
    return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
  }
  return [1, '...', current - 1, current, current + 1, '...', total];
}

function makePageUrl(siteId: number, targetPage: number, selectedSiteId?: number): string {
  const params = new URLSearchParams();
  if (selectedSiteId || siteId) {
    params.set('website', String(selectedSiteId ?? siteId));
  }
  if (targetPage > 1) {
    params.set('page', String(targetPage));
  }
  const s = params.toString();
  return `/new-website/repurpose${s ? `?${s}` : ''}#discovered-articles`;
}

export function repurposePage(
  websites: NewWebsiteRow[],
  selectedSiteId: number | undefined,
  articlesOf: Map<number, RepurposeArticleRow[]>,
  postsOf: Map<number, (RepurposePostRow & { article_title: string; article_url: string; article_cover_url?: string; channel_name: string })[]>,
  channelsOf: Map<number, ChannelRow[]>,
  sentTodayOf: Map<number, number>,
  currentPage: number = 1,
): Html {
  const visibleSites = selectedSiteId
    ? websites.filter((s) => s.id === selectedSiteId)
    : websites;

  return html`
    <style>${raw(CSS)}</style>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Repurpose old content</h1>
        <p class="ns-lede">Automatically discover existing articles from your connected websites and turn them into fresh, platform-tailored social posts with original angles.</p>
      </div>
    </div>

    ${websites.length > 1
      ? html`<nav class="rp-tabs" aria-label="Websites">
          <a class="rp-tab ${!selectedSiteId ? 'on' : ''}" href="/new-website/repurpose">
            All websites <span class="n">(${String(websites.length)})</span>
          </a>
          ${websites.map((s) => {
            const count = (articlesOf.get(s.id) ?? []).length;
            const isSel = selectedSiteId === s.id;
            return html`<a class="rp-tab ${isSel ? 'on' : ''}" href="/new-website/repurpose?website=${String(s.id)}">
              ${s.name} <span class="n">(${String(count)})</span>
            </a>`;
          })}
        </nav>`
      : raw('')}

    ${visibleSites.length
      ? visibleSites.map((site) => {
          const articles = articlesOf.get(site.id) ?? [];
          const posts = postsOf.get(site.id) ?? [];
          const channels = channelsOf.get(site.id) ?? [];
          const sentToday = sentTodayOf.get(site.id) ?? 0;
          const status = site.repurpose_status ?? 'paused';

          const pageSize = 24;
          const totalPages = Math.max(1, Math.ceil(articles.length / pageSize));
          const safePage = Math.min(Math.max(1, currentPage), totalPages);
          const startIdx = (safePage - 1) * pageSize;
          const pagedArticles = articles.slice(startIdx, startIdx + pageSize);
          const pageNums = paginationWindow(safePage, totalPages);

          return html`<details class="rp-site-card" open id="site-${String(site.id)}">
            <summary class="rp-head-row" style="cursor:pointer;list-style:none">
              <div class="rp-site-info">
                <div class="rp-title">
                  <span class="rp-toggle-arrow">▼</span>
                  <h2>${site.name}</h2>
                  <span class="ns-mono" style="font-size:14px;color:var(--soft);font-weight:400">${site.domain}</span>
                </div>
                <div class="rp-meta">
                  <span class="ns-badge ${status === 'active' ? 'good' : 'bad'}">Repurposing: ${status === 'active' ? 'Active' : 'Paused'}</span>
                  <span>Target: <b>${String(sentToday)} / ${String(site.repurpose_daily_target ?? 1)} today</b></span>
                  <span>Cooldown: <b>${String(site.repurpose_cooldown_days ?? 30)} days</b></span>
                  <span>${site.repurpose_auto_publish ? 'Auto-publish' : 'Manual approval'}</span>
                  <span>Articles: <b>${String(articles.length)}</b></span>
                  <span>Posts: <b>${String(posts.length)}</b></span>
                </div>
              </div>
              <div class="rp-actions" onclick="event.stopPropagation()">
                <form method="post" action="/new-website/repurpose/${String(site.id)}/toggle" style="margin:0">
                  <input type="hidden" name="page" value="${String(safePage)}" />
                  <button class="ns-btn ${status === 'active' ? 'quiet' : 'primary'}">${status === 'active' ? 'Pause repurposing' : 'Resume repurposing'}</button>
                </form>
                <form method="post" action="/new-website/repurpose/${String(site.id)}/sync" style="margin:0">
                  <button class="ns-btn quiet">Fetch articles from site</button>
                </form>
              </div>
            </summary>

            <!-- Settings disclosure -->
            <details style="margin-bottom: 20px;">
              <summary style="cursor:pointer;font-weight:600;font-size:14px;color:var(--accent-text)">Repurposing settings for ${site.name}</summary>
              <form method="post" action="/new-website/repurpose/${String(site.id)}/settings" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-top:12px;padding:14px;background:var(--raised);border-radius:var(--r-ctl)">
                <input type="hidden" name="page" value="${String(safePage)}" />
                <div>
                  <label style="display:block;font-size:13px;color:var(--soft);margin-bottom:4px">Daily limit</label>
                  <input type="number" name="dailyTarget" min="1" max="50" value="${String(site.repurpose_daily_target ?? 1)}" style="width:100px;padding:6px 10px;border-radius:var(--r-ctl);border:1px solid var(--line)" />
                </div>
                <div>
                  <label style="display:block;font-size:13px;color:var(--soft);margin-bottom:4px">Cooldown (days)</label>
                  <input type="number" name="cooldownDays" min="1" max="365" value="${String(site.repurpose_cooldown_days ?? 30)}" style="width:100px;padding:6px 10px;border-radius:var(--r-ctl);border:1px solid var(--line)" />
                </div>
                <div>
                  <label style="display:flex;align-items:center;gap:6px;font-size:13px;height:36px">
                    <input type="checkbox" name="autoPublish" value="1" ${site.repurpose_auto_publish ? raw('checked') : raw('')} />
                    Auto publish
                  </label>
                </div>
                <button class="ns-btn small primary">Save settings</button>
              </form>
            </details>

            <!-- Discovered Articles -->
            <div id="discovered-articles" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin:24px 0 12px">
              <h3 style="font-size:17px;margin:0">Discovered articles (${String(articles.length)})</h3>
              ${articles.length > pageSize
                ? html`<div style="font-size:13px;color:var(--soft);display:flex;align-items:center;gap:10px">
                    <span>Showing <b>${String(startIdx + 1)}–${String(Math.min(articles.length, startIdx + pageSize))}</b> of <b>${String(articles.length)}</b> (Oldest first)</span>
                    <span style="border-left:1px solid var(--line);padding-left:10px">Page <b>${String(safePage)}</b> of <b>${String(totalPages)}</b></span>
                  </div>`
                : raw('')}
            </div>

            ${articles.length
              ? html`
                  <form method="post" action="/new-website/repurpose/${String(site.id)}/bulk-articles" id="bulk-form-${String(site.id)}">
                    <input type="hidden" name="page" value="${String(safePage)}" />

                    <!-- Bulk action toolbar -->
                    <div class="rp-bulk-bar">
                      <div class="rp-bulk-left">
                        <span class="rp-bulk-count" id="bulk-count-${String(site.id)}">0 articles selected</span>
                      </div>
                      <div class="rp-bulk-actions">
                        <label class="rp-bulk-label">
                          Channel:
                          <select name="channelId" class="rp-select">
                            <option value="all">All connected channels (${String(channels.length)})</option>
                            ${channels.map((ch) => html`<option value="${String(ch.id)}">${ch.name} (${platformLabel(ch.platform)})</option>`)}
                          </select>
                        </label>
                        <button name="bulkAction" value="repurpose" class="ns-btn small primary">Repurpose selected</button>
                        <button name="bulkAction" value="pause" class="ns-btn small quiet">Pause selected</button>
                        <button name="bulkAction" value="activate" class="ns-btn small quiet">Mark active</button>
                        <button name="bulkAction" value="delete" class="ns-btn small danger" onclick="return confirm('Remove selected articles?')">Delete</button>
                      </div>
                    </div>

                    <table class="rp-articles-table">
                      <thead>
                        <tr>
                          <th style="width:36px;text-align:center">
                            <input type="checkbox" class="rp-select-all" data-site="${String(site.id)}" title="Select all on this page" />
                          </th>
                          <th>Title</th>
                          <th style="width:170px">Status</th>
                          <th style="width:260px">Channels</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${pagedArticles.map((art) => {
                          const daysAgo = art.last_repurposed_at ? Math.floor((Date.now() / 1000 - art.last_repurposed_at) / 86400) : null;
                          const statusText = art.status === 'paused' ? 'Paused' : daysAgo === null ? 'Never repurposed' : `Repurposed ${daysAgo}d ago`;
                          const badgeClass = art.status === 'paused' ? 'bad' : daysAgo === null ? 'idle' : 'good';
                          return html`<tr>
                            <td style="text-align:center">
                              <input type="checkbox" name="articleIds" value="${String(art.id)}" class="rp-art-cb rp-cb-${String(site.id)}" />
                            </td>
                            <td>
                              <a class="rp-art-title" href="${art.url}" target="_blank" rel="noopener">${art.title}</a>
                              ${art.category ? html`<span class="rp-cat-tag">${art.category}</span>` : raw('')}
                            </td>
                            <td>
                              <span class="ns-badge ${badgeClass}">${statusText}</span>
                            </td>
                            <td>
                              ${channels.length
                                ? html`<div class="rp-channel-row">
                                    <select class="rp-select small" onchange="document.getElementById('row-ch-${String(art.id)}').value = this.value">
                                      ${channels.map((ch) => html`<option value="${String(ch.id)}">${ch.name} (${platformLabel(ch.platform)})</option>`)}
                                    </select>
                                    <form method="post" action="/new-website/repurpose/article/${String(art.id)}/generate" style="margin:0">
                                      <input type="hidden" name="page" value="${String(safePage)}" />
                                      <input type="hidden" name="channelId" id="row-ch-${String(art.id)}" value="${String(channels[0]?.id ?? '')}" />
                                      <button class="ns-btn small primary">Repurpose</button>
                                    </form>
                                  </div>`
                                : html`<span style="font-size:12px;color:var(--soft)">No channels connected</span>`}
                            </td>
                          </tr>`;
                        })}
                      </tbody>
                    </table>
                  </form>

                  ${totalPages > 1
                    ? html`<nav class="rp-pagination" aria-label="Articles pagination">
                        <a class="rp-page-btn ${safePage <= 1 ? 'disabled' : ''}" href="${makePageUrl(site.id, 1, selectedSiteId)}" title="First page">&laquo;</a>
                        <a class="rp-page-btn ${safePage <= 1 ? 'disabled' : ''}" href="${makePageUrl(site.id, safePage - 1, selectedSiteId)}" title="Previous page">&lsaquo;</a>
                        ${pageNums.map((p) =>
                          p === '...'
                            ? html`<span class="rp-page-ellipsis">&hellip;</span>`
                            : html`<a class="rp-page-btn ${p === safePage ? 'active' : ''}" href="${makePageUrl(site.id, p as number, selectedSiteId)}">${String(p)}</a>`,
                        )}
                        <a class="rp-page-btn ${safePage >= totalPages ? 'disabled' : ''}" href="${makePageUrl(site.id, safePage + 1, selectedSiteId)}" title="Next page">&rsaquo;</a>
                        <a class="rp-page-btn ${safePage >= totalPages ? 'disabled' : ''}" href="${makePageUrl(site.id, totalPages, selectedSiteId)}" title="Last page">&raquo;</a>
                        <form class="rp-page-jump" method="get" action="/new-website/repurpose">
                          <input type="hidden" name="website" value="${String(selectedSiteId ?? site.id)}" />
                          <input type="number" name="page" min="1" max="${String(totalPages)}" placeholder="Page" aria-label="Go to page" />
                          <button class="ns-btn small quiet" type="submit">Go</button>
                        </form>
                      </nav>`
                    : raw('')}`
              : html`<div class="rp-empty">
                  <p>No articles discovered yet from ${site.name}. Click "Fetch articles from site" to load your existing content.</p>
                </div>`}

            <!-- Generated Repurpose Posts -->
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin:28px 0 10px">
              <h3 style="font-size:17px;margin:0">Repurposed social posts (${String(posts.length)})</h3>
              ${posts.some((p) => p.status === 'failed')
                ? html`<form method="post" action="/new-website/repurpose/${String(site.id)}/retry-failed" style="margin:0">
                    <button class="ns-btn small danger">Regenerate all failed (${String(posts.filter((p) => p.status === 'failed').length)})</button>
                  </form>`
                : raw('')}
            </div>

            ${posts.length
              ? html`<table class="rp-posts-table">
                  <thead>
                    <tr>
                      <th style="width:180px">Channel</th>
                      <th style="width:72px">Image</th>
                      <th style="width:200px">Source article</th>
                      <th>Fresh generated copy</th>
                      <th style="width:90px">Status</th>
                      <th style="width:190px">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${posts.slice(0, 50).map((p) => {
                      const img = p.image_url || p.article_cover_url;
                      return html`<tr>
                      <td>
                        <b>${p.channel_name}</b> <span style="font-size:12px;color:var(--soft)">(${platformLabel(p.platform)})</span>
                        ${p.board_name ? html`<div style="font-size:12px;color:var(--soft);margin-top:2px">Board: <b>${p.board_name}</b></div>` : raw('')}
                      </td>
                      <td>
                        ${img
                          ? html`<div class="rp-thumb-box">
                              <img src="${img}" alt="${p.title || p.article_title}" class="rp-thumb" onclick="openLightbox(event, '${img}')" title="Click to enlarge" loading="lazy" />
                            </div>`
                          : html`<span style="font-size:12px;color:var(--soft)">No image</span>`}
                      </td>
                      <td><a href="${p.article_url}" target="_blank" rel="noopener" style="color:var(--accent-text);text-decoration:none">${p.article_title}</a></td>
                      <td>
                        ${p.title ? html`<div style="font-weight:600;margin-bottom:4px">${p.title}</div>` : raw('')}
                        <div class="rp-post-text">${p.text}</div>
                        ${p.error ? html`<div style="color:var(--bad);font-size:12px;margin-top:4px">${p.error}</div>` : raw('')}
                      </td>
                      <td><span class="ns-badge ${p.status === 'sent' ? 'good' : p.status === 'failed' ? 'bad' : 'idle'}">${p.status}</span></td>
                      <td>
                        <div style="display:flex;gap:6px;flex-wrap:wrap">
                          ${p.status === 'failed'
                            ? html`
                                <form method="post" action="/new-website/repurpose/post/${String(p.id)}/regenerate" style="margin:0">
                                  <button class="ns-btn small primary" title="Generate fresh copy and retry">Regenerate</button>
                                </form>
                                <form method="post" action="/new-website/repurpose/post/${String(p.id)}/send" style="margin:0">
                                  <button class="ns-btn small quiet">Retry</button>
                                </form>`
                            : p.status === 'waiting'
                              ? html`
                                  <form method="post" action="/new-website/repurpose/post/${String(p.id)}/send" style="margin:0">
                                    <button class="ns-btn small primary">Send</button>
                                  </form>
                                  <form method="post" action="/new-website/repurpose/post/${String(p.id)}/regenerate" style="margin:0">
                                    <button class="ns-btn small quiet" title="Generate fresh copy">Regenerate</button>
                                  </form>`
                              : html`
                                  ${p.post_link ? html`<a class="ns-btn small quiet" href="${p.post_link}" target="_blank" rel="noopener">View</a>` : raw('')}
                                  <form method="post" action="/new-website/repurpose/post/${String(p.id)}/regenerate" style="margin:0">
                                    <button class="ns-btn small quiet" title="Generate fresh copy">Regenerate</button>
                                  </form>`}
                          <form method="post" action="/new-website/repurpose/post/${String(p.id)}/delete" style="margin:0" onsubmit="return confirm('Delete this post?')">
                            <button class="ns-btn small danger">Delete</button>
                          </form>
                        </div>
                      </td>
                    </tr>`;
                    })}
                  </tbody>
                </table>`
              : html`<div class="rp-empty" style="margin-top:10px">
                  <p>No repurposed social posts generated yet for ${site.name}.</p>
                </div>`}
          </details>`;
        })
      : html`<div class="rp-empty"><h2>No websites yet</h2><p>Add a website to begin repurposing its published content.</p><a class="ns-btn primary" href="/new-website/add">Add website</a></div>`}

    <!-- Lightbox for image enlargement -->
    <div id="rp-lightbox" class="rp-lightbox" onclick="closeLightbox(event)">
      <div class="rp-lightbox-inner">
        <span class="rp-lightbox-close" onclick="closeLightbox()">&times;</span>
        <img id="rp-lightbox-img" src="" alt="Enlarged preview" />
      </div>
    </div>

    <script>
    (function () {
      document.querySelectorAll('.rp-select-all').forEach(function (allCb) {
        var siteId = allCb.dataset.site;
        var cbs = document.querySelectorAll('.rp-cb-' + siteId);
        var countEl = document.getElementById('bulk-count-' + siteId);
        function updateCount() {
          var checked = document.querySelectorAll('.rp-cb-' + siteId + ':checked').length;
          if (countEl) countEl.textContent = checked + ' article' + (checked === 1 ? '' : 's') + ' selected';
          allCb.checked = checked > 0 && checked === cbs.length;
          allCb.indeterminate = checked > 0 && checked < cbs.length;
        }
        allCb.addEventListener('change', function () {
          cbs.forEach(function (cb) { cb.checked = allCb.checked; });
          updateCount();
        });
        cbs.forEach(function (cb) {
          cb.addEventListener('change', updateCount);
        });
      });

      window.openLightbox = function (e, src) {
        if (e) e.preventDefault();
        var lb = document.getElementById('rp-lightbox');
        var img = document.getElementById('rp-lightbox-img');
        if (lb && img) {
          img.src = src;
          lb.classList.add('open');
        }
      };

      window.closeLightbox = function (e) {
        if (e && e.target && e.target.tagName === 'IMG') return;
        var lb = document.getElementById('rp-lightbox');
        if (lb) lb.classList.remove('open');
      };

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          var lb = document.getElementById('rp-lightbox');
          if (lb) lb.classList.remove('open');
        }
      });
    })();
    </script>
  `;
}
