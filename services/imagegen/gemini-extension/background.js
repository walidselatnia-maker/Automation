// Gemini Chat service worker.
//
// Long-polls the agent beside it for a prompt, runs it in a Gemini window of its own through the
// content script, and posts the reply back. One prompt at a time; a heartbeat every few seconds
// tells the agent the prompt is still being worked on, so a hand-off lost in transit is put back
// in the queue instead of waiting out its whole timeout.
//
// The window is a popup created straight at the Gemini address, never a blank tab: Flow Kit
// takes over blank tabs on startup and opens its own tabs in the first *normal* window, so a
// popup keeps the two extensions out of each other's way. Chrome here runs with background
// throttling off and covered windows counted as visible (docker/supervisord.conf), so the page
// keeps working while Flow's window is in front of it.
const AGENT = 'http://127.0.0.1:8100/ext/gemini';
const APP = 'https://gemini.google.com/app';

const ports = new Map(); // tabId -> content-script port
let polling = false;
// Set when a prompt fails: whatever it left on the page (a half-typed prompt, an attachment) is
// not trusted, so the next prompt gets a freshly loaded page.
let dirty = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'gemini-chat' || !port.sender?.tab) return;
  const tabId = port.sender.tab.id;
  ports.set(tabId, port);
  port.onDisconnect.addListener(() => {
    if (ports.get(tabId) === port) ports.delete(tabId);
  });
});

// ── the Gemini window ────────────────────────────────────────────────────────
// The tab is ours while it is on Gemini, or on Google's sign-in where Gemini sends a signed-out
// account. Anywhere else, Flow Kit has it: it is left to Flow and a new window is opened, rather
// than pulling Flow's page out from under a picture being made.
const OURS = /^https:\/\/(gemini|accounts)\.google\.com\//;

async function geminiTab() {
  const { tabId } = await chrome.storage.session.get('tabId');
  if (tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && OURS.test(tab.pendingUrl || tab.url || '')) return tab;
  }
  const win = await chrome.windows.create({ url: APP, type: 'popup', focused: false, left: 0, top: 0, width: 1280, height: 720 });
  const tab = win.tabs[0];
  await chrome.storage.session.set({ tabId: tab.id });
  return tab;
}

function loaded(tabId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error('NO_PROMPT_BOX: the Gemini page did not finish loading'));
    }, timeoutMs);
    function onUpdate(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

// Ask the page to do something and wait for its answer ({ rid, ok }).
function request(port, cmd, timeoutMs = 15_000) {
  const rid = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(ok) {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onGone);
      resolve(ok);
    }
    function onMessage(msg) { if (msg.rid === rid) done(Boolean(msg.ok)); }
    function onGone() { done(false); }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onGone);
    port.postMessage({ cmd, rid });
  });
}

// The page for a prompt: the chat it continues (one per article), or a new chat -- never whatever
// chat the previous prompt left open. The page is only loaded again when it has to be: an
// article's next prompt goes into its chat where it already is, and a new chat comes from
// Gemini's own New chat button. Switching to another article's chat loads that chat.
async function openChat(account, conversationId) {
  const continuing = /^[A-Za-z0-9_-]{1,64}$/.test(conversationId || '');
  const path = continuing ? `${APP}/${conversationId}` : APP;
  const tab = await geminiTab();
  const open = ports.get(tab.id);
  const here = (tab.url || '').split(/[?#]/)[0];
  if (open && tab.status === 'complete' && !dirty) {
    if (here === path) return open;
    if (!continuing && here.startsWith(`${APP}/`) && (await request(open, 'newChat'))) return open;
  }

  const url = account ? `${path}?authuser=${encodeURIComponent(account)}` : path;
  ports.delete(tab.id);
  const done = loaded(tab.id);
  await chrome.tabs.update(tab.id, { url });
  await done;
  const now = await chrome.tabs.get(tab.id);
  // An account that is not signed in is sent to Google's sign-in page instead.
  if (!(now.url || '').startsWith('https://gemini.google.com/')) {
    throw new Error(`NOT_SIGNED_IN: Google asked to sign in${account ? ` ${account}` : ''}. Sign in on the Browser page.`);
  }
  for (let i = 0; i < 80 && !ports.get(tab.id); i++) await sleep(250);
  const port = ports.get(tab.id);
  if (!port) throw new Error('NO_PROMPT_BOX: the Gemini page did not load the extension');
  dirty = false;
  return port;
}

async function run(job) {
  const port = await openChat(job.payload.account || '', job.payload.conversationId || '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('TIMEOUT: the Gemini page stopped answering')), (job.payload.timeoutMs || 240_000) + 30_000);
    function finish(err, result) {
      clearTimeout(timer);
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onGone);
      if (err) reject(err);
      else resolve(result);
    }
    function onMessage(msg) {
      // The page's heartbeat: it keeps this worker alive and is passed on to the agent.
      if (msg.beat === job.id) {
        post('/beat', { id: job.id }).catch(() => {});
        return;
      }
      if (msg.id !== job.id) return;
      if (msg.ok) finish(null, msg.result);
      else finish(new Error(msg.error));
    }
    function onGone() {
      finish(new Error('NO_PROMPT_BOX: the Gemini page closed or reloaded during the prompt'));
    }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onGone);
    port.postMessage({ cmd: 'run', job });
  });
}

// ── talking to the agent ─────────────────────────────────────────────────────
const post = (path, body) =>
  fetch(`${AGENT}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function report(id, body) {
  for (let i = 0; i < 3; i++) {
    try {
      if ((await post('/result', { id, ...body })).ok) return;
    } catch { /* the agent is restarting */ }
    await sleep(1000);
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      let job = null;
      try {
        const r = await fetch(`${AGENT}/poll`);
        if (r.status === 200) job = (await r.json()).job;
      } catch {
        await sleep(3000); // the agent is not up yet
        continue;
      }
      if (!job) continue;
      // The first beat says the prompt arrived. From then on the agent never hands it out again,
      // so Gemini is never asked the same prompt twice.
      await post('/beat', { id: job.id }).catch(() => {});
      const beat = setInterval(() => post('/beat', { id: job.id }).catch(() => {}), 5_000);
      try {
        await report(job.id, { ok: true, result: await run(job) });
      } catch (e) {
        dirty = true;
        await report(job.id, { ok: false, error: e.message || String(e) });
      } finally {
        clearInterval(beat);
      }
    }
  } finally {
    polling = false;
  }
}

// A service worker is stopped when idle; the alarm brings the loop back.
chrome.alarms.create('gemini-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'gemini-keepalive') pollLoop(); });
chrome.runtime.onStartup.addListener(pollLoop);
chrome.runtime.onInstalled.addListener(pollLoop);
pollLoop();
