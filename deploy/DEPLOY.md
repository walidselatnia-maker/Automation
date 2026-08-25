# Deploying to a VPS

## Before you start: two network facts

**1. The UI has no login screen.** It must never listen on a public interface.
The bootstrap script binds it to `127.0.0.1` and you reach it over an SSH
tunnel. If you publish port 8080 to the internet, anyone who finds it can read
your credentials and publish to your sites.

**2. Ollama runs in the cloud.** The models are called at `https://ollama.com`
with an API key, so the VPS needs nothing but ordinary outbound internet. No
VPN, no tunnel, no GPU on the server.

Multiple API keys are used to spread the provider's rate limits. Add each one
as its own endpoint; the pool rotates between them and fails over on `429`.

---

## Requirements

- Ubuntu 22.04 or 24.04 (Debian 12 works too)
- 2 GB RAM, 1 vCPU, 20 GB disk — the app is small; the heavy lifting is on your
  Ollama boxes and the image service
- Root or a sudo user

---

## Step 1 — Get the code onto the server

### Option A: Git (recommended)

Best if more than one person will run this, or you expect updates.

```bash
# On your machine, once:
cd app
git init && git add -A && git commit -m "Initial commit"
git remote add origin git@github.com:YOU/article-platform.git
git push -u origin main
```

```bash
# On the VPS:
git clone git@github.com:YOU/article-platform.git ~/article-platform
```

Updating later is `git pull && docker compose up -d --build`.

> Make the repository **private**. It contains no secrets — `.env` and `data/`
> are gitignored — but your prompts are your product.

### Option B: Copy directly

Fastest for a one-off test, no accounts needed.

```bash
rsync -av --exclude node_modules --exclude dist --exclude data --exclude .env \
  ./app/ user@your-vps:~/article-platform/
```

On Windows without rsync, use `scp -r` or WSL.

## Step 2 — Bootstrap

```bash
cd ~/article-platform
bash deploy/bootstrap.sh
```

It installs Docker, generates an encryption key into `.env`, forces the port
binding to localhost, builds the image, and waits for the health check.

## Step 3 — Open the UI

From your own machine:

```bash
ssh -N -L 8080:127.0.0.1:8080 user@your-vps
```

Leave that running and browse to <http://localhost:8080>.

---

## Configuring Ollama endpoints

Add one endpoint per API key under **Settings → LLM endpoints**:

| Field | Value |
|---|---|
| Name | `ollama-03`, `ollama-04`, … (any label; reusing one updates it) |
| Base URL | `https://ollama.com` |
| API key | that account's key |
| Models | `gemma4:31b, gpt-oss:120b, gpt-oss:20b` |

All nine keys use the same base URL. They are separate endpoints because the
pool rotates between them least-recently-used, which is what spreads the rate
limit — the same thing the old workflow did by pinning a different credential
into each node, except failover now actually works.

Requests go to `POST {baseUrl}/api/chat` with `Authorization: Bearer <key>`.

### Behaviour under rate limits

1. `429` → that key cools down (honouring `Retry-After`) and the **same
   request is retried on the next key**.
2. Three consecutive failures → the key is marked unhealthy and skipped until
   a background check restores it.
3. Only when every key for that model is exhausted does the step fail — and
   the error names each one tried.

The health column on the Settings page shows which key is throttled and when
it last succeeded.

### Self-hosted Ollama instead

If you ever run Ollama yourself, use its address as the base URL and leave the
API key blank. Endpoints in the pool can mix cloud and self-hosted freely.

---

## Step 4 — Configure and test

1. **Settings** — site API token, image service URL and key, Buffer token,
   timezone. Save.
2. **Settings → LLM endpoints** — add each Ollama server with the models it
   serves. The health column tells you immediately if one is unreachable.
3. **Sites** — add **one** site with `daily_target: 1` for the first test.
4. **Keywords** — import a small CSV, or add one keyword and set it to `go` for
   that site.
5. **Dashboard → Run once now.**

If it fails, open the run. The failing step, its error, and the endpoint that
served each LLM call are all on that page.

Only after a successful manual run: **Settings → General → Automation enabled**.

---

## Migrating your sheets

Export both Google Sheets as CSV, copy them up, then:

```bash
docker compose run --rm platform \
  node dist/scripts/import-sheets.js --keys KEYS.csv --spy "SPY DATA.csv"
```

Sites import first so the SPY file's per-domain columns can be matched.

Credentials are not imported — they were duplicated across every row in the old
sheet and belong in Settings once.

---

## Operating it

```bash
docker compose logs -f            # follow logs
docker compose restart            # restart
docker compose down               # stop
docker compose up -d --build      # redeploy after a change
curl localhost:8080/healthz       # machine-readable status
```

### Backups

Everything is one SQLite file. Back up `.env` too — without the encryption key
the stored credentials are unrecoverable.

```bash
mkdir -p ~/backups
docker compose stop
cp data/platform.db ~/backups/platform-$(date +%F).db
cp .env ~/backups/env-$(date +%F).bak
docker compose start
```

A nightly cron:

```bash
0 3 * * * cd ~/article-platform && docker compose stop && \
  cp data/platform.db ~/backups/platform-$(date +\%F).db && \
  docker compose start
```

### Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw enable
```

Do **not** add a rule for 8080.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/healthz` lists problems | Credentials missing — Settings |
| Endpoint shows unhealthy | Bad API key, or the account is rate limited |
| `HTTP 401` on fetch-categories | Wrong site API token |
| Nothing publishes, no runs | Automation off, or no eligible pair — see **Decisions** |
| Runs stop after one article | Expected: daily target or interval reached |
| Port already in use | Another service on 8080; change `PORT` in `.env` |

The **Decisions** page answers "why did nothing happen?" — every site checked
and every keyword skipped, with the reason recorded at the moment of the choice.
