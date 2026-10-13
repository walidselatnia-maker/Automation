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
    label: 'Platform settings',
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
    href: '/new-website/channels',
    label: 'Channels',
    icon: ICON('<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.9l7.6-3.8M8.2 13.1l7.6 3.8"/>'),
  },
  {
    href: '/new-website/shared',
    label: 'Shared content',
    icon: ICON('<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v12M7 8l5-5 5 5"/>'),
  },
];

const CSS = `
/*
 * The design system. Colour has one meaning each, everywhere:
 *   red, dark red (--accent) = active or selected: the main button of an area,
 *       the page you are on, the option you picked, the steps done, focus;
 *   light blue (--idle)      = inactive or not selected: every other button,
 *       the other pages, options you did not pick, steps still to come;
 *   green (--good)           = done, working, connected;
 *   red tint (--bad)         = a problem: failures and warnings, always shown
 *       as a tinted box or badge with words, never as a solid button.
 * Removing something is an outlined button (red text and border, no fill),
 * so it never looks like the main action. The brand red is the logo mark.
 * Text has three levels, all readable on every surface:
 *   --ink (main), --soft (secondary), --faint (hints and meta).
 */
:root {
  --page: #eceff3; --surface: #ffffff; --raised: #f4f6f9; --line: #d6dce4; --line-strong: #aeb8c5;
  --ink: #111820; --soft: #3c4755; --faint: #566271;
  --accent: #b91c2c; --accent-hover: #8f1521; --accent-ink: #ffffff; --accent-text: #a0182a; --accent-tint: #fbe7e9;
  --idle: #dcebfb; --idle-hover: #c6ddf8; --idle-line: #a6c6ec; --idle-ink: #12386a;
  --good: #146c43; --good-tint: #e3f3ea;
  --bad: #b42318; --bad-hover: #9a1d14; --bad-tint: #fdeceb;
  --brand: #e63946;
  --shadow: 0 1px 2px rgba(17, 24, 32, .06), 0 1px 1px rgba(17, 24, 32, .04);
  --r-card: 10px; --r-ctl: 7px;
  --display: 'Bricolage Grotesque', 'Segoe UI', system-ui, sans-serif;
  --body: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
  --mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
}
:root.dark {
  --page: #0e1217; --surface: #181e26; --raised: #212833; --line: #323b47; --line-strong: #4f5b6b;
  --ink: #eef2f6; --soft: #c5cdd7; --faint: #9ea9b6;
  --accent: #c8323d; --accent-hover: #a82530; --accent-ink: #ffffff; --accent-text: #ff9aa3; --accent-tint: rgba(200, 50, 61, .22);
  --idle: #1c3352; --idle-hover: #244166; --idle-line: #36577f; --idle-ink: #cfe3ff;
  --good: #5fd39a; --good-tint: rgba(95, 211, 154, .14);
  --bad: #ff8b7e; --bad-hover: #c9372b; --bad-tint: rgba(255, 139, 126, .14);
  --shadow: none;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--page); color: var(--ink); font: 15px/1.6 var(--body); -webkit-font-smoothing: antialiased; }
a { color: var(--accent-text); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input[type=checkbox], input[type=radio] { accent-color: var(--accent); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; } }

/* -- shell */
.ns-side { position: fixed; inset: 0 auto 0 0; width: 240px; display: flex; flex-direction: column;
  background: var(--surface); border-right: 1px solid var(--line); padding: 28px 14px 20px; }
.ns-brand { display: block; padding: 0 12px 28px; text-decoration: none; color: var(--ink); }
.ns-brand b { display: block; font: 700 18px/1.2 var(--display); letter-spacing: -.02em; }
.ns-brand b::after { content: '.'; color: var(--brand); }
.ns-brand small { display: block; margin-top: 2px; font-size: 13px; color: var(--faint); }
.ns-nav { display: flex; flex-direction: column; gap: 6px; }
.ns-nav a { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: var(--r-ctl);
  border: 1px solid var(--idle-line); background: var(--idle); color: var(--idle-ink); text-decoration: none; font-weight: 500; }
.ns-nav a:hover { background: var(--idle-hover); }
.ns-nav a.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
.ns-nav svg, .ns-foot svg { width: 18px; height: 18px; flex: none; }
.ns-foot { margin-top: auto; border-top: 1px solid var(--line); padding-top: 12px; display: flex; flex-direction: column; gap: 2px; }
.ns-foot a, .ns-foot button { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: var(--r-ctl);
  color: var(--soft); text-decoration: none; font: 500 14px/1.4 var(--body); background: none; border: 0; cursor: pointer; text-align: left; }
.ns-foot a:hover, .ns-foot button:hover { background: var(--raised); color: var(--ink); }
.ns-main { margin-left: 240px; padding: 44px 56px 80px; }
.ns-wrap { max-width: 900px; margin: 0 auto; }

/* -- type */
h1, h2, h3, h4 { font-family: var(--display); letter-spacing: -.015em; margin: 0; color: var(--ink); }
.ns-title { font-size: 30px; line-height: 1.15; font-weight: 700; }
.ns-lede { color: var(--soft); margin: 10px 0 0; max-width: 62ch; }
.ns-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
  padding-bottom: 24px; margin-bottom: 32px; border-bottom: 1px solid var(--line); }
.ns-mono { font-family: var(--mono); font-size: 13px; }
.ns-num { font-variant-numeric: tabular-nums; }

/* -- buttons: primary (blue), secondary (outlined), quiet (for going back), danger (red, removes something) */
.ns-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 40px; padding: 0 18px;
  border-radius: var(--r-ctl); border: 1px solid var(--idle-line); background: var(--idle); color: var(--idle-ink);
  font: 600 14px/1 var(--body); text-decoration: none; cursor: pointer; white-space: nowrap; }
.ns-btn:hover { background: var(--idle-hover); border-color: var(--idle-line); }
.ns-btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.ns-btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.ns-btn.quiet { background: var(--idle); color: var(--idle-ink); border-color: var(--idle-line); }
.ns-btn.quiet:hover { background: var(--idle-hover); color: var(--idle-ink); }
.ns-btn.danger { background: var(--surface); border-color: var(--bad); color: var(--bad); }
.ns-btn.danger:hover { background: var(--bad-hover); border-color: var(--bad-hover); color: #fff; }
.ns-btn.small { height: 32px; padding: 0 12px; font-size: 13px; }
.ns-btn:disabled, .ns-btn.disabled, .ns-btn:disabled:hover, .ns-btn.disabled:hover {
  background: var(--raised); border-color: var(--line); color: var(--faint); cursor: not-allowed; opacity: 1; }
.ns-btn.busy { cursor: progress; }

/* -- status badges: one look for every "Done / Failed / Writing…" */
.ns-badge { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px;
  font: 600 13px/1 var(--body); white-space: nowrap; background: var(--raised); color: var(--soft); border: 1px solid var(--line); }
.ns-badge::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.ns-badge.ok { background: var(--good-tint); color: var(--good); border-color: transparent; }
.ns-badge.bad { background: var(--bad-tint); color: var(--bad); border-color: transparent; }
.ns-badge.busy { background: var(--idle); color: var(--idle-ink); border-color: transparent; }

/* -- tags: a neutral word that says what something is (Pillar, Feature, Recipe) */
.ns-tag { display: inline-block; padding: 2px 8px; border-radius: 5px; background: var(--raised); border: 1px solid var(--line);
  color: var(--soft); font: 600 13px/1.5 var(--body); white-space: nowrap; }

/* -- alerts: page messages and in-page notes */
.ns-flash, .ns-alert { border: 1px solid; border-left-width: 4px; border-radius: var(--r-ctl); padding: 12px 16px; margin-bottom: 28px;
  font-weight: 500; background: var(--surface); color: var(--ink); }
.ns-flash.ok, .ns-alert.ok { border-color: var(--good); background: var(--good-tint); color: var(--ink); }
.ns-flash.error, .ns-alert.bad { border-color: var(--bad); background: var(--bad-tint); color: var(--ink); }
.ns-alert.info { border-color: var(--idle-line); background: var(--idle); }

/* -- cards */
.ns-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); }

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
