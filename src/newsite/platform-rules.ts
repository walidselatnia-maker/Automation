import { createHash } from 'node:crypto';
import { readShippedPrompt } from '../pipeline/prompts.js';
import type { Settings } from '../settings.js';

/**
 * Each social platform's rules, kept as a data file (prompts/platforms/<name>.md),
 * never in the code: what the sharing phase makes for that platform, its words,
 * its picture and its limits.
 *
 * The whole file is given to the AI that writes the platform's content, and the
 * "## Limits" part ("- title_chars: 40-100") is what the platform checks the
 * answer against. The owner approves a rules file before anything is posted
 * with it; changing the file asks for approval again.
 */

export type RulesPlatform = 'pinterest' | 'facebook';

export interface PlatformRules {
  platform: RulesPlatform;
  /** The whole file, as given to the AI. */
  text: string;
  /** From the Limits part: name -> [min, max]. */
  limits: Record<string, [number, number]>;
  /** Changes whenever the file changes. */
  hash: string;
}

const APPROVED_KEY = (platform: RulesPlatform) => `newsite_rules_approved_${platform}`;

/** Read the "- name: min-max" lines under "## Limits". */
export function parseLimits(text: string): Record<string, [number, number]> {
  const limits: Record<string, [number, number]> = {};
  const part = text.split(/^##\s+Limits\s*$/m)[1]?.split(/^##\s/m)[0] ?? '';
  for (const m of part.matchAll(/^-\s*([a-z_]+)\s*:\s*(\d+)\s*-\s*(\d+)\s*$/gm)) {
    limits[m[1]!] = [Number(m[2]), Number(m[3])];
  }
  return limits;
}

/** The rules file as shipped in prompts/platforms/. */
export function loadPlatformRules(platform: RulesPlatform): PlatformRules {
  const text = readShippedPrompt(`platforms/${platform}.md`).replace(/\r\n/g, '\n');
  if (!text.trim()) throw new Error(`The ${platform} rules file (prompts/platforms/${platform}.md) is missing.`);
  return { platform, text, limits: parseLimits(text), hash: createHash('sha256').update(text).digest('hex').slice(0, 16) };
}

/** The limit, or the fallback when the file does not have it. */
export const limitOf = (rules: PlatformRules, name: string, fallback: [number, number]): [number, number] => rules.limits[name] ?? fallback;

/** Has the owner approved this platform's rules as they are now? */
export const rulesApproved = (rules: PlatformRules, settings: Settings): boolean => settings.get(APPROVED_KEY(rules.platform)) === rules.hash;

export const approveRules = (rules: PlatformRules, settings: Settings): void => settings.set(APPROVED_KEY(rules.platform), rules.hash);
