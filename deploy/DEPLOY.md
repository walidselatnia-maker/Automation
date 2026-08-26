# Deploying

Built for Docker platforms — Coolify, Dokploy, Portainer, CapRover, Komodo, or
plain `docker compose`. No SSH and no setup script.

---

## Deploy

Point your platform at the repository. It reads `docker-compose.yml` and runs.

Two containers come up:

| Service | What it is | Reachable from outside |
|---|---|---|
| `platform` | pipeline, dashboard, scheduler | **yes** — attach your domain here, container port 8080 |
| `imagegen` | Chrome + the Google Flow extension + an image job queue | **no** — no published port, no domain |

Attach your domain to `platform` only. `imagegen` sits on an internal Docker
network with no route in from anywhere; the platform is the only thing that can
reach it, and it proxies the parts you need behind the same login.

Set one environment variable before the first deploy:

```
IMAGE_API_KEY=<a long random string>
```

Generate one with `openssl rand -hex 32`. Both containers read it — it is what
stops anything else on the Docker network spending your Flow credits.

Everything else generates itself on first boot.

### Get the admin password

It is printed in the container logs on every start until you set your own:

```
┌─────────────────────────────────────────────────────────┐
│  ADMIN PASSWORD (generated on first start)              │
├─────────────────────────────────────────────────────────┤
│  quartz-nectar-violet-6493                              │
└─────────────────────────────────────────────────────────┘
```

Open your platform's log view for the container and search for
`ADMIN PASSWORD`.

To choose your own instead, set `AUTH_PASSWORD` in the platform's environment
variables and redeploy.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `IMAGE_API_KEY` | — | **Required.** Shared secret between the two containers |
| `AUTH_PASSWORD` | generated | UI password |
| `ENCRYPTION_KEY` | generated | 64 hex chars; encrypts stored credentials |
| `FLOW_PROJECT_ID` | — | Optional here; easier to set in Settings → Images |
| `MAX_CONCURRENT_REQUESTS` | `2` | Parallel image generations. Google's own ceiling is 5 |
| `API_COOLDOWN` | `10` | Seconds between calls to Google |
| `PORT` | `8080` | Platform listening port |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### The volumes are the things that matter

`platform-data` holds the database, the encryption key and the admin password.
Deleting it means re-entering every credential.

`imagegen-data` holds the **signed-in Google session** and the job queue.
Deleting it means signing in to Google again by hand through the Browser page.

Back up both. The Google session is the slower one to replace.

### The Browser page

`imagegen` runs a real Chrome under a virtual display, because the Google Flow
API will not accept a request that was not made by a genuine, reCAPTCHA-scored
browser session. There is no API key that substitutes for it.

The dashboard's **Browser** page is that Chrome, live, behind the same login as
everything else. Use it to sign in to Google the first time, and again whenever
the dashboard warns that the session has lapsed. Refreshing the tab, checking
`chrome://extensions` and switching Google accounts all work there.

It was previously a second public domain guarded by an eight-character VNC
password. It is not exposed at all now.

---

## Security

The UI holds every credential and can publish to your live sites, so it is
password-protected. That is what makes it safe to sit behind your platform's
public URL.

- Sessions are HMAC-signed cookies, `HttpOnly` and `SameSite=Lax`, valid 30 days.
- `Secure` is set automatically when the proxy forwards `X-Forwarded-Proto: https`.
- Only `/healthz` and `/static/*` are reachable without signing in.
- `/healthz` returns status only — never credentials.

Let your platform terminate TLS. Do not expose port 8080 directly over plain
HTTP on a public address.

The `imagegen` container is not password-protected itself, and does not need to
be: it has no route in from outside. It lives on a Docker network declared
`internal: true`, so the only client that can open a socket to it is the
platform, which checks the session cookie on every request it serves. Give it a
domain and you undo that — do not.

---

## First-time setup

### 1. Settings (shared by every site)

- **LLM** — base URL, normally `https://ollama.com`
- **LLM API keys** — add each key one at a time. Label plus key; nothing else.
  They all share the base URL above.
- **Images** — the API key (same value as `IMAGE_API_KEY`) and the **Flow
  project ID**. The service URL already points at the `imagegen` container.

  The Flow project ID must be a **real project id from the Google Flow UI**. It
  is sent to Google with every generation as `clientContext.projectId`; a made
  up value makes each request look unlike one the Flow UI would send. Open a
  project in Flow and take the id from the URL.
- **General** — timezone
- **Buffer / Telegram** — on/off switches

### 2. Sites (each has its own credentials)

Every site carries its **own** Site API token and **own** Buffer API token,
because the domains do not share accounts. Add them under **Sites → Add a site**:

| Field | Notes |
|---|---|
| Name, Domain | Domain is editable later; renaming keeps the site's history |
| Daily target | Articles per day. 0 means never publish |
| Minimum gap | Amount plus unit — 20 minutes, 90 minutes, 3 days |
| Site API token | This domain's bearer token |
| Buffer API token | This site's own Buffer account |
| Pinterest username | Picks the right Buffer channel when there is more than one |

The Sites list shows an **API** and **Buffer** badge per row, so a missing
credential is visible at a glance rather than at 3am mid-run. Editing a site
and leaving a credential field blank keeps the stored value.

### 3. Keywords

**Keywords → Download template** gives you a CSV already containing a column
for every site you have added, plus example rows showing `go` / `done` / `no`.
Fill it in, then import it with the button beside it.

### 4. Test

**Dashboard → Run once now.** Enable automation only after that succeeds.

### Which model runs which step

Taken from the original workflow and applied automatically:

| Operation | Model |
|---|---|
| Spy validation | `gpt-oss:120b` |
| Recipe generation | `gpt-oss:20b` |
| Image prompts | `gemma4:31b` |
| Article parts 1-3 (+ fallbacks) | `gemma4:31b` |
| Pinterest description | `gpt-oss:120b` |
| Board selection | `gpt-oss:120b` |
| JSON repair | `gpt-oss:120b` |

API keys are unrelated to this: any key can serve any model. Keys spread rate
limits; this table decides quality.

### Rate limit behaviour

1. `429` → that key cools down (honouring `Retry-After`) and the **same request
   is retried on the next key**.
2. Three consecutive failures → the key is marked unhealthy and skipped until a
   background check restores it.
3. Only when every key is exhausted does the step fail, naming each one tried.

---

## Migrating from Google Sheets

Export both sheets as CSV. Import keywords through **Keywords → Import CSV** in
the UI.

For sites, if your platform offers a one-off command:

```bash
node dist/scripts/import-sheets.js --keys KEYS.csv --spy "SPY DATA.csv"
```

Otherwise add sites through the UI — with 5 to 20 of them that is a few minutes.

Credentials are deliberately not imported: they were duplicated across every
row in the old sheet and belong in Settings once.

---

## Updating

Push to the repository and redeploy. The volume persists, so credentials and
history survive.

## Running locally

```bash
docker compose -f docker-compose.local.yml up -d --build
```

Binds to `127.0.0.1:8080`, bind-mounts `./data` so you can inspect the
database, and mounts `./prompts` read-write for editing without a rebuild.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Cannot sign in | Search the container logs for `ADMIN PASSWORD`, or set `AUTH_PASSWORD` |
| Signed out after redeploy | The data volume was recreated; the cookie key changed |
| `/healthz` lists problems | Credentials missing — Settings |
| API key unhealthy | Bad key, or that account is rate limited |
| `HTTP 401` on fetch-categories | Wrong Site API token for that site |
| Nothing publishes | Automation off, or no eligible pair — see **Decisions** |
| Only one article, then stops | Expected: daily target or interval reached |
| "browser is not signed in to Google" | Open **Browser** and sign in. The session lapsed |
| "Image service unreachable" | `imagegen` is restarting. Chrome takes about a minute |
| Images fail with no useful error | Check credits on the Flow account, and that the Flow project ID is real |
| Browser page is blank | Chrome has not finished starting; reload after a minute |

**Decisions** answers "why did nothing happen?" — every site checked and every
keyword skipped, with the reason recorded when the choice was made.
