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


window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
  const { requestId, pageAction } = detail;
  try {
    await waitForGrecaptcha();
    const token = await window.grecaptcha.enterprise.execute(SITE_KEY, {
      action: pageAction,
    });
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
 * Get to a working grecaptcha.enterprise, loading it if the page has not.
 *
 * On labs.google the Flow page had already loaded reCAPTCHA by the time we
 * asked, so waiting was enough. On flow.google.com it is not on every page —
 * the project list has no reason to load it — and waiting ten seconds for a
 * script nobody is fetching just fails slowly.
 *
 * The script tag is added by the content script rather than here. This file
 * runs in the page's own world, where flow.google.com enforces Trusted Types:
 * assigning a string to script.src throws "This document requires
 * 'TrustedScriptURL' assignment". A content script runs in an isolated world
 * that the page's Trusted Types policy does not govern, so it can add the tag
 * the page will not let us add — and the script still executes in the page,
 * which is where grecaptcha has to end up.
 */
function grecaptchaReady() {
  return typeof window.grecaptcha?.enterprise?.execute === 'function';
}

function pollFor(predicate, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - start > timeout) return resolve(false);
      setTimeout(check, 200);
    };
    check();
  });
}

async function waitForGrecaptcha(timeout = 10000) {
  // The page's own copy, if it is coming. Short: this is the fast path, and
  // when the page is never going to load one, every second here is a second
  // added to a request that has a deadline.
  if (await pollFor(grecaptchaReady, 2500)) return;

  window.dispatchEvent(new CustomEvent('FLOWKIT_LOAD_RECAPTCHA', {
    detail: { siteKey: SITE_KEY },
  }));

  if (!(await pollFor(grecaptchaReady, timeout))) {
    throw new Error('grecaptcha not available after loading enterprise.js');
  }
}

