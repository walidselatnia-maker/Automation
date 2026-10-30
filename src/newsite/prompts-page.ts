import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  deletePromptOverride,
  getPromptOverride,
  getPromptVersion,
  listPromptVersions,
  savePromptVersion,
  setPromptOverride,
  type PromptVersionRow,
} from '../db/repos.js';
import { invalidatePromptCache, readShippedPrompt } from '../pipeline/prompts.js';
import { variablesFor } from '../pipeline/prompt-contexts.js';
import { html, raw, type Html } from '../web/views/layout.js';
import { newLayout, type NewFlash } from './layout.js';
import { SKELETON_PARTS, SKELETON_VERSIONS, styleFile } from './skeleton.js';

/**
 * The prompts the new platform writes with, in the order the work is done.
 *
 * This list is also the allow-list: an address names a prompt by its key, and
 * a key that is not here reaches no file. Edits are stored as prompt overrides,
 * the same place every AI call reads from, so a save applies to the next run.
 */

export interface PromptEntry {
  key: string;
  name: string;
  about: string;
  /** A picture template is one text; an AI prompt has instructions and a request. */
  template?: boolean;
  /** Edited on its own page instead. */
  href?: string;
  /** One version of a part of another prompt: listed under it, one text. */
  style?: boolean;
}

export interface PromptStage {
  title: string;
  about: string;
  prompts: PromptEntry[];
  /** A prompt kept on its own page elsewhere, linked from here. */
  link?: { href: string; name: string; about: string };
}

export const PROMPT_STAGES: PromptStage[] = [
  {
    title: 'Keywords',
    about: 'Turning a main keyword into the articles to write.',
    prompts: [
      { key: 'keyword-cluster', name: 'Pick the sub-keywords', about: 'Chooses which real Google searches deserve their own article under a main keyword.' },
      { key: 'keyword-research', name: 'Content research plan', about: 'Groups the real Google searches of a research into pillars and their sub-articles.' },
    ],
  },
  {
    title: 'SEO',
    about: 'What Google shows for each article.',
    prompts: [{ key: 'seo-metadata', name: 'Title and description', about: 'Writes the SEO title, meta description and focus keyword of each article.' }],
  },
  {
    title: 'Article',
    about: 'Writing the article itself.',
    prompts: [
      { key: 'recipe-card', name: 'Recipe card', about: 'Creates the recipe an article is written from: ingredients, amounts, times and steps.' },
      { key: 'article-skeleton', name: 'Article outline', about: 'Decides which sections the article has and in what order.' },
      // Its three parts, each in a few styles: every article gets one of each.
      ...SKELETON_PARTS.flatMap((part) =>
        Array.from({ length: SKELETON_VERSIONS }, (_, i) => ({
          key: styleFile(part.key, i + 1).replace(/\.txt$/, ''),
          name: `${part.name}, version ${i + 1}`,
          about: part.about,
          style: true,
        })),
      ),
      { key: 'article-section', name: 'Article sections', about: 'Writes each section of the article from its outline.' },
    ],
  },
  {
    title: 'Pictures',
    about: 'The photos inside the article.',
    prompts: [{ key: 'article-images', name: 'Article picture descriptions', about: 'Describes each photo Google Flow makes for the article, so it matches the recipe.' }],
  },
  {
    title: 'Publishing',
    about: 'Putting the article on the website.',
    prompts: [
      { key: 'pick-category', name: 'Website category', about: 'Picks the category the article goes in, from the website’s own categories.' },
      { key: 'category-intro', name: 'Category intro', about: 'Writes the text at the top of a category page, once it has 3 articles.' },
      { key: 'top-list-post', name: 'Top list', about: 'Writes a round-up post of the website’s own posts about one topic.' },
    ],
  },
  {
    title: 'Social posts',
    about: 'What goes out on each social channel.',
    prompts: [
      { key: 'newsite-social-post', name: 'Post text', about: 'Writes the text of each post, following that platform’s rules.' },
      { key: 'newsite-pick-board', name: 'Pinterest board', about: 'Chooses which Pinterest board each pin goes to.' },
      { key: 'pin-designs', name: 'Pinterest pin designs', about: 'The pictures made for pins. Add new designs and pick which ones pins are made from.', href: '/new-website/pin-designs' },
      { key: 'newsite-fb-1.template', name: 'Facebook picture', about: 'The picture made for a Facebook post.', template: true },
      { key: 'newsite-ig-1.template', name: 'Instagram, Threads, TikTok and YouTube picture', about: 'The tall picture made for these platforms.', template: true },
      { key: 'newsite-social-1.template', name: 'LinkedIn and X picture', about: 'The wide picture made for these platforms.', template: true },
    ],
  },
  {
    title: 'Reels',
    about: 'The video made for each article.',
    prompts: [
      { key: 'newsite-reel-prompt', name: 'Video prompt', about: 'Writes the prompt Google Flow turns into the reel, following the reel rules.' },
      { key: 'newsite-reel-story', name: 'Long reel story', about: 'Writes the scenes of a long reel: what each shows and the words said in it.' },
      { key: 'newsite-reel-scene-picture', name: 'Long reel scene picture', about: 'Writes the picture prompt of one scene.' },
      { key: 'newsite-reel-scene-video', name: 'Long reel scene clip', about: 'Writes the clip prompt of one scene.' },
    ],
    link: { href: '/new-website/sharing/reel-rules?back=/new-website/prompts', name: 'Reel rules', about: 'The structure, pace and closing line every reel follows.' },
  },
];

const ENTRIES = new Map(PROMPT_STAGES.flatMap((s) => s.prompts.filter((p) => !p.href).map((p) => [p.key, p] as const)));

/** One editable text of a prompt: its file and what it is called on the page. */
interface Part {
  file: string;
  label: string;
  help: string;
}

const partsOf = (p: PromptEntry): Part[] =>
  p.style
    ? [{ file: `${p.key}.txt`, label: 'Style', help: 'Added to the article outline prompt. Each article gets one version of each part.' }]
    : p.template
    ? [{ file: `${p.key}.txt`, label: 'Picture description', help: 'Sent to the picture maker as it is, with the words in double braces filled in.' }]
    : [
        { file: `${p.key}.system.txt`, label: 'Instructions', help: 'Who the AI is and the rules it follows. The same every time.' },
        { file: `${p.key}.user.txt`, label: 'What it is given', help: 'Sent with each request, with the words in double braces filled in for that article.' },
      ];

export const current = (file: string): string => getPromptOverride(file) ?? readShippedPrompt(file);
const isChanged = (p: PromptEntry): boolean => partsOf(p).some((part) => getPromptOverride(part.file) !== undefined);

/** The {{words}} a prompt may use: the step's own list, else those its default text uses. */
function wordsFor(p: PromptEntry): string[] {
  const known = variablesFor(p.key);
  if (known.length) return known;
  const used = new Set<string>();
  for (const part of partsOf(p)) for (const m of readShippedPrompt(part.file).matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) used.add(m[1]!);
  return [...used].sort();
}

const unknownWords = (text: string, allowed: string[]): string[] => {
  const ok = new Set(allowed);
  return [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!).filter((w) => !ok.has(w)))];
};

const CSS = `
.pr-stage { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); margin-bottom: 12px; overflow: hidden; }
.pr-stage > summary { list-style: none; display: flex; align-items: baseline; gap: 12px; padding: 8px 20px; background: var(--idle-hover); cursor: pointer; }
.pr-stage > summary::-webkit-details-marker { display: none; }
.pr-stage[open] > summary { border-bottom: 1px solid var(--idle-line); }
.pr-stage > summary:hover { background: var(--idle-line); }
.pr-stage > summary small { margin-left: auto; font-size: 13px; font-weight: 600; color: var(--idle-ink); white-space: nowrap; }
.pr-stage > summary small b { color: var(--accent); }
.pr-stage > summary::after { content: ''; align-self: center; flex: none; width: 7px; height: 7px; border-right: 2px solid var(--idle-ink); border-bottom: 2px solid var(--idle-ink); transform: rotate(-45deg); transition: transform .15s ease; }
.pr-stage[open] > summary::after { transform: rotate(45deg); }
.pr-stage h2 { font-size: 15px; margin: 0; color: var(--idle-ink); }
.pr-stage summary p { margin: 0; font-size: 13px; color: var(--idle-ink); opacity: .75; }
.pr-row { display: flex; align-items: center; gap: 16px; padding: 8px 20px; border-top: 1px solid var(--line); }
.pr-row:first-of-type { border-top: 0; }
.pr-row.sub { padding-left: 44px; }
.pr-row div { flex: 1; min-width: 0; }
.pr-row b { display: block; font-weight: 600; font-size: 15px; }
.pr-row span { color: var(--soft); font-size: 13px; }
.pr-state { font-size: 14px; font-weight: 600; color: var(--faint); white-space: nowrap; }
.pr-state.changed { color: var(--accent); }
.pr-row .ns-btn { height: 30px; padding: 0 12px; font-size: 13px; }
.pr-edit { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; align-items: start; }
.pr-part { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 20px 24px; margin-bottom: 20px; box-shadow: var(--shadow); }
.pr-part h2 { font-size: 17px; margin: 0; display: flex; align-items: baseline; gap: 12px; }
.pr-part h2 small { font: 600 13px/1 var(--body); color: var(--faint); }
.pr-part h2 small.changed { color: var(--accent); }
.pr-part > p { margin: 4px 0 12px; color: var(--soft); font-size: 14px; }
.pr-text { width: 100%; min-height: 320px; resize: vertical; font: 14px/1.55 var(--mono); padding: 14px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--page); color: var(--ink); }
.pr-text:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.pr-actions { display: flex; gap: 10px; justify-content: flex-end; align-items: center; }
.pr-side { position: sticky; top: 24px; display: flex; flex-direction: column; gap: 20px; }
.pr-box { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 18px 20px; }
.pr-box h3 { font-size: 15px; margin: 0 0 6px; }
.pr-box p { margin: 0 0 10px; color: var(--soft); font-size: 14px; }
.pr-words { list-style: none; margin: 0; padding: 0; }
.pr-words li { border-top: 1px solid var(--line); }
.pr-words button { width: 100%; text-align: left; background: none; border: 0; padding: 7px 0; font: 13px/1.3 var(--mono); color: var(--idle-ink); cursor: pointer; }
.pr-words button:hover { color: var(--accent); }
.pr-versions { list-style: none; margin: 0; padding: 0; }
.pr-versions li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 14px; }
.pr-versions button { background: none; border: 0; color: var(--idle-ink); font-weight: 600; cursor: pointer; padding: 0; }
.pr-crumb { margin-bottom: 8px; font-size: 14px; }
.pr-crumb a { color: var(--idle-ink); text-decoration: none; font-weight: 600; }
.pr-problem { margin: 0 0 20px; padding: 12px 16px; border: 1px solid var(--bad); border-left-width: 4px; border-radius: var(--r-ctl); background: var(--bad-tint); color: var(--ink); }
@media (max-width: 980px) { .pr-edit { grid-template-columns: 1fr; } .pr-side { position: static; } }
@media (max-width: 640px) { .pr-row { flex-wrap: wrap; padding: 8px 14px; } .pr-stage > summary { flex-wrap: wrap; padding: 8px 14px; gap: 2px 10px; } }
`;

export function promptsListPage(): Html {
  const row = (p: PromptEntry): Html => {
    if (p.href) return html`<div class="pr-row"><div><b>${p.name}</b><span>${p.about}</span></div><a class="ns-btn quiet" href="${p.href}">Open</a></div>`;
    const changed = isChanged(p);
    return html`<div class="pr-row${p.style ? ' sub' : ''}"><div><b>${p.name}</b><span>${p.about}</span></div>
      <span class="pr-state ${changed ? 'changed' : ''}">${changed ? 'Changed' : 'Default'}</span>
      <a class="ns-btn quiet" href="/new-website/prompts/${p.key}">Edit</a></div>`;
  };
  return html`
    <style>${raw(CSS)}</style>
    <div data-plain>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Prompts</h1>
        <p class="ns-lede">The instructions the AI follows at each step, from picking keywords to making reels. Change one and the next article, post or reel uses it. You can always go back to an earlier version or to the default.</p>
      </div>
    </div>
    ${PROMPT_STAGES.map(
      (s) => {
        const count = s.prompts.filter((p) => !p.style).length + (s.link ? 1 : 0);
        const changed = s.prompts.filter((p) => !p.href && isChanged(p)).length;
        return html`<details class="pr-stage" data-stage="${s.title}"><summary><h2>${s.title}</h2><p>${s.about}</p>
          <small>${String(count)} ${count === 1 ? 'prompt' : 'prompts'}${changed ? html` · <b>${String(changed)} changed</b>` : raw('')}</small></summary>
        ${s.prompts.map(row)}
        ${s.link
          ? html`<div class="pr-row"><div><b>${s.link.name}</b><span>${s.link.about}</span></div><a class="ns-btn quiet" href="${s.link.href}">Edit</a></div>`
          : raw('')}</details>`;
      },
    )}
    </div>
    <script>
    (function () {
      // Each category opens and closes; the page remembers which ones were left open.
      document.querySelectorAll('details.pr-stage').forEach(function (d) {
        var key = 'pr-stage:' + d.dataset.stage;
        try { if (localStorage.getItem(key) === '1') d.open = true; } catch (e) {}
        d.addEventListener('toggle', function () {
          try { localStorage.setItem(key, d.open ? '1' : '0'); } catch (e) {}
        });
      });
    })();
    </script>`;
}

const when = (sqlite: string): string => {
  const d = new Date(sqlite.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? sqlite : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function promptEditPage(p: PromptEntry, texts?: Record<string, string>, problem = ''): Html {
  const parts = partsOf(p);
  const words = wordsFor(p);
  const versions: (PromptVersionRow & { label: string })[] = parts
    .flatMap((part) => listPromptVersions(part.file).map((v) => ({ ...v, label: part.label })))
    .sort((a, b) => b.id - a.id)
    .slice(0, 12);
  return html`
    <style>${raw(CSS)}</style>
    <div data-plain>
    <div class="pr-crumb"><a href="/new-website/prompts">Prompts</a> › ${p.name}</div>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">${p.name}</h1>
        <p class="ns-lede">${p.about}</p>
      </div>
      <div class="pr-actions">
        <a class="ns-btn quiet" href="/new-website/prompts">Back</a>
        <button class="ns-btn primary" form="pr-form">Save</button>
      </div>
    </div>
    ${problem ? html`<p class="pr-problem" role="alert">${problem}</p>` : raw('')}
    <div class="pr-edit">
      <form id="pr-form" method="post" action="/new-website/prompts/${p.key}">
        ${parts.map((part, i) => {
          const changed = getPromptOverride(part.file) !== undefined;
          return html`<div class="pr-part"><h2>${part.label}<small class="${changed ? 'changed' : ''}">${changed ? 'Changed' : 'Default'}</small></h2>
            <p>${part.help}</p>
            <textarea class="pr-text" name="part${String(i)}" spellcheck="false" aria-label="${part.label}">${texts?.[part.file] ?? current(part.file)}</textarea></div>`;
        })}
        <div class="pr-actions"><button class="ns-btn primary">Save</button></div>
      </form>
      <aside class="pr-side">
        ${words.length
          ? html`<div class="pr-box"><h3>Words you can use</h3><p>Each is replaced by the article’s own value. Click one to add it where the cursor is.</p>
              <ul class="pr-words">${words.map((w) => html`<li><button type="button" data-word="${w}">{{${w}}}</button></li>`)}</ul></div>`
          : raw('')}
        <div class="pr-box"><h3>Earlier versions</h3>
          ${versions.length
            ? html`<p>Saved each time you change it. Using one keeps the current text in this list too.</p>
              <ul class="pr-versions">${versions.map(
                (v) => html`<li><span>${when(v.created_at)} · ${v.label}</span>
                  <form method="post" action="/new-website/prompts/${p.key}/restore"><input type="hidden" name="version" value="${String(v.id)}" /><button>Use this</button></form></li>`,
              )}</ul>`
            : html`<p>None yet. Each save keeps the text it replaced here.</p>`}
        </div>
        <div class="pr-box"><h3>Default</h3>
          <p>${isChanged(p) ? 'Go back to the text the platform came with. What you have now is kept in Earlier versions.' : 'This is the text the platform came with.'}</p>
          ${isChanged(p)
            ? html`<form method="post" action="/new-website/prompts/${p.key}"><input type="hidden" name="reset" value="1" /><button class="ns-btn danger">Use the default</button></form>`
            : raw('')}
        </div>
      </aside>
    </div>
    </div>
    <script>
    (function () {
      var last = document.querySelector('.pr-text');
      document.querySelectorAll('.pr-text').forEach(function (t) { t.addEventListener('focus', function () { last = t; }); });
      document.querySelectorAll('[data-word]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!last) return;
          var w = '{{' + b.dataset.word + '}}', s = last.selectionStart, e = last.selectionEnd;
          last.setRangeText(w, s, e, 'end');
          last.focus();
        });
      });
    })();
    </script>`;
}

export interface PromptRouteDeps {
  readFlash: (query: unknown) => NewFlash;
}

/** Keep what it replaces as a version, then store the new text (or drop the change when it is the default again). */
export function store(file: string, text: string): void {
  const before = current(file);
  if (text === before) return;
  savePromptVersion(file, before);
  if (text === readShippedPrompt(file)) deletePromptOverride(file);
  else setPromptOverride(file, text);
}

export function registerPromptRoutes(app: FastifyInstance, deps: PromptRouteDeps): void {
  const entryOf = (request: FastifyRequest): PromptEntry | undefined => ENTRIES.get(String((request.params as { key?: string }).key ?? ''));
  const show = (title: string, body: Html, flash: NewFlash): string =>
    newLayout({ title, active: '/new-website/prompts', body, flash });
  const back = (p: PromptEntry, msg: string, kind: 'ok' | 'error' = 'ok') => `/new-website/prompts/${p.key}?${kind}=${encodeURIComponent(msg)}`;

  app.get('/new-website/prompts', async (request, reply) =>
    reply.type('text/html; charset=utf-8').send(show('Prompts', promptsListPage(), deps.readFlash(request.query))),
  );

  app.get('/new-website/prompts/:key', async (request, reply) => {
    const p = entryOf(request);
    if (!p) return reply.redirect('/new-website/prompts?error=' + encodeURIComponent('There is no such prompt.'), 303);
    return reply.type('text/html; charset=utf-8').send(show(p.name, promptEditPage(p), deps.readFlash(request.query)));
  });

  app.post('/new-website/prompts/:key', async (request, reply) => {
    const p = entryOf(request);
    if (!p) return reply.redirect('/new-website/prompts', 303);
    const b = (request.body ?? {}) as Record<string, unknown>;
    const parts = partsOf(p);
    if (b.reset) {
      for (const part of parts) store(part.file, readShippedPrompt(part.file));
      invalidatePromptCache();
      return reply.redirect(back(p, 'Back to the default. The text you had is in Earlier versions.'), 303);
    }
    const texts = Object.fromEntries(parts.map((part, i) => [part.file, String(b[`part${i}`] ?? '').replace(/\r\n/g, '\n')]));
    const empty = parts.find((part) => !texts[part.file]!.trim());
    if (empty) {
      return reply
        .type('text/html; charset=utf-8')
        .send(show(p.name, promptEditPage(p, texts, `“${empty.label}” is empty. The AI would get nothing to work from. Write it, or use the default.`), null));
    }
    for (const part of parts) store(part.file, texts[part.file]!);
    invalidatePromptCache();
    const unknown = unknownWords(Object.values(texts).join('\n'), wordsFor(p));
    return reply.redirect(
      back(p, unknown.length
        ? `Saved. Note: ${unknown.map((w) => `{{${w}}}`).join(', ')} is not one of the words this step fills in, so it stays empty.`
        : 'Saved. The next run uses it.'),
      303,
    );
  });

  app.post('/new-website/prompts/:key/restore', async (request, reply) => {
    const p = entryOf(request);
    if (!p) return reply.redirect('/new-website/prompts', 303);
    const version = getPromptVersion(Number((request.body as { version?: string } | undefined)?.version) || 0);
    if (!version || !partsOf(p).some((part) => part.file === version.name)) {
      return reply.redirect(back(p, 'That version is not one of this prompt’s.', 'error'), 303);
    }
    store(version.name, version.body);
    invalidatePromptCache();
    return reply.redirect(back(p, `Using the version from ${when(version.created_at)}. The text it replaced is in Earlier versions.`), 303);
  });
}
