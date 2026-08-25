# Deploying

Built for Docker platforms — Coolify, Dokploy, Portainer, CapRover, Komodo, or
plain `docker compose`. No SSH, no setup script, no environment variables
required.

---

## Deploy

Point your platform at the repository. It reads `docker-compose.yml` and runs.

That is the whole procedure. On first boot the app generates its own
encryption key and admin password into the data volume, so there is nothing to
create by hand.

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

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_PASSWORD` | generated | UI password |
| `ENCRYPTION_KEY` | generated | 64 hex chars; encrypts stored credentials |
| `DB_PATH` | `/app/data/platform.db` | Database location |
| `PORT` | `8080` | Listening port |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### The volume is the only thing that matters

`platform-data` holds the database, the encryption key and the admin password.
Back it up. Deleting it means re-entering every credential.

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

---

## First-time setup

1. **Settings**
   - *Sites* — the API token your websites accept
   - *Images* — image service URL (default `https://f.longlivo.com`) and API key
   - *Buffer* — token, or switch Buffer off
   - *General* — timezone
2. **Settings → LLM endpoints** — add one endpoint per Ollama API key:

   | Field | Value |
   |---|---|
   | Name | `ollama-03`, `ollama-04`, … |
   | Base URL | `https://ollama.com` |
   | API key | that account's key |
   | Models | leave blank so any key can serve any operation |

   Keys are separate endpoints so the pool can rotate between them
   least-recently-used, which is what spreads the provider's rate limit.
3. **Sites** — add one site, `daily_target: 1`, for the first test.
4. **Keywords** — import a CSV.
5. **Dashboard → Run once now.** Only enable automation after that succeeds.

### Which model runs which step

Taken from the original workflow and applied automatically:

| Operation | Model |
|---|---|
| Spy validation | `gpt-oss:120b` |
| Recipe generation | `gpt-oss:20b` |
| Image prompts | `gemma4:31b` |
| Article parts 1–3 (+ fallbacks) | `gemma4:31b` |
| Pinterest description | `gpt-oss:120b` |
| Board selection | `gpt-oss:120b` |
| JSON repair | `gpt-oss:120b` |

API keys are unrelated to this: any key can serve any model. Keys exist to
spread rate limits; this table decides quality.

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
| Endpoint unhealthy | Bad API key, or that account is rate limited |
| `HTTP 401` on fetch-categories | Wrong site API token |
| Nothing publishes | Automation off, or no eligible pair — see **Decisions** |
| Only one article, then stops | Expected: daily target or interval reached |

**Decisions** answers "why did nothing happen?" — every site checked and every
keyword skipped, with the reason recorded when the choice was made.
