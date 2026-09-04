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
 * The address of a project that actually exists, read off the project list.
 *
 * reCAPTCHA is loaded on a project page and not on the list, so a solve has to
 * happen from one. Which project does not matter — generation names its own in
 * the request body — and that is the whole reason this reads a link instead of
 * building a URL from a configured id: an id the signed-in account cannot open
 * lands on Flow's 404, a page that serves no requests, and the tab is then
 * stuck somewhere it can never recover from. A link on the page is a project
 * this account can definitely open.
 */
chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type !== 'FIND_PROJECT_URL') return;

  const link = document.querySelector('a[href*="/project/"]');
  reply({ url: link ? link.href : null });
  return true;
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
