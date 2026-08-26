# Folding FlowKit into the platform as an image service

**Date:** 2026-08-26
**Status:** Approved for planning

## Why

Image generation currently lives in a second system (FlowKit) that is deployed,
updated, and signed into separately. That means two repos, two deploys, two
domains, two passwords, and a Google login ritual on a URL that has nothing to
do with the platform.

FlowKit is also a *video production* system — scenes, chaining, upscaling,
music, narration, YouTube upload. The article platform uses exactly one thing
from it: generate an image from a prompt.

This spec folds a stripped FlowKit into the platform repo as an internal image
service, and moves the browser session into the platform's own dashboard.

## What we are not doing

Chrome is not going away. `extension/injected.js` mints a reCAPTCHA
**Enterprise** token via `window.grecaptcha.enterprise.execute()` on
labs.google, and `background.js` attaches it to every Flow request. That token
can only be produced by a real, scored browser session on Google's origin.
There is no server-side substitute, no API key, no library.

Nor are we switching browsers. Chromium, Edge and Brave are the same Blink
engine with the same memory model. Firefox would need the extension ported to a
different MV3 dialect and reliably scores lower on reCAPTCHA Enterprise —
trading memory for the one thing the system cannot survive losing.

Headless is also out. The current supervisord config avoids `--headless` and
`--enable-automation` deliberately: both are trivially fingerprinted. Headless
would likely keep working right up until Google silently scores the session at
zero, which fails with no error message.

## Architecture

Two containers, one compose file, one repo, one deploy.

```
platform  (Node 24, existing)         imagegen  (Python + Chrome, stripped FlowKit)
  │                                     │
  ├── public domain via Dokploy         ├── no domain, no published port
  │                                     │
  ├── /v1/generate  ─────────────────►  :8100  FastAPI
  ├── /v1/jobs/{id} ─────────────────►  :8100
  └── /browser (proxy, authed) ──────►  :6080  noVNC ──► :5900 x11vnc ──► Xvfb ──► Chrome
```

### Networks

Two networks, and this is what makes the rest safe:

- `web` — Dokploy's proxy network. **platform only.**
- `internal` — `internal: true`. **platform and imagegen.**

`imagegen` is on `internal` alone, so it has no route to or from the outside
world. Every path to it runs through the platform, which already checks a
session cookie on every request. That is what lets us delete the VNC password
(below) without opening anything up.

### Repository layout

FlowKit is vendored, not submoduled. We are deleting roughly 80% of it, so
tracking upstream is meaningless — and a submodule is one more thing to
explain. The MIT `LICENSE` and attribution come along.

```
<repo root>
├── docker-compose.yml         new — defines both services
├── Dockerfile                 existing — the Node platform
├── src/  prompts/  test/      existing
└── services/imagegen/         new — stripped FlowKit
    ├── Dockerfile
    ├── agent/
    ├── extension/
    └── docker/
```

`services/` goes into the platform's `.dockerignore` so the Node build context
does not grow by a Chrome-sized directory.

## The imagegen service

### The API contract already matches

`agent/api/v1.py` was written for n8n and speaks exactly what
`src/integrations/images.ts` already sends:

| | |
|---|---|
| `POST /v1/generate` | `{prompt, orientation}` → `{job_id, status}`, 202 |
| `GET /v1/jobs/{id}` | → `{job_id, status, image_url, image_expires_at, error, prompt}` |
| Auth | `X-API-Key` header |
| Statuses | `PENDING` / `PROCESSING` / `COMPLETED` / `FAILED` |

**`ImageClient` needs no changes at all.** Only its configured base URL moves,
to `http://imagegen:8100`.

### What survives

- `agent/main.py`, `config.py`, `auth.py`, `watchdog.py`
- `agent/api/v1.py` — rewritten against the new `job` table (see below)
- `agent/api/ext_host.py` — serves the CRX that Chrome's enterprise policy
  fetches. Load-bearing: without it the extension never installs.
- `agent/services/flow_client.py`, `headers.py` — the WebSocket bridge
- `agent/worker/processor.py` — trimmed to `GENERATE_IMAGE`
- `agent/db/` — reduced schema
- `extension/` — unchanged
- `docker/` — supervisord, entrypoint, pack-extension
- `agent/api/flow.py` — reduced to `GET /flow/status` and `GET /flow/credits`.
  Its generation routes are internal duplicates of what `/v1` already exposes
  properly, and nothing will call them once the dashboard is gone.
- A `GET /health`, unauthenticated, for the container healthcheck

### What is deleted

- **ffmpeg** and the `anthropic` dependency
- `agent/api/`: `music.py`, `reviews.py`, `scenes.py`, `videos.py`,
  `projects.py`, `materials.py`, `tts.py`, `characters.py`,
  `active_project.py`, `models.py`, `setup.py`, `requests.py`
- `agent/services/`: `suno.py`, `post_process.py`, `scene_chain.py`,
  `video_reviewer.py`, `tts.py`
- `agent/materials.py`, `agent/models/`, `agent/sdk/`
- `dashboard/`, `skills/`, `tools/`, `scripts/` — FlowKit's own UI and
  tooling. The platform's dashboard replaces the first; the rest served a
  standalone project that no longer exists.
- `POST /flow/edit-image` — dropped per decision. One route and one extension
  method; restoring it later is a small change, not a redesign.
- Tables: `project`, `video`, `scene`, `character`, `project_character`,
  and the review tables

### The job table

`/v1` currently fakes a video pipeline underneath itself: `_ensure_container()`
maintains a singleton project and video so that every generation can be a scene
inside them. With the video half gone, that scaffolding has nothing to hold up.

```sql
CREATE TABLE job (
  id             TEXT PRIMARY KEY,
  prompt         TEXT NOT NULL,
  orientation    TEXT NOT NULL DEFAULT 'VERTICAL'
                 CHECK (orientation IN ('VERTICAL','HORIZONTAL')),
  status         TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','PROCESSING','COMPLETED','FAILED')),
  media_id       TEXT,
  output_url     TEXT,
  error_message  TEXT,
  created_at     DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at     DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_job_status ON job(status);
```

`/v1/generate` inserts one row. The worker claims `PENDING` rows, calls the
extension, writes `output_url` or `error_message`. `/v1/jobs/{id}` reads one
row. `_ensure_container()`, `_cached_video_id`, and the hardcoded project UUID
all go.

The existing `_extract_expiry()` stays — Flow returns signed CDN URLs valid for
roughly six hours, and surfacing the deadline is how a caller learns to
download now rather than discovering a 403 tomorrow. The platform already
downloads immediately.

## Memory

`shm_size: "2gb"` is a cap on a tmpfs, not an allocation — worth stating
because it reads like a 2GB reservation and is not one. Real usage is the
browser process, a GPU process, one renderer for the permanently-open
labs.google tab (`background.js` keeps and reuses it), and the extension's
service worker.

Changes, in two groups.

**Safe — no fingerprint surface:**

- `--disable-dev-shm-usage` — Chrome uses `/tmp` instead of `/dev/shm`, which
  lets us **delete `shm_size` entirely**. Slower in theory, irrelevant for one
  tab.
- `--renderer-process-limit=1`
- `--disable-background-networking --disable-sync --disable-component-update`
- `MAX_CONCURRENT_REQUESTS` from 5 to 2. Peak memory scales with in-flight
  generations, and an interval-driven article pipeline never needs five.

**Opt-in — changes what the page can observe:**

- `--disable-gpu` kills a whole process, but it also changes the WebGL renderer
  strings a fingerprinter reads. Apply it *last*, on its own, and confirm
  generation still succeeds before keeping it. If image jobs start failing with
  no useful error, this is the first thing to revert.

Xvfb stays at 24-bit colour. Dropping to 16 saves a few megabytes of
framebuffer and risks rendering differences for no meaningful gain.

Target is roughly 250–350MB steady, which sits comfortably beside a Node
process that idles under 100MB.

## The browser panel

A page in the platform's dashboard showing the live Chrome session.

**Why VNC and not CDP.** `Page.startScreencast` streams page content only — no
tab strip, no address bar, no extension toolbar, and `chrome://extensions` is
WebUI that does not screencast reliably. That is enough for a login box and not
enough for "refresh the tab and manage the extension". VNC captures the whole X
display: real Chrome, real menus, real `chrome://` pages.

**What changes** is that VNC stops being public. Today `websockify` is on port
6080 behind its own Dokploy domain, guarded by an 8-character VNC password.
After this it binds `0.0.0.0:6080` on the `internal` network only, with no
domain and no published port, and the platform proxies it at `/browser` behind
the session cookie it already validates.

That is strictly more locked down than today, so the VNC password comes out:
`-rfbauth` is dropped from the x11vnc command, `VNC_PASSWORD` is removed from
the environment, and `entrypoint.sh` stops writing `/data/.vncpasswd`. One
login, for everything.

**Implementation.** A Fastify route that upgrades to a WebSocket and pipes to
`ws://imagegen:6080/websockify`, plus a static passthrough for noVNC's own
assets. Auth is checked at upgrade time — `PUBLIC_PATHS` in `src/web/auth.ts`
is not touched, so `/browser` is protected by default. The page embeds noVNC's
client pointed at the proxied path.

The panel is lazy: no connection is opened until the page is visited, so an
idle dashboard costs nothing.

## Platform-side changes

Small, and mostly configuration:

- `ImageClient` — unchanged.
- Settings — the image base URL defaults to `http://imagegen:8100`. Still
  editable, so pointing at an external instance stays possible.
- `problemsFor()` in `src/web/server.ts` — add a warning when `/flow/status`
  reports the extension is not connected, linking to `/browser`. That is the
  "you need to sign into Google again" signal, surfaced where the other
  configuration problems already are.
- Navigation — a `Browser` entry.
- `.dockerignore` — add `services/`.

## Testing

**Node.** The proxy is the new surface, so: an unauthenticated request to
`/browser` is rejected; an authenticated one upgrades. `ImageClient` is
untouched and its existing coverage stands.

**Python.** FlowKit has pytest configured. Rewrite the `/v1` tests against the
`job` table: generate returns 202 with a job id; polling an unknown id returns
404; a `FAILED` job surfaces `error`; generate returns 503 when the extension
is disconnected (this path already exists and is worth keeping covered).

**Manual, once.** Deploy, open `/browser`, sign into Google, confirm
`chrome://extensions` shows the extension installed, then run one article
end-to-end. This cannot be automated — it is a human solving a Google login.

## Risks

- **Google re-challenges the session** when it appears from a new IP. Expected
  at least once during the move. The browser panel is the mitigation: handling
  it becomes a two-minute task in the dashboard instead of a separate domain
  and a VNC password.
- **`--disable-gpu` degrades the reCAPTCHA score.** Mitigated by applying it
  last and separately, with a documented revert.
- **The Chrome profile volume is the one irreplaceable thing.** Losing it means
  redoing the Google sign-in by hand. Named volume, and worth backing up.
- **Chrome crash-loops.** supervisord restarts it and `watchdog.py` already
  exists; Chrome's stdout is already wired to the container log.

## Out of scope

- Any video capability — permanently, not "for now"
- `edit-image`
- Sharing one imagegen across multiple platform instances. Each VPS runs its
  own pair, matching how the platform is already deployed.

## Build order

1. Vendor and strip FlowKit into `services/imagegen/`; replace the schema with
   `job` and rewrite `/v1` against it.
2. Chrome memory flags; drop `shm_size`.
3. Root `docker-compose.yml` with both services and both networks; remove the
   VNC password.
4. The `/browser` proxy route and page in the platform.
5. Settings default, `/status` health check, nav entry.
6. Deploy, sign in once, run one article end-to-end.
