import { html, raw, timeAgo, type Html } from './layout.js';
import type { ReelView } from '../../db/repos.js';

/**
 * Everything recorded about one reel, on one page.
 *
 * A run has this and a reel did not, so the only account of a failure was
 * whatever fitted on a card in the list — which clipped mid-sentence exactly
 * when the message mattered, on a generation that costs credits to repeat.
 * The prompt that was sent, the reference images it was sent with, the job id
 * and the error in full are all already stored; none of them were readable.
 */

const REEL_STATE: Record<string, string> = {
  draft: 'pending',
  generating: 'pending',
  ready: 'ok',
  publishing: 'pending',
  published: 'ok',
  failed: 'failed',
};

function references(reel: ReelView): string[] {
  try {
    const parsed = JSON.parse(reel.reference_json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function fact(label: string, value: Html | string | null): Html {
  if (value === null || value === '') return raw('');
  return html`
    <div class="field">
      <label>${label}</label>
      <div>${value}</div>
    </div>
  `;
}

export function reelDetailPage(reel: ReelView): Html {
  const images = references(reel);

  return html`
    <p class="small"><a href="/reels">&larr; All reels</a></p>

    <h1>${reel.run_title || 'Reel'}</h1>
    <p class="muted">
      <span class="badge ${REEL_STATE[reel.status] ?? 'pending'}">${reel.status}</span>
      &middot; ${reel.site_domain ?? 'no site'} &middot; ${reel.seed_keyword ?? 'no niche'}
      &middot; created ${timeAgo(reel.created_at)}
    </p>

    ${reel.error
      ? html`
          <div class="card">
            <h2>What went wrong</h2>
            <pre>${reel.error}</pre>
          </div>
        `
      : raw('')}

    ${reel.video_url
      ? html`
          <div class="card">
            <h2>The video</h2>
            <video src="${reel.video_url}" controls playsinline style="max-width:100%"></video>
            <pre>${reel.video_url}</pre>
          </div>
        `
      : raw('')}

    <div class="card">
      <h2>Where it goes</h2>
      ${fact(
        'Page',
        reel.page_name || reel.page_external_id
          ? html`${reel.page_name || reel.page_external_id}`
          : html`<span class="muted">No page routed — it will wait here.</span>`,
      )}
      ${fact('Caption', reel.caption ? html`<pre>${reel.caption}</pre>` : null)}
      ${fact(
        'Published as',
        reel.fb_video_id ? html`<code>${reel.fb_video_id}</code>` : null,
      )}
    </div>

    <div class="card">
      <h2>What was sent</h2>
      ${fact('Video job', reel.job_id ? html`<code>${reel.job_id}</code>` : null)}
      ${fact(
        'Article',
        reel.post_url ? html`<a href="${reel.post_url}" rel="noreferrer">${reel.post_url}</a>` : null,
      )}

      <div class="field">
        <label>Reference images (${images.length})</label>
        ${images.length === 0
          ? html`<span class="muted">None recorded.</span>`
          : html`<div class="pick-grid">
              ${images.map(
                (url) => html`<a href="${url}" rel="noreferrer">
                  <img src="${url}" alt="Reference" loading="lazy" />
                </a>`,
              )}
            </div>`}
      </div>

      <div class="field">
        <label>Prompt</label>
        <pre>${reel.prompt}</pre>
      </div>
    </div>
  `;
}
