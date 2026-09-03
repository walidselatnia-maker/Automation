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
 * On labs.google the Flow page had already loaded reCAPTCHA Enterprise by the
 * time we asked, so waiting was enough. On flow.google.com it is not there on
 * every page — the project list has no reason to load it — and waiting ten
 * seconds for a script nobody is fetching just fails slowly.
 *
 * So: wait briefly for the page's own copy, and if it does not appear, add the
 * script ourselves. It is the same library from the same origin with the same
 * site key, and a second copy is a no-op if the page loads one later.
 */
const ENTERPRISE_SRC = 'https://www.google.com/recaptcha/enterprise.js?render=' + SITE_KEY;

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

let _loadingEnterprise = null;

function loadEnterprise() {
  if (_loadingEnterprise) return _loadingEnterprise;

  _loadingEnterprise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src^="https://www.google.com/recaptcha/"]');
    if (existing && grecaptchaReady()) return resolve();

    const script = document.createElement('script');
    script.src = ENTERPRISE_SRC;
    script.async = true;
    script.onerror = () => reject(new Error('recaptcha enterprise failed to load'));
    script.onload = () => {
      // The script defines grecaptcha.enterprise.ready, which fires once the
      // library is actually usable — onload alone is too early to execute.
      if (window.grecaptcha?.enterprise?.ready) {
        window.grecaptcha.enterprise.ready(() => resolve());
      } else {
        resolve();
      }
    };
    (document.head || document.documentElement).appendChild(script);
  });

  return _loadingEnterprise;
}

async function waitForGrecaptcha(timeout = 10000) {
  // The page's own copy, if it is coming. Short: this is the fast path, and
  // when it is not there at all, every second here is a second wasted.
  if (await pollFor(grecaptchaReady, 2500)) return;

  await loadEnterprise();

  if (!(await pollFor(grecaptchaReady, timeout))) {
    throw new Error('grecaptcha not available after loading enterprise.js');
  }
}
