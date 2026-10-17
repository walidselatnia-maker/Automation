/**
 * Injected into MAIN world on the Flow app — has access to window.grecaptcha
 * Also intercepts TRPC fetch responses to capture fresh signed media URLs.
 */
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

// ─── TRPC Response Monitor ─────────────────────────────────
// Monkey-patch fetch to intercept TRPC responses containing media URLs.
// Fresh signed GCS URLs are extracted and forwarded to the agent.

const _originalFetch = window.fetch;
window.fetch = async function (...args) {
  const response = await _originalFetch.apply(this, args);
  try {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
    // Only intercept TRPC calls that return project/flow data. Matched on the
    // path, so it survived Flow moving host.
    if (url.includes('/fx/api/trpc/') && response.ok) {
      const clone = response.clone();
      clone.text().then(text => {
        if (text.includes('storage.googleapis.com/ai-sandbox-videofx/')) {
          window.dispatchEvent(new CustomEvent('TRPC_MEDIA_URLS', {
            detail: { url, body: text },
          }));
        }
      }).catch(() => {});
    }
  } catch {}
  return response;
};


// ─── The mint Flow's 2026-09-22 build accepts ───────────────
//
// Flow's front end wraps grecaptcha.enterprise.execute (its x2a trap) so every
// token it mints carries action "extension_hijack_detected", which the backend
// refuses with PUBLIC_ERROR_UNUSUAL_ACTIVITY. hijack_bypass.js runs before the
// page and keeps the pristine execute; minting through that is the primary
// path. The Object.assign neuter and our own widget stay as fallbacks.
// Ported from upstream crisng95/flowkit (hijack_bypass.js, injected.js, v0.5.x).

/** The site key the page is configured with, else the constant. */
function resolveSitekey() {
  try {
    const clients = (window.___grecaptcha_cfg || {}).clients || {};
    for (const id of Object.keys(clients)) {
      const client = clients[id];
      if (client && client.sitekey) return client.sitekey;
    }
  } catch (e) { /* the constant, then */ }
  return SITE_KEY;
}

function waitReady(timeout = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    try { window.grecaptcha?.enterprise?.ready?.(finish); } catch (e) { /* timeout covers it */ }
    setTimeout(finish, timeout);
  });
}

// One widget for the life of the page: rendering a second one on the same
// host throws, and there is nothing a fresh one would do better.
let widgetPromise = null;

function ensureWidget(sitekey) {
  if (widgetPromise) return widgetPromise;
  widgetPromise = (async () => {
    await waitReady(5000);
    let host = document.getElementById('flowkit-recaptcha-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'flowkit-recaptcha-host';
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;';
      document.documentElement.appendChild(host);
    }
    return new Promise((resolve, reject) => {
      try {
        resolve(window.grecaptcha.enterprise.render(host, {
          sitekey,
          size: 'invisible',
          callback: () => {},
          'error-callback': (m) => reject(new Error('render_error: ' + m)),
        }));
      } catch (e) {
        reject(new Error('render_threw: ' + (e?.message || e)));
      }
    });
  })().catch((e) => { widgetPromise = null; throw e; });
  return widgetPromise;
}

// Primary path: the pristine execute hijack_bypass.js captured before Flow's
// trap could overwrite it, called with our own action.
async function executeWithPristine(sitekey, action) {
  const pristine = window.__fk_hijack?.pristine;
  if (typeof pristine !== 'function') return null;
  const token = await Promise.race([
    pristine(sitekey, { action }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('execute_hang')), 8000)),
  ]);
  return token ? String(token) : null;
}

// Fallback when the capture lost the race: the trap builds its poison action
// with Object.assign, so swap Object.assign out for the one execute call and
// put our action back over the poison one.
const _realObjectAssign = Object.assign;

async function executeWithAssignNeuter(sitekey, action) {
  Object.assign = function (target, ...sources) {
    const result = _realObjectAssign.call(this, target, ...sources);
    if (result && typeof result === 'object' &&
        result.action === 'extension_hijack_detected') {
      result.action = action;
    }
    return result;
  };
  try {
    await waitReady(2500);
    const token = await Promise.race([
      window.grecaptcha.enterprise.execute(sitekey, { action }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('execute_hang')), 8000)),
    ]);
    return token ? String(token) : null;
  } finally {
    Object.assign = _realObjectAssign;
  }
}

async function executeWithRetry(sitekey, action, attempts = 2) {
  let lastError = null;
  const hijack = window.__fk_hijack;
  const hasPristine = typeof hijack?.pristine === 'function';
  const knownTrapped = !!hijack?.trapped;
  for (let i = 0; i < attempts; i++) {
    try {
      if (hasPristine) {
        const token = await executeWithPristine(sitekey, action);
        if (token) return token;
        lastError = new Error('pristine_empty_token');
      } else if (knownTrapped) {
        const token = await executeWithAssignNeuter(sitekey, action);
        if (token) return token;
        lastError = new Error('assign_neuter_empty_token');
      } else {
        // Last resort: our own widget. Flow's trap is expected to refuse it too.
        await waitReady(2500);
        const widgetId = await ensureWidget(sitekey);
        const token = await Promise.race([
          window.grecaptcha.enterprise.execute(widgetId, { action }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('execute_hang')), 8000)),
        ]);
        if (token) return String(token);
        lastError = new Error('empty_token');
      }
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw lastError || new Error('execute_failed');
}

// One mint at a time: two executes racing on one widget get each other's token.
let mintTail = Promise.resolve();

async function mintCaptcha(action) {
  const previous = mintTail.catch(() => {});
  let release;
  mintTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    await waitForGrecaptcha();
    return await executeWithRetry(resolveSitekey(), action);
  } finally {
    release();
  }
}

window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
  const { requestId, pageAction } = detail;
  try {
    const token = await mintCaptcha(pageAction);
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, token },
    }));
  } catch (e) {
    window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
      detail: { requestId, error: e.message },
    }));
  }
});

/**
 * Wait for the page's reCAPTCHA.
 *
 * Not loaded here, and not loadable here: the page's CSP allows the
 * extension's own resources but not www.google.com/recaptcha, so a tag we add
 * lands in the DOM and is never executed. What makes grecaptcha available is
 * being on a project page rather than the project list — background.js parks
 * the tab there before asking. See ensureFlowTabOnProject.
 */
function waitForGrecaptcha(timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      // The pristine execute counts as ready even when Flow has wrapped the public one.
      if (window.__fk_hijack?.pristine) return resolve();
      if (typeof window.grecaptcha?.enterprise?.execute === 'function') return resolve();
      if (Date.now() - start > timeout) {
        return reject(
          new Error('grecaptcha not available — is the tab on a Flow project page?'),
        );
      }
      setTimeout(check, 200);
    };
    check();
  });
}


