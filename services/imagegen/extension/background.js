/**
 * Flow Kit — Chrome Extension Background Service Worker
 *
 * Connects to local Python agent via WebSocket (agent runs WS server).
 * Captures bearer token, solves reCAPTCHA, proxies API calls through browser.
 */

const AGENT_WS_URL = 'ws://127.0.0.1:9222';
// NOTE: This is a browser-restricted public API key — safe to ship in extension bundles.
const API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';

let ws = null;
let flowKey = null;
let callbackSecret = null;  // Auth secret for HTTP callback, received from server on WS connect
let state = 'off'; // off | idle | running
let manualDisconnect = false;

// ─── Account rotation state ───────────────────────────────────
let accounts = [];          // ["email1@gmail.com", "email2@gmail.com"]
let currentAuthUser = 0;    // Index matching Google's ?authuser=N
let autoRotate = true;

let metrics = {
  tokenCapturedAt: null,
  requestCount: 0,   // captcha-consuming requests only (gen image/video/upscale)
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

// ─── URL → Log Type Classifier ─────────────────────────────

// Visible log types — only these appear in the request log
const _VISIBLE_TYPES = new Set(['GEN_IMG', 'GEN_VID', 'GEN_VID_REF', 'UPSCALE', 'TRACKING', 'URL_REFRESH']);

function _classifyApiUrl(url) {
  if (url.includes('uploadImage'))                     return 'UPLOAD';
  if (url.includes('batchGenerateImages'))              return 'GEN_IMG';
  if (url.includes('UpsampleVideo'))                   return 'UPSCALE';
  if (url.includes('ReferenceImages'))                 return 'GEN_VID_REF';
  if (url.includes('batchAsyncGenerateVideo'))          return 'GEN_VID';
  if (url.includes('batchCheckAsync'))                  return 'POLL';
  if (url.includes('upsampleImage'))                   return 'UPS_IMG';
  if (url.includes('/media/'))                         return 'MEDIA';
  if (url.includes('/credits'))                        return 'CREDITS';
  return 'API';
}

// ─── Request Log ────────────────────────────────────────────

let requestLog = [];

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 100) requestLog.pop();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

// ─── Startup ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'reconnect') connectToAgent();
  if (alarm.name === 'keepAlive') keepAlive();
  if (alarm.name === 'token-refresh') {
    await refreshFlowToken('scheduled');
  }
  // Unconditional tab recycle. Something in a Flow tab left open for many
  // hours stops it producing a usable token, and a manual refresh has
  // consistently fixed it on the spot. Rather than keep hunting for what
  // decays, recycle the tab on a timer — cheap, and it matches the fix that
  // demonstrably works.
  if (alarm.name === 'tab-recycle' || alarm.name === 'tab-recycle-retry') {
    await refreshFlowToken('periodic');
  }
});

// ─── State hydration ────────────────────────────────────────
// An MV3 service worker is terminated after ~30s idle and revived by the next
// event. Revival re-runs this file from scratch, so every module-level
// variable — flowKey included — resets to its initial value, and neither
// onInstalled nor onStartup fires to restore it.
//
// That is the real cause of NO_FLOW_KEY appearing after a long run: the token
// was never lost, just forgotten. It sat in chrome.storage the whole time.
// Reloading the Flow tab appeared to fix it only because the reload made the
// page send a request, and the header listener re-captured the token.
//
// Hydrating at module scope restores it on every revival, and awaiting the
// same promise before reading flowKey closes the race where a request arrives
// mid-hydration.

let _hydration = null;
let _hydratedAt = null;
const _workerStartedAt = Date.now();

async function reloadFromStorage() {
  const data = await chrome.storage.local.get([
    'flowKey', 'metrics', 'callbackSecret', 'accounts', 'currentAuthUser', 'autoRotate',
  ]);
  if (data.flowKey) flowKey = data.flowKey;
  if (data.metrics) Object.assign(metrics, data.metrics);
  if (data.callbackSecret) callbackSecret = data.callbackSecret;
  if (data.accounts) accounts = data.accounts;
  if (data.currentAuthUser !== undefined) currentAuthUser = data.currentAuthUser;
  if (data.autoRotate !== undefined) autoRotate = data.autoRotate;
  _hydratedAt = Date.now();
  console.log('[FlowAgent] State loaded from storage (flowKey present:', !!flowKey, ')');
  return !!flowKey;
}

function ensureHydrated() {
  // Cached deliberately: the common case is many calls per worker lifetime and
  // only the first needs to touch storage. Recovery paths must NOT use this —
  // a cached "no token" result would be returned forever even after one lands
  // in storage. They call reloadFromStorage() directly.
  if (!_hydration) _hydration = reloadFromStorage();
  return _hydration;
}

// Runs on every service-worker revival, not only on install/startup.
ensureHydrated();

async function init() {
  await ensureHydrated();
  connectToAgent();
  chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
}

// ─── Token Capture ──────────────────────────────────────────

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    // Always update — even if same token string, refresh the timestamp
    flowKey = token;
    metrics.tokenCapturedAt = Date.now();
    chrome.storage.local.set({ flowKey, metrics });
    console.log('[FlowAgent] Bearer token captured');

    // Notify agent
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);

let _openingFlowTab = false;

async function captureTokenFromFlowTab() {
  const tabs = await chrome.tabs.query({
    url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
  });
  if (!tabs.length) {
    if (_openingFlowTab) {
      console.log('[FlowAgent] Flow tab already opening, skipping');
      return;
    }
    _openingFlowTab = true;
    try {
      await openFlowTab('token-refresh');
      await sleep(3000);
      const retryTabs = await chrome.tabs.query({
        url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
      });
      if (!retryTabs.length) {
        console.log('[FlowAgent] Flow tab not ready yet after open');
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: retryTabs[0].id },
        files: ['content.js'],
      });
      console.log('[FlowAgent] Token refresh triggered on newly opened Flow tab');
    } catch (e) {
      console.error('[FlowAgent] Token refresh failed after opening tab:', e);
    } finally {
      _openingFlowTab = false;
    }
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      files: ['content.js'],
    });
    console.log('[FlowAgent] Token refresh triggered on Flow tab');
  } catch (e) {
    console.error('[FlowAgent] Token refresh failed:', e);
  }
}

// ─── Diagnostics ────────────────────────────────────────────
// NO_FLOW_KEY has now been "fixed" twice and come back. The failure only
// appears after many hours, so it cannot be reproduced on demand — the only
// way to stop guessing is to record enough state that one snapshot taken while
// it is broken identifies the cause.
//
// The distinctions that matter, none of which the old status message could
// tell apart:
//   token in memory but not storage   the worker holds it, persistence failed
//   token in storage but not memory   hydration is not running or not working
//   token in neither                  capture stopped happening entirely
//   no Flow tab                       nothing can produce a token
//   Flow tab discarded                Chrome evicted it under memory pressure
//   tab URL not on labs.google        navigated away or bounced to a sign-in

async function collectDiagnostics() {
  const now = Date.now();
  const diag = {
    now: new Date(now).toISOString(),
    worker_uptime_s: Math.round((now - _workerStartedAt) / 1000),
    hydrated_at: _hydratedAt ? new Date(_hydratedAt).toISOString() : null,
    state,
    ws_open: ws?.readyState === WebSocket.OPEN,

    token_in_memory: !!flowKey,
    token_age_s: metrics.tokenCapturedAt
      ? Math.round((now - metrics.tokenCapturedAt) / 1000) : null,
    token_captured_at: metrics.tokenCapturedAt
      ? new Date(metrics.tokenCapturedAt).toISOString() : null,

    metrics: { ...metrics },
    refresh_in_flight: _refreshInFlight,
  };

  try {
    const stored = await chrome.storage.local.get(['flowKey', 'metrics']);
    diag.token_in_storage = !!stored.flowKey;
    diag.token_matches_storage = !!stored.flowKey && stored.flowKey === flowKey;
    diag.storage_token_captured_at = stored.metrics?.tokenCapturedAt
      ? new Date(stored.metrics.tokenCapturedAt).toISOString() : null;
  } catch (e) {
    diag.token_in_storage = 'error: ' + e.message;
  }

  try {
    const flowTabs = await queryFlowTabs();
    diag.flow_tabs = flowTabs.map((t) => ({
      id: t.id,
      url: (t.url || '').slice(0, 120),
      status: t.status,
      discarded: t.discarded === true,
      frozen: t.frozen === true,
      active: t.active,
    }));
    const allTabs = await chrome.tabs.query({});
    diag.total_tabs = allTabs.length;
    diag.non_flow_tab_urls = allTabs
      .filter((t) => !(t.url || '').includes('/tools/flow'))
      .map((t) => (t.url || '').slice(0, 90))
      .slice(0, 10);
  } catch (e) {
    diag.flow_tabs = 'error: ' + e.message;
  }

  try {
    const alarms = await chrome.alarms.getAll();
    diag.alarms = alarms.map((a) => ({
      name: a.name,
      next_in_s: Math.round((a.scheduledTime - now) / 1000),
      period_min: a.periodInMinutes,
    }));
  } catch (e) {
    diag.alarms = 'error: ' + e.message;
  }

  diag.tab_audit_recent = tabAudit.slice(-10);
  return diag;
}

// ─── Flow token refresh ─────────────────────────────────────
// The bearer token expires after roughly an hour. Injecting content.js is not
// enough to renew it: capture is passive, driven by the Authorization header
// on requests the *page* makes, and injecting a script into an idle tab makes
// the page send nothing. Reloading it does.
//
// This reloads an existing tab. It never creates one, so it does not go
// through the openFlowTab gate and cannot contribute to runaway tab creation.

const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;   // refresh well inside the ~60min life
const TAB_RECYCLE_MINUTES = 12 * 60;       // unconditional Flow tab reload
let _refreshInFlight = false;

async function refreshFlowToken(reason) {
  await ensureHydrated();

  if (_refreshInFlight) {
    console.log('[FlowAgent] Token refresh already running, skipping');
    return false;
  }

  // Never reload mid-generation: the in-flight request would go with it.
  // Retry shortly instead of waiting for the next full period.
  if (state === 'running' && reason !== 'on-demand') {
    console.log('[FlowAgent] Busy generating, deferring reload by 5min');
    chrome.alarms.create('tab-recycle-retry', { delayInMinutes: 5 });
    return false;
  }

  // 'periodic' reloads unconditionally. The age check below applies only to
  // 'scheduled', and in practice made that path dead code: the Flow page
  // refreshes its own token constantly, so tokenCapturedAt is almost always
  // recent and the reload was skipped every time. The observed failure —
  // generation stops after many hours, a manual tab refresh fixes it
  // instantly — is cured by recycling the tab regardless of token age.
  if (reason === 'periodic') {
    console.log('[FlowAgent] Periodic tab recycle');
  } else {
    const age = metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : Infinity;
    if (reason === 'scheduled' && flowKey && age < TOKEN_MAX_AGE_MS) {
      console.log('[FlowAgent] Token still fresh (' + Math.round(age / 60000) + 'min), skipping reload');
      return false;
    }
  }

  _refreshInFlight = true;
  try {
    const tabs = await queryFlowTabs();
    if (!tabs.length) {
      // No tab to reload — fall back to the guarded open/inject path.
      await captureTokenFromFlowTab();
      return !!flowKey;
    }

    const before = metrics.tokenCapturedAt;
    console.log('[FlowAgent] Reloading Flow tab to refresh token (' + reason + ')');
    await chrome.tabs.reload(tabs[0].id, { bypassCache: false });

    // The header listener fires as the page re-requests. Poll briefly rather
    // than guessing a fixed delay.
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      if (metrics.tokenCapturedAt && metrics.tokenCapturedAt !== before) {
        console.log('[FlowAgent] Token refreshed after reload');
        return true;
      }
    }
    console.warn('[FlowAgent] Reloaded but no new token seen within 20s');
    return false;
  } catch (e) {
    console.error('[FlowAgent] Token refresh failed:', e);
    return false;
  } finally {
    _refreshInFlight = false;
  }
}

// ─── WebSocket to Agent ─────────────────────────────────────

function connectToAgent() {
  if (manualDisconnect) return;
  if (ws?.readyState === WebSocket.CONNECTING) return;
  if (ws?.readyState === WebSocket.OPEN) return;

  try {
    ws = new WebSocket(AGENT_WS_URL);
  } catch (e) {
    console.error('[FlowAgent] WS connect error:', e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[FlowAgent] Connected to agent');
    chrome.alarms.clear('reconnect');
    setState('idle');

    // Token refresh alarm — 45 min gives buffer before ~60 min expiry
    chrome.alarms.create('token-refresh', { periodInMinutes: 15 });
    // 12 hours. Alarms persist across service-worker restarts, so creating it
    // on every connect just resets the schedule rather than stacking timers.
    chrome.alarms.create('tab-recycle', { periodInMinutes: TAB_RECYCLE_MINUTES });

    // Send current state + resend token if we have one
    ws.send(JSON.stringify({
      type: 'extension_ready',
      flowKeyPresent: !!flowKey,
      tokenAge: flowKey && metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
    }));
    if (flowKey) {
      ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
    }
  };

  ws.onmessage = async ({ data }) => {
    try {
      const msg = JSON.parse(data);

      if (msg.method === 'api_request') {
        await handleApiRequest(msg);
      } else if (msg.method === 'trpc_request') {
        await handleTrpcRequest(msg);
      } else if (msg.method === 'solve_captcha') {
        await handleSolveCaptcha(msg);
      } else if (msg.method === 'get_status') {
        sendToAgent({
          id: msg.id,
          result: {
            state,
            flowKeyPresent: !!flowKey,
            manualDisconnect,
            tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
            metrics,
          },
        });
      } else if (msg.method === 'get_diagnostics') {
        sendToAgent({ id: msg.id, result: await collectDiagnostics() });
      } else if (msg.type === 'callback_secret') {
        callbackSecret = msg.secret;
        chrome.storage.local.set({ callbackSecret: msg.secret });
        console.log('[FlowAgent] Received callback secret');
      } else if (msg.type === 'pong') {
        // keepalive response
      } else if (msg.method === 'set_accounts') {
        // Update account list from agent
        accounts = msg.params?.accounts || [];
        autoRotate = msg.params?.autoRotate !== undefined ? msg.params.autoRotate : autoRotate;
        if (msg.params?.currentAuthUser !== undefined) currentAuthUser = msg.params.currentAuthUser;
        chrome.storage.local.set({ accounts, autoRotate, currentAuthUser });
        console.log('[FlowAgent] Accounts updated:', accounts.length, 'accounts, authuser=' + currentAuthUser);
        sendToAgent({ id: msg.id, result: { ok: true, count: accounts.length, currentAuthUser } });
      } else if (msg.method === 'switch_account') {
        handleSwitchAccount(msg);
      } else if (msg.method === 'get_account_status') {
        sendToAgent({ id: msg.id, result: {
          accounts,
          currentAuthUser,
          autoRotate,
          flowKeyPresent: !!flowKey,
          connected: ws?.readyState === WebSocket.OPEN,
        }});
      }
    } catch (e) {
      console.error('[FlowAgent] Message error:', e);
    }
  };

  ws.onclose = () => {
    setState('off');
    chrome.alarms.clear('token-refresh');
    if (!manualDisconnect) scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.error('[FlowAgent] WS error:', e);
    metrics.lastError = 'WS_ERROR';
    chrome.storage.local.set({ metrics });
  };
}

function scheduleReconnect() {
  chrome.alarms.create('reconnect', { delayInMinutes: 0.083 }); // ~5s
}

function keepAlive() {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  } else {
    connectToAgent();
  }
}

// ─── Account Switching ──────────────────────────────────────

/**
 * Wait for a tab to finish loading, with timeout.
 */
function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout (' + timeoutMs + 'ms)'));
    }, timeoutMs);
    const listener = (changedTabId, changeInfo) => {
      if (changedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Switch to a different Google account in the Flow tab.
 * Navigates to ?authuser=N to switch account context.
 * @param {object} msg - WS message { id, params: { authUser, auto } }
 */
async function handleSwitchAccount(msg) {
  const { id, params = {} } = msg;
  const { authUser, auto } = params;

  let targetUser;
  if (typeof authUser === 'number') {
    targetUser = authUser;
  } else if (auto && accounts.length > 1) {
    // Auto-rotate: try the next account in the list
    targetUser = (currentAuthUser + 1) % accounts.length;
  } else if (authUser === 'next') {
    targetUser = (currentAuthUser + 1) % Math.max(accounts.length, 1);
  } else if (authUser === 'prev') {
    targetUser = (currentAuthUser - 1 + accounts.length) % Math.max(accounts.length, 1);
  } else {
    targetUser = 0;
  }

  try {
    const tabs = await chrome.tabs.query({
      url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
    });

    if (!tabs.length) {
      // No Flow tab open — just update the index and try to open one
      currentAuthUser = targetUser;
      chrome.storage.local.set({ currentAuthUser });
      await openFlowTab('switch-account', 'https://labs.google/fx/tools/flow?authuser=' + targetUser);
      await sleep(5000);
      await captureTokenFromFlowTab();
      sendToAgent({ id, result: { ok: true, authUser: targetUser, note: 'opened new tab' } });
      return;
    }

    const tab = tabs[0];
    const url = new URL(tab.url);
    url.searchParams.set('authuser', String(targetUser));
    const newUrl = url.toString();

    console.log('[FlowAgent] Switching account: authuser ' + currentAuthUser + ' -> ' + targetUser);
    chrome.storage.local.set({ currentAuthUser: targetUser });

    // Navigate
    await chrome.tabs.update(tab.id, { url: newUrl });

    // Wait for page to load
    try {
      await waitForTabLoad(tab.id, 15000);
    } catch (e) {
      console.warn('[FlowAgent] Tab load wait timeout, proceeding anyway:', e.message);
      await sleep(2000);
    }

    // Extra wait for grecaptcha + token capture
    await sleep(4000);

    // Force token capture
    await captureTokenFromFlowTab();

    currentAuthUser = targetUser;
    console.log('[FlowAgent] Account switched to authuser=' + targetUser);

    sendToAgent({ id, result: { ok: true, authUser: targetUser, account: accounts[targetUser] || null } });
  } catch (e) {
    console.error('[FlowAgent] Account switch failed:', e);
    sendToAgent({ id, error: e.message || 'SWITCH_FAILED' });
  }
}

function sendToAgent(msg) {
  // API responses (with msg.id) go via HTTP — immune to WS disconnect
  if (msg.id) {
    fetch('http://127.0.0.1:8100/api/ext/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    }).catch(() => {
      // HTTP failed — fallback to WS
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    });
    return;
  }
  // Non-response messages (ping, status) or no secret yet — use WS
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── reCAPTCHA Solving ──────────────────────────────────────

// Self-healing captcha solver: if the Flow tab is missing or has navigated to a
// host the extension can't inject into (expired session → accounts.google.com,
// Google "unusual traffic" page, revoked site access), we open a fresh Flow tab
// and retry instead of hard-failing. Recovery is bounded and only triggers on
// fast-fail transport errors so it stays inside the agent's 60s submit window.

const FLOW_TAB_URLS = [
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];
const FLOW_HOME = 'https://labs.google/fx/tools/flow';
const CAPTCHA_HARD_TIMEOUT_MS = 30000;
const FLOW_TAB_READY_TIMEOUT_MS = 15000;   // how long to wait for a repair tab to land on labs.google
const RECOVERY_MAX_ATTEMPTS = 1;            // one bounded recovery beyond the initial try

// ─── Flow tab creation choke point ──────────────────────────
// Every path that opens a Flow tab goes through openFlowTab(). Guarding each
// call site separately has already proven insufficient: the paths run
// concurrently (the worker drives MAX_CONCURRENT_REQUESTS solves in parallel,
// and rate-limit rotation fans out one switch_account per failed response),
// so the only reliable place to bound tab creation is a single global gate.

const FLOW_TAB_CREATE_COOLDOWN_MS = 20000;  // floor between two creations, any caller
let _flowTabCreateInFlight = null;
let _lastFlowTabCreatedAt = 0;

// Rolling audit of creations and of suppressed attempts, so a recurrence can be
// diagnosed from evidence instead of re-derived from the code. Read it from the
// service worker console with: chrome.runtime.sendMessage({type:'TAB_AUDIT'})
const tabAudit = [];
function recordTabEvent(action, reason, extra = {}) {
  const entry = { t: new Date().toISOString(), action, reason, ...extra };
  tabAudit.push(entry);
  if (tabAudit.length > 100) tabAudit.shift();
  console.log(`[FlowAgent][tab] ${action} reason=${reason}`, extra);
}

// Strict lookup — the set of tabs we are willing to message/inject into.
async function queryFlowTabs() {
  return chrome.tabs.query({ url: FLOW_TAB_URLS });
}

// Tolerant existence check, used ONLY to decide whether opening another tab is
// warranted. A healthy Flow tab stops matching FLOW_TAB_URLS while it is
// mid-redirect — an authuser switch bounces through accounts.google.com — and
// that blind spot is what makes concurrent callers each open "the missing tab".
async function flowTabLikelyExists() {
  if ((await queryFlowTabs()).length) return true;
  if ((await chrome.tabs.query({ url: 'https://labs.google/*' })).length) return true;
  const loading = await chrome.tabs.query({ status: 'loading' });
  return loading.some((t) => (t.url || '').startsWith('https://accounts.google.com/'));
}

// The single gate. Returns true if a Flow tab exists or was opened, false if
// creation was suppressed. Never opens more than one tab per cooldown window.
async function openFlowTab(reason, url = FLOW_HOME) {
  if (_flowTabCreateInFlight) {
    recordTabEvent('joined-inflight', reason);
    return _flowTabCreateInFlight;
  }
  _flowTabCreateInFlight = (async () => {
    if (await flowTabLikelyExists()) {
      recordTabEvent('skipped-exists', reason);
      return true;
    }
    const since = Date.now() - _lastFlowTabCreatedAt;
    if (since < FLOW_TAB_CREATE_COOLDOWN_MS) {
      recordTabEvent('suppressed-cooldown', reason, { msSinceLast: since });
      return false;
    }
    _lastFlowTabCreatedAt = Date.now();
    const tabCount = (await chrome.tabs.query({})).length;
    recordTabEvent('created', reason, { url, totalTabsBefore: tabCount });
    await chrome.tabs.create({ url, active: false });
    return true;
  })();
  try {
    return await _flowTabCreateInFlight;
  } finally {
    _flowTabCreateInFlight = null;
  }
}

function isContentsAccessError(err) {
  const m = (err?.message || '').toLowerCase();
  return (
    m.includes('cannot access contents of the page') ||
    m.includes('permission to access the respective host') ||
    m.includes('cannot access contents') ||
    m.includes('access to the respective host') ||
    m.includes('cannot access a')
  );
}

// Errors that mean "no usable Flow tab right now" — recoverable by reopening.
function isRecoverableTransportError(err) {
  const m = (err?.message || '');
  return (
    m.startsWith('TAB_HOST_BLOCKED') ||
    isContentsAccessError(err) ||
    m.includes('Receiving end does not exist') ||
    m.includes('Could not establish connection') ||
    m === 'NO_FLOW_TAB'
  );
}

// Map an internal failure reason to the code surfaced back to the agent.
function classifyTerminalCaptchaError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('timeout')) return 'CAPTCHA_TIMEOUT';
  if (m.includes('no_flow_tab')) return 'NO_FLOW_TAB';
  if (m.includes('host_blocked') || m.includes('cannot access')) return 'SESSION_EXPIRED';
  return msg || 'CAPTCHA_FAILED';
}

// Wait for a Flow tab that is fully loaded on a labs.google URL. Returns the tab
// or null if none settles in time (e.g. session expired → redirected away).
async function waitForFlowTabReady(timeoutMs = FLOW_TAB_READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tabs = await chrome.tabs.query({ url: FLOW_TAB_URLS });
    const ready = tabs.find((t) => t.status === 'complete' && (t.url || '').startsWith('https://labs.google/'));
    if (ready) return ready;
    await sleep(500);
  }
  return null;
}

// Ensure a usable Flow tab exists on a permitted host. Returns true when a
// ready Flow tab exists, false when none settled (session expired / consent /
// block page → needs manual user action, or creation was gated).
async function ensureFlowTab() {
  await openFlowTab('captcha-recovery');
  return !!(await waitForFlowTabReady());
}

async function requestCaptchaFromTab(tabId, requestId, pageAction) {
  try {
    return await chrome.tabs.sendMessage(tabId, {
      type: 'GET_CAPTCHA',
      requestId,
      pageAction,
    });
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) {
      // sendMessage itself hit a host-access failure (tab navigated off labs.google).
      if (isContentsAccessError(error)) throw new Error('TAB_HOST_BLOCKED: ' + msg);
      throw error;
    }

    // Content script not loaded yet — inject and retry.
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      await sleep(200);
      return await chrome.tabs.sendMessage(tabId, {
        type: 'GET_CAPTCHA',
        requestId,
        pageAction,
      });
    } catch (injectErr) {
      // Injection refused: tab is on a host the manifest doesn't permit. Tag it
      // so the outer loop knows this is recoverable by opening a fresh Flow tab.
      const im = injectErr?.message || 'INJECTION_FAILED';
      const tagged = isContentsAccessError(injectErr) ? 'TAB_HOST_BLOCKED: ' + im : im;
      throw new Error(tagged);
    }
  }
}

async function solveCaptcha(requestId, captchaAction) {
  let lastError = null;

  for (let attempt = 0; attempt <= RECOVERY_MAX_ATTEMPTS; attempt++) {
    const tabs = await chrome.tabs.query({ url: FLOW_TAB_URLS });

    if (tabs.length) {
      try {
        const resp = await Promise.race([
          requestCaptchaFromTab(tabs[0].id, requestId, captchaAction),
          new Promise((_, rej) => setTimeout(() => rej(new Error('CAPTCHA_TIMEOUT')), CAPTCHA_HARD_TIMEOUT_MS)),
        ]);
        // Success or a solver-level error (e.g. grecaptcha threw) — either way
        // it's a real answer, not a transport failure we can heal.
        return resp;
      } catch (e) {
        lastError = e?.message || 'CAPTCHA_FAILED';
        const recoverable = isRecoverableTransportError(e);
        // A real CAPTCHA_TIMEOUT already burned the time budget — don't recover.
        if (!recoverable || attempt === RECOVERY_MAX_ATTEMPTS) {
          return { error: classifyTerminalCaptchaError(lastError) };
        }
        // Fall through to recovery: open/repair a Flow tab and retry once.
      }
    } else {
      lastError = 'NO_FLOW_TAB';
    }

    // Last iteration — the result is already decided, so opening a repair tab
    // here would create a tab nobody retries against.
    if (attempt === RECOVERY_MAX_ATTEMPTS) break;

    // Recovery: ensure a usable Flow tab exists on a permitted host.
    const recovered = await ensureFlowTab();
    if (!recovered) {
      // Flow tab opened but didn't stay on labs.google → bounced to a
      // login/consent/block page. Needs the user, not another retry.
      return { error: 'SESSION_EXPIRED' };
    }
  }

  return { error: classifyTerminalCaptchaError(lastError) };
}

// ─── reCAPTCHA rejection recovery ───────────────────────────
//
// A solved captcha is not an accepted captcha. grecaptcha.enterprise.execute()
// returns a token for any session; Google then *scores* it server-side and
// answers 403 "reCAPTCHA evaluation failed" when the score is under its
// threshold. That is a different failure from the solver breaking, and it used
// to be passed straight back to the agent, which classified it as permanent
// and failed the job on the first attempt of five.
//
// Reloading the Flow tab is what resets the scored session — it is exactly
// what the side panel's "Refresh Token" button does, and pressing that by hand
// was the known workaround. This does it automatically, once, then solves a
// fresh captcha and re-sends.
//
// Re-sending is safe: a 403 is returned before any generation happens, so the
// rejected attempt cost no credits and no image exists to duplicate.

const RECAPTCHA_REJECT_MAX_RETRIES = 1;
const RECAPTCHA_SETTLE_MS = 2500;

function isRecaptchaRejection(status, data) {
  if (status !== 403) return false;

  // The message lives at different depths depending on which API answered.
  let text;
  try {
    text = typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    return false;
  }
  return /recaptcha/i.test(text || '');
}

// Reload the Flow tab and wait for grecaptcha to come back up. Returns false
// when no usable tab settles, which means the session needs a person and
// retrying would only burn time.
async function resetCaptchaSession(reason) {
  console.warn(`[FlowAgent] reCAPTCHA rejected (${reason}) — reloading Flow tab for a fresh session`);
  recordTabEvent('captcha-session-reset', reason);

  // 'on-demand' bypasses both the age check and the busy-deferral: we are
  // already inside a failed request, so there is nothing left to protect.
  await refreshFlowToken('on-demand');

  const tab = await waitForFlowTabReady();
  if (!tab) {
    console.error('[FlowAgent] No Flow tab settled after reload — session needs attention');
    return false;
  }

  // The tab reports complete before grecaptcha has finished initialising, and
  // a token solicited in that window is the low-scoring kind we are recovering
  // from. injected.js polls for grecaptcha too; this is belt and braces.
  await sleep(RECAPTCHA_SETTLE_MS);
  return true;
}

async function handleSolveCaptcha(msg) {
  const { id, params } = msg;
  const result = await solveCaptcha(id, params?.captchaAction || 'VIDEO_GENERATION');

  // Standalone captcha solve counts as captcha-consuming
  metrics.requestCount++;
  if (result?.token) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
    metrics.lastError = result?.error || 'NO_TOKEN';
  }
  chrome.storage.local.set({ metrics });

  sendToAgent({ id, result });
}

// ─── API Request Proxy ──────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  if (!url || !url.startsWith('https://labs.google/')) {
    sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');
  // TRPC calls don't consume captcha — don't count in metrics

  const logId = id;
  const logType = url.includes('createProject') ? 'CREATE_PROJECT' : 'TRPC';
  // TRPC calls are silent — don't show in request log

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  if (flowKey) {
    fetchHeaders['authorization'] = `Bearer ${flowKey}`;
  }

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await resp.json();
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'success' });
    sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[FlowAgent] tRPC request failed:', e);
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'failed', error: e.message || 'TRPC_FETCH_FAILED' });
    sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params;

  if (!url) {
    sendToAgent({ id, error: 'MISSING_URL' });
    return;
  }

  if (!url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    sendToAgent({ id, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  const logId = id;
  const logType = _classifyApiUrl(url);
  if (_VISIBLE_TYPES.has(logType)) {
    const payloadSummary = body ? JSON.stringify(body).slice(0, 200) : null;
    addRequestLog({ id: logId, type: logType, time: new Date().toISOString(), status: 'processing', error: null, outputUrl: null, url, payloadSummary });
  }

  try {
    // Step 1: Solve captcha if needed
    let captchaToken = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      if (!captchaToken) {
        // Cannot proceed without captcha — API will 403
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[FlowAgent] Captcha failed for ${captchaAction}: ${err}`);
        sendToAgent({ id, status: 403, error: `CAPTCHA_FAILED: ${err}` });
        if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `CAPTCHA_FAILED: ${err}`; }
        chrome.storage.local.set({ metrics });
        updateRequestLog(logId, { status: 'failed', error: `CAPTCHA_FAILED: ${err}` });
        setState('idle');
        return;
      }
    }

    // Step 2: Inject captcha token into body
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody)); // deep clone
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (finalBody.requests && Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    // Step 3: Use flowKey for auth
    // Hydrate first — after a service-worker revival the token is in storage
    // but not yet in memory, and failing here would report NO_FLOW_KEY for a
    // token we actually hold.
    await ensureHydrated();

    let activeFlowKey = flowKey;
    if (!activeFlowKey) {
      // Re-read storage directly rather than via ensureHydrated(), whose
      // cached promise would keep returning the same empty result.
      console.warn('[FlowAgent] No token in memory — re-reading storage');
      await reloadFromStorage();
      activeFlowKey = flowKey;
    }
    if (!activeFlowKey) {
      // Genuinely absent, not merely forgotten: reload the Flow tab to capture
      // a fresh one instead of failing the request outright.
      console.warn('[FlowAgent] Still no token — reloading Flow tab');
      if (await refreshFlowToken('on-demand')) {
        activeFlowKey = flowKey;
      }
    }

    if (!activeFlowKey) {
      sendToAgent({ id, status: 503, error: 'NO_FLOW_KEY' });
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = 'NO_FLOW_KEY'; }
      chrome.storage.local.set({ metrics });
      updateRequestLog(logId, { status: 'failed', error: 'NO_FLOW_KEY' });
      setState('idle');
      return;
    }

    const send = async (bodyToSend) => {
      const fetchHeaders = { ...(headers || {}) };
      fetchHeaders['authorization'] = `Bearer ${flowKey || activeFlowKey}`;

      const res = await fetch(url, {
        method: method || 'POST',
        headers: fetchHeaders,
        credentials: 'include',
        body: method === 'GET' ? undefined : JSON.stringify(bodyToSend),
      });

      const text = await res.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      return { res, text, parsed };
    };

    // Step 4: Make the API call from browser context
    let { res: response, text: responseText, parsed: responseData } = await send(finalBody);

    // Step 5: A rejected score is recoverable — reset the session and re-send.
    // Only worth doing for a request that carried a captcha in the first place.
    for (
      let attempt = 0;
      captchaAction &&
      attempt < RECAPTCHA_REJECT_MAX_RETRIES &&
      isRecaptchaRejection(response.status, responseData);
      attempt++
    ) {
      updateRequestLog(logId, {
        status: 'processing',
        error: 'reCAPTCHA rejected — resetting session',
      });

      if (!(await resetCaptchaSession(captchaAction))) break;

      const retryCaptcha = await solveCaptcha(id, captchaAction);
      if (!retryCaptcha?.token) {
        console.error('[FlowAgent] No captcha after session reset:', retryCaptcha?.error);
        break;
      }

      // Rebuild the body around the new token rather than mutating the old
      // one, so a partially rewritten payload can never be sent.
      let retryBody = JSON.parse(JSON.stringify(body));
      if (retryBody.clientContext?.recaptchaContext) {
        retryBody.clientContext.recaptchaContext.token = retryCaptcha.token;
      }
      if (Array.isArray(retryBody.requests)) {
        for (const req of retryBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = retryCaptcha.token;
          }
        }
      }

      console.log('[FlowAgent] Re-sending with a fresh captcha after session reset');
      ({ res: response, text: responseText, parsed: responseData } = await send(retryBody));

      if (response.ok) {
        metrics.recaptchaRecovered = (metrics.recaptchaRecovered || 0) + 1;
        console.log('[FlowAgent] Recovered from reCAPTCHA rejection');
      }
    }

    sendToAgent({
      id,
      status: response.status,
      data: responseData,
    });

    const responseSummary = responseText ? responseText.slice(0, 300) : null;
    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(logId, { status: 'success', httpStatus: response.status, responseSummary });
    } else {
      // Name it, so the run log says why rather than "API_403". The agent
      // keys its retry decision on this text.
      const label = isRecaptchaRejection(response.status, responseData)
        ? 'RECAPTCHA_REJECTED: score too low after a session reset'
        : `API_${response.status}`;
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = label; }
      updateRequestLog(logId, { status: 'failed', error: label, httpStatus: response.status, responseSummary });
    }
  } catch (e) {
    sendToAgent({
      id,
      status: 500,
      error: e.message || 'API_REQUEST_FAILED',
    });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message; }
    updateRequestLog(logId, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── State & Popup ──────────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f59e0b', off: '#6b7280' };
  chrome.action.setBadgeText({ text: badges[state] || '' });
  chrome.action.setBadgeBackgroundColor({ color: colors[state] || '#000' });
  broadcastStatus();
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    reply({
      connected: ws?.readyState === WebSocket.OPEN,
      agentConnected: ws?.readyState === WebSocket.OPEN,
      flowKeyPresent: !!flowKey,
      manualDisconnect,
      tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
      metrics: {
        requestCount: metrics.requestCount,
        successCount: metrics.successCount,
        failedCount: metrics.failedCount,
        lastError: metrics.lastError,
      },
      state,
    });
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    if (ws) ws.close();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    connectToAgent();
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    reply({ log: requestLog });
    return true;
  }

  if (msg.type === 'TAB_AUDIT') {
    reply({ audit: tabAudit, lastCreatedAt: _lastFlowTabCreatedAt });
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({
      url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
    }).then((tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        reply({ ok: true, tabId: tabs[0].id });
      } else {
        // User-initiated from the popup — deliberately not gated by the
        // cooldown, but recorded so the audit trail stays complete.
        recordTabEvent('created', 'user-popup', { url: FLOW_HOME });
        chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow' })
          .then((tab) => reply({ ok: true, tabId: tab.id }))
          .catch((e) => reply({ error: e.message }));
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    captureTokenFromFlowTab()
      .then(() => reply({ ok: true }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TEST_CAPTCHA') {
    solveCaptcha(`test-${Date.now()}`, msg.pageAction || 'IMAGE_GENERATION')
      .then((r) => reply(r))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TRPC_MEDIA_URLS') {
    handleTrpcMediaUrls(msg.trpcUrl, msg.body);
    reply({ ok: true });
    return true;
  }

  return true;
});

// ─── TRPC Media URL Extractor ──────────────────────────────

function handleTrpcMediaUrls(trpcUrl, bodyText) {
  try {
    // Extract all fresh GCS signed URLs
    const urlRegex = /https:\/\/storage\.googleapis\.com\/ai-sandbox-videofx\/(?:image|video)\/[0-9a-f-]{36}\?[^"'\s]+/g;
    const matches = bodyText.match(urlRegex) || [];
    if (!matches.length) return;

    // Deduplicate and parse
    const urlMap = {};
    for (const rawUrl of matches) {
      // Unescape JSON-escaped URLs
      const url = rawUrl.replace(/\\u0026/g, '&').replace(/\\/g, '');
      const mediaMatch = url.match(/\/(image|video)\/([0-9a-f-]{36})\?/);
      if (mediaMatch) {
        const [, mediaType, mediaId] = mediaMatch;
        // Keep last occurrence (freshest)
        urlMap[mediaId] = { mediaType, url, mediaId };
      }
    }

    const entries = Object.values(urlMap);
    if (!entries.length) return;

    console.log(`[FlowAgent] Captured ${entries.length} fresh media URLs from TRPC`);
    // URL refresh is silent — don't show in request log

    // Forward to agent for DB update
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'media_urls_refresh',
        urls: entries,
      }));
    }
  } catch (e) {
    console.error('[FlowAgent] Failed to extract TRPC media URLs:', e);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Human-like Telemetry ──────────────────────────────────
// Periodically send tracking events to Google's analytics endpoints
// to mimic normal browser behavior.

const _UA = navigator.userAgent;
let _telemetrySessionId = `;${Date.now()}`;

function _rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function _buildBatchLogPayload() {
  const events = [];
  const types = ['FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY'];
  const count = _rand(1, 3);
  for (let i = 0; i < count; i++) {
    events.push({
      event: types[_rand(0, types.length - 1)],
      eventProperties: [
        { key: 'CURRENT_TIME_MS', doubleValue: Date.now() },
        { key: 'DURATION_MS', doubleValue: _rand(150, 800) },
        { key: 'USER_AGENT', stringValue: _UA },
        { key: 'IS_DESKTOP', booleanValue: true },
      ],
      eventMetadata: { sessionId: _telemetrySessionId },
      eventTime: new Date().toISOString(),
    });
  }
  return { appEvents: events };
}

function _buildFrontendEventsPayload() {
  const eventTypes = [
    'FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY', 'GRID_SCROLL_DEPTH',
    'FLOW_PROJECT_OPEN', 'FLOW_SCENE_VIEW',
  ];
  const count = _rand(1, 4);
  const events = [];
  for (let i = 0; i < count; i++) {
    const et = eventTypes[_rand(0, eventTypes.length - 1)];
    const params = {
      USER_AGENT: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: _UA },
      IS_DESKTOP: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'true' },
    };
    if (et.includes('LATENCY')) {
      params.CURRENT_TIME_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(Date.now()) };
      params.DURATION_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(_rand(100, 600)) };
    }
    if (et === 'GRID_SCROLL_DEPTH') {
      params.MEDIA_GENERATION_PAYGATE_TIER = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'PAYGATE_TIER_TWO' };
    }
    events.push({
      eventType: et,
      metadata: {
        sessionId: _telemetrySessionId,
        createTime: new Date().toISOString(),
        additionalParams: params,
      },
    });
  }
  return { events };
}

async function sendTelemetry() {
  if (!flowKey || state === 'off') return;

  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    'authorization': `Bearer ${flowKey}`,
  };

  // Telemetry is silent — don't show in request log
  try {
    if (Math.random() < 0.5) {
      await fetch(`https://aisandbox-pa.googleapis.com/v1:batchLog`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildBatchLogPayload()),
      });
    } else {
      await fetch(`https://aisandbox-pa.googleapis.com/v1/flow:batchLogFrontendEvents`, {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildFrontendEventsPayload()),
      });
    }
  } catch {}
}

// Send telemetry at random intervals (45-120s) to look organic
function scheduleTelemetry() {
  const delay = _rand(45, 120) * 1000;
  setTimeout(async () => {
    await sendTelemetry();
    scheduleTelemetry(); // reschedule with new random interval
  }, delay);
}

// Refresh session ID every ~30min like a real user
setInterval(() => { _telemetrySessionId = `;${Date.now()}`; }, _rand(25, 35) * 60 * 1000);

scheduleTelemetry();

console.log('[FlowAgent] Extension loaded');
