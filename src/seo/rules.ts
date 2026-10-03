/**
 * The platform's SEO rules, as code.
 *
 * Google gives no hard limits for titles or descriptions -- only "unique,
 * descriptive, readable, not stuffed". The numbers here are stricter on
 * purpose: 60 and 160 characters are where search results *cut text off*
 * (display limits, not Google rules), and the rest turn "don't stuff keywords"
 * and "write something different for every page" into things a program can
 * check. Every check returns plain-English problems, so the same text can be
 * shown to a model that must fix them.
 */

export const TITLE_MAX = 60;
export const TITLE_MIN = 15;
export const DESCRIPTION_MIN = 70;
export const DESCRIPTION_MAX = 160;
export const SLUG_MAX_WORDS = 6;
export const SLUG_MAX_CHARS = 60;
export const ALT_MIN = 10;
export const ALT_MAX = 125;
/** At or above this word overlap, two texts read as the same page. */
export const SIMILAR_AT = 0.75;

export interface CheckContext {
  /** The phrase the page should be found for. */
  keyword: string;
  /** Texts already in use on the site (titles, descriptions or slugs). */
  others?: string[];
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'for', 'with', 'to', 'in', 'on', 'at', 'or',
  'is', 'it', 'this', 'that', 'your', 'my', 'you', 'we', 'will', 'are', 'be',
]);

const clean = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Lower-case, accent-free text with apostrophes removed, so "Mom's" is "moms" and "Jalapeño" is "jalapeno". */
const normalise = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/['‘’]/g, '')
    .toLowerCase();

/** Lower-case content words, so "Thighs" and "thigh" count as the same word. */
export function words(text: string): string[] {
  return normalise(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

/** Share of words two texts have in common, 0 (nothing) to 1 (same words). */
export function similarity(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return shared / (left.size + right.size - shared);
}

// The platform's existing content rules (the spy-validation prompt), not new
// policy. Turkey/beef bacon and ham and wine vinegar are the sanctioned
// substitutes and so are allowed.
const RESTRICTED: RegExp[] = [
  /\bvalentine(?:['’]?s)?\b|\b(?:christmas|thanksgiving|halloween|easter)\b/gi,
  /\b(?:porks?|prosciuttos?|pancettas?|lards?)\b|(?<!turkey )(?<!beef )\b(?:bacons?|hams?)\b/gi,
  /(?<!root )(?<!ginger )\bbeers?\b|\b(?:vodkas?|whiskeys?|whiskies|whisky|bourbons?|brandy|brandies|liqueurs?|tequilas?|champagnes?)\b|\brums?\b(?! extract)|\bwines?\b(?! vinegar)/gi,
];

export function restrictedWords(text: string): string[] {
  const found: string[] = [];
  for (const pattern of RESTRICTED) {
    for (const match of text.matchAll(pattern)) found.push(match[0]);
  }
  return found;
}

function tooSimilar(text: string, others: string[] | undefined): string | null {
  for (const other of others ?? []) {
    if (similarity(text, other) >= SIMILAR_AT) return other;
  }
  return null;
}

const missingWords = (keyword: string, text: string): string[] => {
  const have = new Set(words(text));
  return words(keyword).filter((w) => !have.has(w));
};

export function checkTitle(title: string, ctx: CheckContext): string[] {
  const text = clean(title);
  const problems: string[] = [];

  if (text.length > TITLE_MAX) {
    problems.push(`The title is ${text.length} characters; keep it to ${TITLE_MAX} or fewer so it is not cut off.`);
  }
  if (text.length < TITLE_MIN) {
    problems.push(`The title is only ${text.length} characters; say what the dish is (at least ${TITLE_MIN}).`);
  }

  const missing = missingWords(ctx.keyword, text);
  if (missing.length) {
    problems.push(`The title is missing the keyword words: ${missing.join(', ')}.`);
  } else {
    const first = words(ctx.keyword)[0];
    if (first && normalise(text).indexOf(first) > 40) {
      problems.push('Put the keyword nearer the start of the title.');
    }
  }

  const counts = new Map<string, number>();
  for (const w of words(text)) counts.set(w, (counts.get(w) ?? 0) + 1);
  for (const [w, n] of counts) {
    if (n > 2) problems.push(`The word "${w}" is repeated ${n} times; that reads as stuffing.`);
  }

  if (text.includes('|') || (text.match(/,/g) ?? []).length >= 2) {
    problems.push('The title reads like a keyword list; write it as a normal title.');
  }

  const letters = text.replace(/[^a-z]/gi, '');
  if (letters.length >= 5 && text === text.toUpperCase()) {
    problems.push('The title is all capitals; use normal title case.');
  }

  for (const word of restrictedWords(text)) {
    problems.push(`The title contains "${word}", which this site does not publish.`);
  }

  const twin = tooSimilar(text, ctx.others);
  if (twin) problems.push(`The title is too similar to another title on the site: "${twin}".`);

  return problems;
}

export function checkDescription(description: string, ctx: CheckContext): string[] {
  const text = clean(description);
  const problems: string[] = [];

  if (text.length < DESCRIPTION_MIN || text.length > DESCRIPTION_MAX) {
    problems.push(
      `The description is ${text.length} characters; keep it between ${DESCRIPTION_MIN} and ${DESCRIPTION_MAX}.`,
    );
  }
  if (!/[.!?]$/.test(text)) {
    problems.push('Write the description as a sentence that ends with a full stop, ! or ?.');
  }

  const missing = missingWords(ctx.keyword, text);
  if (missing.length) {
    problems.push(`The description is missing the keyword words: ${missing.join(', ')}.`);
  }
  const phrase = normalise(clean(ctx.keyword));
  if (phrase && normalise(text).split(phrase).length - 1 > 1) {
    problems.push('Use the keyword phrase once, naturally, not repeated.');
  }

  if (text.includes('|') || (text.match(/,/g) ?? []).length > 3) {
    problems.push('The description reads like a list; write it as a sentence a person would say.');
  }

  for (const word of restrictedWords(text)) {
    problems.push(`The description contains "${word}", which this site does not publish.`);
  }

  const twin = tooSimilar(text, ctx.others);
  if (twin) problems.push('The description is too similar to another description on the site.');

  return problems;
}

export function checkSlug(slug: string, ctx: CheckContext): string[] {
  const problems: string[] = [];

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    problems.push('The slug may only use lower-case letters, numbers and single dashes.');
  }
  const parts = slug.split('-').filter(Boolean);
  if (parts.length > SLUG_MAX_WORDS || slug.length > SLUG_MAX_CHARS) {
    problems.push(`Keep the slug to ${SLUG_MAX_WORDS} words and ${SLUG_MAX_CHARS} characters.`);
  }
  if (parts.some((p) => /^(?:19|20)\d{2}$/.test(p))) {
    problems.push('Leave the year out of the slug so it does not date the page.');
  }

  const missing = missingWords(ctx.keyword, slug.replace(/-/g, ' '));
  if (missing.length) problems.push(`The slug is missing the keyword words: ${missing.join(', ')}.`);

  if ((ctx.others ?? []).includes(slug)) problems.push('Another page already has this slug.');

  return problems;
}

export function checkFocusKeyword(keyword: string): string[] {
  const count = clean(keyword).split(' ').filter(Boolean).length;
  return count >= 3 ? [] : [`The focus keyword is ${count} word(s); a long-tail keyword has 3 or more.`];
}

export function checkAlt(alt: string): string[] {
  const text = clean(alt);
  if (text.length < ALT_MIN || text.length > ALT_MAX) {
    return [`The alt text is ${text.length} characters; describe the picture in ${ALT_MIN} to ${ALT_MAX}.`];
  }
  return [];
}

/** The rules above, as text for a prompt, so the model is told what will be checked. */
export function rulesPrompt(): string {
  return [
    'SEO RULES (your answer is checked by a program against these):',
    `- Title: ${TITLE_MIN}-${TITLE_MAX} characters, includes every word of the keyword with the keyword near the start, no word used more than twice, no lists or "|", normal title case, different from every other title.`,
    `- Description: ${DESCRIPTION_MIN}-${DESCRIPTION_MAX} characters, one natural sentence that ends with a full stop, includes the keyword once, no lists, different from every other description. Say what the page really delivers.`,
    `- Slug: lower-case words joined by single dashes, at most ${SLUG_MAX_WORDS} words, includes the keyword words, no year.`,
    '- Never stuff keywords. Write for the person searching, not for a robot.',
    '- No pork, no alcohol, no holiday words (Christmas, Thanksgiving, Valentine\'s, Easter, Halloween).',
  ].join('\n');
}
