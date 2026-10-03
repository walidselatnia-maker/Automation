# SEO writer — design

Branch: `new-website`. Date: 2026-10-03. Agreed 2026-10-03 (operator: "automatic at import, no review"; details left to the implementer).

## Problem

The content guide ends by adding keywords. A keyword added that way has a seed
phrase and nothing else. The platform needs more before it can write a good
page:

- **Recipes** are written from a *source* title, description and notes
  (`spy_title`, `spy_description`, `annotation`). `validate-spy` refuses a
  keyword with no `spy_title` ("This keyword has no spy title"), so a recipe
  imported from the guide cannot run at all.
- **SEO text** (title, meta description, slug) is written by the model with a
  single line of guidance ("at most 60 characters"). Nothing checks the result,
  and two recipes in one batch can come out near-identical.

## What Google says (the rules this is built on)

From Google Search Central (title links, snippets, SEO starter guide, helpful
content, recipe structured data):

- Titles: unique per page, descriptive, concise, no keyword stuffing, no
  repeated boilerplate. Google rewrites titles that are empty-ish or do not
  match the page.
- Meta descriptions: unique per page, accurate, human-readable, not keyword
  lists. Programmatic generation is fine if it stays readable and varied.
- URLs: short, descriptive words.
- There is **no official length limit**. 60 / 160 characters are *display*
  limits (longer is cut off), so the checker treats them as caps, not as
  Google rules.
- Recipes need `name` and `image` for rich results (already produced by the
  existing pipeline).
- Mass automated content with no real value is a red flag, so every page needs
  its own specific title and description.

## Parts

### 1. `src/seo/rules.ts` — the checker (plain code, no AI)

Pure functions. Each check returns a list of plain-English problems; an empty
list means it passes.

- `checkTitle(title, ctx)` — ≤ 60 chars; ≥ 15 chars; contains the focus
  keyword's words, with the keyword (or its first two words) in the first 40
  chars; no word used more than twice; no comma/pipe keyword lists; not
  ALL CAPS; no holiday terms; no pork / alcohol words; not too similar to any
  title in `ctx.others`.
- `checkDescription(text, ctx)` — 70–160 chars; ends like a sentence
  (`. ! ?`); contains the focus keyword's words at most once as a phrase; not a
  list (≤ 3 commas, no `|`); no holiday / pork / alcohol; not too similar to
  `ctx.others`.
- `checkSlug(slug, ctx)` — lowercase `a-z0-9-` only; ≤ 6 words and ≤ 60 chars;
  no 4-digit years; contains the focus keyword's main words; unique among
  `ctx.others`.
- `checkFocusKeyword(kw)` — 3 or more words.
- `checkAlt(text)` — 10–125 chars.
- `similarity(a, b)` — token Jaccard on lower-cased, stop-word-free words,
  used for "too similar" (≥ 0.75).
- `rulesPrompt()` — the same rules as text, put into prompts so the model is
  told exactly what will be checked.
- Holiday / pork / alcohol word lists live here and are the platform's
  existing content restrictions (`spy-validation` prompt), not new policy.

Display caps (60 / 160) are named constants with a comment saying they are
display limits.

### 2. `src/seo/writer.ts` — the import-time writer

`writeSeoFor(deps, siteId, pillar, items)`:

1. Takes the **new recipe** keywords an import just inserted (articles are
   skipped: the article pipeline plans its own metadata, and a `spy_title`
   there would make it say "cover the same ground, better").
2. One model call (`seo-writer` prompt, `gpt-oss:120b`, `format: 'json'`) for
   the whole batch, with the identity and pillar as context, returns for each
   keyword: `dish_title` (the specific dish, names the sauce / method /
   vessel), `description` (one sentence, ≤ 160), `notes` (1–2 sentences:
   what makes it different from the other recipes in the batch).
3. Each result is checked with the rules (title rule on `dish_title`,
   description rule on `description`, `others` = the batch plus the titles of
   keywords already linked to the site). Only failures are sent back, with the
   exact problems, up to 2 more rounds.
4. Whatever still fails after that gets a **safe fallback** built from the
   keyword itself (title-cased keyword; a plain one-sentence description
   template), which passes the checker by construction. The import never
   fails because of the writer, and the fallback is recorded in the notes
   (`seo:fallback`) so it can be found and redone.
5. Saves `spy_title`, `spy_description`, `annotation` (`guide:<pillar> | <notes>`)
   on the keyword row.

`ask` is injected (wired to `askPrompt` in `server.ts`, like the guide
assistant), so tests need no model. If the model is unreachable the whole
batch gets fallbacks.

### 3. Rules enforced where SEO text is already written

- **`validate-spy`** (`src/pipeline/steps/content.ts`): after parsing,
  `checkTitle` / `checkDescription` run on the derived `title` /
  `description`. On failure, one corrected re-ask with the problems; if it
  still fails, keep the output and log a warning (never stop a run for SEO
  wording). The prompt's SEO line is replaced with `rulesPrompt()`.
- **`plan-article`** (`src/pipeline/steps/blog.ts`): same for `metaTitle`,
  `metaDescription`, `slug`, image `alt`s. The silent `.slice(0, 60)` /
  `.slice(0, 160)` cut-offs stay as the last-resort guard but a real retry
  runs first, so a sentence is not chopped mid-word.
- A note: guide keywords' seed is the specific dish, not a topic group, so
  `collapsedToGroup` may warn spuriously on them. It is only a warning; left
  alone.

### 4. Wiring

`importShortlistReport` stays pure and fast. The `/import` route calls
`writeSeoFor` after it (new recipe ids only, from the report), then saves the
step result as today. The success message gains "SEO text written for N
recipes" and, when fallbacks were used, "M used a simple default; you can
improve them in Keywords".

## Data

No schema change. Uses existing `keywords.spy_title`, `spy_description`,
`annotation`.

## Errors

- Model down / bad JSON: fallback for every item; import succeeds.
- Duplicate-ish titles in a batch: the checker flags them and the batch is
  re-asked for those items only.
- Rule checker bug can never block an import: the writer wraps the whole step
  in a try/catch that logs and falls back.

## Testing

- `test/seo-rules.test.ts`: every rule, pass and fail cases, `similarity`,
  `rulesPrompt` mentions the caps.
- `test/seo-writer.test.ts`: batch comes out different; failing items are
  re-asked with the problem text; fallback passes the checker; model throwing
  → all fallbacks; articles skipped; existing site titles count as "others";
  rows saved.
- Existing `content`/`blog` step tests updated for the retry-then-warn
  behaviour.
- `test/guide-routes.test.ts`: import fills `spy_title` for new recipes and
  leaves articles alone.
- `test/prompts.test.ts` keeps passing with the new `seo-writer` prompt.

## Out of scope

- A review / edit screen (operator chose automatic; a read-only list can come
  later).
- Search volume, SERP scraping, schema markup changes, internal-link
  suggestions.
- Re-writing SEO text for keywords imported before this change.
