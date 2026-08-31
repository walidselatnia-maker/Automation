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
  /** Inline stroke icon, sized and coloured by CSS via `currentColor`. */
  icon: string;
}

/**
 * Nav icons.
 *
 * Drawn inline rather than pulled from an icon font: six glyphs is not worth a
 * network request, and `currentColor` means they inherit the link's colour in
 * both themes and in the active state without a second rule.
 */
const ICON = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/**
 * The rail holds destinations you navigate between and nothing else.
 *
 * Prompts moved under Settings (it is configuration, not a place you visit
 * daily), Decisions became a section of the dashboard, and the live browser
 * became a button in the top-right corner because it opens its own tab.
 *
 * The order is the operator's, not alphabetical and not the order these pages
 * were built in: the ones opened daily sit at the top, and Runs is last
 * because it is where you go after something has already gone wrong.
 */
const NAV: NavItem[] = [
  {
    href: '/',
    label: 'Dashboard',
    icon: ICON('<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/>' +
      '<rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'),
  },
  {
    href: '/sites',
    label: 'Sites',
    icon: ICON('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
      '<path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>'),
  },
  {
    href: '/settings',
    label: 'Settings',
    icon: ICON('<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2' +
      'a2 2 0 1 1-4 0a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15' +
      'a2 2 0 1 1 0-4a1.7 1.7 0 0 0 1.5-2.6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6' +
      'a2 2 0 1 1 4 0a1.7 1.7 0 0 0 2.6 1.5l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11' +
      'a2 2 0 1 1 0 4a1.7 1.7 0 0 0-1.6 0z"/>'),
  },
  {
    href: '/keywords',
    label: 'Keywords',
    icon: ICON('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  },
  {
    href: '/events',
    label: 'Events',
    icon: ICON('<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/>'),
  },
  {
    href: '/runs',
    label: 'Runs',
    icon: ICON('<polygon points="6 4 20 12 6 20 6 4"/>'),
  },
];

/**
 * The theme, applied before the first paint.
 *
 * This runs in <head> rather than at the end of <body> deliberately: setting
 * the class after the page has painted means a light flash on every navigation
 * for anyone using dark mode. The stored choice wins; with nothing stored the
 * OS preference is the starting point.
 */
const THEME_BOOT = `<script>
(function () {
  try {
    var stored = localStorage.theme;
    var dark = stored === 'dark' ||
      (!stored && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) { /* private mode: fall through to the light default */ }
})();
</script>`;

/** Flips the class on <html> and remembers the choice. */
const THEME_TOGGLE = `<script>
(function () {
  var button = document.getElementById('theme-toggle');
  // The boot script has already decided; the switch just catches up with it.
  button.setAttribute('aria-checked',
    String(document.documentElement.classList.contains('dark')));
})();
document.getElementById('theme-toggle').addEventListener('click', function () {
  var dark = document.documentElement.classList.toggle('dark');
  this.setAttribute('aria-checked', String(dark));
  try { localStorage.theme = dark ? 'dark' : 'light'; } catch (e) {}
});
</script>`;

/** Shared <head> contents, so the sign-in page cannot drift from the app. */
export function head(title: string): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Article Platform</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap">
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23e63946'/><rect x='9' y='9' width='14' height='2.5' rx='1.25' fill='white'/><rect x='9' y='15' width='14' height='2.5' rx='1.25' fill='white' opacity='.75'/><rect x='9' y='21' width='8' height='2.5' rx='1.25' fill='white' opacity='.5'/></svg>">
${THEME_BOOT}`;
}

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
        >${raw(item.icon)}<span>${item.label}</span></a
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
${head(options.title)}
</head>
<body>
<header class="topbar">
  <div class="brand"><a href="/">Article&nbsp;Platform</a>${status.value}</div>
  <nav>${nav.map((n) => n.value).join('')}</nav>
  <div class="rail-utils">
    <button type="button" id="theme-toggle" class="theme-switch"
            role="switch" aria-checked="false" title="Switch between light and dark">
      <span>Dark mode</span><span class="track"></span>
    </button>
    <a class="button browser" href="/browser" target="_blank" rel="noopener"
       title="The live Chrome session used to generate images">Browser</a>
    <form method="post" action="/logout">
      <button type="submit">Sign out</button>
    </form>
  </div>
</header>
<main>
${flash.value}
${options.body.value}
</main>
${THEME_TOGGLE}
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

/**
 * A small inline bar chart.
 *
 * Four counters answer "what happened today". They cannot answer "is this
 * actually running", which is a shape rather than a number — a week of threes
 * and a week of nothing look identical in a counter reading 3.
 *
 * Inline SVG, no library: the page has no build step and a chart is not worth
 * acquiring one for. Bars rather than a line because the series is a count per
 * day, and a line between two days implies values in between that do not exist.
 */
export function sparkline(
  series: { day: string; published: number; failed: number }[],
  options: { width?: number; height?: number } = {},
): Html {
  if (series.length === 0) return raw('');

  const width = options.width ?? 320;
  const height = options.height ?? 44;
  const gap = 2;
  const barWidth = Math.max(2, width / series.length - gap);
  const peak = Math.max(1, ...series.map((d) => d.published + d.failed));

  const bars = series.map((day, index) => {
    const x = index * (barWidth + gap);
    const total = day.published + day.failed;

    // A day with nothing gets a visible baseline tick rather than blank space:
    // "we published nothing" is the reading this chart exists to make obvious.
    if (total === 0) {
      return html`<rect x="${x.toFixed(1)}" y="${height - 1}" width="${barWidth.toFixed(1)}"
        height="1" fill="currentColor" opacity="0.18"></rect>`;
    }

    const publishedHeight = (day.published / peak) * (height - 2);
    const failedHeight = (day.failed / peak) * (height - 2);

    return html`<g>
      <title>${day.day}: ${day.published} published, ${day.failed} failed</title>
      <rect x="${x.toFixed(1)}" y="${(height - failedHeight).toFixed(1)}"
        width="${barWidth.toFixed(1)}" height="${failedHeight.toFixed(1)}"
        fill="#e63946" opacity="0.85"></rect>
      <rect x="${x.toFixed(1)}" y="${(height - failedHeight - publishedHeight).toFixed(1)}"
        width="${barWidth.toFixed(1)}" height="${publishedHeight.toFixed(1)}"
        fill="#10b981"></rect>
    </g>`;
  });

  // preserveAspectRatio="none" so the chart fills the card it is in. The
  // default keeps the viewBox's ratio, which drew a small chart floating in
  // the middle of a wide empty box — the bars are what carry the meaning and
  // stretching them horizontally costs nothing, since only their heights are
  // being compared.
  return html`<svg class="spark" viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
    preserveAspectRatio="none"
    role="img" aria-label="Articles published per day">${bars}</svg>`;
}

/** Thousands separators, so 148213 reads as a number rather than a barcode. */
export const formatCount = (n: number): string => n.toLocaleString('en-US');

/** Token counts compressed to something scannable in a table. */
export function formatTokens(n: number): string {
  if (n === 0) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * How a run ended, in the language of the thing that happened.
 *
 * A held run is stored as `cancelled` — see markRunHeld — and rendering it
 * that way would tell you an article was thrown away when it is sitting there
 * finished, waiting for you.
 */
export function runBadge(run: { status: string; hold?: string }): Html {
  if (run.hold === 'awaiting') return html`<span class="badge warn">awaiting approval</span>`;
  if (run.hold === 'dry') return html`<span class="badge brand">dry run</span>`;
  return statusBadge(run.status);
}
