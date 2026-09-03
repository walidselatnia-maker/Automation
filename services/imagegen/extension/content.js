/**
 * Content script — bridge between background.js and injected.js
 * Injects injected.js into MAIN world to access window.grecaptcha
 */
(function () {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

/**
 * Add reCAPTCHA Enterprise to the page, on request from injected.js.
 *
 * Done here rather than in the page's own world because flow.google.com
 * enforces Trusted Types: a string assigned to script.src there throws. A
 * content script's world is not governed by the page's policy, so it can add
 * the tag — and the script still runs in the page, which is the point.
 */
let _recaptchaRequested = false;

window.addEventListener('FLOWKIT_LOAD_RECAPTCHA', ({ detail }) => {
  if (_recaptchaRequested) return;
  _recaptchaRequested = true;

  const script = document.createElement('script');
  script.src = 'https://www.google.com/recaptcha/enterprise.js?render=' + detail.siteKey;
  script.async = true;
  script.onerror = () => {
    _recaptchaRequested = false;
    console.error('[FlowKit] reCAPTCHA Enterprise failed to load');
  };
  (document.head || document.documentElement).appendChild(script);
});

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type !== 'GET_CAPTCHA') return;

  const { requestId, pageAction } = msg;

  const handler = (e) => {
    if (e.detail?.requestId === requestId) {
      window.removeEventListener('CAPTCHA_RESULT', handler);
      clearTimeout(timer);
      reply({ token: e.detail.token, error: e.detail.error });
    }
  };

  const timer = setTimeout(() => {
    window.removeEventListener('CAPTCHA_RESULT', handler);
    reply({ error: 'CONTENT_TIMEOUT' });
  }, 25000);

  window.addEventListener('CAPTCHA_RESULT', handler);

  window.dispatchEvent(new CustomEvent('GET_CAPTCHA', {
    detail: { requestId, pageAction },
  }));

  return true; // keep channel open for async reply
});

// ─── TRPC Media URL Monitor ─────────────────────────────────
// Forward intercepted TRPC responses with media URLs to background.js
window.addEventListener('TRPC_MEDIA_URLS', (e) => {
  const { url, body } = e.detail || {};
  if (!body) return;
  chrome.runtime.sendMessage({
    type: 'TRPC_MEDIA_URLS',
    trpcUrl: url,
    body,
  }).catch(() => {});
});
