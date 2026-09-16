import { html, raw, timeAgo, type Html } from './layout.js';
import type { PresenterRow, ReelSceneRow, ReelView } from '../../db/repos.js';
import { formatByKey } from '../../reels/formats.js';

/**
 * One reel, as a storyboard.
 *
 * The finished reel at the top when there is one; then every scene with what
 * it is filmed from, what happens, what is said, and how far it got -- with
 * a Retry on any scene that failed, so one bad clip costs one clip. Below
 * that, where it goes and what was published.
 */

const REEL_STATE: Record<string, string> = {
  draft: 'pending',
  generating: 'pending',
  ready: 'ok',
  publishing: 'pending',
  published: 'ok',
  failed: 'failed',
};

const SCENE_STATE: Record<ReelSceneRow['status'], string> = {
  pending: 'muted',
  working: 'busy',
  done: 'ok',
  failed: 'error',
};

const SOURCE_LABEL: Record<string, string> = {
  feature: 'feature',
  topShot: 'top shot',
  textureMacro: 'texture macro',
  beforeAfter: 'before / after',
  pin: 'Pinterest graphic',
};

/** What the reel is doing right now, in a sentence. */
export function stageSentence(reel: ReelView, scenes: ReelSceneRow[]): string {
  if (reel.status === 'failed') return 'Stopped. See what went wrong below.';
  if (reel.status === 'published') return 'Published.';
  if (reel.status === 'ready') return 'Ready to publish.';
  if (reel.status === 'publishing') return 'Publishing to Facebook.';
  if (reel.status === 'draft') return 'Waiting to start.';
  switch (reel.stage) {
    case 'planning':
      return 'Writing the storyboard.';
    case 'imaging':
      return 'Making a picture for each scene.';
    case 'filming': {
      const done = scenes.filter((s) => s.status === 'done').length;
      return `Filming scene ${Math.min(done + 1, scenes.length)} of ${scenes.length}.`;
    }
    case 'assembling':
      return 'Joining the scenes into one reel.';
    default:
      return 'Generating the video.';
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

function sources(scene: ReelSceneRow): string[] {
  try {
    const parsed = JSON.parse(scene.sources_json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function sceneCard(reel: ReelView, scene: ReelSceneRow, presenter: PresenterRow | undefined): Html {
  return html`
    <div class="card scene">
      <div class="spread">
        <div>
          <strong>Scene ${scene.position}</strong>
          <span class="muted small">· ${scene.seconds} s</span>
          ${sources(scene).map(
            (role) => html`<span class="badge muted">${SOURCE_LABEL[role] ?? role}</span>`,
          )}
          ${scene.presenter === 1
            ? html`<span class="badge brand">with ${presenter?.name ?? 'the presenter'}</span>`
            : raw('')}
        </div>
        <span class="badge ${SCENE_STATE[scene.status]}">${scene.status}</span>
      </div>
      <p>${scene.motion_prompt}</p>
      ${scene.line ? html`<p class="muted">“${scene.line}”</p>` : raw('')}
      ${scene.error ? html`<pre>${scene.error}</pre>` : raw('')}
      ${scene.image_url
        ? html`<p class="small muted">Filmed from a fresh image:
            <a href="${scene.image_url}" target="_blank" rel="noopener">open</a></p>`
        : raw('')}
      ${scene.clip_path
        ? html`<video src="/reels/${reel.id}/scenes/${scene.id}/clip" controls playsinline
                     preload="none" style="max-width:100%;max-height:50vh"></video>`
        : raw('')}
      ${scene.status === 'failed'
        ? html`<form method="post" action="/reels/${reel.id}/scenes/${scene.id}/retry">
            <button type="submit">Retry this scene</button>
          </form>`
        : raw('')}
    </div>
  `;
}

export function reelDetailPage(
  reel: ReelView,
  scenes: ReelSceneRow[] = [],
  presenter: PresenterRow | undefined = undefined,
): Html {
  const format = formatByKey(reel.format);

  return html`
    <p class="small"><a href="/reels">&larr; All reels</a></p>

    <h1>${reel.run_title || 'Reel'}</h1>
    <p class="muted">
      <span class="badge ${REEL_STATE[reel.status] ?? 'pending'}">${reel.status}</span>
      &middot; ${stageSentence(reel, scenes)}
      ${format ? html`&middot; ${format.title}` : raw('')}
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

    ${reel.output_path
      ? html`
          <div class="card">
            <h2>The reel</h2>
            <video src="/reels/${reel.id}/video" controls playsinline
                   style="max-width:100%;max-height:70vh"></video>
          </div>
        `
      : reel.video_url
        ? html`
            <div class="card">
              <h2>The video</h2>
              <video src="${reel.video_url}" controls playsinline style="max-width:100%"></video>
            </div>
          `
        : raw('')}

    ${scenes.length
      ? html`<h2>Storyboard</h2>
          ${scenes.map((scene) => sceneCard(reel, scene, presenter))}`
      : raw('')}

    <div class="card">
      <h2>Where it goes</h2>
      ${fact(
        'Page',
        reel.page_name || reel.page_external_id
          ? html`${reel.page_name || reel.page_external_id}`
          : html`<span class="muted">No page has this niche — it will wait here.</span>`,
      )}
      ${fact('Presenter', presenter ? presenter.name : null)}
      ${fact('Caption', reel.caption ? html`<pre>${reel.caption}</pre>` : null)}
      ${fact(
        'Article',
        reel.post_url ? html`<a href="${reel.post_url}" rel="noreferrer">${reel.post_url}</a>` : null,
      )}
      ${fact('Published as', reel.fb_video_id ? html`<code>${reel.fb_video_id}</code>` : null)}
    </div>
  `;
}
