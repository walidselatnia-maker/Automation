import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { escapeHtml } from './views/layout.js';

/**
 * Password gate for the UI.
 *
 * The platform is deployed behind a Docker host's proxy, which means a public
 * URL. The UI holds every credential the system uses and can publish to live
 * sites, so it cannot be left open. This is deliberately the smallest thing
 * that is actually safe: one shared password, an HMAC-signed session cookie,
 * no user table, no dependencies.
 */

const COOKIE = 'ap_session';
const SESSION_DAYS = 30;

/** Constant-time compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still compare something so timing does not leak the length.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function issueToken(secret: Buffer): string {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const nonce = randomBytes(8).toString('base64url');
  const payload = `${expires}.${nonce}`;
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token: string, secret: Buffer): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [expires, nonce, signature] = parts as [string, string, string];
  if (!safeEqual(signature, sign(`${expires}.${nonce}`, secret))) return false;

  const expiryMs = Number(expires);
  return Number.isFinite(expiryMs) && expiryMs > Date.now();
}

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function loginPage(error?: string, generated?: boolean): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Article Platform</title>
<link rel="stylesheet" href="/static/style.css">
</head><body>
<main style="max-width:400px;margin:12vh auto">
  <h1>Article Platform</h1>
  <p class="subtitle">Enter the admin password to continue.</p>
  ${error ? `<div class="flash error">${escapeHtml(error)}</div>` : ''}
  ${
    generated
      ? `<div class="flash warn">A password was generated on first start. Find it in the
         container logs (look for "ADMIN PASSWORD"), or set <span class="mono">AUTH_PASSWORD</span>
         in your deployment's environment variables.</div>`
      : ''
  }
  <div class="card">
    <form method="post" action="/login">
      <div class="field">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autofocus required
               autocomplete="current-password">
      </div>
      <button class="primary" type="submit" style="width:100%">Sign in</button>
    </form>
  </div>
</main>
</body></html>`;
}

export interface AuthOptions {
  password: string;
  /** HMAC secret for session cookies; the encryption key is reused. */
  secret: Buffer;
  /** True when the password was auto-generated, so the hint can be shown. */
  generated: boolean;
}

/** Paths reachable without a session. */
const PUBLIC_PATHS = new Set(['/login', '/healthz']);

export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';

    if (PUBLIC_PATHS.has(path) || path.startsWith('/static/')) return;

    const token = readCookie(request, COOKIE);
    if (token && verifyToken(token, options.secret)) return;

    if (request.method !== 'GET') {
      // Never silently redirect a mutation; the user would lose the submission.
      return reply.status(401).type('text/html').send(loginPage('Session expired. Sign in again.'));
    }

    return reply.status(401).type('text/html').send(loginPage(undefined, options.generated));
  });

  app.get('/login', async (_request, reply) =>
    reply.type('text/html').send(loginPage(undefined, options.generated)),
  );

  app.post('/login', async (request, reply) => {
    const body = request.body as { password?: string } | undefined;
    const submitted = typeof body?.password === 'string' ? body.password : '';

    if (!safeEqual(submitted, options.password)) {
      // Slow down guessing without holding a worker for long.
      await new Promise((r) => setTimeout(r, 400));
      return reply.status(401).type('text/html').send(loginPage('Incorrect password.'));
    }

    const secure = (request.headers['x-forwarded-proto'] ?? request.protocol) === 'https';

    return reply
      .header(
        'set-cookie',
        `${COOKIE}=${issueToken(options.secret)}; Path=/; HttpOnly; SameSite=Lax; ` +
          `Max-Age=${SESSION_DAYS * 86_400}${secure ? '; Secure' : ''}`,
      )
      .redirect('/', 303);
  });

  app.post('/logout', async (_request, reply) =>
    reply
      .header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
      .redirect('/login', 303),
  );
}
