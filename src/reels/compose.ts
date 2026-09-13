import { loadTemplate } from '../pipeline/prompts.js';
import type { ArticleImages } from '../pipeline/steps/images.js';

/**
 * What every reel is built from, whoever asks for it -- the pipeline after a
 * publish, or a person on the composer page. One copy, so the two cannot
 * drift apart.
 */

/**
 * The video prompt.
 *
 * A template rather than a model call: on the composer a person edits it
 * before anything is generated, and the pipeline sends it as it is.
 */
export function buildReelPrompt(c: {
  title: string;
  spy_title: string;
  seed_keyword: string;
}): string {
  return loadTemplate('reel-video.template.txt', {
    seo: { title: c.title || c.spy_title, category: c.seed_keyword },
    spy: { title: c.spy_title, group: c.seed_keyword },
  });
}

/**
 * The caption with the one thing it must never carry removed.
 *
 * Belt to the prompt's braces. The model is told not to link; if it does
 * anyway, the link comes out here rather than going on the post. The article
 * url is posted as the first comment and only there.
 */
export function withoutLinks(caption: string): string {
  return caption
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The four article images as absolute urls, in the order the template names them. */
export function referenceUrls(host: string, images: ArticleImages): string[] {
  return [images.feature, images.topShot, images.textureMacro, images.beforeAfter].map(
    (path) => `https://${host}${path}`,
  );
}
