import type { FastifyInstance, FastifyRequest } from 'fastify';
import { get, run } from '../db/index.js';
import { setModelOverride } from '../db/repos.js';
import { GeminiError, type GeminiFile, type GeminiReply } from '../integrations/gemini.js';
import { GEMINI_LAST_ERROR, GEMINI_LAST_OK, GEMINI_MODEL, geminiClient, recordGeminiOutcome, type GeminiChats } from '../llm/gemini.js';
import { invalidatePromptCache, modelFor, PROMPT_MODELS } from '../pipeline/prompts.js';
import type { Settings } from '../settings.js';
import { html, raw, type Html } from '../web/views/layout.js';
import { listGoogleAccounts } from './google-accounts.js';
import { PROMPT_STAGES } from './prompts-page.js';
import type { Fetch } from './platform.js';

/**
 * Gemini on Platform settings: whether it works, which steps use it, and a box to try it.
 *
 * Gemini needs nothing set up of its own. It runs in the image service's browser, beside Google
 * Flow, signed in with the same Google account, and its extension is installed with the image
 * service. So this section has one decision on it -- which steps Gemini writes -- and that is off
 * for every step until someone ticks one, so an installation behaves exactly as before.
 */

/**
 * Each article's Gemini chat, kept on its own row (keyword_seo.gemini_chat). A key that is not an
 * article's has no chat to keep: such a prompt starts a new one each time.
 */
export const geminiChats: GeminiChats = {
  get(key) {
    const id = /^article:(\d+)$/.exec(key)?.[1];
    return id ? (get<{ gemini_chat: string }>('SELECT gemini_chat FROM keyword_seo WHERE id = ?', Number(id))?.gemini_chat ?? '') : '';
  },
  set(key, conversationId) {
    const id = /^article:(\d+)$/.exec(key)?.[1];
    if (id) run('UPDATE keyword_seo SET gemini_chat = ? WHERE id = ?', conversationId, Number(id));
  },
};

/** The Prompts page's stages, keeping only prompts an AI writes (not picture templates). */
export const GEMINI_STAGES = PROMPT_STAGES.map((stage) => ({
  title: stage.title,
  about: stage.about,
  prompts: stage.prompts.map((p) => p.key).filter((key) => key in PROMPT_MODELS),
})).filter((stage) => stage.prompts.length > 0);

/** The stages whose every prompt is answered by Gemini. */
export function geminiStages(): string[] {
  return GEMINI_STAGES.filter((s) => s.prompts.every((p) => modelFor(p) === GEMINI_MODEL)).map((s) => s.title);
}

/**
 * Turn Gemini on for the named stages and off for the rest. Turning a stage off removes only the
 * Gemini choice: a prompt someone pointed at another model keeps it.
 */
export function setGeminiStages(titles: string[]): void {
  const on = new Set(titles);
  for (const stage of GEMINI_STAGES) {
    for (const prompt of stage.prompts) {
      if (on.has(stage.title)) setModelOverride(prompt, GEMINI_MODEL);
      else if (modelFor(prompt) === GEMINI_MODEL) setModelOverride(prompt, '');
    }
  }
  invalidatePromptCache();
}

/**
 * The Google account Gemini asks as. With one account (or none listed) it is the browser's own
 * signed-in account, addressed plainly; with several, the first on the list, the same one Flow
 * jobs try first -- Gemini cannot otherwise tell which of the signed-in accounts is meant.
 */
export function geminiAccount(): string {
  const accounts = listGoogleAccounts().filter((a) => a.email.trim());
  return accounts.length >= 2 ? accounts[0]!.email.trim() : '';
}

/** Plain words for a failure code from the Gemini page. */
export function geminiProblem(code: string, message: string): string {
  switch (code) {
    case 'NOT_SIGNED_IN':
      return 'No Google account is signed in to Gemini. Open the Browser page (bottom left) and sign in to Google.';
    case 'WRONG_ACCOUNT':
      return `${message} The Browser page is where accounts are signed in.`;
    case 'TIMEOUT':
      return 'Gemini did not answer in time. Try again in a minute.';
    case 'STOPPED':
      return 'The Gemini page stopped reporting back in the middle of a prompt. It was not sent again, so Gemini was not asked twice.';
    case 'NOT_AN_ANSWER':
    case 'NOT_JSON':
      return `${message}. The step used your AI keys instead.`;
    case 'GONE':
      return 'The image service restarted while Gemini was answering. Send it again.';
    case 'KEY':
    case 'SERVICE':
    case 'SETUP':
      return `The image service, where Gemini runs, is not answering properly: ${message}`;
    default:
      return message;
  }
}

export interface GeminiState {
  kind: 'ok' | 'bad' | 'idle';
  label: string;
  detail: string;
}

/**
 * The badge and the line under it, from the last prompt's outcome and the service's answer.
 * `serviceProblem` is the page's own image-service check, when it has made one: a service already
 * known to be down is not asked again.
 */
export async function geminiState(settings: Settings, fetchImpl?: Fetch, serviceProblem?: string | null): Promise<GeminiState> {
  const client = geminiClient(settings, fetchImpl as typeof fetch | undefined);
  if (!client) return { kind: 'bad', label: 'Not available', detail: 'The image service is not configured, and Gemini runs there.' };
  const down = { kind: 'bad', label: 'Not answering', detail: 'The image service is not answering. Gemini runs there, beside Google Flow.' } as const;
  if (serviceProblem) return down;
  try {
    await client.status();
  } catch {
    return down;
  }

  const okAt = settings.get(GEMINI_LAST_OK);
  const failed = settings.get(GEMINI_LAST_ERROR);
  if (failed) {
    const [at = '', ...rest] = failed.split(' ');
    const { code, message } = GeminiError.from(rest.join(' '));
    return {
      kind: 'bad',
      label: code === 'NOT_SIGNED_IN' || code === 'WRONG_ACCOUNT' ? 'Sign-in needed' : 'Last prompt failed',
      detail: `${geminiProblem(code, message)} (${at.slice(0, 16).replace('T', ' ')})`,
    };
  }
  if (okAt) return { kind: 'ok', label: 'Working', detail: `Last answer ${okAt.slice(0, 16).replace('T', ' ')}.` };
  return { kind: 'idle', label: 'Not tried yet', detail: 'Send a test message below to check it.' };
}

const CSS = `
.gm-steps { display: grid; gap: 8px; margin: 4px 0 14px; }
.gm-step { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: baseline; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--surface); cursor: pointer; }
.gm-step:has(input:checked) { border-color: var(--accent); background: var(--accent-tint); }
.gm-step input { grid-row: span 2; }
.gm-step span { color: var(--soft); font-size: 14px; }
.gm-hint { color: var(--soft); font-size: 14px; margin: 0 0 14px; max-width: 80ch; }
.gm-try textarea { width: 100%; min-height: 96px; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: var(--r-ctl); background: var(--surface); color: var(--ink); font: inherit; resize: vertical; }
.gm-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 10px; }
.gm-row input[type=file] { font-size: 14px; color: var(--soft); }
.gm-wait { color: var(--soft); font-size: 14px; }
.gm-reply { margin-top: 16px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--r-ctl); background: var(--raised); }
.gm-reply.bad { border-color: var(--bad); background: var(--bad-tint); }
.gm-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: inherit; }
.gm-code { margin: 12px 0 0; padding: 10px 12px; border-radius: var(--r-ctl); background: var(--surface); border: 1px solid var(--line); overflow-x: auto; font: 13px/1.5 var(--mono); white-space: pre; }
.gm-pics { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.gm-pics img { max-width: 260px; max-height: 260px; border-radius: var(--r-ctl); border: 1px solid var(--line); }
.gm-actions { display: flex; gap: 8px; margin-top: 12px; }
`;

/** The section, as it sits among the other parts of Platform settings. */
export function geminiSection(state: GeminiState, onStages: string[], account: string): Html {
  const badge = state.kind === 'ok' ? 'ok' : state.kind === 'bad' ? 'bad' : '';
  return html`<style>${raw(CSS)}</style>
  <section class="pf-group" id="gemini">
    <div><h2>Gemini</h2><span class="pf-state ${badge}">${state.label}</span></div>
    <dl>
      <dt>How it works</dt><dd>Gemini runs in the same browser as Google Flow, signed in with your Google account. There is nothing to install or connect.</dd>
      <dt>Google account</dt><dd>${account || 'The account signed in on the Browser page'}</dd>
      <dt>Status</dt><dd>${state.detail}</dd>
      <dt>Steps using Gemini</dt><dd>${onStages.length ? onStages.join(', ') : 'None yet. Your AI keys write everything.'}</dd>
    </dl>
    <details class="pf-wide pf-more">
      <summary>Choose which steps Gemini writes</summary>
      <form method="post" action="/new-website/gemini/steps">
        <div class="gm-steps">${GEMINI_STAGES.map(
          (s) => html`<label class="gm-step"><input type="checkbox" name="stage" value="${s.title}" ${raw(onStages.includes(s.title) ? 'checked' : '')}><b>${s.title}</b><span>${s.about}</span></label>`,
        )}</div>
        <p class="gm-hint">If Gemini cannot answer (signed out, or its daily limit reached), that step is written by your AI keys instead, so nothing stops.
          Gemini's daily limits are low for automatic use: start with one light step, such as Social posts.</p>
        <button class="ns-btn primary small" type="submit">Save</button>
      </form>
    </details>
    <details class="pf-wide pf-more gm-try" id="gemini-try">
      <summary>Try Gemini</summary>
      <form id="gm-form">
        <label for="gm-prompt" class="gm-hint">Ask anything. Links in your message are read too, and you can attach pictures, PDFs or other files.</label>
        <textarea id="gm-prompt" name="prompt" placeholder="For example: write three short Pinterest titles for a lemon cake recipe"></textarea>
        <div class="gm-row">
          <input type="file" id="gm-files" multiple>
          <button class="ns-btn primary small" type="submit" id="gm-send">Send</button>
          <span class="gm-wait" id="gm-wait" role="status"></span>
        </div>
      </form>
      <div class="gm-reply" id="gm-reply" hidden></div>
    </details>
  </section>
  ${raw(TRY_SCRIPT)}`;
}

// The reply is put on the page as text nodes, never as HTML: it is whatever Gemini wrote.
const TRY_SCRIPT = `<script>
(function () {
  var form = document.getElementById('gm-form');
  if (!form) return;
  var send = document.getElementById('gm-send'), wait = document.getElementById('gm-wait'), out = document.getElementById('gm-reply');
  // Files travel as base64 (a third larger) in a request the server caps at 20 MB.
  var MAX = 14 * 1024 * 1024;
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function readFile(f) {
    return new Promise(function (ok, no) {
      var r = new FileReader();
      r.onload = function () { ok({ name: f.name, mime: f.type || 'application/octet-stream', base64: String(r.result).split(',')[1] || '' }); };
      r.onerror = function () { no(new Error('Could not read ' + f.name)); };
      r.readAsDataURL(f);
    });
  }
  function show(reply, error) {
    out.hidden = false; out.className = 'gm-reply' + (error ? ' bad' : ''); out.textContent = '';
    if (error) { out.appendChild(el('p', 'gm-text', error)); return; }
    out.appendChild(el('pre', 'gm-text', reply.text || '(no text)'));
    (reply.code_blocks || []).forEach(function (b) { out.appendChild(el('pre', 'gm-code', b.code)); });
    var pics = (reply.images || []).filter(function (i) { return i.data_base64; });
    if (pics.length) {
      var box = el('div', 'gm-pics');
      pics.forEach(function (i) { var img = el('img'); img.src = 'data:' + (i.mime || 'image/png') + ';base64,' + i.data_base64; img.alt = i.alt || 'Picture from Gemini'; box.appendChild(img); });
      out.appendChild(box);
    }
    var actions = el('div', 'gm-actions'), copy = el('button', 'ns-btn small', 'Copy as Markdown');
    copy.type = 'button';
    copy.onclick = function () { navigator.clipboard.writeText(reply.markdown || reply.text || '').then(function () { copy.textContent = 'Copied'; }); };
    actions.appendChild(copy); out.appendChild(actions);
  }
  function done() { send.disabled = false; send.classList.remove('busy'); wait.textContent = ''; }
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var prompt = document.getElementById('gm-prompt').value.trim();
    var picked = Array.from(document.getElementById('gm-files').files || []);
    if (!prompt && !picked.length) { show(null, 'Write a message or attach a file first.'); return; }
    if (picked.reduce(function (n, f) { return n + f.size; }, 0) > MAX) { show(null, 'The files are too large together. Keep them under 14 MB.'); return; }
    send.disabled = true; send.classList.add('busy'); wait.textContent = 'Sending…'; out.hidden = true;
    try {
      var files = await Promise.all(picked.map(readFile));
      var r = await fetch('/new-website/gemini/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: prompt, files: files }) });
      var body = await r.json();
      if (!r.ok) throw new Error(body.error || 'Could not send it.');
      var started = Date.now();
      for (;;) {
        await new Promise(function (ok) { setTimeout(ok, 2000); });
        var s = Math.round((Date.now() - started) / 1000);
        wait.textContent = 'Gemini is answering… ' + s + ' s (the first message can take a minute while the browser starts)';
        var p = await fetch('/new-website/gemini/ask/' + encodeURIComponent(body.id));
        var job = await p.json();
        if (job.status === 'done') { show(job.reply); break; }
        if (job.status === 'failed' || !p.ok) { show(null, job.error || 'Gemini could not answer.'); break; }
      }
    } catch (err) { show(null, err.message || String(err)); }
    done();
  });
})();
</script>`;

const many = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)]);

export interface GeminiRouteDeps {
  settings: Settings;
  fetchImpl?: Fetch;
}

/** What the page shows of a reply; pictures only as data (their blob: addresses mean nothing here). */
const forPage = (reply: GeminiReply) => ({
  text: reply.text,
  markdown: reply.markdown,
  code_blocks: reply.code_blocks,
  images: reply.images.filter((i) => i.data_base64).map((i) => ({ alt: i.alt, mime: i.mime, data_base64: i.data_base64 })),
});

export function registerGeminiRoutes(app: FastifyInstance, deps: GeminiRouteDeps): void {
  const { settings } = deps;
  const client = () => geminiClient(settings, deps.fetchImpl as typeof fetch | undefined);

  app.post('/new-website/gemini/steps', async (request: FastifyRequest, reply) => {
    const known = new Set(GEMINI_STAGES.map((s) => s.title));
    const picked = many((request.body as Record<string, unknown> | undefined)?.stage).filter((t) => known.has(t));
    setGeminiStages(picked);
    const message = picked.length ? `Gemini now writes: ${picked.join(', ')}.` : 'Gemini writes nothing now. Your AI keys write every step.';
    return reply.redirect(`/new-website/platform?ok=${encodeURIComponent(message)}#gemini`, 303);
  });

  app.post('/new-website/gemini/ask', async (request: FastifyRequest, reply) => {
    const body = (request.body ?? {}) as { prompt?: unknown; files?: unknown };
    const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 100_000) : '';
    const files = (Array.isArray(body.files) ? body.files : [])
      .filter((f): f is GeminiFile => Boolean(f && typeof f.name === 'string' && typeof f.mime === 'string' && typeof f.base64 === 'string'))
      .slice(0, 10);
    if (!prompt.trim() && !files.length) return reply.status(400).send({ error: 'Write a message or attach a file first.' });

    const gemini = client();
    if (!gemini) return reply.status(503).send({ error: geminiProblem('SETUP', 'it has no address or key in this deployment.') });
    try {
      const id = await gemini.submit({ prompt, files, account: geminiAccount(), images: true, timeoutS: 300 });
      return reply.send({ id });
    } catch (err) {
      const e = err instanceof GeminiError ? err : new GeminiError(String(err), 'SERVICE');
      return reply.status(502).send({ error: geminiProblem(e.code, e.message) });
    }
  });

  app.get('/new-website/gemini/ask/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const gemini = client();
    if (!gemini) return reply.status(503).send({ status: 'failed', error: geminiProblem('SETUP', 'it has no address or key in this deployment.') });
    try {
      const job = await gemini.job(id);
      if (job.status === 'done' && job.result) {
        recordGeminiOutcome(settings, null);
        return reply.send({ status: 'done', reply: forPage(job.result) });
      }
      if (job.status === 'failed') {
        const e = GeminiError.from(job.error ?? '');
        recordGeminiOutcome(settings, `${e.code}: ${e.message}`);
        return reply.send({ status: 'failed', error: geminiProblem(e.code, e.message) });
      }
      return reply.send({ status: job.status });
    } catch (err) {
      const e = err instanceof GeminiError ? err : new GeminiError(String(err), 'SERVICE');
      return reply.status(502).send({ status: 'failed', error: geminiProblem(e.code, e.message) });
    }
  });
}
