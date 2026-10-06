# Topic hubs — design

Branch: `new-website`. Date: 2026-10-06. Status: **plan for review, nothing built yet.**

## Goal

Run the "one strong pillar page, then a few genuinely different sub-pages that
link to it" strategy (the pumpkin chocolate chip cookies document) on the
platform, automatically, and publish to the **new website** (`blog-engine`).

Decisions from the operator (2026-10-06):

- Do **not** wait for Google indexing before creating the sub-pages.
- Sub-pages are created by AI, from real search suggestions.
- A **duplicate check** is required.
- **Internal links** go through the site's API; the site's API can be changed
  if that is needed.
- Pillar type depends on the topic: the **main recipe** for recipe topics, a
  **guide article** for everything else.
- The number of sub-pages is chosen for SEO, not fixed (see Rules).
- The pillar goes live now; sub-pages **drip out over days**.

## The new website (what it already gives us)

Checked against the `blog-engine` code on 2026-10-06. Automation API, key sent
as `Authorization: Bearer <key from Admin → Automation>`:

| Need | What the site offers | Enough? |
|---|---|---|
| Create a page | `POST /api/v1/posts` — types `article`, `recipe`, `review`, `listicle`, `howto` | yes |
| Never duplicate on retry | same `externalId` again updates the post | yes |
| Clean URL | `slug` can be sent; a taken slug is silently made unique (`-2`) | yes, but the platform must check the slug that comes back |
| Read before writing | `GET /api/v1/posts` (status/type filter, 100 per page; id, slug, title, type, status), `GET /api/v1/posts/<id | slug | ext:ID>` (full post) | enough for the duplicate check |
| Change a page later | `PATCH /api/v1/posts/<ref>` (only the fields sent) | yes — this is how links get added |
| Schedule | `status: published` + a future `publishedAt` = not live until then | yes |
| Learn what a type accepts | `GET /api/v1/site` lists each type's fields | yes |
| Cover image | the site downloads it from a link | needs a public link |
| Internal links | automatic: a post's `seo.focusKeyword`, category names and tag names become links inside *other* posts (first occurrence, at most 5 per post); "related posts" are chosen by shared tags | partly — nothing guarantees pillar ↔ sub-page links |
| Group pages as a hub | no pillar/parent field | **missing** (not needed for round 1, see Links) |
| Search for a duplicate | none | **missing** — the platform does it (see Duplicate check) |

The old Guelma API (`/api/recipe`, `/api/articles`, `/api/upload`,
`/api/categories`) that `src/integrations/site-api.ts` talks to is **not** the
new site's API. That client is replaced for sites on the new platform.

## The hub, step by step

A **hub** is one pillar and its sub-pages for one site.

1. **Topic.** The operator gives the pillar keyword and picks the niche
   (recipe or not). The pillar type follows the niche (recipe → main recipe;
   otherwise guide article, or `howto` when the topic is a procedure). The
   operator can override it.
2. **Pillar duplicate check.** If the live site already has a page that is
   close to the pillar keyword (same test as below), the hub stops and says
   which page it found: improve that page, or choose another topic. This is the
   automatic version of the manual `site:` search in the strategy.
3. **Plan the sub-pages.** The AI proposes up to 8 candidates from Google
   autocomplete (the grounding already built for the guide) plus a list of
   intent types. Each candidate must state its intent in one line and why it is
   not the pillar. Recipes: a different diet, method, main ingredient or
   format. Guides: a different sub-question, a comparison, common mistakes, a
   cost or time breakdown.
4. **Filter.** Drop modifier-only pages (easy, best, soft, chewy, quick,
   15-minute, healthy, simple …), anything too close to the pillar or to
   another candidate, and anything that fails the duplicate check. Keep the
   ones that remain, up to 6. Fewer is fine.
5. **Write.** Each page is written by the existing recipe or article
   generation, with the SEO rules from `src/seo/rules.ts` (title, description,
   slug, focus keyword, alt text) applied. A recipe sub-page must be a
   genuinely different recipe, not the pillar with one swap.
6. **Publish.** The pillar is sent first with `status: published`. Sub-pages
   are sent with `status: published` and a future `publishedAt`, one or two
   days apart, so the site releases them itself. Every post gets `externalId`,
   the clean `slug`, `seo.focusKeyword`, and a shared **hub tag**.
7. **Link.** See Links.
8. **Report.** The hub page shows every page: role, keyword, intent, slug,
   live date, link status, and why any candidate was dropped.

## Rules

### How many sub-pages
Not a fixed number. The target is **4**, the range **2 to 6**. A candidate
survives only if it has a different search intent *and* passes the duplicate
check. If only 2 survive, the hub has 2. Reason: the strategy's whole point is
a few justified pages instead of many near-duplicates, and the old site's
problem was Google crawling but not indexing near-duplicates.

### Duplicate check (three layers)
1. **Live site.** List every post (paged, 100 per request) and compare each
   candidate's keyword and slug with each post's title and slug using the
   `similarity()` already in `src/seo/rules.ts` after removing modifier words.
   At or above the threshold (0.75) it is a duplicate. For near matches the full
   post is fetched to compare `focusKeyword` as well.
2. **The platform's own queue.** Keywords and other hubs for the same site that
   are not on the site yet.
3. **Within the hub.** Candidates against each other.
Every dropped candidate keeps its reason, shown in the hub report.

### Slugs
Slug = the keyword, lower-case words, at most 6 words, no filler like
`-easy-quick-recipe`, no year. After a post is created the platform compares
the slug the site returned with the slug it asked for. A difference (the site
added `-2`) means the duplicate check missed something: the post is marked
failed and left as a draft, not silently kept.

### Links
Two-way, written by the platform, no site change in round 1:

- **Sub → pillar**: each sub-page gets a short deterministic block near the top
  ("This is a variation of our <pillar title>") and the writer is told to
  mention the pillar's focus keyword naturally once, so the site's own
  auto-linking agrees with it.
- **Pillar → subs**: a "More ways to make it" (or "Keep reading") list of the
  sub-pages **that are live**. Because sub-pages drip out, a daily job finds
  sub-pages whose date has passed and are not yet in the pillar, and `PATCH`es
  the pillar's content. A link is never published before its target is live.
- The shared hub tag makes the site's own "related posts" show the hub too.

Optional later, with a site change: a `hub` field on posts and a built-in
"in this guide" box. Not needed for round 1.

### Pillar and sub-page type
| Niche | Pillar | Sub-pages |
|---|---|---|
| Recipes | main recipe (`recipe`) | variation recipes (`recipe`) |
| Procedures | `howto` | `howto` or `article` |
| Everything else | guide `article` | `article` |

## What changes on the platform (the reorganisation)

| Area | Change |
|---|---|
| `src/integrations/site-api.ts` | New `BlogEngineClient` for `/api/v1`: `getSite`, `listPosts` (paged), `getPost`, `createPost`, `patchPost`, `categories`, `authors`. Bearer key per site, stored encrypted like the other secrets. The old client stays only for sites still on the old API. |
| Sites | Each site gets: API key, post base path (`/blog` or `/recipes`, read from the site), content type mapping. |
| New `src/hub/` | `plan.ts` (candidates), `filter.ts` (modifiers + duplicate check), `publish.ts` (create/schedule), `link.ts` (daily link-up job), `state.ts` (hub tables). Pure logic is separate from the site client so it is testable without a site. |
| Content guide | Steps 1–3 (identity, pillars, Search Console) stay. Steps 4–6 (collect keywords, shortlist, import) are replaced by "Start a hub for this pillar". |
| Generation | The recipe and article generators stay; their final step maps their output to the site's `/api/v1/posts` shape (read from `GET /api/v1/site` at build time) instead of the old recipe JSON. |
| SEO writer | Applies unchanged to hub pages (it already writes titles/descriptions and checks them). |
| Pins | One pin per page as today. Several different pins per URL is a separate later phase. |

## Data

New tables (names indicative):

- `hubs(id, site_id, topic, niche, pillar_type, status, created_at)`
- `hub_posts(id, hub_id, role pillar|sub, keyword, intent, title, slug, external_id, site_post_id, publish_at, status, linked, error)`
- `hub_candidates(id, hub_id, keyword, intent, verdict kept|dropped, reason)`

Hub status: `planned → pillar_live → subs_scheduled → linked → done`, or
`failed` with the failing step recorded so it can be resumed.

## Errors and recovery

- **Site unreachable or a 4xx/5xx:** the failing step is recorded; resuming
  uses `externalId`, so nothing is duplicated.
- **Model unavailable:** hub planning stops with a clear message; writing falls
  back as the SEO writer already does.
- **Slug mismatch, duplicate found late:** the post stays a draft and the hub
  shows it.
- **Daily link-up job fails for one hub:** retried next day; other hubs are
  unaffected.

## Testing

- Pure logic (modifier stripping, similarity, candidate filtering, link block
  building, slug rules, schedule dates) with unit tests.
- A fake site (in-memory, same shape as `/api/v1`) to test publish, slug
  mismatch, resume after failure, and the link-up job.
- One contract test against the real `GET /api/v1/site` field list (recorded
  sample) so a site change is caught.

## Build order

1. `BlogEngineClient` + site settings (key, base path) + a "test connection".
2. Duplicate checker and candidate filter (works against a recorded post list).
3. Hub planner (AI candidates, intent rules).
4. Publisher (pillar now, subs scheduled, slug check).
5. Link-up job (pillar → subs as they go live; sub → pillar block).
6. Guide change: replace steps 4–6 with the hub; hub report page.
7. Later: several pins per URL; optional `hub` field on the site.

## Still to confirm before building

- The exact `recipe` fields in `details` (read them once from the live
  `GET /api/v1/site`; needs a site key).
- Which sites move to the new website, and whether the old sites keep using the
  old API.
- The post base path per site (`/blog` or `/recipes`).
- Category and author mapping per site (the site accepts a name, slug or id).
- The old site's ~400 crawled-but-not-indexed near-duplicate pages are a
  separate clean-up on that site, not part of this work.

## Out of scope

- Waiting for or checking Google indexing (removed by decision).
- Search volume data from paid tools.
- Changing the site's database or admin (round 1 needs no site change).
