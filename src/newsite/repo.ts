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
  persona: string;
  status: 'active' | 'paused';
  auto_publish: number;
  daily_target: number;
  interval_minutes: number;
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
       api_key_encrypted, buffer_token_encrypted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  ).lastInsertRowid;
}

/** Every setting replaced; secrets arrive already resolved (kept, new or removed). */
export function updateNewWebsite(id: number, site: CleanWebsite, key: Buffer): void {
  run(
    `UPDATE new_websites SET name = ?, domain = ?, niche = ?, niche_context = ?, persona = ?, status = ?,
       auto_publish = ?, daily_target = ?, interval_minutes = ?, pin_username = ?, project_id = ?,
       api_key_encrypted = ?, buffer_token_encrypted = ?
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
    id,
  );
}

export const deleteNewWebsite = (id: number): void => {
  run('DELETE FROM new_websites WHERE id = ?', id);
};

/* -- Keyword plans --------------------------------------------------------- */

export interface PlanItem {
  keyword: string;
  intent: string;
  reason: string;
}

export interface KeywordPlan {
  id: number;
  website_id: number;
  pillar: string;
  created_at: string;
  items: PlanItem[];
}

export function listKeywordPlans(websiteId?: number): KeywordPlan[] {
  const plans = websiteId
    ? all<Omit<KeywordPlan, 'items'>>('SELECT * FROM keyword_plans WHERE website_id = ? ORDER BY id DESC', websiteId)
    : all<Omit<KeywordPlan, 'items'>>('SELECT * FROM keyword_plans ORDER BY id DESC');
  return plans.map((plan) => ({
    ...plan,
    items: all<PlanItem>(
      'SELECT keyword, intent, reason FROM keyword_plan_items WHERE plan_id = ? ORDER BY position',
      plan.id,
    ),
  }));
}

export function saveKeywordPlan(websiteId: number, pillar: string, items: PlanItem[]): number {
  return transaction(() => {
    const id = run('INSERT INTO keyword_plans (website_id, pillar) VALUES (?, ?)', websiteId, pillar).lastInsertRowid;
    items.forEach((item, position) =>
      run(
        'INSERT INTO keyword_plan_items (plan_id, keyword, intent, reason, position) VALUES (?, ?, ?, ?, ?)',
        id,
        item.keyword,
        item.intent,
        item.reason,
        position,
      ),
    );
    return id;
  });
}

export const deleteKeywordPlan = (id: number): void => {
  run('DELETE FROM keyword_plans WHERE id = ?', id);
};
