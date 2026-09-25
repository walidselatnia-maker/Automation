import { errorMessage } from '../lib/logger.js';

/**
 * Client for the APIs each publishing site exposes:
 *   GET  /api/categories
 *   POST /api/upload    (multipart)
 *   POST /api/recipe
 *   GET  /api/recipe?id=
 *
 * Contracts were recovered from a captured successful n8n execution.
 */

export interface Category {
  id: string;
  slug: string;
  title: string;
  href: string;
  alt: string;
  description: string;
  image?: string;
  recipeCount?: number;
}

/** What /api/articles answers with, inside its `data`. */
export interface PostedArticle {
  id: string;
  slug: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}

/** How many slugs to try before giving up: the wanted one, then -2 and -3. */
const SLUG_ATTEMPTS = 3;

export interface UploadResult {
  success: boolean;
  url: string;
  thumbnailUrl: string;
  filename: string;
  originalName: string;
  width: number;
  height: number;
  size: number;
  category: string;
}

export interface PostedRecipe {
  id: string;
  title: string;
  href: string;
  categoryId: string;
  heroImage?: string;
  featuredText?: string;
  [key: string]: unknown;
}

export class SiteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'SiteApiError';
  }
}

/** Turn a status code into the thing an operator actually needs to check. */
function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return ' (check the site API token in Settings → Sites)';
  }
  if (status === 404) return ' (endpoint not found — is this site running the expected API?)';
  if (status === 413) return ' (payload too large)';
  if (status >= 500) return ' (the site itself returned an error)';
  return '';
}

export class SiteApiClient {
  constructor(
    private readonly domain: string,
    private readonly apiToken: string,
  ) {}

  private url(path: string): string {
    const host = this.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return `https://${host}${path}`;
  }

  /**
   * The public URL of something this site is serving.
   *
   * `uploadImage` returns a site-relative path; prefixed with the domain it
   * becomes a permanent link any other site can download from — which is what
   * lets one keyword's images be shared across sites without an image cache.
   * An already-absolute URL passes through unchanged, so callers do not have
   * to know which kind they are holding.
   */
  absoluteUrl(path: string): string {
    return /^https?:\/\//i.test(path) ? path : this.url(path);
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiToken}` };
  }

  async getCategories(): Promise<Category[]> {
    const response = await fetch(this.url('/api/categories'), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SiteApiError(
        `GET /api/categories failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 200)}` : ''}`,
        response.status,
        body,
      );
    }

    const json: unknown = await response.json();
    if (Array.isArray(json)) return json as Category[];

    // Tolerate a wrapped payload without assuming one.
    const wrapped = json as { categories?: Category[]; data?: Category[] };
    return wrapped.categories ?? wrapped.data ?? [];
  }

  async uploadImage(
    data: Buffer,
    filename: string,
    contentType = 'image/webp',
    category = 'recipes',
  ): Promise<UploadResult> {
    const form = new FormData();
    form.append('category', category);
    form.append('file', new Blob([new Uint8Array(data)], { type: contentType }), filename);

    const response = await fetch(this.url('/api/upload'), {
      method: 'POST',
      headers: this.authHeaders(), // fetch sets the multipart boundary itself
      body: form,
      signal: AbortSignal.timeout(180_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new SiteApiError(
        `POST /api/upload failed on ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)}${body ? ` — ${body.slice(0, 200)}` : ''}`,
        response.status,
        body,
      );
    }

    const result = (await response.json()) as UploadResult;
    if (!result.url) throw new SiteApiError('Upload returned no url', 200, JSON.stringify(result));
    return result;
  }

  /**
   * Publish the assembled recipe.
   *
   * The body is the recipe object exactly as the article prompts produce it,
   * matching the previous implementation's `JSON.stringify($json)`.
   */
  async postRecipe(recipe: Record<string, unknown>): Promise<PostedRecipe> {
    const response = await fetch(this.url('/api/recipe'), {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(recipe),
      signal: AbortSignal.timeout(120_000),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new SiteApiError(
        `POST /api/recipe rejected by ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)} — ${text.slice(0, 400)}`,
        response.status,
        text,
      );
    }

    try {
      return JSON.parse(text) as PostedRecipe;
    } catch {
      throw new SiteApiError(
        `POST /api/recipe returned unparseable JSON from ${this.domain}`,
        response.status,
        text,
      );
    }
  }

  /**
   * Publish a blog article.
   *
   * A different endpoint and a different shape from postRecipe -- the body is
   * one HTML string rather than a structured recipe -- so it is its own call
   * rather than a flag on that one.
   *
   * The slug has to be unique and the site says so with a 400 naming it. That
   * is not a failure worth losing an article over, so a taken slug is suffixed
   * and sent again: "guide-to-kyoto", then "-2", then "-3". Any other 400 is
   * a real rejection and is raised.
   */
  async postArticle(article: Record<string, unknown>): Promise<PostedArticle> {
    const wanted = String(article.slug ?? '').trim();

    for (let attempt = 1; attempt <= SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 1 || !wanted ? wanted : `${wanted}-${attempt}`;
      const body = slug ? { ...article, slug } : article;

      const response = await fetch(this.url('/api/articles'), {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      const text = await response.text();

      if (response.ok) {
        try {
          const parsed = JSON.parse(text) as { data?: PostedArticle };
          const data = parsed.data ?? (JSON.parse(text) as PostedArticle);
          if (!data?.slug && !data?.id) {
            throw new Error('no id or slug');
          }
          return data;
        } catch {
          throw new SiteApiError(
            `POST /api/articles returned unparseable JSON from ${this.domain}`,
            response.status,
            text,
          );
        }
      }

      // Only the slug is retried, and only while there is another name to try.
      if (response.status === 400 && /slug already exists/i.test(text) && wanted) {
        continue;
      }

      throw new SiteApiError(
        `POST /api/articles rejected by ${this.domain}: HTTP ${response.status}` +
          `${describeStatus(response.status)} — ${text.slice(0, 400)}`,
        response.status,
        text,
      );
    }

    throw new SiteApiError(
      `Every slug from "${wanted}" to "${wanted}-${SLUG_ATTEMPTS}" is taken on ${this.domain}`,
      400,
      '',
    );
  }

  /** The authors this site knows, for the article payload's authorId. */
  async getAuthors(): Promise<{ id: string; name?: string }[]> {
    const response = await fetch(this.url('/api/admin/authors'), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return [];

    const json: unknown = await response.json().catch(() => null);
    if (Array.isArray(json)) return json as { id: string }[];
    const wrapped = json as { authors?: { id: string }[]; data?: { id: string }[] } | null;
    return wrapped?.authors ?? wrapped?.data ?? [];
  }

  async getRecipe(id: string): Promise<PostedRecipe> {
    const response = await fetch(this.url(`/api/recipe?id=${encodeURIComponent(id)}`), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new SiteApiError(
        `GET /api/recipe?id=${id} failed on ${this.domain}: HTTP ${response.status}` +
          describeStatus(response.status),
        response.status,
        await response.text().catch(() => ''),
      );
    }
    return (await response.json()) as PostedRecipe;
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.getCategories();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }
}
