# New website: keyword strategy

Branch `new-website`. 2026-10-08. Approved in chat. Step 2 of
`docs/CONTENT-CREATION-PLAN.md` ("Keyword Strategy"), in the new dashboard.

## Decisions

- Lives in the new dashboard (`/new-website/keywords`), its own tables.
- Reuses the shared tools: Google autocomplete (`src/integrations/google-suggest.ts`),
  the AI connection (`askPrompt`), `similarity()`/`words()` from `src/seo/rules.ts`.
- No restricted-word rule (pork, alcohol, holidays) for new websites.
- Keep only sub-keywords that pass; at most 6, fewer is fine, never padded.
- Google unreachable: stop and say so. Never invent keywords.

## Flow

1. Pick a website, type the pillar keyword, press **Find sub-keywords**.
2. **Pillar check**: the website's posts (`GET /api/v1/posts`, every page) and its
   saved keyword plans. A match stops the search and names the page.
3. **Real searches**: autocomplete for the pillar with the 8 modifiers.
4. **AI picks** (`prompts/keyword-cluster`): only from those searches, each with an
   intent (diet, method, format, flavor, ingredient, time) and a one-line reason.
5. **Code filters**, each drop keeps its reason:
   - not one of the Google searches;
   - not about the pillar (shares under half the pillar's words);
   - adds only adjectives / filler (easy, best, quick, simple, healthy, moist, …);
   - too close (similarity ≥ 0.75, filler removed) to a site post, a saved plan
     keyword, or an earlier pick.
6. **Review**: remove any, add your own (same checks except the Google one).
7. **Save** as a keyword plan: `keyword_plans` (website, pillar) and
   `keyword_plan_items` (keyword, intent, reason, position). Saved plans are
   listed per website; deleting a website deletes its plans.

## Out of scope

Writing, images, scheduling, publishing (later steps).
