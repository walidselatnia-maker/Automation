# Article Platform

Self-hosted article generation and publishing for a set of recipe websites.
Replaces three n8n workflows — Master Orchestrator, Article generator, and
Daily Reset — with one application.

Each person runs their own copy on their own VPS with their own sites. There
are no accounts, no roles, and no shared state between installations.

---

## Install

You need Docker and Docker Compose. Nothing else.

```bash
cp .env.example .env
```

Generate the one value `.env` needs:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste it as `ENCRYPTION_KEY`, then start:

```bash
docker compose up -d
```

Open <http://localhost:8080>. Everything else is configured in the UI.

> **Keep the encryption key safe.** It encrypts stored credentials. If you lose
> it, every credential must be re-entered.

## First-time setup

1. **Settings** — enter the site API token, image service URL and key, and the
   Buffer token. Set your timezone.
2. **Settings → LLM endpoints** — add each Ollama server. List the models each
   one serves, or leave models blank if it serves everything.
3. **Sites** — add your websites with a daily target and minimum hours between
   posts.
4. **Keywords** — import a CSV.
5. **Settings → General** — turn **Automation enabled** on.

Use **Run once now** on the dashboard to test before enabling automation.

## Migrating from Google Sheets

Export both sheets as CSV (File → Download → CSV), then:

```bash
docker compose run --rm platform node dist/scripts/import-sheets.js --keys KEYS.csv --spy "SPY DATA.csv"
```

Sites import first so per-domain columns can be matched to real sites.

Credentials are deliberately **not** imported. In the old sheet the API token,
Buffer token, and image URL were duplicated across every row; they belong in
Settings once.

The importer warns about duplicate domain columns. The old SPY sheet had
`bitespoon.com` and `treasurebarrel.com` twice, which let one keyword hold two
contradictory statuses. The database forbids that, but check those keywords
after importing to confirm the surviving value is the one you meant.

---

## How it works

```
Scheduler (every N minutes)
   │
   ├─ automation off, or a run already in progress ─→ stop
   │
   ├─ selectTask(sites, keywords, links, now)          ← a pure function
   │     Filter 1  site is active, under its daily target, past its interval
   │     Filter 2  keyword is 'go' AND linked 'go' to an eligible site
   │     → one task, or nothing, plus a reason for every decision
   │
   └─ pipeline (12 checkpointed steps)
         fetch-categories → validate-spy → generate-recipe
         → generate-image-prompts → generate-images → generate-article
         → post-article → generate-pin-image → generate-pin-description
         → resolve-buffer-target → publish-to-buffer → notify
```

### Why it cannot loop

The n8n orchestrator had an edge from its last node back to its first, with no
exit condition and no memory of what it had already tried. Combined with a
keyword lookup that always returned the same first row, that guaranteed an
infinite loop.

`selectTask` is a bounded iteration over a finite list with no back edge. When
a keyword has no eligible site, the loop moves to the next keyword — that is
what `continue` does. Termination is structural, not enforced by a counter.

The image polling loop is bounded too: a maximum attempt count, and a reported
`FAILED` status ends the wait instead of being retried forever.

### Why counters cannot drift

`today_count`, `last_publish`, and `error_count` are not columns. They are
queries over the `runs` table:

```sql
SELECT COUNT(*) FROM runs
WHERE site_id = ? AND status = 'published' AND date(published_at) = date('now')
```

This removes a whole class of bug: string arithmetic (`"3" + 1 = "31"`), lost
updates between concurrent runs, and counters disagreeing with reality. It also
removes the need for a nightly reset job — there is no counter to reset.

### Resuming a failed run

Every step's output is stored in `run_steps`. Re-running skips completed steps
and reuses their output, so a failure at step 11 costs one retry rather than
thirteen LLM calls and five image generations. Use **Resume from failed step**
on any failed run.

### LLM failover

The old workflow pinned each generation node to a specific Ollama credential.
That spread load but gave no resilience: if the endpoint wired into "Part 1"
went down, that stage failed every time while the others sat idle.

Here, a request names a model and the pool picks the least recently used
healthy endpoint serving it. On `429` the endpoint cools down and the request
is retried elsewhere; after three consecutive failures an endpoint is marked
unhealthy and skipped until a background check restores it. A run fails only
when every endpoint for that model is exhausted — and the error names each one
tried.

Every step records which endpoint served it, so **Settings → LLM endpoints**
shows exactly which box is misbehaving.

---

## Development

```bash
npm install
npm run dev        # tsx watch
npm test           # vitest
npm run typecheck
npm run build
```

### Layout

| Path | Contains |
|---|---|
| `src/core/selector.ts` | The pure selection function. Start here. |
| `src/db/schema.sql` | Schema, with the reasoning in comments |
| `src/pipeline/steps/` | One file per pipeline stage |
| `src/llm/pool.ts` | Endpoint pool and health tracking |
| `src/web/views/` | Server-rendered HTML, no build step |
| `prompts/` | LLM prompts as plain text |

### Prompts

Extracted verbatim from the n8n workflow, so article quality is unchanged.
Placeholders are `{{dotted.path}}` and nothing else is interpreted.

`part-1`, `part-2`, and `part-3` each have a `.fallback` variant using a
shorter prompt. The primary is tried first; the fallback runs only if the
primary fails or returns unusable JSON. This preserves the degradation
strategy the original encoded as duplicate nodes.

Prompts are mounted read-only into the container, so they can be edited and
the container restarted without a rebuild.

### Tests

```
test/selector.test.ts     the selection rules, including regressions for
                          every production bug found in the old system
test/integration.test.ts  real database: derived counters, the matrix
                          constraint, checkpoints
test/pool.test.ts         endpoint failover, rate limits, health
test/units.test.ts        crypto, CSV, LLM JSON parsing, templating
```

The regression tests encode bugs that actually occurred: `last_publish`
containing the literal text `{{ $json.now_iso }}` (which silently disabled
rate limiting), `"3" + 1 = "31"`, and the keyword that could never be
satisfied but was retried forever.

---

## Operations

| Task | Where |
|---|---|
| Why did nothing publish? | **Decisions** — every site and keyword with its reason |
| Why did a run fail? | **Runs → open the run** — per-step status, timing, input, output |
| Is an Ollama box down? | **Settings → LLM endpoints** — health and last success |
| Technical errors | **/events** |
| Machine-readable status | `GET /healthz` |

### Backup

Everything is in one SQLite file:

```bash
docker compose stop
cp data/platform.db data/platform.db.backup
docker compose start
```

### Security notes

- Credentials are encrypted at rest (AES-256-GCM) with `ENCRYPTION_KEY`.
- The UI has **no authentication**. Do not expose port 8080 to the internet —
  bind it to localhost and reach it over SSH or a private network such as
  Tailscale.
- The site API token is shared across all sites, so rotating it means updating
  one field in Settings.
