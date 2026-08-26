/**
 * Server-rendered HTML with no build step and no client framework.
 *
 * The audience for this code is an AI assistant six months from now with no
 * memory of how it was written. Template literals returning strings are the
 * most legible thing available: there is no compilation, no hydration, and
 * no hidden state — what you read is what the browser receives.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Marks a string as already-safe HTML so `html` will not escape it. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export const raw = (value: string): Html => new Html(value);

/** Tagged template that escapes interpolations unless they are Html. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';

  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    out +=
      value instanceof Html
        ? value.value
        : Array.isArray(value)
          ? value.map((v) => (v instanceof Html ? v.value : escapeHtml(v))).join('')
          : escapeHtml(value);
    out += strings[i + 1] ?? '';
  }

  return new Html(out);
}

export interface NavItem {
  href: string;
  label: string;
  /** Opens in its own tab rather than replacing the dashboard. */
  newTab?: boolean;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Dashboard' },
  { href: '/runs', label: 'Runs' },
  { href: '/sites', label: 'Sites' },
  { href: '/keywords', label: 'Keywords' },
  { href: '/prompts', label: 'Prompts' },
  { href: '/decisions', label: 'Decisions' },
  // A live browser session is something you keep open beside the dashboard
  // while you work, not somewhere you navigate to and back from.
  { href: '/browser', label: 'Browser', newTab: true },
  { href: '/settings', label: 'Settings' },
];

export interface LayoutOptions {
  title: string;
  active: string;
  body: Html;
  flash?: { kind: 'ok' | 'error' | 'warn'; message: string } | null;
  automationOn?: boolean;
}

export function layout(options: LayoutOptions): string {
  const nav = NAV.map(
    (item) => html`
      <a href="${item.href}" class="${item.href === options.active ? 'active' : ''}"
        ${item.newTab ? raw('target="_blank" rel="noopener"') : raw('')}
        >${item.label}</a
      >
    `,
  );

  const flash = options.flash
    ? html`<div class="flash ${options.flash.kind}">${options.flash.message}</div>`
    : raw('');

  const status =
    options.automationOn === undefined
      ? raw('')
      : options.automationOn
        ? html`<span class="pill ok">Automation on</span>`
        : html`<span class="pill off">Automation off</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)} · Article Platform</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='3' fill='%231b2024'/><rect x='7' y='9' width='18' height='3' fill='%23e5a83a'/><rect x='7' y='15' width='18' height='2' fill='%23cfd6dc'/><rect x='7' y='20' width='12' height='2' fill='%23cfd6dc'/></svg>">
</head>
<body>
<header class="topbar">
  <div class="brand"><a href="/">Article&nbsp;Platform</a>${status}</div>
  <nav>${nav.map((n) => n.value).join('')}
    <form method="post" action="/logout" style="display:inline">
      <button class="small" type="submit">Sign out</button>
    </form>
  </nav>
</header>
<main>
${flash.value}
${options.body.value}
</main>
<footer><span>One article per run. Every skip has a recorded reason.</span></footer>
</body>
</html>`;
}

/* -- Small shared components -------------------------------------------- */

export function statusBadge(status: string): Html {
  const kind =
    status === 'published' || status === 'ok' || status === 'active' || status === 'go'
      ? 'ok'
      : status === 'failed' || status === 'no'
        ? 'error'
        : status === 'running'
          ? 'busy'
          : 'muted';
  return html`<span class="badge ${kind}">${status}</span>`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';

  const then = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(then.getTime())) return String(iso);

  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const emptyState = (message: string): Html =>
  html`<div class="empty">${message}</div>`;
