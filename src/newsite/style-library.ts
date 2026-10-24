import { get } from '../db/index.js';
import { NICHE_COLOR_STYLES, type ColorStyle, type NicheGroup } from './color-styles.js';

/**
 * The ready-made styles a website can add to its Niche step's fields, from a
 * dropdown under each: colour styles (the colour grading of its pictures) and
 * picture styles (where its photos are taken and what is in them). Picking
 * one adds its "Name — description" line to the field; the field stays the
 * website's own text.
 *
 * Both libraries are grouped by niche. A colour style is in the library once,
 * by name, with the description of the first niche that has it.
 *
 * Before an article's image prompts are written, the AI picks ONE picture
 * style from the website's list, the same way it picks one colour style
 * (images.ts). It is kept on the article and every picture of the article
 * follows it, so an article never mixes two.
 */

export type Style = ColorStyle;

export const GROUP_LABELS: Record<NicheGroup, string> = {
  recipes: 'Recipes',
  pets: 'Pets',
  travel: 'Travel',
  home: 'Home & Garden',
  diy: 'DIY',
  crochet: 'Crochet',
  other: 'Other',
};

const list = (text: string): Style[] =>
  text.split(';').map((line) => {
    const [name, description] = line.split(' — ').map((s) => s.trim());
    return { name: name!, description: description ?? '' };
  });

/** Where each niche's photos are taken, main ones first. "Other" has none: the platform decides from the niche. */
export const NICHE_PICTURE_STYLES: Record<NicheGroup, Style[]> = {
  recipes: list(
    'Rustic Wooden Table — The dish on a weathered wooden table with linen napkins, wooden boards and simple vintage props, hands reaching in, natural window light; ' +
      'Marble Kitchen Counter — On a white marble kitchen counter in a bright modern kitchen, a few clean props, the ingredients nearby, the cook’s hands at work; ' +
      'Bright Overhead Flat Lay — Shot from directly above on a light surface, the dish in the middle and its ingredients and tools arranged around it with space between them; ' +
      'Cozy Home Kitchen — In a lived-in home kitchen: the stovetop, pans, a cutting board and the cook’s hands mid-step, warm and real, never staged like a studio; ' +
      'Outdoor Picnic — Outdoors on a picnic blanket or a garden table, dappled sunlight, greenery behind, casual serving in simple dishes; ' +
      'Dark Moody Table — On a dark slate or charcoal surface against a deep background, one soft light from the side, few props',
  ),
  pets: list(
    'Cozy Living Room — Pets at home on the sofa, a rug or the floor of a lived-in living room, soft daylight, an owner’s hands nearby, never on a dining table, never with plates; ' +
      'Garden & Backyard — In a backyard or garden: the grass, flower beds or a patio, natural daylight, the animal playing, sniffing or resting; ' +
      'Park & Trail Walks — Out on a walk in a park or on a forest trail, the leash and the owner’s legs in the frame, natural movement; ' +
      'At the Vet or Groomer — On a vet’s examination table or at a grooming station, the gentle hands of the professional, a clean bright room; ' +
      'Bright Studio Portrait — Against a plain light backdrop, soft even light, the animal sharp and looking at the camera',
  ),
  travel: list(
    'Iconic Landmark View — The place’s famous landmark or skyline in a wide view, a traveller small in the frame; ' +
      'Street-Level Wandering — Narrow streets, markets and cafés seen at walking height, locals and small details, candid; ' +
      'Nature & Viewpoints — Mountains, lakes, coastlines, a trail or a viewpoint, the big landscape with a hiker for scale; ' +
      'Beach & Waterfront — Sand, sea, a harbour or a lakeside in bright open light, people relaxing or swimming; ' +
      'Hotel & Stay — Inside the hotel room, villa or cabin: the bed, the balcony view, a breakfast tray, the pool; ' +
      'Local Food & Markets — Local dishes at a street stall, a market or a restaurant table where they are really eaten',
  ),
  home: list(
    'Bright Living Space — Real living rooms and bedrooms in daylight, styled but lived-in, the subject in its place in the room; ' +
      'Garden Beds & Borders — Planted beds, borders and lawns outdoors, dark soil, gardening tools, gloved hands at work; ' +
      'Patio & Outdoor Living — Patios, decks and balconies with furniture, potted plants and string lights; ' +
      'Indoor Plants Corner — Houseplants on shelves, windowsills and stands, pots and soil, hands repotting or watering; ' +
      'Kitchen & Bathroom Interior — Kitchens and bathrooms as rooms: cabinets, counters, tiles, fixtures and lighting, never food styling; ' +
      'Project in Progress — The room or the spot during the work, tools and materials in view, a person doing the job',
  ),
  diy: list(
    'Workshop Bench — On a sturdy workbench in a home workshop, tools within reach, hands working the material; ' +
      'Step-by-Step Hands — Close-ups of hands doing each step, the material and the tool sharp, the background soft; ' +
      'Craft Table Flat Lay — From above on a clean craft table, the materials and tools laid out in order; ' +
      'Finished Piece at Home — The finished project in use in a real room of a home; ' +
      'Garage & Outdoor Project — Outdoors or in a garage: a drop cloth, sawhorses, power tools, daylight',
  ),
  crochet: list(
    'Cozy Lap & Armchair — The work in progress on a lap or an armchair, a blanket and a mug nearby, hands crocheting; ' +
      'Yarn Flat Lay — From above on a light surface: yarn balls, the hook, stitch markers and the piece; ' +
      'Close-up Stitches — A macro close-up of the stitches and the hook, the yarn texture sharp; ' +
      'Finished Piece in Use — The finished piece worn or in use: on a person, a bed, a sofa or a nursery shelf; ' +
      'Yarn Basket by the Window — A basket of yarn and the project by a sunlit window, soft natural light',
  ),
  other: [],
};

const GROUPS = Object.keys(GROUP_LABELS) as NicheGroup[];

/** Each name once, with the description of the first niche that has it. */
function library(byNiche: Record<NicheGroup, Style[]>): Map<string, Style> {
  const out = new Map<string, Style>();
  for (const g of GROUPS) for (const s of byNiche[g]) if (!out.has(s.name.toLowerCase())) out.set(s.name.toLowerCase(), s);
  return out;
}

export const COLOR_LIBRARY = library(NICHE_COLOR_STYLES);
export const PICTURE_LIBRARY = library(NICHE_PICTURE_STYLES);

export type StyleKind = 'color' | 'picture';

/** The library for a field's dropdown, grouped by niche; each style once, in the first niche that has it. */
export function styleGroups(kind: StyleKind): { label: string; styles: Style[] }[] {
  const byNiche = kind === 'color' ? NICHE_COLOR_STYLES : NICHE_PICTURE_STYLES;
  const shown = new Set<string>();
  return GROUPS.map((g) => ({
    label: GROUP_LABELS[g],
    styles: byNiche[g].filter((s) => !shown.has(s.name.toLowerCase()) && shown.add(s.name.toLowerCase())),
  })).filter((g) => g.styles.length);
}

/** A "Name — description" line (a long or short dash separates them). */
const NAMED_LINE = /^(.{1,60}?)\s+(?:—|–)\s+(.+)$/;

/**
 * A website's picture styles, from its Picture style field. One typed
 * direction (the field as it always was) is one style, followed as it is.
 * Several lines with "Name — description" ones among them (added from the
 * library's dropdown) are several styles; a line with no name gets one.
 * Empty: the platform decides from the niche.
 */
export function pictureStylesOf(site: { picture_style?: string }): Style[] {
  const raw = (site.picture_style ?? '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (lines.length < 2 || !lines.some((l) => NAMED_LINE.test(l))) return [{ name: 'Own style', description: raw }];
  const out: Style[] = [];
  for (const line of lines) {
    const m = NAMED_LINE.exec(line);
    const name = m ? m[1]!.trim() : out.some((s) => s.name === 'Own style') ? `Own style ${out.length + 1}` : 'Own style';
    if (out.some((s) => s.name.toLowerCase() === name.toLowerCase())) continue;
    out.push({ name, description: (m ? m[2]! : line).slice(0, 600) });
  }
  return out;
}

/** The picture style an article was given, or null. */
export function articlePictureStyle(seoId: number): Style | null {
  const raw = get<{ picture_style: string }>('SELECT picture_style FROM keyword_seo WHERE id = ?', seoId)?.picture_style;
  try {
    const s = JSON.parse(raw || 'null') as Style | null;
    return s && typeof s.name === 'string' && s.name ? s : null;
  } catch {
    return null;
  }
}

