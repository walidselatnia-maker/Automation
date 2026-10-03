# Content guide — design

Branch: `new-website`. Date: 2026-10-03. Agreed 2026-10-03.

## Goal

A page inside the platform that walks the operator through the content
strategy for one site, **one step at a time**, with an AI assistant on every
step that does the hard thinking with them.

The operator has ADHD and gets lost in long lists and blank boxes. Every
choice in this design follows from that:

- One card on screen. Never the whole list unless asked for.
- The AI speaks first. The operator reacts to drafts and picks from options;
  typing is optional.
- What the operator decides is saved, and later steps reuse it, so nothing is
  asked twice.
- No calendar, no deadlines. The guide shows the next step whenever it is
  opened.

## The journey

Per site. The operator picks one site and works through it; other sites keep
their own progress.

| # | Key | Step | Round |
|---|---|---|---|
| 1 | `identity` | Write who the site is for, in one line | 1 |
| 2 | `pillars` | Pick 3 pillar topics | 1 |
| 3 | `search-console` | Connect Google Search Console | 1 |
| 4 | `keywords` | Collect 30–50 long-tail keywords for one pillar | 1 |
| 5 | `shortlist` | Remove duplicates, choose 1 pillar article + 10 recipes | 1 |
| 6 | `import` | Send the shortlist into Keywords | 1 |
| 7 | `quality` | Check 3 published posts | 2 |
| 8 | `distribution` | Make sure reels and pins went out | 2 |
| 9 | `improve` | Improve pages at positions 8–20 | 2 |
| 10 | `prune` | Merge or remove pages with no impressions | 2 |
| 11 | `next-pillar` | Pick the next pillar and go back to step 4 | 2 |

**This spec covers round 1 (steps 1–6) in full.** Round 2 is listed so the
data model has room for it; it gets its own spec once Search Console data
exists, because steps 9–10 depend on a Search Console integration that is
out of scope here.

Steps 4–6 belong to a **pillar**, not to the site: after step 6 the operator
can start steps 4–6 again for the next pillar (step 11 will automate that
loop later; in round 1 a "Start next pillar" button on the finished step 6
card does it).

## What the operator sees

New entry **Content → Guide** (`/guide`), first in the Content section.

**`/guide`** — the site list. Each site shows "Step N of 6" and its current
step's title, and a **Continue** button. A site never started shows
**Start**.

**`/guide/:siteId`** — the card for the site's current step:

```
┌ bitespoon.com ─────────────────────── Step 2 of 6 ━━━━━━░░░░ ┐
│ Pick 3 pillar topics                                          │
│ Why: Pillars keep the site focused, so Google trusts it.      │
│ ▸ How (collapsed)                                             │
│                                                               │
│ ┌ Assistant ───────────────────────────────────────────────┐  │
│ │ Based on "Quick weeknight dinners for busy parents",     │  │
│ │ here are 7 topics. Tap the 3 you like most:              │  │
│ │ [Chicken dinners] [One-pan meals] [Air fryer] ...        │  │
│ │                                                          │  │
│ │ [👍 Use these] [🔄 Other ideas] [😵 I'm stuck]          │  │
│ │ ( type here if you want … )                     [Send]   │  │
│ └──────────────────────────────────────────────────────────┘  │
│ Saved: — (nothing yet)                                        │
│                                            [← Back] [Done →]  │
└───────────────────────────────────────────────────────────────┘
          See the whole map ▾   (collapsed by default)
```

- **Header:** site, "Step N of 6", a progress bar.
- **Why:** one sentence. **How:** 2–4 bullets, collapsed.
- **Assistant panel:** chat history for this step on this site. On first
  open of a step the assistant's opening message is generated automatically.
  Its replies may carry **choice chips** (tap to send that text, or toggle when
  the step asks for several) and a **draft** (the proposed result of the step).
- **Saved:** the step's current result. "👍 Use this" on a draft saves it.
- **Done →** is enabled only when the step has a saved result (step 3 needs
  only the checkbox "I've done this"). It marks the step done and opens the
  next one.
- **← Back** reopens the previous step. Changing a saved result there does not
  reset later steps; later steps just read the new value.
- **😵 I'm stuck** sends a fixed message asking the AI to break the step into
  tiny actions and ask only one easy question.
- **See the whole map** expands a list of all steps with ✓ / current / locked.
  Any done step can be clicked to revisit.

The chat works without a page reload (small inline script, `fetch`, same
pattern as `REEL_CAPTION_SCRIPT` in `pages.ts`). If JavaScript fails the card
still renders and the saved result can be typed into a plain form.

## What the AI does per step

All guide prompts are ordinary prompt files in `prompts/`, registered in
`PROMPT_MODELS` with `format: 'json'`, so the existing Prompts page can edit
them and pick their model. Default model: `gpt-oss:120b`. Calls go through
`askPrompt`, i.e. the existing endpoint pool and failover.

Every guide prompt receives the same variables:

- `site_name`, `site_domain`
- `identity` (step 1 result or empty), `pillars` (step 2 result or empty),
  `current_pillar` (for steps 4–6)
- `step_title`, `step_goal`
- `history` — the step's chat so far, as `ROLE: text` lines (last 20 messages)
- `extra` — step-specific data (below)

Every guide prompt must answer with this JSON:

```json
{
  "message": "text shown in the bubble, short, plain words",
  "choices": ["chip 1", "chip 2"],
  "multi": false,
  "draft": null
}
```

`choices` is 0–8 short strings. `multi: true` means chips toggle and a
**Send selected** button appears. `draft` is `null` or the step's result shape
(below). The reply is parsed with `parseJsonOrRepair`; a reply that still
fails becomes the message "I got confused — tap 🔄 to try again" with no
draft.

| Step | Prompt | Behaviour | Result shape (`draft`) |
|---|---|---|---|
| 1 identity | `guide-identity` | Interviews with multiple-choice questions, one at a time (audience, skill level, time, diet/style). After 2–4 answers, offers 3 one-line versions as choices. | `{ "identity": "one line" }` |
| 2 pillars | `guide-pillars` | Proposes 6–8 pillars that fit the identity as multi-select chips; drafts once 3 are chosen. | `{ "pillars": ["a","b","c"] }` (exactly 3) |
| 3 search-console | `guide-search-console` | Explains setup one action per message ("Open search.google.com/search-console", "Choose Domain", …), asking "Done?" each time. No draft; the step completes by checkbox. | none |
| 4 keywords | `guide-keywords` | Asks which pillar (chips from step 2), then generates seed phrases; the server expands and verifies them (below) and the AI presents the verified list. | `{ "pillar": "…", "keywords": ["…", …] }` (30–50) |
| 5 shortlist | `guide-shortlist` | Groups step 4's keywords, marks near-duplicates, proposes 1 pillar article + 10 recipes with a type each. Operator can swap items via chips. | `{ "pillar": "…", "items": [{ "keyword": "…", "type": "article" \| "recipe" }] }` (11 items, exactly one article marked as pillar) |
| 6 import | — (no AI) | Shows the shortlist with checkboxes (all ticked) and one **Add to Keywords** button. | `{ "imported_ids": [ … ] }` |

### Step 4: grounding keywords in real searches

An LLM alone invents keywords nobody searches. Step 4 therefore runs in two
parts:

1. The AI is asked (`guide-keywords`, with `extra.phase = "seeds"`) for 8–12
   short seed phrases for the pillar.
2. The server expands each seed through **Google autocomplete**
   (`https://suggestqueries.google.com/complete/search?client=firefox&q=…`,
   no key needed): the seed alone plus the seed followed by each of
   `how, best, easy, with, without, for, can you`. Hard cap 100 requests per
   step run, 200 ms apart, 5 s timeout each.
3. Suggestions are de-duplicated (lowercase, trimmed) and passed back to
   `guide-keywords` with `extra.phase = "pick"` and
   `extra.suggestions = [...]`. The AI picks the 30–50 best long-tail ones
   (3+ words) **only from that list** and returns them as the draft.

If autocomplete fails entirely (blocked, offline), the AI's own list is used
and the message says, in plain words, that these are unchecked guesses. The
draft then carries `"verified": false`.

### Step 5: duplicates against what already exists

Before calling `guide-shortlist`, the server removes from the step 4 list any
keyword that `findDuplicate` (`src/core/similar-title.ts`) matches against the
site's existing keywords (`seed_keyword` of every keyword linked to the
site). The removed ones are passed as `extra.already_have` so the AI can say
"I skipped 4 you already have".

### Step 6: import

For each ticked item: `insertKeyword({ seed_keyword, content_type, niche:
pillar for articles, annotation: 'guide:<pillar>' })`, then
`setLink(id, siteId, 'go')`. Exact-text duplicates of an existing keyword are
linked instead of inserted again. One transaction. Afterwards the card shows
"11 keywords added — they'll be written on the site's normal schedule" and
the **Start next pillar** button.

## Data

Migration `016-content-guide`:

```sql
CREATE TABLE IF NOT EXISTS guide_steps (
  site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  pillar      TEXT    NOT NULL DEFAULT '',   -- '' for site-wide steps 1–3
  step_key    TEXT    NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  result_json TEXT    NOT NULL DEFAULT 'null',
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (site_id, pillar, step_key)
);

CREATE TABLE IF NOT EXISTS guide_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  pillar      TEXT    NOT NULL DEFAULT '',
  step_key    TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT    NOT NULL,             -- the bubble text
  payload     TEXT    NOT NULL DEFAULT '{}',-- choices / multi / draft, JSON
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_guide_messages ON guide_messages (site_id, pillar, step_key, id);

CREATE TABLE IF NOT EXISTS guide_sites (
  site_id        INTEGER PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  current_step   TEXT    NOT NULL DEFAULT 'identity',
  current_pillar TEXT    NOT NULL DEFAULT ''
);
```

The site's identity and pillars are read from `guide_steps` results; nothing
is copied onto `sites`.

## Code layout

| File | Responsibility |
|---|---|
| `src/guide/steps.ts` | The ordered step list: key, title, why, how[], prompt name, whether it is per pillar, how to validate a draft. Pure data + validators. |
| `src/guide/state.ts` | Read/write `guide_sites`, `guide_steps`, `guide_messages`; `currentCard(siteId)`; `markDone`, `goBack`, `startNextPillar`. |
| `src/guide/assistant.ts` | Build variables, call `askPrompt`, parse the reply, store both messages. Step 4's two-phase flow and step 5's duplicate filter live here. |
| `src/integrations/google-suggest.ts` | `suggest(query)` and `expandSeeds(seeds)`; parsing, cap, delay, timeout. |
| `src/guide/import.ts` | Step 6: shortlist → keywords + links, transactional. |
| `src/web/views/guide.ts` | `guideListPage`, `guideCardPage`, the inline chat script. |
| `src/web/server.ts` | Routes (below). |
| `prompts/guide-*.system.txt`, `prompts/guide-*.user.txt` | Five prompts. |

Routes:

| Method | Path | Does |
|---|---|---|
| GET | `/guide` | Site list |
| GET | `/guide/:siteId` | Current card (opening AI message generated on first view of a step) |
| GET | `/guide/:siteId/step/:key` | Revisit a specific done/current step |
| POST | `/guide/:siteId/chat` | JSON in `{ step, text }` → JSON out: the assistant message |
| POST | `/guide/:siteId/save` | Save a draft (or a typed result) as the step result |
| POST | `/guide/:siteId/done` | Mark current step done, advance |
| POST | `/guide/:siteId/back` | Go to previous step |
| POST | `/guide/:siteId/import` | Step 6 |
| POST | `/guide/:siteId/next-pillar` | Start steps 4–6 for a new pillar |

All behind the existing auth, like every other route.

## Errors

- **No LLM endpoint available** (`NoEndpointAvailableError`): the bubble says
  "The assistant can't reach a model right now. You can still type your
  answer in the Saved box." The manual form is always present.
- **Bad JSON after repair:** generic "try again" bubble, nothing saved.
- **Draft fails validation** (e.g. 2 pillars instead of 3): not offered as a
  draft; the server asks the model once more with the validation error
  appended to `extra.problem`, then falls back to the generic bubble.
- **Autocomplete fails:** see step 4.
- **Site deleted:** cascades remove guide rows.

## Testing

Vitest, same style as the existing suite (`test/`):

- `guide-steps.test.ts` — order, validators accept/reject each result shape.
- `guide-state.test.ts` — progress per site and per pillar, done/back/next
  pillar, Done refused without a result.
- `guide-assistant.test.ts` — with a stubbed `askPrompt`: variables built
  from saved results, messages stored, bad JSON → fallback, invalid draft →
  one retry.
- `google-suggest.test.ts` — parses the `client=firefox` response shape,
  respects the cap, returns `[]` on failure (fetch stubbed).
- `guide-import.test.ts` — inserts and links, reuses exact duplicates, one
  transaction.
- `navigation.test.ts` — add `['/guide', 'Content']` and
  `['/guide/3', 'Content']`.
- `prompts.test.ts` — the five new prompts load and are in `PROMPT_MODELS`.

## Out of scope (round 2 or never)

- Steps 7–11 and any Search Console API integration.
- Search volume numbers from paid tools.
- Multiple operators, reminders, notifications, streaks.
