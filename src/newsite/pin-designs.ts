import type { FastifyInstance, FastifyRequest } from 'fastify';
import { all, get, run } from '../db/index.js';
import { invalidatePromptCache, loadTemplate, render } from '../pipeline/prompts.js';
import { html, raw, type Html } from '../web/views/layout.js';
import { newLayout, type NewFlash } from './layout.js';
import { current, store } from './prompts-page.js';

/**
 * Pinterest pin designs: the picture prompts pins are made from.
 *
 * The four shipped designs read their prompt files (an edit is kept the same
 * way as on the Prompts page); designs added on the dashboard keep their text
 * here. Only the picked designs are used to make pins, in turn per channel.
 */

export interface PinDesign {
  id: number;
  name: string;
  file: string;
  body: string;
  picked: number;
}

/** The words a design can use; each pin fills them in. */
export const DESIGN_WORDS = ['scene', 'detail', 'headline', 'cta', 'domain'] as const;

export const listPinDesigns = (): PinDesign[] => all<PinDesign>('SELECT id, name, file, body, picked FROM newsite_pin_designs ORDER BY id');
export const getPinDesign = (id: number): PinDesign | undefined =>
  get<PinDesign>('SELECT id, name, file, body, picked FROM newsite_pin_designs WHERE id = ?', id);

/** The designs pins are made from. Never empty while any design exists: picking keeps at least one. */
export function pickedPinDesigns(): PinDesign[] {
  const list = listPinDesigns();
  const picked = list.filter((d) => d.picked);
  return picked.length ? picked : list;
}

export const designText = (d: PinDesign): string => (d.file ? current(d.file) : d.body);

/** A design's prompt for one pin, with its words filled in. */
export const renderDesign = (d: PinDesign, context: Record<string, unknown>): string =>
  d.file ? loadTemplate(d.file, context) : render(d.body, context);

export function addPinDesign(name: string, body: string, picked = true): number {
  return Number(run('INSERT INTO newsite_pin_designs (name, body, picked) VALUES (?, ?, ?)', name, body, picked ? 1 : 0).lastInsertRowid);
}

/** Pick or unpick a design. The last picked one cannot be unpicked: pins need at least one. */
export function setPinDesignPicked(id: number, picked: boolean): boolean {
  if (!picked && listPinDesigns().filter((d) => d.picked && d.id !== id).length === 0) return false;
  run('UPDATE newsite_pin_designs SET picked = ? WHERE id = ?', picked ? 1 : 0, id);
  return true;
}

const nextName = (): string => {
  const used = new Set(listPinDesigns().map((d) => d.name.toLowerCase()));
  let n = listPinDesigns().length + 1;
  while (used.has(`design ${n}`)) n++;
  return `Design ${n}`;
};

const unknownWords = (text: string): string[] => {
  const ok = new Set<string>(DESIGN_WORDS);
  return [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!).filter((w) => !ok.has(w)))];
};

const CSS = `
.pd-summary { margin: 0 0 20px; padding: 12px 16px; border: 1px solid var(--idle-line); border-left-width: 4px; border-radius: var(--r-ctl); background: var(--idle); color: var(--ink); }
.pd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 20px; }
.pd-card { display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); box-shadow: var(--shadow); }
.pd-card.picked { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), var(--shadow); }
.pd-card header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
.pd-card h2 { font-size: 17px; margin: 0; }
.pd-card h2 small { display: block; margin-top: 2px; font: 500 13px/1.3 var(--body); color: var(--faint); }
.pd-card p { flex: 1; margin: 0; padding: 14px 20px; color: var(--soft); font-size: 14px; line-height: 1.5; }
.pd-card footer { display: flex; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--line); }
.pd-card footer .ns-btn { height: 34px; padding: 0 14px; font-size: 14px; }
.pd-pick { display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--soft); font: 600 14px/1 var(--body); cursor: pointer; white-space: nowrap; }
.pd-pick svg { width: 16px; height: 16px; }
.pd-pick.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.pd-pick.on svg { fill: currentColor; }
.pd-add { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 220px; border: 2px dashed var(--line-strong); border-radius: var(--r-card); color: var(--idle-ink); text-decoration: none; font-weight: 600; font-size: 16px; }
.pd-add:hover { border-color: var(--accent); color: var(--accent); }
.pd-add span { font-size: 34px; line-height: 1; }
.pd-edit { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; align-items: start; }
.pd-box { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-card); padding: 20px 24px; box-shadow: var(--shadow); }
.pd-box + .pd-box { margin-top: 20px; }
.pd-box h3 { font-size: 15px; margin: 0 0 6px; }
.pd-box p { margin: 0 0 10px; color: var(--soft); font-size: 14px; }
.pd-box label.pd-label { display: block; font-weight: 600; margin: 0 0 6px; }
.pd-name { width: 100%; height: 42px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--page); color: var(--ink); font: inherit; margin-bottom: 18px; }
.pd-text { width: 100%; min-height: 300px; resize: vertical; font: 14px/1.55 var(--mono); padding: 14px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--page); color: var(--ink); }
.pd-check { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-weight: 600; }
.pd-words { list-style: none; margin: 0; padding: 0; }
.pd-words li { border-top: 1px solid var(--line); }
.pd-words button { width: 100%; text-align: left; background: none; border: 0; padding: 7px 0; font: 13px/1.3 var(--mono); color: var(--idle-ink); cursor: pointer; }
.pd-words span { display: block; font: 12px/1.3 var(--body); color: var(--faint); padding-bottom: 6px; }
.pd-crumb { margin-bottom: 8px; font-size: 14px; }
.pd-crumb a { color: var(--idle-ink); text-decoration: none; font-weight: 600; }
.pd-actions { display: flex; gap: 10px; align-items: center; }
.pd-problem { margin: 0 0 20px; padding: 12px 16px; border: 1px solid var(--bad); border-left-width: 4px; border-radius: var(--r-ctl); background: var(--bad-tint); color: var(--ink); }
@media (max-width: 980px) { .pd-edit { grid-template-columns: 1fr; } }
`;

const STAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/></svg>';

const preview = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 220 ? t.slice(0, 220).replace(/\s\S*$/, '') + '…' : t;
};

export function pinDesignsPage(): Html {
  const designs = listPinDesigns();
  const picked = designs.filter((d) => d.picked);
  return html`
    <style>${raw(CSS)}</style>
    <div data-plain>
    <div class="pd-crumb"><a href="/new-website/prompts">Prompts</a> › Pinterest pin designs</div>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">Pinterest pin designs</h1>
        <p class="ns-lede">Each design describes how a pin picture looks. Pick the ones you like with the star: pins are made only from the picked designs, taking them in turn. Facebook and the other channels are not affected.</p>
      </div>
      <a class="ns-btn primary" href="/new-website/pin-designs/new">Add new design</a>
    </div>
    <p class="pd-summary" role="status">Pins are made from <b>${String(picked.length)} of ${String(designs.length)}</b> designs: ${picked.map((d) => d.name).join(', ')}.</p>
    <div class="pd-grid">
      ${designs.map(
        (d) => html`<article class="pd-card ${d.picked ? 'picked' : ''}">
          <header><h2>${d.name}<small>${d.file ? 'Came with the platform' : 'Added by you'}</small></h2>
            <form method="post" action="/new-website/pin-designs/${String(d.id)}/pick">
              <input type="hidden" name="picked" value="${d.picked ? '0' : '1'}" />
              <button class="pd-pick ${d.picked ? 'on' : ''}" aria-pressed="${d.picked ? 'true' : 'false'}" title="${d.picked ? 'Stop using this design' : 'Use this design for pins'}">${raw(STAR)}${d.picked ? 'Used for pins' : 'Not used'}</button>
            </form></header>
          <p>${preview(designText(d))}</p>
          <footer><a class="ns-btn quiet" href="/new-website/pin-designs/${String(d.id)}">Edit</a>
            <form method="post" action="/new-website/pin-designs/${String(d.id)}/remove" onsubmit="return confirm('Delete this design? Pins already made keep their picture.')"><button class="ns-btn danger">Delete</button></form>
          </footer>
        </article>`,
      )}
      <a class="pd-add" href="/new-website/pin-designs/new"><span>+</span>Add new design</a>
    </div>
    </div>`;
}

const WORD_HELP: Record<(typeof DESIGN_WORDS)[number], string> = {
  scene: 'The article’s main photo, described',
  detail: 'A closer detail of the same dish',
  headline: 'The words printed big on the pin',
  cta: 'The small call to action, like “Save for later”',
  domain: 'The website’s address',
};

export function pinDesignEditPage(d: { id?: number; name: string; text: string; picked: boolean; shipped: boolean }, problem = ''): Html {
  const action = d.id ? `/new-website/pin-designs/${d.id}` : '/new-website/pin-designs/new';
  return html`
    <style>${raw(CSS)}</style>
    <div data-plain>
    <div class="pd-crumb"><a href="/new-website/prompts">Prompts</a> › <a href="/new-website/pin-designs">Pinterest pin designs</a> › ${d.id ? d.name : 'New design'}</div>
    <div class="ns-head">
      <div>
        <h1 class="ns-title">${d.id ? d.name : 'New pin design'}</h1>
        <p class="ns-lede">${d.id
          ? 'Changing this design changes only this one. The others stay as they are.'
          : 'Starts from a copy of Design 1. Change it to the look you want; the existing designs stay as they are.'}</p>
      </div>
      <div class="pd-actions"><a class="ns-btn quiet" href="/new-website/pin-designs">Cancel</a>${d.id
        ? html`<button class="ns-btn danger" form="pd-delete">Delete</button>`
        : raw('')}<button class="ns-btn primary" form="pd-form">Save</button></div>
      ${d.id ? html`<form id="pd-delete" method="post" action="/new-website/pin-designs/${String(d.id)}/remove" onsubmit="return confirm('Delete this design? Pins already made keep their picture.')" hidden></form>` : raw('')}
    </div>
    ${problem ? html`<p class="pd-problem" role="alert">${problem}</p>` : raw('')}
    <div class="pd-edit">
      <form id="pd-form" class="pd-box" method="post" action="${action}">
        <label class="pd-label" for="pd-name">Name</label>
        <input id="pd-name" class="pd-name" name="name" value="${d.name}" maxlength="60" required />
        <label class="pd-label" for="pd-text">How the pin looks</label>
        <textarea id="pd-text" class="pd-text" name="text" spellcheck="false">${d.text}</textarea>
        <label class="pd-check"><input type="checkbox" name="picked" value="1" ${raw(d.picked ? 'checked' : '')} /> Use this design for pins</label>
      </form>
      <aside>
        <div class="pd-box"><h3>Words you can use</h3><p>Each pin fills them in. Click one to add it where the cursor is.</p>
          <ul class="pd-words">${DESIGN_WORDS.map((w) => html`<li><button type="button" data-word="${w}">{{${w}}}</button><span>${WORD_HELP[w]}</span></li>`)}</ul></div>
      </aside>
    </div>
    </div>
    <script>
    (function () {
      var box = document.getElementById('pd-text');
      document.querySelectorAll('[data-word]').forEach(function (b) {
        b.addEventListener('click', function () {
          box.setRangeText('{{' + b.dataset.word + '}}', box.selectionStart, box.selectionEnd, 'end');
          box.focus();
        });
      });
    })();
    </script>`;
}

export function registerPinDesignRoutes(app: FastifyInstance, deps: { readFlash: (query: unknown) => NewFlash }): void {
  const show = (title: string, body: Html, flash: NewFlash): string => newLayout({ title, active: '/new-website/prompts', body, flash });
  const list = (msg: string, kind: 'ok' | 'error' = 'ok') => `/new-website/pin-designs?${kind}=${encodeURIComponent(msg)}`;
  const send = (reply: { type: (t: string) => { send: (b: string) => unknown } }, title: string, body: Html) => reply.type('text/html; charset=utf-8').send(show(title, body, null));
  const designOf = (request: FastifyRequest) => getPinDesign(Number((request.params as { id?: string }).id) || 0);
  const form = (request: FastifyRequest) => {
    const b = (request.body ?? {}) as Record<string, unknown>;
    return { name: String(b.name ?? '').trim().slice(0, 60), text: String(b.text ?? '').replace(/\r\n/g, '\n').trim(), picked: String(b.picked ?? '') === '1' };
  };
  const problemOf = (f: { name: string; text: string }): string => {
    if (!f.name) return 'Give the design a name.';
    if (!f.text) return 'Describe how the pin looks. An empty design would make an empty picture.';
    const odd = unknownWords(f.text);
    if (odd.length) return `${odd.map((w) => `{{${w}}}`).join(', ')} is not one of the words a pin fills in. Use the words listed on the right.`;
    return '';
  };

  app.get('/new-website/pin-designs', async (request, reply) =>
    reply.type('text/html; charset=utf-8').send(show('Pinterest pin designs', pinDesignsPage(), deps.readFlash(request.query))),
  );

  app.get('/new-website/pin-designs/new', async (_request, reply) => {
    const first = listPinDesigns()[0];
    return send(reply, 'New pin design', pinDesignEditPage({ name: nextName(), text: first ? designText(first) : '', picked: true, shipped: false }));
  });

  app.post('/new-website/pin-designs/new', async (request, reply) => {
    const f = form(request);
    const problem = problemOf(f);
    if (problem) return send(reply, 'New pin design', pinDesignEditPage({ ...f, shipped: false }, problem));
    addPinDesign(f.name, f.text, f.picked);
    return reply.redirect(list(`${f.name} added${f.picked ? ' and used for pins' : ''}.`), 303);
  });

  app.get('/new-website/pin-designs/:id', async (request, reply) => {
    const d = designOf(request);
    if (!d) return reply.redirect(list('There is no such design.', 'error'), 303);
    return send(reply, d.name, pinDesignEditPage({ id: d.id, name: d.name, text: designText(d), picked: Boolean(d.picked), shipped: Boolean(d.file) }));
  });

  app.post('/new-website/pin-designs/:id', async (request, reply) => {
    const d = designOf(request);
    if (!d) return reply.redirect(list('There is no such design.', 'error'), 303);
    const f = form(request);
    const problem = problemOf(f);
    if (problem) return send(reply, d.name, pinDesignEditPage({ id: d.id, ...f, shipped: Boolean(d.file) }, problem));
    if (!f.picked && !setPinDesignPicked(d.id, false)) {
      return send(reply, d.name, pinDesignEditPage({ id: d.id, ...f, picked: true, shipped: Boolean(d.file) }, 'This is the only design used for pins. Pick another design first, then you can stop using this one.'));
    }
    if (f.picked) setPinDesignPicked(d.id, true);
    if (d.file) {
      store(d.file, f.text);
      invalidatePromptCache();
      run('UPDATE newsite_pin_designs SET name = ? WHERE id = ?', f.name, d.id);
    } else {
      run('UPDATE newsite_pin_designs SET name = ?, body = ? WHERE id = ?', f.name, f.text, d.id);
    }
    return reply.redirect(list(`${f.name} saved.`), 303);
  });

  app.post('/new-website/pin-designs/:id/pick', async (request, reply) => {
    const d = designOf(request);
    if (!d) return reply.redirect(list('There is no such design.', 'error'), 303);
    const want = String((request.body as { picked?: string } | undefined)?.picked ?? '') === '1';
    if (!setPinDesignPicked(d.id, want)) return reply.redirect(list('Pins need at least one design. Pick another one first.', 'error'), 303);
    return reply.redirect(list(want ? `${d.name} is used for pins now.` : `${d.name} is no longer used for pins.`), 303);
  });

  app.post('/new-website/pin-designs/:id/remove', async (request, reply) => {
    const d = designOf(request);
    if (!d) return reply.redirect(list('There is no such design.', 'error'), 303);
    if (listPinDesigns().length === 1) return reply.redirect(list('This is the last design. Add another one before deleting it.', 'error'), 303);
    if (d.picked && listPinDesigns().filter((x) => x.picked && x.id !== d.id).length === 0) {
      return reply.redirect(list('This is the only design used for pins. Star another one first, then delete this one.', 'error'), 303);
    }
    run('DELETE FROM newsite_pin_designs WHERE id = ?', d.id);
    return reply.redirect(list(`${d.name} deleted.`), 303);
  });
}
