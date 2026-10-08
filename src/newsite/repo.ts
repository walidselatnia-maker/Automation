import { all, fromBool, get, run } from '../db/index.js';
import { encrypt } from '../lib/crypto.js';
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

export const deleteNewWebsite = (id: number): void => {
  run('DELETE FROM new_websites WHERE id = ?', id);
};
