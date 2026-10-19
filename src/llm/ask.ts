import { chat, type ChatResult } from './client.js';
import { loadPrompt, modelFor, PROMPT_MODELS } from '../pipeline/prompts.js';
import type { Settings } from '../settings.js';

/**
 * Send one named prompt to the model it is assigned to.
 *
 * The pipeline context does this per step and adds the tokens to the step's
 * bill; the reel engine has no step to bill and calls this directly. One
 * implementation, so an override on the Prompts page reaches both.
 */
export async function askPrompt(
  settings: Settings,
  encryptionKey: Buffer,
  promptName: string,
  variables: Record<string, unknown>,
  overrides: { model?: string; format?: 'json' | null } = {},
): Promise<ChatResult> {
  const spec = PROMPT_MODELS[promptName];
  const loaded = loadPrompt(promptName, variables);
  const language = typeof variables.language === 'string' ? variables.language : '';
  const system = loaded.system + languageRule(promptName, language);
  const { user } = loaded;

  const messages = system.trim()
    ? [
        { role: 'system' as const, content: system },
        { role: 'user' as const, content: user },
      ]
    : [{ role: 'user' as const, content: user }];

  return chat(
    {
      // modelFor applies any override set on the Prompts page; the shipped
      // default underneath it is still PROMPT_MODELS.
      model: overrides.model ?? modelFor(promptName),
      messages,
      format: overrides.format !== undefined ? overrides.format : (spec?.format ?? null),
    },
    encryptionKey,
    settings.get('llm_base_url'),
  );
}

/**
 * A website that writes in another language: one rule added to the prompt's
 * instructions, so the same prompts (and their edits on the Prompts page) serve
 * every language. Picture prompts stay English, Google Flow reads it best.
 */
export function languageRule(promptName: string, language: string): string {
  if (!language || language === 'English') return '';
  const pictures = promptName === 'article-images' || promptName === 'newsite-reel-prompt';
  return (
    `\n\nLANGUAGE: this website is written in ${language}. ` +
    (pictures
      ? `Write the picture or video prompts and the theme in English, so the picture maker understands them; write every alt text, caption and on-screen text in ${language}.`
      : `Write every word a reader sees in ${language}: titles, descriptions, headings, text, recipe, alt text, captions and hashtags. A slug uses only lower-case Latin letters, digits and hyphens (transliterate if needed). A field that only describes a picture for the picture maker (like scene or detail) stays in English.`) +
    ' Keep the JSON keys and fixed values (like "pillar", "easy", "Expertise") exactly as asked, in English. Rules above that give English examples or word lists apply to the ' +
    `${language} text in the same way.`
  );
}
