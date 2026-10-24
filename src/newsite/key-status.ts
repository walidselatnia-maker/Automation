import { listEndpointRows } from '../llm/pool.js';
import type { Settings } from '../settings.js';
import { html, raw, type Html } from '../web/views/layout.js';
import { listNewWebsites } from './repo.js';
import { listSearchKeys } from './search-keys.js';

/**
 * Whether the keys a step needs are there: one short line per key on the
 * Create pages and the Dashboard. A key that is missing (or that all fail)
 * gets a button straight to its part of Platform settings; one that is set
 * gets a small link saying where it lives.
 *
 * Every platform key is kept in Platform settings. Buffer and the platforms'
 * own tokens belong to each social channel, so they are not here.
 */

export type KeyId = 'ai' | 'search' | 'images' | 'flow';
export type KeyState = 'set' | 'missing' | 'failing';

interface KeyDef {
  /** "Search key", as in "Search key missing". */
  label: string;
  /** Its part of Platform settings, as the link names it. */
  section: string;
  /** The id of that part on the Platform settings page. */
  anchor: string;
  button: string;
}

export const KEYS: Record<KeyId, KeyDef> = {
  ai: { label: 'AI key', section: 'AI connection', anchor: 'ai', button: 'Add key' },
  search: { label: 'Search key', section: 'Search keys', anchor: 'search-keys', button: 'Add key' },
  images: { label: 'Image service key', section: 'Images', anchor: 'images', button: 'Open settings' },
  flow: { label: 'Flow project', section: 'Images', anchor: 'images', button: 'Add project' },
};

/** What each Create page needs. */
export const PAGE_KEYS = {
  research: ['search', 'ai'],
  keywords: ['ai', 'images', 'flow'],
  reels: ['ai', 'images', 'flow'],
  dashboard: ['ai', 'search', 'images', 'flow'],
} satisfies Record<string, KeyId[]>;

export const keyHref = (id: KeyId): string => `/new-website/platform#${KEYS[id].anchor}`;

/** One key's state now. Image service and Flow need the settings; without them they are not asked. */
export function keyState(id: KeyId, settings?: Settings): KeyState | null {
  switch (id) {
    case 'ai': {
      const on = listEndpointRows().filter((r) => r.enabled === 1);
      if (!on.length) return 'missing';
      return on.every((r) => r.last_error) ? 'failing' : 'set';
    }
    case 'search': {
      const keys = listSearchKeys();
      if (!keys.length) return 'missing';
      return keys.every((k) => k.status === 'failed') ? 'failing' : 'set';
    }
    case 'images':
      return settings ? (settings.has('image_api_key') ? 'set' : 'missing') : null;
    case 'flow': {
      if (!settings) return null;
      if (settings.has('flow_project_id')) return 'set';
      // No shared project is fine while every website has its own.
      const sites = listNewWebsites();
      return sites.length && sites.every((s) => s.project_id) ? 'set' : 'missing';
    }
  }
}

export interface KeyLine {
  id: KeyId;
  state: KeyState;
}

export const keyLinesFor = (ids: readonly KeyId[], settings?: Settings): KeyLine[] =>
  ids.flatMap((id) => {
    const state = keyState(id, settings);
    return state ? [{ id, state }] : [];
  });

/** The step cannot run: a key it needs is missing or every one fails. */
export const keyMissing = (lines: KeyLine[]): KeyLine | undefined => lines.find((l) => l.state !== 'set');

export const KEY_CSS = `
.ns-keys { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; margin: 0 0 18px; }
.ns-key { display: inline-flex; align-items: center; gap: 10px; margin: 0; font-size: 14px; }
.ns-key.bad { padding: 6px 6px 6px 12px; border: 1px solid var(--bad); border-left-width: 4px; border-radius: var(--r-ctl); background: var(--bad-tint); color: var(--ink); font-weight: 600; }
a.ns-key.ok { font-size: 13px; color: var(--soft); text-decoration: none; }
a.ns-key.ok:hover { color: var(--ink); text-decoration: underline; }
`;

/** "Search key missing [Add key]", or "Search key: set · Platform settings > Search keys". */
export function keyLine(l: KeyLine): Html {
  const d = KEYS[l.id];
  if (l.state === 'set') return html`<a class="ns-key ok" href="${keyHref(l.id)}">${d.label}: set · Platform settings &gt; ${d.section}</a>`;
  return html`<p class="ns-key bad" role="alert"><span>${d.label} ${l.state === 'missing' ? 'missing' : 'failing'}</span>
    <a class="ns-btn small primary" href="${keyHref(l.id)}">${d.button}</a></p>`;
}

export function keyLines(lines: KeyLine[]): Html {
  if (!lines.length) return raw('');
  // What needs doing first, then where the others are.
  const ordered = [...lines.filter((l) => l.state !== 'set'), ...lines.filter((l) => l.state === 'set')];
  return html`<style>${raw(KEY_CSS)}</style><div class="ns-keys">${ordered.map(keyLine)}</div>`;
}
