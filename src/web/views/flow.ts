/**
 * Flow: the pipeline as a canvas, with one run poured into it.
 *
 * The question this page answers is the one asked while looking at a picture
 * that came out wrong: which words produced it, and where are those words
 * written? So the cards are joined the way the data ran, each one carries the
 * brief it was given and the thing it made, and the prompt behind it is one
 * click away and editable in place.
 *
 * Drawn server-side and made movable in the browser. The cards are absolutely
 * positioned inside one transformed plane, the wires are an SVG sharing its
 * coordinate space, and dragging writes to that plane rather than re-rendering
 * anything. Positions are the viewer's own preference, so they live in
 * localStorage -- moving a card is not a change to the run.
 */
import {
  escapeHtml,
  formatDuration,
  html,
  raw,
  timeAgo,
  type Html,
} from './layout.js';
import { START, type FlowEdge } from '../../core/flow-graph.js';
import type { FlowCell } from '../../core/flow-run.js';
import type { PromptFile } from '../../pipeline/prompt-files.js';

export interface FlowPageData {
  cells: FlowCell[];
  edges: readonly FlowEdge[];
  run: {
    id: number;
    title: string;
    status: string;
    site: string;
    keyword: string;
    startedAt: string;
    postUrl: string | null;
  } | null;
  /** The runs the picker offers, newest first. */
  runs: { id: number; label: string; status: string }[];
  /** Every prompt half, so a card can open the right one without another trip. */
  prompts: PromptFile[];
}

/** Card geometry. The client reads these too, through the data attributes. */
const CARD_W = 280;
const COL_GAP = 120;
const ROW_H = 250;

const x = (column: number): number => column * (CARD_W + COL_GAP);
const y = (row: number): number => row * ROW_H;

const STATUS_LABEL: Record<string, string> = {
  ok: 'done',
  failed: 'failed',
  running: 'running',
  skipped: 'skipped',
  pending: 'not reached',
};

function trim(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function card(cell: FlowCell): Html {
  const { node } = cell;
  const left = x(node.column);
  const top = y(node.row);

  return html`<article class="fx-card fx-${cell.status}" data-step="${node.step}"
           style="left:${left}px;top:${top}px">
    <header class="fx-head">
      <span class="fx-kind fx-kind-${node.kind}"></span>
      <strong>${node.title}</strong>
      <span class="fx-status">${STATUS_LABEL[cell.status] ?? cell.status}</span>
    </header>

    ${cell.imageUrl
      ? html`<img class="fx-shot" src="${cell.imageUrl}" alt="${node.title}" loading="lazy" />`
      : raw('')}

    ${cell.input
      ? html`<div class="fx-label">Given</div>
          <p class="fx-text">${trim(cell.input, 170)}</p>`
      : raw('')}

    ${cell.summary && !cell.imageUrl
      ? html`<div class="fx-label">Made</div>
          <p class="fx-text">${trim(cell.summary, 170)}</p>`
      : raw('')}

    ${cell.error
      ? html`<p class="fx-err">${trim(cell.error, 160)}</p>`
      : raw('')}

    <footer class="fx-foot">
      ${node.promptFile
        ? html`<button type="button" class="fx-open" data-open="${node.step}">Prompt</button>`
        : raw('')}
      <button type="button" class="fx-open" data-open="${node.step}">Details</button>
      ${cell.durationMs
        ? html`<span class="fx-meta">${formatDuration(cell.durationMs)}</span>`
        : raw('')}
    </footer>
  </article>`;
}

/**
 * The wires.
 *
 * Cubic béziers leaving the right edge and arriving at the left, with the
 * control points pushed out horizontally: the same shape every node editor
 * uses, because a straight line between two columns crosses the cards between
 * them.
 */
function wires(cells: FlowCell[], edges: readonly FlowEdge[]): Html {
  const at = new Map(cells.map((c) => [c.node.step, c.node] as const));
  const paths: string[] = [];

  for (const edge of edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (!from || !to) continue;

    const x1 = x(from.column) + CARD_W;
    const y1 = y(from.row) + 60;
    const x2 = x(to.column);
    const y2 = y(to.row) + 60;
    const bend = Math.max(60, (x2 - x1) / 2);

    paths.push(
      `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" ` +
        `data-from="${escapeHtml(edge.from)}" data-to="${escapeHtml(edge.to)}" />`,
    );
  }

  return raw(`<svg class="fx-wires" width="4000" height="1400">${paths.join('')}</svg>`);
}

/** Everything a card's panel needs, as JSON the client reads on demand. */
function payload(data: FlowPageData): Html {
  const byPrompt = new Map(data.prompts.map((p) => [`${p.prompt}.${p.half}`, p]));

  const cells = data.cells.map((cell) => {
    const file = cell.node.promptFile;
    const halves = file
      ? ['system', 'user', 'template']
          .map((half) => byPrompt.get(`${file}.${half}`))
          .filter((p): p is PromptFile => Boolean(p))
          .map((p) => ({ file: p.file, half: p.half, edited: p.edited }))
      : [];

    return {
      step: cell.node.step,
      title: cell.node.title,
      blurb: cell.node.blurb,
      status: cell.status,
      input: cell.input,
      summary: cell.summary,
      imageUrl: cell.imageUrl,
      error: cell.error,
      model: cell.model,
      tokens: cell.tokens,
      duration: formatDuration(cell.durationMs),
      settings: cell.node.settings ?? null,
      promptFile: file ?? null,
      halves,
      // Only a picture can be tried again cheaply, and only when its brief is
      // known: the retry re-sends that text and nothing else.
      retryable: cell.node.kind === 'image' && cell.node.step.startsWith('generate-image-') && !!cell.input,
    };
  });

  return raw(
    `<script type="application/json" id="fx-data">${JSON.stringify(cells).replace(/</g, '\\u003c')}</script>`,
  );
}

export function flowPage(data: FlowPageData): Html {
  if (!data.run) {
    return html`
      <h1>Flow</h1>
      <p class="subtitle">The pipeline, with a run poured into it.</p>
      <div class="card">
        <p class="muted">No runs yet. Publish an article and this fills in.</p>
      </div>
    `;
  }

  const run = data.run;

  return html`
    <div class="spread">
      <div>
        <h1>Flow</h1>
        <p class="subtitle">
          What each step was given and what it made. Follow a wire backwards from
          anything that came out wrong.
        </p>
      </div>
      <form method="get" action="/flow" class="row wrap">
        <select name="run" onchange="this.form.submit()">
          ${data.runs.map(
            (r) => html`<option value="${r.id}" ${r.id === run.id ? raw('selected') : raw('')}>
              #${r.id} · ${r.label}
            </option>`,
          )}
        </select>
      </form>
    </div>

    <div class="card fx-bar">
      <div>
        <strong>${run.title || run.keyword || `Run ${run.id}`}</strong>
        <span class="muted small">
          ${run.site} · ${run.status} · ${timeAgo(run.startedAt)}
        </span>
      </div>
      <div class="row wrap">
        ${run.postUrl
          ? html`<a class="button small" href="${run.postUrl}" target="_blank" rel="noopener">The article</a>`
          : raw('')}
        <a class="button small" href="/runs/${run.id}">Steps &amp; cost</a>
        <button type="button" class="small" id="fx-fit">Fit</button>
      </div>
    </div>

    <div class="fx-stage" id="fx-stage">
      <div class="fx-plane" id="fx-plane">
        ${wires(data.cells, data.edges)}
        ${data.cells.map(card)}
      </div>
      <div class="fx-hint muted small">Drag a card to move it · drag the background to pan · scroll to zoom</div>
    </div>

    <aside class="fx-panel" id="fx-panel" hidden>
      <header class="fx-panel-head">
        <strong id="fx-panel-title"></strong>
        <button type="button" class="small" id="fx-close">Close</button>
      </header>
      <div class="fx-panel-body" id="fx-panel-body"></div>
    </aside>

    ${payload(data)}
    ${raw(SCRIPT.replace('__RUN__', String(run.id)))}
  `;
}

/* The canvas behaviour: move, pan, zoom, and the panel. */
const SCRIPT = `<script>
(function () {
  var stage = document.getElementById('fx-stage');
  var plane = document.getElementById('fx-plane');
  if (!stage || !plane) return;

  var RUN = __RUN__;
  var cells = {};
  try {
    JSON.parse(document.getElementById('fx-data').textContent).forEach(function (c) {
      cells[c.step] = c;
    });
  } catch (e) {}

  // The viewer's own arrangement, not the run's. Kept per run-less key so a
  // layout made once holds for every run you open afterwards.
  var KEY = 'flow-layout-v1';
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}

  // Opens fitted rather than at 1:1: the graph is wider than any screen,
  // and the whole point is seeing the shape before picking a card.
  var view = { x: 20, y: 16, k: 0.55 };

  function apply() {
    plane.style.transform =
      'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.k + ')';
  }

  function placeSaved() {
    Object.keys(saved).forEach(function (step) {
      var el = plane.querySelector('[data-step="' + CSS.escape(step) + '"]');
      if (!el) return;
      el.style.left = saved[step].x + 'px';
      el.style.top = saved[step].y + 'px';
    });
    drawWires();
  }

  // The wires are redrawn from where the cards actually are, so a moved card
  // keeps its connections instead of leaving them behind.
  function drawWires() {
    var svg = plane.querySelector('.fx-wires');
    if (!svg) return;
    svg.querySelectorAll('path').forEach(function (path) {
      var a = plane.querySelector('[data-step="' + CSS.escape(path.dataset.from) + '"]');
      var b = plane.querySelector('[data-step="' + CSS.escape(path.dataset.to) + '"]');
      if (!a || !b) return;
      var x1 = a.offsetLeft + a.offsetWidth;
      var y1 = a.offsetTop + 60;
      var x2 = b.offsetLeft;
      var y2 = b.offsetTop + 60;
      var bend = Math.max(60, (x2 - x1) / 2);
      path.setAttribute('d',
        'M ' + x1 + ' ' + y1 + ' C ' + (x1 + bend) + ' ' + y1 + ', ' +
        (x2 - bend) + ' ' + y2 + ', ' + x2 + ' ' + y2);
    });
  }

  /* ---- moving one card, and panning the background ---- */
  var drag = null;

  stage.addEventListener('pointerdown', function (e) {
    var card = e.target.closest('.fx-card');
    if (e.target.closest('button') || e.target.closest('a')) return;

    if (card) {
      drag = {
        kind: 'card', el: card,
        dx: e.clientX / view.k - card.offsetLeft,
        dy: e.clientY / view.k - card.offsetTop,
      };
      card.classList.add('fx-dragging');
    } else {
      drag = { kind: 'pan', dx: e.clientX - view.x, dy: e.clientY - view.y };
    }
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (drag.kind === 'card') {
      drag.el.style.left = Math.round(e.clientX / view.k - drag.dx) + 'px';
      drag.el.style.top = Math.round(e.clientY / view.k - drag.dy) + 'px';
      drawWires();
    } else {
      view.x = e.clientX - drag.dx;
      view.y = e.clientY - drag.dy;
      apply();
    }
  });

  stage.addEventListener('pointerup', function (e) {
    if (drag && drag.kind === 'card') {
      drag.el.classList.remove('fx-dragging');
      saved[drag.el.dataset.step] = {
        x: parseInt(drag.el.style.left, 10) || 0,
        y: parseInt(drag.el.style.top, 10) || 0,
      };
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (err) {}
    }
    drag = null;
    stage.releasePointerCapture(e.pointerId);
  });

  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    var next = Math.min(1.6, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    // Zoom toward the cursor rather than the corner, so the thing being
    // looked at stays where it is.
    var rect = stage.getBoundingClientRect();
    var px = e.clientX - rect.left;
    var py = e.clientY - rect.top;
    view.x = px - (px - view.x) * (next / view.k);
    view.y = py - (py - view.y) * (next / view.k);
    view.k = next;
    apply();
  }, { passive: false });

  document.getElementById('fx-fit').addEventListener('click', function () {
    view = { x: 20, y: 20, k: 0.55 };
    apply();
  });

  /* ---- the panel ---- */
  var panel = document.getElementById('fx-panel');
  var title = document.getElementById('fx-panel-title');
  var body = document.getElementById('fx-panel-body');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function open(step) {
    var c = cells[step];
    if (!c) return;
    title.textContent = c.title;

    var out = '<p class="muted small">' + esc(c.blurb) + '</p>';

    if (c.error) out += '<div class="flash error">' + esc(c.error) + '</div>';
    if (c.imageUrl) out += '<img class="fx-panel-shot" src="' + esc(c.imageUrl) + '" alt="">';

    if (c.input) {
      out += '<div class="fx-label">What it was given</div>' +
        '<pre class="fx-pre">' + esc(c.input) + '</pre>';
    }
    if (c.summary) {
      out += '<div class="fx-label">What it made</div>' +
        '<pre class="fx-pre">' + esc(c.summary) + '</pre>';
    }

    var meta = [];
    if (c.model) meta.push('model ' + esc(c.model));
    if (c.duration) meta.push(esc(c.duration));
    if (c.tokens) meta.push(c.tokens + ' tokens');
    if (meta.length) out += '<p class="muted small">' + meta.join(' · ') + '</p>';

    if (c.retryable) {
      out += '<div class="fx-label">Try this brief again</div>' +
        '<p class="help">Generates one picture from the text below and shows it here. ' +
        'The article is not touched.</p>' +
        '<textarea class="fx-try" id="fx-try" rows="6">' + esc(c.input) + '</textarea>' +
        '<div class="row"><button type="button" class="primary small" id="fx-run">Generate</button>' +
        '<span class="muted small" id="fx-run-note"></span></div>' +
        '<div id="fx-run-out"></div>';
    }

    if (c.halves.length) {
      out += '<div class="fx-label">The prompt behind it</div>';
      c.halves.forEach(function (h) {
        out += '<a class="button small" href="/settings/prompts?file=' +
          encodeURIComponent(h.file) + '">Edit ' + esc(h.half) +
          (h.edited ? ' (edited)' : '') + '</a> ';
      });
    }
    if (c.settings) {
      out += '<div class="fx-label">Settings</div>' +
        '<a class="button small" href="' + esc(c.settings.href) + '">' +
        esc(c.settings.label) + '</a>';
    }

    body.innerHTML = out;
    panel.hidden = false;

    var run = document.getElementById('fx-run');
    if (run) run.addEventListener('click', function () { tryBrief(step); });
  }

  function tryBrief(step) {
    var note = document.getElementById('fx-run-note');
    var out = document.getElementById('fx-run-out');
    var button = document.getElementById('fx-run');
    var prompt = document.getElementById('fx-try').value;

    button.disabled = true;
    note.textContent = 'Generating — this takes a minute…';
    out.innerHTML = '';

    fetch('/flow/' + RUN + '/try/' + encodeURIComponent(step), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: prompt }),
    })
      .then(function (r) { return r.json(); })
      .then(function (b) {
        button.disabled = false;
        if (b.url) {
          note.textContent = 'Done.';
          out.innerHTML = '<img class="fx-panel-shot" src="' + esc(b.url) + '" alt="">';
        } else {
          note.textContent = '';
          out.innerHTML = '<div class="flash error">' + esc(b.error || 'It did not come back.') + '</div>';
        }
      })
      .catch(function (e) {
        button.disabled = false;
        note.textContent = '';
        out.innerHTML = '<div class="flash error">' + esc(e.message) + '</div>';
      });
  }

  stage.addEventListener('click', function (e) {
    var opener = e.target.closest('[data-open]');
    if (opener) open(opener.dataset.open);
  });
  document.getElementById('fx-close').addEventListener('click', function () {
    panel.hidden = true;
  });

  placeSaved();
  apply();
})();
</script>`;
