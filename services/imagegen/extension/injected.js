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


/**
 * The widget Flow rendered on this page, if it rendered one.
 *
 * Flow does not mint with a site key and an action. It renders an invisible
 * reCAPTCHA Enterprise widget -- one client in ___grecaptcha_cfg, with the
 * hidden g-recaptcha-response-<id> field beside it -- and executes that.
 * Minting through the same widget inherits whatever Flow configured on it,
 * including the action, so this does not have to know what the action is,
 * and does not break the next time Google renames it.
 *
 * Which is what happened. This used to pass action: 'IMAGE_GENERATION' with
 * the site key, and Google stopped recognising that name: measured against
 * the live endpoint, a token minted that way is refused exactly as a token
 * minted with a deliberately invented action is -- both
 * PUBLIC_ERROR_UNUSUAL_ACTIVITY, while the page's own button, in the same
 * session seconds later, generated fine. The verdict was on the token, not
 * the account: the same failure reproduces from a signed-in browser on a
 * home connection, so no amount of pausing or IP changing could have moved it.
 */
function pageWidgetId() {
  const clients = (window.___grecaptcha_cfg || {}).clients || {};
  const ids = Object.keys(clients);
  return ids.length ? ids[0] : null;
}

/**
 * A token, minted the way this page mints them.
 *
 * An invisible widget holds one response at a time, so it is reset before
 * being executed again -- without that the second generate of a run gets the
 * first one's answer back, and a replayed token is refused. The site-key call
 * stays as the fallback for a page with no widget on it, which is what every
 * older Flow build was.
 */
async function mintCaptcha(pageAction) {
  const enterprise = window.grecaptcha.enterprise;
  const widgetId = pageWidgetId();

  if (widgetId !== null) {
    try {
      try {
        enterprise.reset(widgetId);
      } catch (resetError) {
        // A widget that has never run has nothing to reset. Not a failure.
      }
      const token = await enterprise.execute(widgetId);
      if (token) return token;
      console.warn('[FlowAgent] the page widget gave an empty token — using the site key');
    } catch (e) {
      console.warn('[FlowAgent] the page widget would not execute — using the site key:', e.message);
    }
  }

  return enterprise.execute(SITE_KEY, { action: pageAction });
}

window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
  const { requestId, pageAction } = detail;
  try {
    await waitForGrecaptcha();
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


