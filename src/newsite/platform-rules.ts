import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promptsDirectory, readShippedPrompt } from '../pipeline/prompts.js';

/**
 * Each social platform's rules, kept as a data file: prompts/platforms/<name>.md.
 *
 * The platform finds every file in that folder by itself and reads it fresh
 * each time a post is made, so editing a file changes what the next post does,
 * removing it stops that platform, and adding one (for a platform Buffer
 * posts to) connects it to the Sharing phase. Nothing about a platform's
 * content lives in the code.
 *
 * A file has a short header between two "---" lines that tells the engine
 * how to run it, then the rules themselves, which the AI is given whole:
 *
 *   ---
 *   platform: pinterest           the channel's platform (and Buffer's service name)
 *   label: Pinterest
 *   post_label: Pin               what one post is called on the pages
 *   fields: headline, cta, title, description, alt
 *   post_text: description        the field that is the post's text
 *   alt_field: alt                the field that describes the picture (optional)
 *   picture_shape: PORTRAIT_3_4   PORTRAIT_3_4 or HORIZONTAL
 *   picture_templates: newsite-pin-1.template.txt, newsite-pin-2.template.txt
 *   link: pin_link                pin_link, first_comment or none
 *   ---
 *
 * and a "## Limits" part the checks read, one "- name: min-max" per line:
 * <field>_chars, <field>_words, <field>_emoji, <field>_hashtags,
 * <field>_exclamations. The link rule (no link or web address in any field)
 * is checked always.
 */

export type LinkMode = 'pin_link' | 'first_comment' | 'none';
export type PictureShape = 'PORTRAIT_9_16' | 'PORTRAIT_3_4' | 'HORIZONTAL';

export interface PlatformRules {
  platform: string;
  label: string;
  postLabel: string;
  fields: string[];
  postText: string;
  altField: string;
  pictureShape: PictureShape;
  pictureTemplates: string[];
  link: LinkMode;
  /** The whole file without its header, as given to the AI. */
  text: string;
  /** From the Limits part: name -> [min, max]. */
  limits: Record<string, [number, number]>;
  file: string;
}

/** A rules file and what is wrong with it, if anything. */
export interface RulesCheck {
  platform: string;
  file: string;
  rules: PlatformRules | null;
  errors: string[];
}

const SHAPES: PictureShape[] = ['PORTRAIT_9_16', 'PORTRAIT_3_4', 'HORIZONTAL'];
const LINKS: LinkMode[] = ['pin_link', 'first_comment', 'none'];
const MEASURES = ['chars', 'words', 'emoji', 'hashtags', 'exclamations'];

const rulesFolder = (): string => join(promptsDirectory(), 'platforms');

/** Read the "- name: min-max" lines under "## Limits". */
export function parseLimits(text: string): Record<string, [number, number]> {
  const limits: Record<string, [number, number]> = {};
  const part = text.split(/^##\s+Limits\s*$/m)[1]?.split(/^##\s/m)[0] ?? '';
  for (const m of part.matchAll(/^-\s*([a-z_]+)\s*:\s*(\d+)\s*-\s*(\d+)\s*$/gm)) {
    limits[m[1]!] = [Number(m[2]), Number(m[3])];
  }
  return limits;
}

const list = (v: string | undefined): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Read and check one rules file's text. Every problem is reported, none is skipped. */
export function parseRules(platformFromName: string, raw: string, file = `platforms/${platformFromName}.md`): RulesCheck {
  const text = raw.replace(/\r\n/g, '\n');
  const errors: string[] = [];
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) {
    return { platform: platformFromName, file, rules: null, errors: ['The file must start with a header between two "---" lines (platform, fields, post_text, picture_shape, picture_templates, link).'] };
  }
  const head: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^\s*([a-z_]+)\s*:\s*(.*?)\s*(#.*)?$/.exec(line);
    if (kv) head[kv[1]!] = kv[2]!;
    else if (line.trim()) errors.push(`Header line not understood: "${line.trim()}". Write it as name: value.`);
  }
  const body = text.slice(m[0].length);
  const platform = head.platform ?? '';
  if (!platform) errors.push('The header needs "platform:" (the channel platform, like pinterest).');
  else if (platform !== platformFromName) errors.push(`The header says platform "${platform}" but the file is named ${platformFromName}.md. Make them the same.`);

  const fields = list(head.fields);
  if (!fields.length) errors.push('The header needs "fields:" (the words the AI writes, like headline, title, description, alt).');
  for (const f of fields) if (!/^[a-z_]+$/.test(f)) errors.push(`Field "${f}" must be lowercase letters and underscores.`);
  const postText = head.post_text ?? '';
  if (!postText) errors.push('The header needs "post_text:" (which field is the post\'s text).');
  else if (!fields.includes(postText)) errors.push(`post_text "${postText}" is not one of the fields (${fields.join(', ')}).`);
  const altField = head.alt_field ?? '';
  if (altField && !fields.includes(altField)) errors.push(`alt_field "${altField}" is not one of the fields (${fields.join(', ')}).`);

  const pictureShape = (head.picture_shape ?? '') as PictureShape;
  if (!SHAPES.includes(pictureShape)) errors.push(`picture_shape must be one of ${SHAPES.join(', ')}.`);
  const pictureTemplates = list(head.picture_templates);
  if (!pictureTemplates.length) errors.push('The header needs "picture_templates:" (one or more picture prompt files in prompts/).');
  for (const t of pictureTemplates) if (!readShippedPrompt(t).trim()) errors.push(`Picture template "${t}" is not in the prompts folder.`);

  const link = (head.link ?? '') as LinkMode;
  if (!LINKS.includes(link)) errors.push(`link must be one of ${LINKS.join(', ')}.`);

  const limits = parseLimits(body);
  for (const [name, [min, max]] of Object.entries(limits)) {
    const measure = MEASURES.find((x) => name.endsWith(`_${x}`));
    const field = measure ? name.slice(0, -(measure.length + 1)) : '';
    if (!measure || !fields.includes(field)) {
      errors.push(`Limit "${name}" is not <field>_${MEASURES.join('|')} for one of the fields (${fields.join(', ')}).`);
    }
    if (min > max) errors.push(`Limit "${name}" goes from ${min} to ${max}; the first number must be the smaller.`);
  }
  if (!body.trim()) errors.push('The file has no rules after its header.');

  const rules: PlatformRules = {
    platform: platformFromName,
    label: head.label || platformFromName,
    postLabel: head.post_label || 'Post',
    fields,
    postText,
    altField,
    pictureShape,
    pictureTemplates,
    link,
    text: body.trim(),
    limits,
    file,
  };
  return { platform: platformFromName, file, rules: errors.length ? null : rules, errors };
}

/** Every rules file in prompts/platforms/, checked. */
export function listPlatformRules(): RulesCheck[] {
  const dir = rulesFolder();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const platform = f.slice(0, -3);
      return parseRules(platform, readShippedPrompt(`platforms/${f}`), `platforms/${f}`);
    });
}

/** One platform's rules file, checked; a missing file is an error too. */
export function checkPlatformRules(platform: string): RulesCheck {
  const raw = readShippedPrompt(`platforms/${platform}.md`);
  if (!raw.trim()) return { platform, file: `platforms/${platform}.md`, rules: null, errors: [`There is no rules file for ${platform} (prompts/platforms/${platform}.md).`] };
  return parseRules(platform, raw);
}

/** One platform's rules, or an error that says exactly what is wrong with its file. */
export function loadPlatformRules(platform: string): PlatformRules {
  const check = checkPlatformRules(platform);
  if (!check.rules) throw new Error(`The ${platform} rules file (prompts/${check.file}) has problems: ${check.errors.join(' ')}`);
  return check.rules;
}

/**
 * Starter rules for a platform that has no default file yet: a plain post and
 * a wide picture with no words, no link. The owner edits them on the
 * channel's page.
 */
export function starterRules(platform: string, label: string): string {
  return `---
platform: ${platform}
label: ${label}
post_label: Post
fields: text, alt
post_text: text
alt_field: alt
picture_shape: HORIZONTAL
picture_templates: newsite-social-1.template.txt
link: none
---
# ${label} rules

These rules decide what is made for this ${label} channel after an article is
published. Everything comes from that article: its keyword, title, headings and
text. Nothing is added that the article does not say.

## The post

- One short post per article, written for ${label}, in plain friendly words.
- Start with something specific from the article that makes people stop.
- Never a link, a web address or a domain name in the post.
- Stay true to the article: no fact, claim or number it does not have.
- Alt text: what the post picture shows, for people who cannot see it.

## The picture

- Its own picture made by Google Flow from the article's picture descriptions.
- Wide (16:9), no words, logos or watermarks.

## Limits

- text_chars: 50-500
- text_hashtags: 0-3
- alt_words: 8-20
`;
}

/** The rules a new channel starts with: its platform's default file, or the starter rules. */
export function defaultRulesText(platform: string, label = platform): string {
  const file = readShippedPrompt(`platforms/${platform}.md`);
  return file.trim() ? file.replace(/\r\n/g, '\n') : starterRules(platform, label);
}

/**
 * A channel's own rules: the text saved on its page, or (until one is saved)
 * its platform's default rules. Each channel's rules are its own.
 */
export function channelRules(channel: { platform: string; name: string; rules_text: string }): RulesCheck {
  if (channel.rules_text.trim()) return parseRules(channel.platform, channel.rules_text, `the rules of channel “${channel.name}”`);
  const file = checkPlatformRules(channel.platform);
  return file.rules || readShippedPrompt(`platforms/${channel.platform}.md`).trim()
    ? file
    : parseRules(channel.platform, starterRules(channel.platform, channel.platform), `the starter rules of channel “${channel.name}”`);
}

/** The limit, if the rules file sets one. */
export const limitOf = (rules: PlatformRules, name: string): [number, number] | undefined => rules.limits[name];
