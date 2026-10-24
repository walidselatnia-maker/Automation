import { all, fromBool, get, run, transaction } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import type { CleanWebsite } from './validate.js';

/** A website created with the New Website wizard. The secrets stay encrypted. */
export interface NewWebsiteRow {
  id: number;
  name: string;
  domain: string;
  niche: string;
  niche_context: string;
  /** How this niche's photos look; empty means the platform decides from the niche. */
  picture_style: string;
  /** Its picture colour styles as JSON (color-styles.ts); '' = its niche's list. */
  color_styles: string;
  persona: string;
  language: string;
  status: 'active' | 'paused';
  auto_publish: number;
  daily_target: number;
  interval_minutes: number;
  /** The random gap between articles, in minutes; random_gap_to 0 = not set, the fixed gap counts. */
  random_gap_from: number;
  random_gap_to: number;
  /** The random gap between two social posts to one channel, in minutes; social_gap_to 0 = not set. */
  social_gap_from: number;
  social_gap_to: number;
  pin_username: string;
  project_id: string;
  api_key_encrypted: string;
  buffer_token_encrypted: string;
  created_at: string;
}

export const listNewWebsites = (): NewWebsiteRow[] =>
  all<NewWebsiteRow>('SELECT * FROM new_websites ORDER BY created_at DESC, id DESC');

export const getNewWebsite = (id: number): NewWebsiteRow | undefined =>
  get<NewWebsiteRow>('SELECT * FROM new_websites WHERE id = ?', id);

/** The website's API key, decrypted for one call. Never logged, never rendered. */
export function websiteApiKey(site: NewWebsiteRow, key: Buffer): string {
  try {
    return decrypt(site.api_key_encrypted, key);
  } catch {
    return '';
  }
}

export const getNewWebsiteByDomain = (domain: string): NewWebsiteRow | undefined =>
  get<NewWebsiteRow>('SELECT * FROM new_websites WHERE domain = ?', domain);

export function createNewWebsite(site: CleanWebsite, key: Buffer): number {
  return run(
    `INSERT INTO new_websites (name, domain, niche, niche_context, persona, status,
       auto_publish, daily_target, interval_minutes, pin_username, project_id,
       api_key_encrypted, buffer_token_encrypted, language, picture_style,
       random_gap_from, random_gap_to, social_gap_from, social_gap_to, color_styles)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    site.name,
    site.domain,
    site.niche,
    site.nicheContext,
    site.persona,
    site.status,
    fromBool(site.autoPublish),
    site.dailyTarget,
    site.intervalMinutes,
    site.pinUsername,
    site.projectId,
    encrypt(site.apiKey, key),
    encrypt(site.bufferToken, key),
    site.language || 'English',
    site.pictureStyle ?? '',
    site.randomGapFrom ?? 0,
    site.randomGapTo ?? 0,
    site.socialGapFrom ?? 0,
    site.socialGapTo ?? 0,
    site.colorStyles ?? '',
  ).lastInsertRowid;
}

/** Every setting replaced; secrets arrive already resolved (kept, new or removed). */
export function updateNewWebsite(id: number, site: CleanWebsite, key: Buffer): void {
  run(
    `UPDATE new_websites SET name = ?, domain = ?, niche = ?, niche_context = ?, persona = ?, status = ?,
       auto_publish = ?, daily_target = ?, interval_minutes = ?, pin_username = ?, project_id = ?,
       api_key_encrypted = ?, buffer_token_encrypted = ?, language = ?, picture_style = ?,
       random_gap_from = ?, random_gap_to = ?, social_gap_from = ?, social_gap_to = ?, color_styles = ?
     WHERE id = ?`,
    site.name,
    site.domain,
    site.niche,
    site.nicheContext,
    site.persona,
    site.status,
    fromBool(site.autoPublish),
    site.dailyTarget,
    site.intervalMinutes,
    site.pinUsername,
    site.projectId,
    encrypt(site.apiKey, key),
    encrypt(site.bufferToken, key),
    site.language || 'English',
    site.pictureStyle ?? '',
    site.randomGapFrom ?? 0,
    site.randomGapTo ?? 0,
    site.socialGapFrom ?? 0,
    site.socialGapTo ?? 0,
    site.colorStyles ?? '',
    id,
  );
}

/** The language a keyword plan's website writes in. */
export const planLanguage = (planId: number): string =>
  get<{ language: string }>('SELECT w.language FROM keyword_plans p JOIN new_websites w ON w.id = p.website_id WHERE p.id = ?', planId)?.language || 'English';

export const deleteNewWebsite = (id: number): void => {
  run('DELETE FROM new_websites WHERE id = ?', id);
};

/* -- Keyword plans --------------------------------------------------------- */

export interface PlanItem {
  keyword: string;
  intent: string;
  reason: string;
  /** 'recipe' gets a fixed recipe; 'article' does not. */
  page?: 'recipe' | 'article';
}

export interface KeywordPlan {
  id: number;
  website_id: number;
  pillar: string;
  pillar_page: 'recipe' | 'article';
  created_at: string;
  /** A niche given for this keyword (CSV import); empty means the website's niche. */
  niche: string;
  /** 'csv' when it came from an import. */
  source: string;
  /** '' = has its sub-keywords; 'finding' = being found (or more added to the CSV's own); 'failed' = could not be found. */
  subs_status: '' | 'finding' | 'failed';
  subs_error: string;
  /** Sub-keywords the owner deleted, as a JSON list: the finder never adds them back. */
  removed_json: string;
  items: PlanItem[];
}

/** The sub-keywords the owner deleted from a plan. */
export function planRemoved(plan: Pick<KeywordPlan, 'removed_json'>): string[] {
  try {
    const list: unknown = JSON.parse(plan.removed_json || '[]');
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** Remember more deleted sub-keywords for a plan. */
export function addPlanRemoved(planId: number, keywords: string[]): void {
  const plan = get<{ removed_json: string }>('SELECT removed_json FROM keyword_plans WHERE id = ?', planId);
  if (!plan || !keywords.length) return;
  const list = planRemoved(plan);
  for (const k of keywords) if (!list.some((x) => x.toLowerCase() === k.toLowerCase())) list.push(k);
  run('UPDATE keyword_plans SET removed_json = ? WHERE id = ?', JSON.stringify(list), planId);
}

/** Delete one sub-keyword of a plan, and remember it so it is never found again. Returns its SEO row ids. */
export function deletePlanItem(planId: number, keyword: string): number[] {
  return transaction(() => {
    const key = keyword.trim().toLowerCase();
    const seo = all<{ id: number }>(`SELECT id FROM keyword_seo WHERE plan_id = ? AND role = 'sub' AND lower(trim(keyword)) = ?`, planId, key).map((r) => r.id);
    run('DELETE FROM keyword_plan_items WHERE plan_id = ? AND lower(trim(keyword)) = ?', planId, key);
    for (const id of seo) run('DELETE FROM keyword_seo WHERE id = ?', id);
    addPlanRemoved(planId, [keyword.trim()]);
    return seo;
  });
}

export function listKeywordPlans(websiteId?: number): KeywordPlan[] {
  const plans = websiteId
    ? all<Omit<KeywordPlan, 'items'>>('SELECT * FROM keyword_plans WHERE website_id = ? ORDER BY id', websiteId)
    : all<Omit<KeywordPlan, 'items'>>('SELECT * FROM keyword_plans ORDER BY id');
  return plans.map((plan) => ({
    ...plan,
    items: all<PlanItem>(
      'SELECT keyword, intent, reason, page FROM keyword_plan_items WHERE plan_id = ? ORDER BY position',
      plan.id,
    ),
  }));
}

export function saveKeywordPlan(
  websiteId: number,
  pillar: string,
  items: PlanItem[],
  pillarPage: 'recipe' | 'article' = 'recipe',
): number {
  return transaction(() => {
    const id = run('INSERT INTO keyword_plans (website_id, pillar, pillar_page) VALUES (?, ?, ?)', websiteId, pillar, pillarPage).lastInsertRowid;
    items.forEach((item, position) =>
      run(
        'INSERT INTO keyword_plan_items (plan_id, keyword, intent, reason, position, page) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        item.keyword,
        item.intent,
        item.reason,
        position,
        item.page ?? 'recipe',
      ),
    );
    return id;
  });
}

/** A plan's own niche, where it came from, and whether its sub-keywords are still being found. */
export function setPlanImport(id: number, fields: { niche?: string; source?: string; subsStatus?: KeywordPlan['subs_status']; subsError?: string }): void {
  const plan = get<{ niche: string; source: string; subs_status: string; subs_error: string }>('SELECT niche, source, subs_status, subs_error FROM keyword_plans WHERE id = ?', id);
  if (!plan) return;
  run(
    'UPDATE keyword_plans SET niche = ?, source = ?, subs_status = ?, subs_error = ? WHERE id = ?',
    fields.niche ?? plan.niche,
    fields.source ?? plan.source,
    fields.subsStatus ?? plan.subs_status,
    fields.subsError ?? plan.subs_error,
    id,
  );
}

/** Add sub-keywords to a plan (after the platform found them), and set its pillar page. */
export function addPlanItems(planId: number, items: PlanItem[], pillarPage?: 'recipe' | 'article'): void {
  transaction(() => {
    const start = get<{ n: number }>('SELECT COALESCE(MAX(position) + 1, 0) AS n FROM keyword_plan_items WHERE plan_id = ?', planId)?.n ?? 0;
    items.forEach((item, i) =>
      run(
        'INSERT INTO keyword_plan_items (plan_id, keyword, intent, reason, position, page) VALUES (?, ?, ?, ?, ?, ?)',
        planId, item.keyword, item.intent, item.reason, start + i, item.page ?? 'recipe',
      ),
    );
    if (pillarPage) run('UPDATE keyword_plans SET pillar_page = ? WHERE id = ?', pillarPage, planId);
  });
}

export function getKeywordPlan(id: number): KeywordPlan | undefined {
  const plan = get<Omit<KeywordPlan, 'items'>>('SELECT * FROM keyword_plans WHERE id = ?', id);
  return plan
    ? { ...plan, items: all<PlanItem>('SELECT keyword, intent, reason, page FROM keyword_plan_items WHERE plan_id = ? ORDER BY position', id) }
    : undefined;
}

export const deleteKeywordPlan = (id: number): void => {
  run('DELETE FROM keyword_plans WHERE id = ?', id);
};
