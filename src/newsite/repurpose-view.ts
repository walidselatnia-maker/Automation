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
.rp-head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.rp-site-info { display: flex; flex-direction: column; gap: 6px; }
.rp-title { margin: 0; font: 700 22px/1.25 var(--display); color: var(--ink); display: flex; align-items: center; gap: 12px; }
.rp-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; font-size: 13px; color: var(--soft); }
.rp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; margin-top: 16px; }
.rp-art-card { background: var(--raised); border: 1px solid var(--line); border-radius: var(--r-ctl); padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.rp-art-title { font-weight: 600; font-size: 15px; line-height: 1.35; color: var(--ink); text-decoration: none; }
.rp-art-title:hover { color: var(--accent-text); text-decoration: underline; }
.rp-art-meta { font-size: 12px; color: var(--soft); display: flex; justify-content: space-between; }
.rp-art-foot { margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.rp-posts-table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 14px; }
.rp-posts-table th, .rp-posts-table td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--line); }
.rp-posts-table th { color: var(--soft); font-weight: 600; font-size: 13px; }
.rp-post-text { font-family: var(--mono); font-size: 13px; color: var(--ink); max-height: 60px; overflow: hidden; text-overflow: ellipsis; white-space: pre-wrap; }
.rp-empty { border: 1px dashed var(--line); border-radius: var(--r-ctl); padding: 32px; text-align: center; color: var(--soft); font-size: 14px; }
`;

export function repurposePage(
  websites: NewWebsiteRow[],
  selectedSiteId: number | undefined,
  articlesOf: Map<number, RepurposeArticleRow[]>,
  postsOf: Map<number, (RepurposePostRow & { article_title: string; article_url: string; channel_name: string })[]>,
  channelsOf: Map<number, ChannelRow[]>,
  sentTodayOf: Map<number, number>,
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

          return html`<section class="rp-site-card" id="site-${String(site.id)}">
            <div class="rp-head-row">
              <div class="rp-site-info">
                <div class="rp-title">
                  <h2>${site.name}</h2>
                  <span class="ns-mono" style="font-size:14px;color:var(--soft);font-weight:400">${site.domain}</span>
                </div>
                <div class="rp-meta">
                  <span class="ns-badge ${status === 'active' ? 'good' : 'bad'}">Repurposing: ${status === 'active' ? 'Active' : 'Paused'}</span>
                  <span>Target: <b>${String(sentToday)} / ${String(site.repurpose_daily_target ?? 1)} today</b></span>
                  <span>Cooldown: <b>${String(site.repurpose_cooldown_days ?? 30)} days</b></span>
                  <span>${site.repurpose_auto_publish ? 'Auto-publish' : 'Manual approval'}</span>
                </div>
              </div>
              <div class="rp-actions">
                <form method="post" action="/new-website/repurpose/${String(site.id)}/toggle" style="margin:0">
                  <button class="ns-btn ${status === 'active' ? 'quiet' : 'primary'}">${status === 'active' ? 'Pause repurposing' : 'Resume repurposing'}</button>
                </form>
                <form method="post" action="/new-website/repurpose/${String(site.id)}/sync" style="margin:0">
                  <button class="ns-btn quiet">Fetch articles from site</button>
                </form>
              </div>
            </div>

            <!-- Settings disclosure -->
            <details style="margin-bottom: 20px;">
              <summary style="cursor:pointer;font-weight:600;font-size:14px;color:var(--accent-text)">Repurposing settings for ${site.name}</summary>
              <form method="post" action="/new-website/repurpose/${String(site.id)}/settings" style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-top:12px;padding:14px;background:var(--raised);border-radius:var(--r-ctl)">
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
            <h3 style="font-size:17px;margin:20px 0 10px">Discovered articles (${String(articles.length)})</h3>
            ${articles.length
              ? html`<div class="rp-grid">
                  ${articles.slice(0, 12).map((art) => {
                    const daysAgo = art.last_repurposed_at ? Math.floor((Date.now() / 1000 - art.last_repurposed_at) / 86400) : null;
                    return html`<div class="rp-art-card">
                      <a class="rp-art-title" href="${art.url}" target="_blank" rel="noopener">${art.title}</a>
                      <div class="rp-art-meta">
                        <span>${art.category ? art.category : 'Article'}</span>
                        <span>${daysAgo === null ? 'Never repurposed' : `Repurposed ${daysAgo}d ago`}</span>
                      </div>
                      ${art.excerpt ? html`<p style="font-size:13px;color:var(--soft);margin:0;line-height:1.4">${art.excerpt.slice(0, 120)}...</p>` : raw('')}
                      <div class="rp-art-foot">
                        ${channels.length
                          ? html`<form method="post" action="/new-website/repurpose/article/${String(art.id)}/generate" style="margin:0;display:flex;gap:6px">
                              <select name="channelId" style="padding:4px 8px;border-radius:var(--r-ctl);border:1px solid var(--line);font-size:12px">
                                ${channels.map((ch) => html`<option value="${String(ch.id)}">${ch.name} (${platformLabel(ch.platform)})</option>`)}
                              </select>
                              <button class="ns-btn small primary">Repurpose now</button>
                            </form>`
                          : html`<span style="font-size:12px;color:var(--soft)">No channels connected</span>`}
                      </div>
                    </div>`;
                  })}
                </div>`
              : html`<div class="rp-empty">
                  <p>No articles discovered yet from ${site.name}. Click "Fetch articles from site" to load your existing content.</p>
                </div>`}

            <!-- Generated Repurpose Posts -->
            <h3 style="font-size:17px;margin:28px 0 10px">Repurposed social posts (${String(posts.length)})</h3>
            ${posts.length
              ? html`<table class="rp-posts-table">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>Source article</th>
                      <th>Fresh generated copy</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${posts.slice(0, 20).map((p) => html`<tr>
                      <td><b>${p.channel_name}</b> <span style="font-size:12px;color:var(--soft)">(${platformLabel(p.platform)})</span></td>
                      <td><a href="${p.article_url}" target="_blank" rel="noopener" style="color:var(--accent-text);text-decoration:none">${p.article_title}</a></td>
                      <td>
                        ${p.title ? html`<div style="font-weight:600;margin-bottom:4px">${p.title}</div>` : raw('')}
                        <div class="rp-post-text">${p.text}</div>
                        ${p.error ? html`<div style="color:var(--bad);font-size:12px;margin-top:4px">${p.error}</div>` : raw('')}
                      </td>
                      <td><span class="ns-badge ${p.status === 'sent' ? 'good' : p.status === 'failed' ? 'bad' : 'idle'}">${p.status}</span></td>
                      <td>
                        <div style="display:flex;gap:6px">
                          ${p.status !== 'sent'
                            ? html`<form method="post" action="/new-website/repurpose/post/${String(p.id)}/send" style="margin:0">
                                <button class="ns-btn small primary">Send</button>
                              </form>`
                            : p.post_link
                              ? html`<a class="ns-btn small quiet" href="${p.post_link}" target="_blank" rel="noopener">View</a>`
                              : raw('')}
                          <form method="post" action="/new-website/repurpose/post/${String(p.id)}/delete" style="margin:0" onsubmit="return confirm('Delete this post?')">
                            <button class="ns-btn small danger">Delete</button>
                          </form>
                        </div>
                      </td>
                    </tr>`)}
                  </tbody>
                </table>`
              : html`<div class="rp-empty" style="margin-top:10px">
                  <p>No repurposed social posts generated yet for ${site.name}.</p>
                </div>`}
          </section>`;
        })
      : html`<div class="rp-empty"><h2>No websites yet</h2><p>Add a website to begin repurposing its published content.</p><a class="ns-btn primary" href="/new-website/add">Add website</a></div>`}
  `;
}
