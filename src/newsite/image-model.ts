import type { FastifyInstance } from 'fastify';
import { html, raw, type Html } from '../web/views/layout.js';
import type { ImageModelCatalogue } from '../web/views/pages.js';
import type { Settings } from '../settings.js';
import { IMAGE_MODELS } from './platform.js';
import type { Fetch } from './platform.js';

/**
 * The image model setting, shown as cards in the Images part of the
 * Platform settings page (it is one platform setting, not a page of its own).
 *
 * The same setting the old dashboard's picker writes (image_model): the image
 * service reads it with every picture. Each card also shows what Google last
 * said to that model, read from the image service, the same way the old
 * Settings page does.
 */

const ABOUT: Record<string, string> = {
  auto: 'Nano Banana Pro first. If Google refuses it (no access or no credits left), Nano Banana 2.1, then Nano Banana 2 Lite.',
  NANO_BANANA_PRO: 'The best pictures. Limited credits: when they run out, Google refuses it.',
  NANO_BANANA_2_1: 'The current Nano Banana. Very good pictures, and Flow showed it at 0 credits.',
  NANO_BANANA_2_LITE: 'The fastest and lightest. Simpler pictures.',
};

/** The model names Google uses, read off the Flow page on 2026-10-10. */
const WIRE: Record<string, string> = {
  NANO_BANANA_PRO: 'GEM_PIX_2',
  NANO_BANANA_2_1: 'BELUGA',
  NANO_BANANA_2_LITE: 'HARBOR_SEAL',
};

const CSS = `
.im-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.im-card { display: flex; flex-direction: column; gap: 10px; width: 100%; text-align: left; padding: 20px; cursor: pointer;
  background: var(--idle); border: 1px solid var(--idle-line); border-radius: var(--r-card); color: var(--idle-ink); font: inherit; }
.im-card:hover { background: var(--idle-hover); }
.im-card.on { border-color: var(--accent); background: var(--accent-tint); color: var(--ink); box-shadow: inset 0 0 0 1px var(--accent); }
.im-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.im-card h2 { font-size: 18px; color: inherit; }
.im-pick { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px; font: 600 13px/1 var(--body); white-space: nowrap; background: var(--surface); color: var(--idle-ink); border: 1px solid var(--idle-line); }
.im-card.on .im-pick { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.im-about { margin: 0; color: inherit; font-size: 14px; }
.im-foot { margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; }
.im-wire { color: inherit; opacity: .85; }
.im-verdict { font-weight: 600; color: var(--faint); }
.im-verdict.accepted { color: var(--good); }
.im-verdict.refused, .im-verdict.rejected { color: var(--bad); }
.im-order { margin: 0 0 24px; color: var(--soft); font-size: 14px; }
`;

const verdict = (m: ImageModelCatalogue['models'][number] | undefined): Html => {
  if (!m) return html`<span class="im-verdict">Not tried yet</span>`;
  const text = { accepted: 'Working', refused: 'Refused by Google', rejected: 'Not a model Flow knows', untried: 'Not tried yet', unknown: 'Not tried yet' }[m.outcome];
  return html`<span class="im-verdict ${m.outcome}" title="${m.error ?? ''}">${text}</span>`;
};

/** The model cards: click one to use it. */
export function imageModelCards(current: string, catalogue: ImageModelCatalogue | null): Html {
  // A setting saved before Nano Banana 2 became 2.1 still means 2.1.
  const picked = current === 'NANO_BANANA_2' ? 'NANO_BANANA_2_1' : current || 'auto';
  const known = new Map((catalogue?.models ?? []).map((m) => [m.key === 'NANO_BANANA_2' ? 'NANO_BANANA_2_1' : m.key, m]));
  return html`
    <style>${raw(CSS)}</style>
    <p class="im-order">Which Google Flow model makes the pictures. Click a card to use it. On Automatic: Nano Banana Pro, then Nano Banana 2.1, then Nano Banana 2 Lite.</p>
    <form method="post" action="/new-website/image-model" class="im-grid">
      ${IMAGE_MODELS.map(
        (m) => html`<button class="im-card ${m.value === picked ? 'on' : ''}" name="image_model" value="${m.value}" aria-pressed="${m.value === picked ? 'true' : 'false'}">
          <div class="im-top"><h2>${m.value === 'auto' ? 'Automatic' : m.label}</h2><span class="im-pick">${m.value === picked ? 'In use' : 'Use this'}</span></div>
          <p class="im-about">${ABOUT[m.value] ?? ''}</p>
          ${m.value === 'auto'
            ? raw('')
            : html`<div class="im-foot"><span class="im-wire ns-mono">${WIRE[m.value] ?? ''}</span>${verdict(known.get(m.value))}</div>`}
        </button>`,
      )}
    </form>`;
}

/** What Google last said to each model, from the image service. Best effort, like the old Settings page. */
export async function imageCatalogue(settings: Settings, fetchImpl: Fetch = fetch): Promise<ImageModelCatalogue | null> {
  const base = settings.get('image_base_url').replace(/\/+$/, '');
  if (!base) return null;
  try {
    const res = await fetchImpl(`${base}/flow/image-models`, {
      headers: { 'X-API-Key': settings.get('image_api_key') },
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok ? ((await res.json()) as ImageModelCatalogue) : null;
  } catch {
    return null;
  }
}

const HOME = '/new-website/platform';

export function registerImageModelRoutes(app: FastifyInstance, settings: Settings): void {
  // The old address of the page: the cards now live on Platform settings.
  app.get('/new-website/image-model', async (_request, reply) => reply.redirect(`${HOME}#images`, 303));

  app.post('/new-website/image-model', async (request, reply) => {
    const value = String((request.body as Record<string, unknown> | undefined)?.image_model ?? '');
    const model = IMAGE_MODELS.find((m) => m.value === value);
    if (!model) return reply.redirect(`${HOME}?error=${encodeURIComponent('Pick one of the models.')}#images`, 303);
    settings.set('image_model', model.value);
    const name = model.value === 'auto' ? 'Automatic' : model.label;
    return reply.redirect(`${HOME}?ok=${encodeURIComponent(`Pictures now use ${name}.`)}#images`, 303);
  });
}
