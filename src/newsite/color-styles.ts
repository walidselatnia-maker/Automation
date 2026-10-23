import { get } from '../db/index.js';
import { articleTypeFor } from './skeleton.js';

/**
 * Each website's colour styles: the colour grading its pictures can have.
 *
 * A website starts with the list for its niche (the first two are its main
 * styles) and can change it. Before an article's pictures are made, the AI
 * picks ONE style from the list for that article (images.ts), it is kept on
 * the article, and the same style is added to every main and step picture
 * of that article when it is made (pictures.ts). Never two styles in one
 * article: a remake or a retry uses the one kept.
 */

export interface ColorStyle {
  name: string;
  description: string;
}

const list = (text: string): ColorStyle[] =>
  text.split(';').map((line) => {
    const [name, description] = line.split(' — ').map((s) => s.trim());
    return { name: name!, description: description ?? '' };
  });

/** The default lists by niche, main style first, then the second one. */
export const NICHE_COLOR_STYLES: Record<string, ColorStyle[]> = {
  recipes: list(
    'Warm & Appetizing — Warm golden highlights, rich natural colors, soft shadows; Clean & Bright — Bright neutral tones, soft daylight, minimal shadows; ' +
      'Luxury & Elegant — Deep shadows, warm highlights, rich contrast; Earthy & Organic — Warm browns, natural greens, muted earth tones; ' +
      'Rustic Vintage — Faded warm colors, nostalgic tones, subtle film grain; Rich & Dramatic — Deep blacks, amber highlights, strong contrast',
  ),
  pets: list(
    'Natural & Documentary — Realistic fur colors, natural greens, balanced saturation; Warm & Cozy — Warm highlights, soft shadows, inviting golden tones; ' +
      'Clean & Bright — Bright exposure, neutral whites, crisp natural colors; Soft & Dreamy — Pastel undertones, diffused light, gentle contrast; ' +
      'Vibrant & Playful — Bright colors, lively saturation, clean highlights; Cinematic & Emotional — Warm highlights, cool shadows, controlled contrast',
  ),
  travel: list(
    'Golden Hour — Warm amber highlights, golden sunlight, long soft shadows; Natural Documentary — Realistic landscape colors, organic tones, balanced saturation; ' +
      'Tropical Vibrant — Rich blues, vivid greens, bright highlights; Cinematic Teal & Orange — Teal shadows, warm highlights, dramatic contrast; ' +
      'Vintage Travel Film — Faded colors, warm yellows, lifted blacks, subtle grain; Cool Alpine — Crisp cool blues, clean whites, natural contrast; ' +
      'Luxury Editorial — Refined colors, deep shadows, elegant warm highlights',
  ),
  home: list(
    'Clean & Airy — Bright neutral tones, soft daylight, minimal shadows; Warm & Cozy — Warm neutrals, golden highlights, inviting atmosphere; ' +
      'Earthy & Organic — Olive greens, natural browns, muted earth tones; Luxury Interior — Rich contrast, elegant neutrals, deep shadows, warm highlights; ' +
      'Pastel Cottagecore — Soft pastels, gentle warmth, delicate contrast; Natural Documentary — Accurate material colors, realistic greens, balanced saturation; ' +
      'Moody Interior — Desaturated tones, deep shadows, subdued highlights',
  ),
  diy: list(
    'Clean & Bright — Neutral whites, bright exposure, clear colors, minimal shadows; Natural Workshop — Warm wood tones, realistic materials, balanced saturation; ' +
      'Vibrant & Creative — Bold colors, lively saturation, bright highlights; Earthy Handmade — Warm browns, muted greens, organic tones; ' +
      'Pastel Craft — Soft pastels, gentle contrast, bright neutral backgrounds; High Contrast / Detail — Defined shadows, clear material textures, strong tonal separation',
  ),
  crochet: list(
    'Soft & Dreamy — Gentle pastel tones, diffused highlights, soft contrast; Warm & Cozy — Creamy neutrals, warm golden highlights, inviting tones; ' +
      'Pastel Editorial — Soft pinks, sage greens, pale blues, balanced whites; Clean & Bright — Neutral backgrounds, accurate yarn colors, bright diffused light; ' +
      'Rustic Vintage — Faded warm tones, nostalgic colors, subtle film grain; Earthy & Organic — Terracotta, beige, olive, warm brown tones; ' +
      'Luxury Handmade — Rich colors, elegant shadows, refined contrast, detailed yarn texture',
  ),
  /** A niche none of the others fits. */
  other: list(
    'Clean & Bright — Bright neutral tones, soft daylight, crisp natural colors; Natural Documentary — Realistic colors, organic tones, balanced saturation; ' +
      'Warm & Cozy — Warm highlights, soft shadows, inviting golden tones',
  ),
};

/** Which default list a niche gets. */
export function nicheGroup(niche: string): keyof typeof NICHE_COLOR_STYLES {
  if (/crochet|knit|yarn|amigurumi|tricot|ganchillo|uncinetto|häkel/i.test(niche)) return 'crochet';
  if (/\bdiy\b|\bcrafts?\b|crafting|woodwork|handmade|\bmakers?\b|upcycl|bricolage|sewing/i.test(niche)) return 'diy';
  if (/\bpets?\b|\bdogs?\b|\bcats?\b|pupp|kitten|\banimals?\b|\bbirds?\b|parrot|aquarium|hamster|rabbit|\bhorses?\b|\bchiens?\b|\bchats?\b|\bperros?\b|\bgatos?\b/i.test(niche)) return 'pets';
  if (/travel|\btrips?\b|destination|vacation|holiday|\btour|\bhotels?\b|\bbeach|voyage|viaje|viaggi/i.test(niche)) return 'travel';
  if (articleTypeFor(niche) === 'recipe') return 'recipes';
  if (/\bhomes?\b|garden|interior|\bdecor|\bhouses?\b|\bplants?\b|\blawn|patio|maison|jardin|\bcasa\b/i.test(niche)) return 'home';
  return 'other';
}

/** One style as a line of the list: "Name — description". */
export const styleLine = (s: ColorStyle): string => (s.description ? `${s.name} — ${s.description}` : s.name);

/** The website's list as typed, one style per line: "Name — description" (a dash or a colon also separates them). */
export function parseColorStyles(text: string): ColorStyle[] {
  const seen = new Set<string>();
  const out: ColorStyle[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s*(?:—|–|\s-\s|:)\s*(.*?)\s*$/.exec(line) ?? /^\s*(.+?)\s*$/.exec(line);
    const name = (m?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, description: (m?.[2] ?? '').replace(/\s+/g, ' ').trim().slice(0, 240) });
  }
  return out;
}

/** A website's colour styles: its own list, or its niche's when it has none. */
export function colorStylesOf(site: { niche: string; color_styles?: string }): ColorStyle[] {
  try {
    const own = JSON.parse(site.color_styles || '[]') as ColorStyle[];
    if (Array.isArray(own) && own.length) return own.filter((s) => s && typeof s.name === 'string' && s.name);
  } catch {
    /* none of its own */
  }
  return NICHE_COLOR_STYLES[nicheGroup(site.niche)]!;
}

/** The style an article's pictures were given, or null. */
export function articleColorStyle(seoId: number): ColorStyle | null {
  const raw = get<{ color_style: string }>('SELECT color_style FROM keyword_seo WHERE id = ?', seoId)?.color_style;
  try {
    const s = JSON.parse(raw || 'null') as ColorStyle | null;
    return s && typeof s.name === 'string' && s.name ? s : null;
  } catch {
    return null;
  }
}

/** The same rule with every style: one look for the whole article, nothing overdone. */
export const COLOR_RULE = 'Keep the lighting consistent with the other pictures of this article, realistic colors, no excessive saturation or contrast.';

/** A picture prompt with its article's colour style added. */
export const withColorStyle = (prompt: string, style: ColorStyle | null): string =>
  style ? `${prompt.trim()} Color grading: ${styleLine(style)}. ${COLOR_RULE}` : prompt;
