import { html, raw, type Html } from './layout.js';
import { STUCK_TEXT } from '../../guide/assistant.js';
import type { GuideMessage, SiteProgress } from '../../guide/state.js';
import type {
  IdentityResult,
  KeywordsResult,
  PillarsResult,
  ShortlistResult,
  StepDef,
  StepKey,
} from '../../guide/steps.js';

/**
 * The content guide.
 *
 * Built for someone who loses the thread in long pages: one card, one step,
 * the assistant speaking first, and the full map folded away until asked for.
 */

export interface GuideListRow {
  site: { id: number; name: string; domain: string };
  progress: SiteProgress;
  stepTitle: string;
}

export function guideListPage(rows: GuideListRow[]): Html {
  return html`
    <div class="page-head"><h1>Guide</h1></div>
    <p class="muted">Pick one site and follow it step by step. The assistant helps on every step.</p>
    <div class="guide-sites">
      ${rows.length
        ? rows.map(
            (r) => html`
              <div class="card guide-site">
                <div>
                  <strong>${r.site.name}</strong> <span class="muted">${r.site.domain}</span>
                  <div class="muted">
                    ${r.progress.started
                      ? r.progress.finished
                        ? `Pillar ${r.progress.round} done — ready for the next one`
                        : `Step ${r.progress.index} of ${r.progress.total} · ${r.stepTitle}`
                      : 'Not started'}
                  </div>
                </div>
                <a class="button primary" href="/guide/${r.site.id}">${r.progress.started ? 'Continue' : 'Start'}</a>
              </div>
            `,
          )
        : html`<p>Add a site under Channels first.</p>`}
    </div>
  `;
}

export interface GuideCardData {
  site: { id: number; name: string; domain: string };
  step: StepDef;
  index: number;
  total: number;
  round: number;
  currentPillar: string;
  messages: GuideMessage[];
  result: unknown | null;
  map: { def: StepDef; state: 'done' | 'current' | 'open' | 'locked' }[];
  finished: boolean;
}

/** A saved result in plain words, one line per item. */
export function summarizeResult(step: StepKey, result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  switch (step) {
    case 'identity':
      return [(result as IdentityResult).identity];
    case 'pillars':
      return (result as PillarsResult).pillars;
    case 'search-console':
      return ['Connected'];
    case 'keywords': {
      const r = result as KeywordsResult;
      return [
        `${r.keywords.length} keywords for “${r.pillar}”${r.verified ? '' : ' (unchecked guesses)'}`,
        ...r.keywords,
      ];
    }
    case 'shortlist':
      return (result as ShortlistResult).items.map(
        (i) => `${i.type === 'article' ? 'Article' : 'Recipe'}: ${i.keyword}`,
      );
    case 'import':
      return ['Added to Keywords'];
  }
}

const MANUAL_HINT: Record<StepKey, string> = {
  identity: 'One line: who the site is for.',
  pillars: 'Three lines, one pillar each.',
  'search-console': '',
  keywords: 'First line: the pillar. Then one keyword per line.',
  shortlist: 'First line: the pillar article. Then one recipe per line.',
  import: '',
};

function bubble(m: GuideMessage): Html {
  return html`<div class="guide-msg ${m.role}">${m.content}</div>`;
}

function savedBlock(data: GuideCardData): Html {
  const lines = summarizeResult(data.step.key, data.result);
  return html`
    <div class="guide-saved">
      <h3>Saved</h3>
      ${lines.length
        ? html`<ul>${lines.slice(0, 60).map((l) => html`<li>${l}</li>`)}</ul>`
        : html`<p class="muted">Nothing yet.</p>`}
    </div>
  `;
}

function manualForm(data: GuideCardData): Html {
  const id = data.site.id;
  if (data.step.key === 'search-console') {
    return html`
      <form method="post" action="/guide/${id}/save" class="guide-manual">
        <label><input type="checkbox" name="confirmed" value="1" required /> I’ve done this</label>
        <button type="submit">Save</button>
      </form>
    `;
  }
  if (data.step.key === 'import') return html``;
  return html`
    <details class="guide-manual">
      <summary>Or type it yourself</summary>
      <form method="post" action="/guide/${id}/save">
        <p class="muted">${MANUAL_HINT[data.step.key]}</p>
        <textarea name="manual" rows="5"></textarea>
        <button type="submit">Save</button>
      </form>
    </details>
  `;
}

function importBlock(data: GuideCardData): Html {
  const id = data.site.id;
  if (data.finished) {
    return html`
      <div class="guide-finished">
        <p><strong>Done!</strong> These keywords are in Keywords and will be written on the site’s normal schedule.</p>
        <form method="post" action="/guide/${id}/next-pillar">
          <button class="primary" type="submit">Start next pillar →</button>
        </form>
      </div>
    `;
  }
  const shortlist = data.result as ShortlistResult | null;
  return html`<p class="muted">Untick anything you changed your mind about.</p>
    <form method="post" action="/guide/${id}/import" class="guide-import">
      <ul>
        ${(shortlist?.items ?? []).map(
          (item, i) => html`<li><label>
            <input type="checkbox" name="pick" value="${i}" checked />
            ${item.type === 'article' ? 'Article' : 'Recipe'}: ${item.keyword}
          </label></li>`,
        )}
      </ul>
      <button class="primary" type="submit">Add to Keywords</button>
    </form>`;
}

export function guideCardPage(data: GuideCardData): Html {
  const id = data.site.id;
  const pct = Math.round(((data.index - 1) / data.total) * 100);
  const last = [...data.messages].reverse().find((m) => m.role === 'assistant');
  const hasAssistant = data.step.prompt !== null;

  return html`
    <div class="guide-card card">
      <div class="guide-head">
        <span><a href="/guide">Guide</a> › ${data.site.domain}${data.step.perRound ? ` · Pillar ${data.round}` : ''}</span>
        <span>Step ${data.index} of ${data.total}</span>
      </div>
      <div class="guide-progress"><div style="width:${pct}%"></div></div>

      <h1>${data.step.title}</h1>
      <p><strong>Why:</strong> ${data.step.why}</p>
      <details><summary>How</summary><ul>${data.step.how.map((h) => html`<li>${h}</li>`)}</ul></details>

      ${data.step.key === 'import'
        ? importBlock(data)
        : html`${hasAssistant
              ? html`
                  <div
                    class="guide-chat"
                    id="guide-chat"
                    data-chat-url="/guide/${id}/chat"
                    data-save-url="/guide/${id}/save"
                    data-stuck="${STUCK_TEXT}"
                    data-empty="${data.messages.length === 0 ? '1' : ''}"
                    data-last="${last ? JSON.stringify(last.payload) : ''}"
                  >
                    <div class="guide-log" id="guide-log">${data.messages.map(bubble)}</div>
                    <div class="guide-controls" id="guide-controls"></div>
                    <form class="guide-send" id="guide-send">
                      <input type="text" name="text" placeholder="Type here if you want…" autocomplete="off" />
                      <button type="submit">Send</button>
                    </form>
                    <div class="guide-quick">
                      <button type="button" data-say="Give me other ideas.">🔄 Other ideas</button>
                      <button type="button" data-stuck-button>😵 I’m stuck</button>
                    </div>
                  </div>
                `
              : html``}
            ${savedBlock(data)} ${manualForm(data)}`}

      <div class="guide-nav">
        <form method="post" action="/guide/${id}/back">
          <button type="submit" ${data.index === 1 ? raw('disabled') : raw('')}>← Back</button>
        </form>
        ${data.step.key === 'import'
          ? html``
          : html`<form method="post" action="/guide/${id}/done">
              <button class="primary" type="submit" ${data.result ? raw('') : raw('disabled')}>Done →</button>
            </form>`}
      </div>
    </div>

    <details class="guide-map">
      <summary>See the whole map</summary>
      <ol>
        ${data.map.map(({ def, state }) =>
          state === 'locked'
            ? html`<li class="locked">${def.title}</li>`
            : html`<li class="${state}"><a href="/guide/${id}/step/${def.key}">${state === 'done' ? '✓ ' : ''}${def.title}</a></li>`,
        )}
      </ol>
    </details>
    ${raw(GUIDE_SCRIPT)}
  `;
}

/**
 * The chat. Plain DOM, textContent only -- model text is never parsed as HTML.
 * A reply's chips and draft replace the controls; "Use this" posts the draft
 * to /save as a normal form so the page reloads with it saved.
 */
const GUIDE_SCRIPT = `<script>
(function () {
  var box = document.getElementById('guide-chat');
  if (!box) return;
  var log = document.getElementById('guide-log');
  var controls = document.getElementById('guide-controls');
  var form = document.getElementById('guide-send');
  var busy = false;

  function bubble(role, text) {
    var div = document.createElement('div');
    div.className = 'guide-msg ' + role;
    div.textContent = text;
    log.appendChild(div);
    div.scrollIntoView({ block: 'nearest' });
    return div;
  }

  function draftLines(d) {
    if (!d) return [];
    if (d.identity) return [d.identity];
    if (d.pillars) return d.pillars;
    if (d.keywords) return [d.keywords.length + ' keywords for \\u201c' + d.pillar + '\\u201d'].concat(d.keywords);
    if (d.items) return d.items.map(function (i) { return (i.type === 'article' ? 'Article: ' : 'Recipe: ') + i.keyword; });
    return [];
  }

  function button(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls || '';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function show(payload) {
    controls.textContent = '';
    if (!payload) return;
    var choices = payload.choices || [];
    var picked = [];
    if (choices.length) {
      var row = document.createElement('div');
      row.className = 'guide-chips';
      choices.forEach(function (c) {
        var chip = button(c, 'chip', function () {
          if (!payload.multi) return send(c);
          var at = picked.indexOf(c);
          if (at >= 0) { picked.splice(at, 1); chip.classList.remove('on'); }
          else { picked.push(c); chip.classList.add('on'); }
        });
        row.appendChild(chip);
      });
      controls.appendChild(row);
      if (payload.multi) {
        controls.appendChild(button('Send selected', 'primary', function () {
          if (picked.length) send(picked.join(', '));
        }));
      }
    }
    if (payload.draft) {
      var card = document.createElement('div');
      card.className = 'guide-draft';
      var ul = document.createElement('ul');
      draftLines(payload.draft).slice(0, 60).forEach(function (l) {
        var li = document.createElement('li');
        li.textContent = l;
        ul.appendChild(li);
      });
      card.appendChild(ul);
      card.appendChild(button('\\ud83d\\udc4d Use this', 'primary', function () { save(payload.draft); }));
      card.appendChild(button('\\u270f\\ufe0f Change it', '', function () {
        form.elements.text.focus();
      }));
      controls.appendChild(card);
    }
  }

  function save(draft) {
    var f = document.createElement('form');
    f.method = 'post';
    f.action = box.dataset.saveUrl;
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = 'draft_json';
    input.value = JSON.stringify(draft);
    f.appendChild(input);
    document.body.appendChild(f);
    f.submit();
  }

  function send(text) {
    if (busy) return;
    busy = true;
    if (text) bubble('user', text);
    controls.textContent = '';
    var wait = bubble('assistant thinking', 'Thinking\\u2026');
    fetch(box.dataset.chatUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text || null })
    })
      .then(function (r) { return r.json(); })
      .then(function (reply) {
        wait.remove();
        bubble('assistant', reply.message);
        show(reply);
      })
      .catch(function () {
        wait.remove();
        bubble('assistant', 'Something went wrong. Try again in a moment.');
      })
      .then(function () { busy = false; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = form.elements.text.value.trim();
    if (!text) return;
    form.elements.text.value = '';
    send(text);
  });

  box.querySelectorAll('[data-say]').forEach(function (b) {
    b.addEventListener('click', function () { send(b.dataset.say); });
  });
  var stuck = box.querySelector('[data-stuck-button]');
  if (stuck) stuck.addEventListener('click', function () { send(box.dataset.stuck); });

  if (box.dataset.empty) send(null);
  else if (box.dataset.last) { try { show(JSON.parse(box.dataset.last)); } catch (e) {} }
})();
</script>`;
