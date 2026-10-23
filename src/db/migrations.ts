import { createLogger } from '../lib/logger.js';
import type { Db } from './index.js';

const log = createLogger('migrate');

/**
 * Versioned schema changes, applied once each and recorded.
 *
 * schema.sql is all CREATE TABLE IF NOT EXISTS, which is a no-op against a
 * table that already exists — so a column added to one of those definitions
 * never reaches a database that has been deployed before. That was survivable
 * while nothing was live. It is not survivable now, and it had already broken:
 * a partial index added to schema.sql referenced a column that only existed on
 * fresh databases, so booting the new code against the deployed one failed
 * outright with "no such column: hold".
 *
 * The rules here:
 *
 *  - Every migration is idempotent on its own, so a half-applied state cannot
 *    wedge the next boot.
 *  - Each runs in a transaction and is recorded only if it commits.
 *  - Order is the array order, and it never changes. Appending is the only
 *    permitted edit to this list.
 *  - Nothing here drops a column, drops a table, or rewrites data. A migration
 *    that can lose something does not belong in a runner that executes
 *    unattended at boot; those go in a script somebody runs on purpose.
 */

export interface Migration {
  /** Stable identifier. Never renamed once deployed. */
  id: string;
  description: string;
  up(db: Db): void;
}

/* -- Idempotent helpers --------------------------------------------------- */

function hasTable(db: Db, table: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { present: number } | undefined;
  return row !== undefined;
}

function columns(db: Db, table: string): string[] {
  if (!hasTable(db, table)) return [];
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * Add a column unless it is already there.
 *
 * The one schema change that is safe to apply unattended: it cannot lose data
 * and it cannot fail on a second run.
 *
 * CHECK constraints from schema.sql are deliberately not repeated in the
 * definitions passed here. SQLite cannot add a CHECK to an existing table
 * without rewriting the whole table, and rewriting a live table to gain a
 * constraint the application already enforces is a bad trade. A new database
 * gets the constraint from schema.sql; an older one gets the column and the
 * same behaviour.
 */
function addColumn(db: Db, table: string, column: string, definition: string): void {
  // No table means schema.sql has not created it yet, or this deployment never
  // had it. Either way there is nothing to alter and nothing to fix.
  if (!hasTable(db, table)) return;
  if (columns(db, table).includes(column)) return;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info(`added ${table}.${column}`);
}

/* -- The list ------------------------------------------------------------- */

export const MIGRATIONS: Migration[] = [
  {
    id: '001-share-images',
    description: 'Per keyword-and-site control over reusing article images',
    up(db) {
      addColumn(db, 'keyword_sites', 'share_images', 'INTEGER NOT NULL DEFAULT 1');
    },
  },

  {
    id: '002-site-pause-and-approval',
    description: 'A pause with a reason and an expiry, and per-site approval',
    up(db) {
      addColumn(db, 'sites', 'paused_reason', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'sites', 'paused_until', 'TEXT');
      addColumn(db, 'sites', 'auto_publish', 'INTEGER NOT NULL DEFAULT 1');
    },
  },

  {
    id: '003-run-mode-holds-retries',
    description: 'Dry runs, approval holds, automatic retries, and the published title',
    up(db) {
      addColumn(db, 'runs', 'mode', "TEXT NOT NULL DEFAULT 'live'");
      addColumn(db, 'runs', 'hold', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'runs', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'runs', 'retry_after', 'TEXT');
      addColumn(db, 'runs', 'title', "TEXT NOT NULL DEFAULT ''");
    },
  },

  {
    id: '004-run-indexes',
    description: 'Indexes over the columns 003 added',
    up(db) {
      // Separate from 003 on purpose. These are partial indexes over `hold`
      // and `retry_after`, so they cannot be created until those columns
      // exist. Having them in schema.sql — which runs before any column is
      // added — is precisely what broke booting against a deployed database.
      if (!columns(db, 'runs').includes('hold')) return;

      db.exec("CREATE INDEX IF NOT EXISTS idx_runs_hold ON runs (hold) WHERE hold != ''");
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_runs_retry ON runs (retry_after) ' +
          'WHERE retry_after IS NOT NULL',
      );
    },
  },

  {
    id: '005-step-usage',
    description: 'What each step cost, in tokens and images',
    up(db) {
      addColumn(db, 'run_steps', 'tokens_in', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'run_steps', 'tokens_out', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'run_steps', 'images', 'INTEGER NOT NULL DEFAULT 0');
    },
  },

  {
    id: '006-prompt-history-models-notices',
    description: 'Prompt versions, per-prompt models, notification de-duplication',
    up(db) {
      // Also in schema.sql, which is what creates them on a fresh database.
      // Repeated here so an existing one gets them without depending on the
      // order the two files happen to run in.
      db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_versions (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT    NOT NULL,
          body       TEXT    NOT NULL,
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_versions ON prompt_versions (name, id DESC);

        CREATE TABLE IF NOT EXISTS model_overrides (
          prompt     TEXT PRIMARY KEY,
          model      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS notice_state (
          kind       TEXT PRIMARY KEY,
          state      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },

  {
    id: '007-buffer-account-rotation',
    description: 'Per-site Buffer accounts, tried in order when a queue fills',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS buffer_accounts (
          id               INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id          INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          label            TEXT    NOT NULL DEFAULT '',
          token_encrypted  TEXT    NOT NULL DEFAULT '',
          position         INTEGER NOT NULL DEFAULT 1,
          enabled          INTEGER NOT NULL DEFAULT 1,
          full_until       TEXT,
          last_used_at     TEXT,
          last_error       TEXT,
          created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_buffer_accounts_site ON buffer_accounts (site_id, position);
      `);

      // Every site that already had a token keeps posting through it, as
      // account one. Nothing to re-enter, and a site with one account behaves
      // exactly as it did before rotation existed.
      db.exec(`
        INSERT INTO buffer_accounts (site_id, label, token_encrypted, position)
        SELECT id, 'Account 1', buffer_token_encrypted, 1
          FROM sites
         WHERE buffer_token_encrypted <> ''
           AND id NOT IN (SELECT site_id FROM buffer_accounts);
      `);
    },
  },

  {
    id: '008-block-hopeless-pairs',
    description: 'Quarantine a keyword-site pair that keeps failing the same way',
    up(db) {
      addColumn(db, 'keyword_sites', 'blocked_at', 'TEXT');
      addColumn(db, 'keyword_sites', 'blocked_reason', 'TEXT');
    },
  },
  {
    id: '009-facebook-reels',
    description: 'Facebook pages, their keyword-group routes, and reels',
    up(db) {
      // Pages are registered by hand rather than synced from Graph. The token
      // can see every page in the business, and only some of them are ones
      // this platform should ever post to.
      db.exec(`
        CREATE TABLE IF NOT EXISTS fb_pages (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          page_id       TEXT    NOT NULL UNIQUE,
          name          TEXT    NOT NULL DEFAULT '',
          -- Per page, not per site: one page can be told to hold its reels
          -- for review while the others post on their own.
          auto_publish  INTEGER NOT NULL DEFAULT 1 CHECK (auto_publish IN (0, 1)),
          enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          last_used_at  TEXT,
          last_error    TEXT,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // Which page a reel goes to, decided by (site, niche).
      //
      // One site carries several nano-niches and each niche has its own page,
      // so the site alone cannot decide and the niche alone cannot either. A
      // NULL site_id is the fallback for a niche whose page is shared across
      // every site, which is why site_id is nullable rather than required.
      db.exec(`
        CREATE TABLE IF NOT EXISTS fb_page_routes (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id      INTEGER REFERENCES sites (id) ON DELETE CASCADE,
          seed_keyword TEXT    NOT NULL,
          fb_page_id   INTEGER NOT NULL REFERENCES fb_pages (id) ON DELETE CASCADE,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // COALESCE, because NULL never equals NULL in a UNIQUE index and two
      // identical fallback routes would both be accepted without it.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_route_unique
          ON fb_page_routes (COALESCE(site_id, 0), seed_keyword COLLATE NOCASE);
      `);

      // A reel is an artefact of a run, not a second kind of run: it borrows a
      // published article's images and caption and has its own short life
      // afterwards. Keeping it out of `runs` keeps every derived counter on the
      // dashboard meaning what it already means.
      db.exec(`
        CREATE TABLE IF NOT EXISTS reels (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id         INTEGER REFERENCES runs (id)     ON DELETE SET NULL,
          site_id        INTEGER REFERENCES sites (id)    ON DELETE SET NULL,
          keyword_id     INTEGER REFERENCES keywords (id) ON DELETE SET NULL,
          fb_page_id     INTEGER REFERENCES fb_pages (id) ON DELETE SET NULL,
          status         TEXT    NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','generating','ready',
                                           'publishing','published','failed')),
          prompt         TEXT    NOT NULL DEFAULT '',
          caption        TEXT    NOT NULL DEFAULT '',
          -- The images chosen as references, in order, as JSON.
          reference_json TEXT    NOT NULL DEFAULT '[]',
          job_id         TEXT,
          video_url      TEXT,
          fb_video_id    TEXT,
          error          TEXT,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_reels_status ON reels (status, created_at DESC);
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_reels_run ON reels (run_id);`);
    },
  },
  {
    id: '010-fb-tokens',
    description: 'Tokens as rows, one niche per page; routes retired',
    up(db) {
      // A token per app. The single fb_system_token setting could reach only
      // the pages one app was allowed to see, so a second app meant a second
      // deployment. Encrypted with the platform key exactly as a secret
      // setting is, which is what lets the stored setting move over as-is.
      db.exec(`
        CREATE TABLE IF NOT EXISTS fb_tokens (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT    NOT NULL DEFAULT '',
          token_encrypted TEXT    NOT NULL,
          last_synced_at  TEXT,
          last_error      TEXT,
          created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      addColumn(db, 'fb_pages', 'token_id', 'INTEGER REFERENCES fb_tokens (id) ON DELETE CASCADE');
      // The niche a page carries. One page, one niche; the site the article
      // was published on does not come into it. NULL is a page the platform
      // can see but does not post to.
      addColumn(db, 'fb_pages', 'niche', 'TEXT');
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fb_pages_niche
          ON fb_pages (niche COLLATE NOCASE) WHERE niche IS NOT NULL AND enabled = 1;
      `);

      if (hasTable(db, 'settings')) {
        const stored = db
          .prepare("SELECT value FROM settings WHERE key = 'fb_system_token' AND value != ''")
          .get() as { value: string } | undefined;
        const tokens = db.prepare('SELECT COUNT(*) AS n FROM fb_tokens').get() as { n: number };
        if (stored && tokens.n === 0) {
          db.prepare("INSERT INTO fb_tokens (name, token_encrypted) VALUES ('Imported', ?)").run(
            stored.value,
          );
          db.prepare(
            'UPDATE fb_pages SET token_id = (SELECT MAX(id) FROM fb_tokens) WHERE token_id IS NULL',
          ).run();
          log.info('moved the Facebook system token into fb_tokens');
        }
      }

      if (!hasTable(db, 'fb_page_routes')) return;

      // A route naming a niche and exactly one page, where that page was
      // routed nothing else, becomes the page's niche. Two pages for one
      // niche, or two niches on one page, is a question for a person: left
      // blank, and said so in the log. The table itself stays -- this runner
      // never drops one -- but nothing reads it after this.
      const routes = db
        .prepare("SELECT seed_keyword, fb_page_id FROM fb_page_routes WHERE seed_keyword != ''")
        .all() as { seed_keyword: string; fb_page_id: number }[];
      const pagesByNiche = new Map<string, Set<number>>();
      const nichesByPage = new Map<number, Set<string>>();
      for (const r of routes) {
        const niche = r.seed_keyword.trim().toLowerCase();
        if (!pagesByNiche.has(niche)) pagesByNiche.set(niche, new Set());
        pagesByNiche.get(niche)!.add(r.fb_page_id);
        if (!nichesByPage.has(r.fb_page_id)) nichesByPage.set(r.fb_page_id, new Set());
        nichesByPage.get(r.fb_page_id)!.add(niche);
      }

      const assign = db.prepare('UPDATE fb_pages SET niche = ? WHERE id = ? AND niche IS NULL');
      for (const [niche, pages] of pagesByNiche) {
        if (pages.size !== 1) {
          log.warn(`niche "${niche}" was routed to ${pages.size} pages; left for you to assign`);
          continue;
        }
        const [pageId] = pages;
        if (nichesByPage.get(pageId!)!.size !== 1) {
          log.warn(`page ${pageId} was routed several niches; left for you to assign`);
          continue;
        }
        const original = routes.find((r) => r.fb_page_id === pageId)!.seed_keyword.trim();
        assign.run(original, pageId!);
      }
    },
  },
  {
    id: '011-reel-studio',
    description: 'Presenters, reel scenes, and the stage a reel is at',
    up(db) {
      // A presenter is a character and a voice that live in the Flow project
      // as two assets -- that is where both are made and kept. What the
      // platform adds is the pairing, the name the operator knows them by,
      // and how the delivery should sound, in words the clip prompt repeats
      // scene after scene so it stays the same.
      db.exec(`
        CREATE TABLE IF NOT EXISTS presenters (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          name              TEXT    NOT NULL,
          flow_character_id TEXT    NOT NULL,
          flow_voice_id     TEXT    NOT NULL DEFAULT '',
          voice_description TEXT    NOT NULL DEFAULT '',
          portrait_url      TEXT    NOT NULL DEFAULT '',
          created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      addColumn(db, 'fb_pages', 'presenter_id', 'INTEGER REFERENCES presenters (id) ON DELETE SET NULL');

      // The stage an in-flight reel is at. status stays as it was ('generating'
      // covers every stage) because its CHECK cannot be widened without
      // rebuilding the table; the stage says which of the five it is on.
      // 'done' is the default so every reel from before this reads as past
      // all of them, which for a one-shot reel is true.
      addColumn(db, 'reels', 'stage', "TEXT NOT NULL DEFAULT 'done'");
      addColumn(db, 'reels', 'plan_json', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'reels', 'format', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'reels', 'output_path', "TEXT NOT NULL DEFAULT ''");

      // One row per scene: what to film it from, what happens, what is said,
      // and how far it got. A scene that fails is retried alone.
      db.exec(`
        CREATE TABLE IF NOT EXISTS reel_scenes (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          reel_id       INTEGER NOT NULL REFERENCES reels (id) ON DELETE CASCADE,
          position      INTEGER NOT NULL,
          seconds       INTEGER NOT NULL DEFAULT 10,
          presenter     INTEGER NOT NULL DEFAULT 0 CHECK (presenter IN (0, 1)),
          sources_json  TEXT    NOT NULL DEFAULT '[]',
          image_prompt  TEXT    NOT NULL DEFAULT '',
          motion_prompt TEXT    NOT NULL DEFAULT '',
          line          TEXT    NOT NULL DEFAULT '',
          image_job_id  TEXT,
          image_url     TEXT,
          clip_job_id   TEXT,
          clip_path     TEXT,
          status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'working', 'done', 'failed')),
          error         TEXT,
          UNIQUE (reel_id, position)
        );
      `);
    },
  },
  {
    id: '012-fb-pages-auto-publish',
    description: 'Facebook pages publish on their own unless told otherwise',
    up(db) {
      // 009 created pages holding for review, then upsertFbPage started
      // adding them with auto-publish on, so the pages that have been here
      // longest were the only ones still waiting to be read. The platform's
      // point is not to be asked; a page that should wait is switched off
      // under Channels -> Facebook.
      db.exec('UPDATE fb_pages SET auto_publish = 1');
    },
  },
  {
    id: '013-reels-through-buffer',
    description: 'A Buffer channel per page, and the post id a reel got back',
    up(db) {
      // Which Buffer channel a page's reels go to, when reels are published
      // through Buffer rather than straight to Graph. On the page and not in
      // settings because the routing is already per page: a niche picks a
      // page, and the page decides where its reels land.
      addColumn(db, 'fb_pages', 'buffer_channel_id', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'fb_pages', 'buffer_channel_name', "TEXT NOT NULL DEFAULT ''");

      // Buffer answers with its own post id, not a Facebook video id, and the
      // two are not interchangeable: one addresses a queued post, the other a
      // video that exists. Kept apart so a reel says which it has.
      addColumn(db, 'reels', 'buffer_post_id', 'TEXT');
    },
  },
  {
    id: '014-content-types',
    description: 'A site and a keyword each say whether they are recipes or articles',
    up(db) {
      // Two kinds of content now, written by two different pipelines and
      // posted to two different endpoints. The keyword alone says which: one
      // site serves both, so there is nothing on the site to decide.
      // Everything that exists is a recipe, which is what the default says.
      addColumn(db, 'keywords', 'content_type', "TEXT NOT NULL DEFAULT 'recipe'");

      // The niche an article is written in -- travel, DIY, health. Empty for a
      // recipe keyword, where the niche is the whole site.
      addColumn(db, 'keywords', 'niche', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '015-page-publisher',
    description: 'Each Facebook page says whether its reels go through Graph or Buffer',
    up(db) {
      // Decided per page rather than once for the whole platform. The routing
      // is already per page -- a niche picks a page -- and the two ways out
      // are not a preference but a fact about the page: some are connected to
      // a Buffer channel and some are not.
      //
      // Empty, and not 'facebook', is what "not asked yet" has to look like.
      // A page carrying an explicit answer overrides the platform default, so
      // defaulting the column to a real value would pin every existing page,
      // and every page a token brings in later, to Graph -- silently moving a
      // Buffer platform's reels on upgrade and leaving the default switch
      // with nothing to decide.
      addColumn(db, 'fb_pages', 'publisher', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '016-content-guide',
    description: 'A step-by-step guide per site, with the assistant chat for each step',
    up(db) {
      // Where each site is in the guide. One row per site, made the first time
      // the guide is opened for it. `round` counts pillars: steps 4–6 run once
      // per pillar, and the pillar itself is only chosen inside step 4, so the
      // round number is what can be known in advance.
      db.exec(`
        CREATE TABLE IF NOT EXISTS guide_sites (
          site_id      INTEGER PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
          current_step TEXT    NOT NULL DEFAULT 'identity',
          round        INTEGER NOT NULL DEFAULT 1
        );
      `);

      // What the operator settled on for each step. round = 0 for the
      // site-wide steps, so a site's identity is not asked again per pillar.
      db.exec(`
        CREATE TABLE IF NOT EXISTS guide_steps (
          site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          round       INTEGER NOT NULL DEFAULT 0,
          step_key    TEXT    NOT NULL,
          status      TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
          result_json TEXT    NOT NULL DEFAULT 'null',
          updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (site_id, round, step_key)
        );
      `);

      // The chat, kept so leaving and coming back picks up where it was --
      // the whole point for someone who gets pulled away mid-step.
      db.exec(`
        CREATE TABLE IF NOT EXISTS guide_messages (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          site_id    INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
          round      INTEGER NOT NULL DEFAULT 0,
          step_key   TEXT    NOT NULL,
          role       TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
          content    TEXT    NOT NULL,
          payload    TEXT    NOT NULL DEFAULT '{}',
          created_at TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_guide_messages ON guide_messages (site_id, round, step_key, id)',
      );
    },
  },

  {
    id: '017-new-websites',
    description: 'Websites on the new platform, kept apart from the old sites table',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS new_websites (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          name                   TEXT    NOT NULL,
          domain                 TEXT    NOT NULL UNIQUE,
          niche                  TEXT    NOT NULL,
          niche_context          TEXT    NOT NULL DEFAULT '',
          persona                TEXT    NOT NULL,
          status                 TEXT    NOT NULL DEFAULT 'paused'
                                 CHECK (status IN ('active', 'paused')),
          auto_publish           INTEGER NOT NULL DEFAULT 1 CHECK (auto_publish IN (0, 1)),
          daily_target           INTEGER NOT NULL DEFAULT 0,
          interval_minutes       INTEGER NOT NULL DEFAULT 480,
          pin_username           TEXT    NOT NULL DEFAULT '',
          project_id             TEXT    NOT NULL DEFAULT '',
          api_key_encrypted      TEXT    NOT NULL,
          buffer_token_encrypted TEXT    NOT NULL DEFAULT '',
          created_at             TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },

  {
    id: '018-keyword-plans',
    description: 'A pillar keyword and its sub-keywords, per new website',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS keyword_plans (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          website_id  INTEGER NOT NULL REFERENCES new_websites (id) ON DELETE CASCADE,
          pillar      TEXT    NOT NULL,
          created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS keyword_plan_items (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id   INTEGER NOT NULL REFERENCES keyword_plans (id) ON DELETE CASCADE,
          keyword   TEXT    NOT NULL,
          intent    TEXT    NOT NULL,
          reason    TEXT    NOT NULL DEFAULT '',
          position  INTEGER NOT NULL
        );
      `);
    },
  },

  {
    id: '019-keyword-seo',
    description: 'AI#1 metadata (title, description, focus keyword, alt text) per planned keyword',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS keyword_seo (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          plan_id       INTEGER NOT NULL REFERENCES keyword_plans (id) ON DELETE CASCADE,
          keyword       TEXT    NOT NULL,
          role          TEXT    NOT NULL CHECK (role IN ('pillar', 'sub')),
          position      INTEGER NOT NULL,
          status        TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'writing', 'done', 'failed')),
          title         TEXT    NOT NULL DEFAULT '',
          description   TEXT    NOT NULL DEFAULT '',
          focus_keyword TEXT    NOT NULL DEFAULT '',
          alt_text      TEXT    NOT NULL DEFAULT '',
          eeat          TEXT    NOT NULL DEFAULT '',
          confidence    TEXT    NOT NULL DEFAULT '',
          reasoning     TEXT    NOT NULL DEFAULT '',
          problems      TEXT    NOT NULL DEFAULT '',
          updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );
      `);
    },
  },

  {
    id: '020-keyword-skeleton',
    description: 'AI#2 article skeleton per planned keyword, made after its AI#1 metadata',
    up(db) {
      // '' = not started: it becomes 'pending' when the keyword's metadata is done.
      addColumn(db, 'keyword_seo', 'skeleton_status', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'article_type', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'skeleton_json', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'skeleton_problems', "TEXT NOT NULL DEFAULT ''");
    },
  },

  {
    id: '021-keyword-recipe',
    description: 'The fixed recipe per keyword on recipe websites, made before the skeleton',
    up(db) {
      // '' = not a recipe website, or not started yet.
      addColumn(db, 'keyword_seo', 'recipe_status', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'recipe_json', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'recipe_problems', "TEXT NOT NULL DEFAULT ''");
    },
  },

  {
    id: '022-page-kind',
    description: 'Whether each planned keyword is a recipe page or an article page',
    up(db) {
      // 'recipe' keeps what plans saved before this did: every keyword had a recipe.
      addColumn(db, 'keyword_plans', 'pillar_page', "TEXT NOT NULL DEFAULT 'recipe'");
      addColumn(db, 'keyword_plan_items', 'page', "TEXT NOT NULL DEFAULT 'recipe'");
      addColumn(db, 'keyword_seo', 'page', "TEXT NOT NULL DEFAULT 'recipe'");
    },
  },

  {
    id: '023-keyword-article',
    description: 'AI#3: the written article per planned keyword, made from its skeleton',
    up(db) {
      addColumn(db, 'keyword_seo', 'article_status', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'article_md', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'article_words', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'keyword_seo', 'article_problems', "TEXT NOT NULL DEFAULT ''");
    },
  },

  {
    id: '024-keyword-images',
    description: 'AI#4: the visual theme and image prompts per planned keyword, made from its article',
    up(db) {
      addColumn(db, 'keyword_seo', 'images_status', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'images_json', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'images_problems', "TEXT NOT NULL DEFAULT ''");
    },
  },

  {
    id: '025-newsite-pictures',
    description: 'The pictures made by Google Flow from each keyword\'s image prompts, one row per picture',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS newsite_pictures (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          seo_id     INTEGER NOT NULL REFERENCES keyword_seo (id) ON DELETE CASCADE,
          slot       TEXT    NOT NULL,
          position   INTEGER NOT NULL DEFAULT 0,
          prompt     TEXT    NOT NULL,
          alt        TEXT    NOT NULL DEFAULT '',
          status     TEXT    NOT NULL DEFAULT 'queued',
          attempts   INTEGER NOT NULL DEFAULT 0,
          error      TEXT    NOT NULL DEFAULT '',
          file       TEXT    NOT NULL DEFAULT '',
          made_at    TEXT,
          UNIQUE (seo_id, slot)
        );
        CREATE INDEX IF NOT EXISTS newsite_pictures_status ON newsite_pictures (status, id);
      `);
    },
  },

  {
    id: '026-newsite-publish',
    description: 'Each planned keyword\'s post on its website, and each picture\'s copy in its media library',
    up(db) {
      addColumn(db, 'keyword_seo', 'post_status', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'post_id', 'INTEGER');
      addColumn(db, 'keyword_seo', 'post_url', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'post_state', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'post_error', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'posted_at', 'TEXT');
      addColumn(db, 'newsite_pictures', 'media_id', 'INTEGER');
    },
  },

  {
    id: '027-newsite-post-category',
    description: 'The website category the AI picked for each published article',
    up(db) {
      addColumn(db, 'keyword_seo', 'post_category', "TEXT NOT NULL DEFAULT ''");
    },
  },

  {
    id: '028-newsite-auto-retries',
    description: 'Automatic retries of the AI steps: tries so far per step, and when the next one is due',
    up(db) {
      addColumn(db, 'keyword_seo', 'retries_json', "TEXT NOT NULL DEFAULT '{}'");
      addColumn(db, 'keyword_seo', 'retry_step', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_seo', 'retry_at', 'INTEGER');
    },
  },

  {
    id: '029-newsite-channels',
    description: 'Social channels of the new dashboard, the websites that post to each, and every social post',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS newsite_channels (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          platform             TEXT    NOT NULL,
          name                 TEXT    NOT NULL DEFAULT '',
          -- Pinterest: the Buffer account and the Pinterest channel in it.
          buffer_token_enc     TEXT    NOT NULL DEFAULT '',
          buffer_channel_id    TEXT    NOT NULL DEFAULT '',
          -- Facebook: the business token and the page it posts to.
          fb_token_enc         TEXT    NOT NULL DEFAULT '',
          fb_page_id           TEXT    NOT NULL DEFAULT '',
          paid_buffer          INTEGER NOT NULL DEFAULT 0,
          post_image           INTEGER NOT NULL DEFAULT 1,
          post_reel            INTEGER NOT NULL DEFAULT 0,
          multi_website        INTEGER NOT NULL DEFAULT 0,
          next_template        INTEGER NOT NULL DEFAULT 0,
          created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS newsite_website_channels (
          website_id INTEGER NOT NULL REFERENCES new_websites (id) ON DELETE CASCADE,
          channel_id INTEGER NOT NULL REFERENCES newsite_channels (id) ON DELETE CASCADE,
          PRIMARY KEY (website_id, channel_id)
        );

        CREATE TABLE IF NOT EXISTS newsite_social_posts (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          seo_id       INTEGER NOT NULL REFERENCES keyword_seo (id) ON DELETE CASCADE,
          channel_id   INTEGER NOT NULL REFERENCES newsite_channels (id) ON DELETE CASCADE,
          kind         TEXT    NOT NULL,
          -- pending: to work on; picture: waiting for its picture; waiting: the
          -- channel is full, tried again at retry_at; sent; failed.
          status       TEXT    NOT NULL DEFAULT 'pending',
          template     INTEGER NOT NULL DEFAULT 0,
          title        TEXT    NOT NULL DEFAULT '',
          text         TEXT    NOT NULL DEFAULT '',
          alt          TEXT    NOT NULL DEFAULT '',
          overlay      TEXT    NOT NULL DEFAULT '',
          board_name   TEXT    NOT NULL DEFAULT '',
          picture_id   INTEGER,
          external_id  TEXT    NOT NULL DEFAULT '',
          comment_id   TEXT    NOT NULL DEFAULT '',
          error        TEXT    NOT NULL DEFAULT '',
          retry_at     INTEGER,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          sent_at      TEXT,
          UNIQUE (seo_id, channel_id, kind)
        );
        CREATE INDEX IF NOT EXISTS newsite_social_posts_status ON newsite_social_posts (status, id);
      `);
    },
  },

  {
    id: '030-newsite-channel-via',
    description: 'How each channel posts: through Buffer or through the platform API, kept apart',
    up(db) {
      addColumn(db, 'newsite_channels', 'via', "TEXT NOT NULL DEFAULT ''");
      // Until now Pinterest only went through Buffer and Facebook only through its API.
      db.exec(`UPDATE newsite_channels SET via = CASE platform WHEN 'pinterest' THEN 'buffer' ELSE 'api' END WHERE via = ''`);
    },
  },

  {
    id: '031-newsite-social-fields',
    description: 'Each social post keeps every field its platform rules asked for, and when Buffer will post it',
    up(db) {
      addColumn(db, 'newsite_social_posts', 'fields_json', "TEXT NOT NULL DEFAULT '{}'");
      addColumn(db, 'newsite_social_posts', 'due_at', "TEXT NOT NULL DEFAULT ''");
      // A social picture's shape comes from its platform's rules file.
      addColumn(db, 'newsite_pictures', 'shape', "TEXT NOT NULL DEFAULT ''");
      // A post's kind is now its platform: the rules file of that name runs it.
      db.exec(`UPDATE newsite_social_posts SET kind = 'pinterest' WHERE kind = 'pin'`);
      db.exec(`UPDATE newsite_social_posts SET kind = 'facebook' WHERE kind = 'fb_image'`);
      // Posts held for an approval that no longer exists go back to work.
      db.exec(`UPDATE newsite_social_posts SET status = 'pending', error = '' WHERE status = 'held'`);
    },
  },

  {
    id: '032-newsite-channel-rules',
    description: 'Each channel keeps its own rules, edited on its page',
    up(db) {
      // Empty means "the platform's default rules" until the owner saves the channel's own.
      addColumn(db, 'newsite_channels', 'rules_text', "TEXT NOT NULL DEFAULT ''");
    },
  },

  {
    id: '033-keyword-plan-import',
    description: 'Keyword plans keep a niche of their own and whether their sub-keywords are still being found (CSV import)',
    up(db) {
      addColumn(db, 'keyword_plans', 'niche', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_plans', 'source', "TEXT NOT NULL DEFAULT ''");
      // '' = has its sub-keywords; 'finding' = the platform is finding them; 'failed' = it could not.
      addColumn(db, 'keyword_plans', 'subs_status', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'keyword_plans', 'subs_error', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '034-newsite-reels',
    description: 'New websites: one reel video per published article and platform, made in Google Flow from one prompt',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS newsite_reels (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          seo_id     INTEGER NOT NULL REFERENCES keyword_seo(id) ON DELETE CASCADE,
          platform   TEXT NOT NULL,
          prompt     TEXT NOT NULL DEFAULT '',
          -- pending -> making -> done | failed
          status     TEXT NOT NULL DEFAULT 'pending',
          job_id     TEXT NOT NULL DEFAULT '',
          file       TEXT NOT NULL DEFAULT '',
          error      TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          done_at    TEXT,
          UNIQUE (seo_id, platform)
        );
      `);
    },
  },
  {
    id: '035-newsite-reel-hook',
    description: 'New websites: a reel keeps the hook and closing lines its prompt was written with',
    up(db) {
      addColumn(db, 'newsite_reels', 'hook', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'newsite_reels', 'closing', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '036-newsite-reel-shares',
    description: 'New websites: each made reel shared on its website channels of that platform, one share per reel and channel',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS newsite_reel_shares (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          reel_id     INTEGER NOT NULL REFERENCES newsite_reels(id) ON DELETE CASCADE,
          channel_id  INTEGER NOT NULL REFERENCES newsite_channels(id) ON DELETE CASCADE,
          -- pending -> sent | failed; waiting = a full Buffer queue, tried again at retry_at
          status      TEXT NOT NULL DEFAULT 'pending',
          text        TEXT NOT NULL DEFAULT '',
          title       TEXT NOT NULL DEFAULT '',
          board_name  TEXT NOT NULL DEFAULT '',
          external_id TEXT NOT NULL DEFAULT '',
          comment_id  TEXT NOT NULL DEFAULT '',
          error       TEXT NOT NULL DEFAULT '',
          retry_at    INTEGER,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          sent_at     TEXT,
          UNIQUE (reel_id, channel_id)
        );
      `);
    },
  },
  {
    id: '037-newsite-post-links',
    description: 'New websites: the address of each shared post on its platform, once it is out',
    up(db) {
      addColumn(db, 'newsite_social_posts', 'post_link', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'newsite_reel_shares', 'post_link', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '038-newsite-website-channel-content',
    description: 'New websites: each website decides what it sends to each of its channels (image posts, reels), starting from the channel’s own choice',
    up(db) {
      addColumn(db, 'newsite_website_channels', 'post_image', 'INTEGER NOT NULL DEFAULT 1');
      addColumn(db, 'newsite_website_channels', 'post_reel', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(`
        UPDATE newsite_website_channels SET
          post_image = COALESCE((SELECT c.post_image FROM newsite_channels c WHERE c.id = channel_id), 1),
          post_reel  = COALESCE((SELECT c.post_reel  FROM newsite_channels c WHERE c.id = channel_id), 0);
      `);
    },
  },
  {
    id: '039-newsite-api-accounts',
    description: 'New websites: Instagram and Threads through their own APIs (the account posted to, and when a Threads token runs out)',
    up(db) {
      addColumn(db, 'newsite_channels', 'api_account_id', "TEXT NOT NULL DEFAULT ''");
      addColumn(db, 'newsite_channels', 'token_expires_at', 'INTEGER');
    },
  },
  {
    id: '040-newsite-comment-tries',
    description: 'New websites: how often the first comment was tried on a post Buffer sent (it stops after a few)',
    up(db) {
      addColumn(db, 'newsite_social_posts', 'comment_tries', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(db, 'newsite_reel_shares', 'comment_tries', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '041-newsite-pin-designs',
    description: 'New websites: Pinterest pin designs (the four shipped ones and any added on the dashboard) and which ones pins are made from',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS newsite_pin_designs (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          name       TEXT NOT NULL,
          -- A shipped design reads its prompt file (edits through the Prompts store); an added one keeps its text in body.
          file       TEXT NOT NULL DEFAULT '',
          body       TEXT NOT NULL DEFAULT '',
          picked     INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO newsite_pin_designs (name, file)
          SELECT 'Design ' || n, 'newsite-pin-' || n || '.template.txt'
            FROM (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4)
           WHERE NOT EXISTS (SELECT 1 FROM newsite_pin_designs);
      `);
    },
  },
  {
    id: '042-newsite-autopilot',
    description: 'New websites: Autopilot, which makes pictures and publishes by the posts per day and gap without anyone pressing a button',
    up(db) {
      addColumn(db, 'new_websites', 'autopilot', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '043-newsite-generate-now',
    description: 'New websites: Generate now, one chosen keyword written, pictured and published ahead of the rest',
    up(db) {
      addColumn(db, 'keyword_seo', 'generate_now', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '044-newsite-language',
    description: 'New websites: the language each website writes in',
    up(db) {
      addColumn(db, 'new_websites', 'language', "TEXT NOT NULL DEFAULT 'English'");
    },
  },
  {
    id: '045-newsite-one-keyword-at-a-time',
    description: 'New websites: Automation works on one keyword at a time, and keeps a history of what it did',
    up(db) {
      addColumn(db, 'keyword_seo', 'auto_active', 'INTEGER NOT NULL DEFAULT 0');
      db.exec(`
        CREATE TABLE IF NOT EXISTS newsite_automation_log (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          at     TEXT NOT NULL DEFAULT (datetime('now')),
          seo_id INTEGER NOT NULL,
          event  TEXT NOT NULL,
          note   TEXT NOT NULL DEFAULT ''
        );
      `);
    },
  },
  {
    id: '046-newsite-csv-subs-topup',
    description: 'New websites: CSV keywords saved with fewer than six sub-keywords go back to the finder, which adds similar ones up to six',
    up(db) {
      db.exec(`
        UPDATE keyword_plans SET subs_status = 'finding', subs_error = ''
         WHERE source = 'csv' AND subs_status IN ('', 'failed')
           AND (SELECT COUNT(*) FROM keyword_plan_items i WHERE i.plan_id = keyword_plans.id) < 6
      `);
    },
  },
  {
    id: '047-newsite-pictures-by-hand',
    description: 'New websites: pictures someone asked for are marked, so Automation never makes another keyword’s pictures ahead of its turn',
    up(db) {
      addColumn(db, 'newsite_pictures', 'by_hand', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    id: '048-newsite-picture-style',
    description: 'New websites: a picture style of their own, so each niche gets photos that fit it (a pet website never gets food photos)',
    up(db) {
      addColumn(db, 'new_websites', 'picture_style', "TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    id: '049-newsite-category-intros',
    description: 'New websites: when each category intro was written and which pillars it covers, so it is rewritten only for a new pillar, at most once in 30 days',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS newsite_category_intros (
          website_id INTEGER NOT NULL,
          category   TEXT NOT NULL,
          written_at TEXT NOT NULL,
          pillar_ids TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY (website_id, category)
        );
      `);
    },
  },
];

/* -- The runner ----------------------------------------------------------- */

function ensureLedger(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function appliedMigrations(db: Db): string[] {
  ensureLedger(db);
  const rows = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[];
  return rows.map((r) => r.id);
}

/** Migrations that would run against this database, in order. */
export function pendingMigrations(db: Db): Migration[] {
  const applied = new Set(appliedMigrations(db));
  return MIGRATIONS.filter((m) => !applied.has(m.id));
}

export interface MigrationReport {
  applied: string[];
  alreadyApplied: number;
}

/**
 * Bring the database up to date.
 *
 * Each migration is its own transaction: one that throws rolls back and is not
 * recorded, so the next boot retries exactly that one rather than skipping it
 * or re-running the ones that already succeeded. The error is rethrown — a
 * process that carries on against a half-migrated schema fails later, somewhere
 * less obvious, with a message about a missing column.
 */
export function runMigrations(db: Db): MigrationReport {
  const applied = new Set(appliedMigrations(db));
  const done: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    db.exec('BEGIN');
    try {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(migration.id);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* rolling back a transaction that already failed */
      }
      log.error(`migration ${migration.id} failed: ${String(err)}`);
      throw err;
    }

    log.info(`applied ${migration.id} — ${migration.description}`);
    done.push(migration.id);
  }

  return { applied: done, alreadyApplied: applied.size };
}
