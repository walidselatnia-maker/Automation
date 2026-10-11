import { html, raw, type Html } from '../web/views/layout.js';

/**
 * The new dashboard's own page shell.
 *
 * Nothing here comes from the old dashboard's layout or stylesheet: its own
 * sidebar, its own CSS, its own type. The only shared things are the login
 * (same session) and the dark-mode choice (same localStorage key), so moving
 * between the two dashboards does not flip the theme.
 */

export type NewFlash = { kind: 'ok' | 'error'; message: string } | null;

interface NavItem {
  href: string;
  label: string;
  icon: string;
}

const ICON = (paths: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const NAV: NavItem[] = [
  {
    href: '/new-website/platform',
    label: 'Platform',
    icon: ICON('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  },
  {
    href: '/new-website',
    label: 'Websites',
    icon: ICON('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  },
  {
    href: '/new-website/keywords',
    label: 'Keywords',
    icon: ICON('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  },
  {
    href: '/new-website/image-model',
    label: 'Image model',
    icon: ICON('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
  },
];

const CSS = `
:root {
  --page: #f3f4f5; --surface: #ffffff; --raised: #f7f8f9; --line: #e1e4e8; --line-strong: #c9ced4;
  --ink: #16191d; --soft: #59626b; --faint: #8b939b;
  --accent: #e63946; --accent-ink: #ffffff; --accent-tint: rgba(230,57,70,.08);
  --good: #13795b; --bad: #c42b1c;
  --r-card: 8px; --r-ctl: 6px;
  --display: 'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif;
  --body: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
}
:root.dark {
  --page: #111316; --surface: #181b1f; --raised: #1e2227; --line: #2b3036; --line-strong: #3b4249;
  --ink: #eceef0; --soft: #a2aab2; --faint: #6e7780;
  --accent-tint: rgba(230,57,70,.14); --good: #46c08f; --bad: #ff7b6b;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--page); color: var(--ink); font: 15px/1.55 var(--body); -webkit-font-smoothing: antialiased; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* -- shell */
.ns-side { position: fixed; inset: 0 auto 0 0; width: 240px; display: flex; flex-direction: column;
  background: var(--surface); border-right: 1px solid var(--line); padding: 28px 16px 20px; }
.ns-brand { display: block; padding: 0 12px 32px; text-decoration: none; }
.ns-brand b { display: block; font: 700 18px/1.2 var(--display); letter-spacing: -.02em; }
.ns-brand b::after { content: '.'; color: var(--accent); }
.ns-brand small { display: block; margin-top: 2px; font-size: 12px; color: var(--faint); }
.ns-nav { display: flex; flex-direction: column; gap: 2px; }
.ns-nav a { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: var(--r-ctl);
  color: var(--soft); text-decoration: none; font-weight: 500; }
.ns-nav a:hover { background: var(--raised); color: var(--ink); }
.ns-nav a.on { background: var(--accent-tint); color: var(--accent); }
.ns-nav svg, .ns-foot svg { width: 18px; height: 18px; flex: none; }
.ns-foot { margin-top: auto; border-top: 1px solid var(--line); padding-top: 12px; display: flex; flex-direction: column; gap: 2px; }
.ns-foot a, .ns-foot button { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: var(--r-ctl);
  color: var(--soft); text-decoration: none; font: 500 14px/1.4 var(--body); background: none; border: 0; cursor: pointer; text-align: left; }
.ns-foot a:hover, .ns-foot button:hover { background: var(--raised); color: var(--ink); }
.ns-main { margin-left: 240px; padding: 48px 56px 72px; }
.ns-wrap { max-width: 880px; margin: 0 auto; }

/* -- type and pieces */
h1, h2, h3 { font-family: var(--display); letter-spacing: -.02em; margin: 0; }
.ns-title { font-size: 32px; line-height: 1.1; font-weight: 700; }
.ns-lede { color: var(--soft); margin: 10px 0 0; max-width: 56ch; }
.ns-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
  padding-bottom: 24px; margin-bottom: 32px; border-bottom: 1px solid var(--line); }
.ns-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 18px;
  border-radius: var(--r-ctl); border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink);
  font: 600 14px/1 var(--body); text-decoration: none; cursor: pointer; white-space: nowrap; }
.ns-btn:hover { border-color: var(--soft); }
.ns-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.ns-btn.primary:hover { background: #d42f3c; border-color: #d42f3c; }
.ns-btn.quiet { border-color: transparent; background: transparent; color: var(--soft); }
.ns-btn.quiet:hover { color: var(--ink); background: var(--raised); }
.ns-btn:disabled, .ns-btn:disabled:hover { opacity: .55; cursor: not-allowed; }
.ns-btn.busy { cursor: progress; }
.ns-mono { font-family: var(--mono); font-size: 13px; }
.ns-num { font-variant-numeric: tabular-nums; }
.ns-flash { border-left: 3px solid; padding: 10px 16px; margin-bottom: 28px; font-weight: 500; background: var(--surface); }
.ns-flash.ok { border-color: var(--good); color: var(--good); }
.ns-flash.error { border-color: var(--bad); color: var(--bad); }

@media (max-width: 860px) {
  .ns-side { position: static; width: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 16px; border-right: 0; border-bottom: 1px solid var(--line); }
  .ns-brand { padding: 0 8px 0 4px; }
  .ns-brand small { display: none; }
  .ns-nav { flex-direction: row; flex-wrap: wrap; }
  .ns-nav a { padding: 8px 10px; }
  .ns-foot { margin: 0 0 0 auto; border: 0; padding: 0; flex-direction: row; }
  .ns-foot span { display: none; }
  .ns-main { margin: 0; padding: 28px 16px 48px; }
  .ns-head { flex-direction: column; align-items: flex-start; }
}
`;

const THEME = `<script>
(function () {
  try {
    var s = localStorage.theme;
    document.documentElement.classList.toggle('dark', s === 'dark' || (!s && matchMedia('(prefers-color-scheme: dark)').matches));
  } catch (e) {}
})();
</script>`;

export interface NewLayoutOptions {
  title: string;
  /** The current path: picks the active sidebar item. */
  active: string;
  body: Html;
  flash?: NewFlash;
}

export function newLayout({ title, active, body, flash }: NewLayoutOptions): string {
  const nav = NAV.map(
    (item) => html`<a href="${item.href}" class="${item.href === active ? 'on' : ''}">${raw(item.icon)}<span>${item.label}</span></a>`,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html`${title}`.value} · New website</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%23e63946'/></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
${THEME}
<style>${CSS}</style>
</head>
<body>
<aside class="ns-side">
  <a class="ns-brand" href="/new-website"><b>New website</b><small>Sites on the new platform</small></a>
  <nav class="ns-nav">${nav.map((n) => n.value).join('')}</nav>
  <div class="ns-foot">
    <button type="button" id="ns-theme">${raw(ICON('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'))}<span>Dark mode</span></button>
    <a href="/">${raw(ICON('<path d="M15 18l-6-6 6-6"/>'))}<span>Back to old dashboard</span></a>
  </div>
</aside>
<main class="ns-main"><div class="ns-wrap">
${flash ? html`<div class="ns-flash ${flash.kind}" role="status">${flash.message}</div>`.value : ''}
${body.value}
</div></main>
<script>
(function () {
  var button = document.getElementById('ns-theme');
  var label = function () {
    button.querySelector('span').textContent =
      document.documentElement.classList.contains('dark') ? 'Light mode' : 'Dark mode';
  };
  label();
  button.addEventListener('click', function () {
    var dark = document.documentElement.classList.toggle('dark');
    try { localStorage.theme = dark ? 'dark' : 'light'; } catch (e) {}
    label();
  });
})();
</script>
</body>
</html>`;
}
