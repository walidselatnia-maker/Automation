/**
 * Asking a new website (blog-engine) whether an address and key are real.
 *
 * Only what the wizard needs: GET /api/v1/site, which answers with the site's
 * name and the kinds of post it accepts when the key is right. Nothing here is
 * shared with the old site client.
 */

export type SiteCheck =
  | { ok: true; siteName: string; types: string[] }
  | { ok: false; field: 'domain' | 'apiKey'; error: string };

export type Fetch = typeof fetch;

export async function checkSite(
  domain: string,
  apiKey: string,
  fetchImpl: Fetch = fetch,
): Promise<SiteCheck> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${domain}/api/v1/site`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, field: 'domain', error: `Could not reach ${domain}. Check the address and that the site is online.` };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      field: 'apiKey',
      error: 'This site rejected the API key. Copy a fresh one from Admin → Automation on that site.',
    };
  }
  if (!response.ok) {
    return { ok: false, field: 'domain', error: `${domain} answered with an error (HTTP ${response.status}).` };
  }

  const body = (await response.json().catch(() => null)) as {
    name?: unknown;
    types?: { key?: unknown }[];
  } | null;
  if (!body || typeof body.name !== 'string' || !Array.isArray(body.types)) {
    return { ok: false, field: 'domain', error: `${domain} answered, but it does not look like a blog-engine site.` };
  }

  return {
    ok: true,
    siteName: body.name,
    types: body.types.map((t) => String(t.key)).filter(Boolean),
  };
}

export interface SitePost {
  id: number | string;
  slug: string;
  title: string;
  status?: string;
  /** Topic cluster label; undefined when the site is too old to know clusters. */
  clusterRole?: string | null;
  pillarId?: number | null;
  pillarRef?: string | null;
}

/** Most pages read for one list, so a runaway answer cannot loop forever. */
const MAX_PAGES = 100;

/**
 * Every post on the website, any status, read 100 at a time.
 * Throws with a plain message when the site cannot be read: the duplicate
 * check needs the whole list, and half a list would let duplicates through.
 */
export async function listPosts(domain: string, apiKey: string, fetchImpl: Fetch = fetch): Promise<SitePost[]> {
  const posts: SitePost[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let response: Response;
    try {
      response = await fetchImpl(`https://${domain}/api/v1/posts?perPage=100&page=${page}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`Could not reach ${domain} to read its posts.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${domain} rejected the API key. Remove the website and add it again with a fresh key.`);
    }
    if (!response.ok) throw new Error(`${domain} could not list its posts (HTTP ${response.status}).`);

    const body = (await response.json().catch(() => null)) as { items?: unknown; pages?: unknown } | null;
    if (!body || !Array.isArray(body.items)) throw new Error(`${domain} answered the post list in an unknown shape.`);

    for (const item of body.items as Record<string, unknown>[]) {
      posts.push({
        id: item.id as number | string,
        slug: String(item.slug ?? ''),
        title: String(item.title ?? ''),
        status: typeof item.status === 'string' ? item.status : undefined,
        ...('clusterRole' in item
          ? {
              clusterRole: (item.clusterRole as string | null) ?? null,
              pillarId: (item.pillarId as number | null) ?? null,
              pillarRef: (item.pillarRef as string | null) ?? null,
            }
          : {}),
      });
    }
    const pages = Number(body.pages);
    if (!Number.isFinite(pages) || page >= pages || body.items.length === 0) break;
  }
  return posts;
}

/* -- Publishing ----------------------------------------------------------- */

/** What the site answered, as a plain message: its own error text and the fields it named. */
async function siteError(domain: string, response: Response, what: string): Promise<Error> {
  if (response.status === 401 || response.status === 403) {
    return new Error(`${domain} rejected the API key. Edit the website and paste a fresh key from Admin → Automation.`);
  }
  const body = (await response.json().catch(() => null)) as { error?: unknown; details?: unknown } | null;
  const details = Array.isArray(body?.details) ? ` (${body!.details.join('; ')})` : '';
  const error = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
  return new Error(`${domain} could not ${what}: ${error}${details}`);
}

export interface SiteMedia {
  id: number;
  url: string;
}

/** Upload one picture to the website's media library (POST /api/v1/media, multipart). */
export async function uploadMedia(
  domain: string,
  apiKey: string,
  file: { data: Buffer; name: string; type: string; alt: string; title?: string; description?: string },
  fetchImpl: Fetch = fetch,
): Promise<SiteMedia> {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
  form.set('alt', file.alt);
  if (file.title) form.set('title', file.title);
  if (file.description) form.set('description', file.description);
  let response: Response;
  try {
    response = await fetchImpl(`https://${domain}/api/v1/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error(`Could not reach ${domain} to upload a picture.`);
  }
  if (!response.ok) throw await siteError(domain, response, 'take the picture');
  const body = (await response.json().catch(() => null)) as { media?: { id?: unknown; url?: unknown } } | null;
  const id = Number(body?.media?.id);
  if (!Number.isFinite(id)) throw new Error(`${domain} took the picture but did not say its id.`);
  return { id, url: String(body?.media?.url ?? '') };
}

export interface SitePostSaved {
  id: number;
  url: string;
  status: string;
}

const readPost = async (domain: string, response: Response): Promise<SitePostSaved> => {
  const body = (await response.json().catch(() => null)) as { post?: { id?: unknown; url?: unknown; status?: unknown } } | null;
  const id = Number(body?.post?.id);
  if (!Number.isFinite(id)) throw new Error(`${domain} saved the post but did not say its id.`);
  return { id, url: String(body?.post?.url ?? ''), status: String(body?.post?.status ?? '') };
};

/**
 * Create a post, or update the one with the same externalId (POST /api/v1/posts).
 * Sending it again never makes a duplicate.
 */
export async function savePost(domain: string, apiKey: string, post: Record<string, unknown>, fetchImpl: Fetch = fetch): Promise<SitePostSaved> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${domain}/api/v1/posts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(post),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error(`Could not reach ${domain} to publish the article.`);
  }
  if (!response.ok) throw await siteError(domain, response, 'save the article');
  return readPost(domain, response);
}

/** Change only the fields sent, on one post (PATCH /api/v1/posts/:id). */
export async function patchPost(domain: string, apiKey: string, id: number, fields: Record<string, unknown>, fetchImpl: Fetch = fetch): Promise<SitePostSaved> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${domain}/api/v1/posts/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(`Could not reach ${domain} to update the article.`);
  }
  if (!response.ok) throw await siteError(domain, response, 'update the article');
  return readPost(domain, response);
}

export interface SiteCategory {
  id: number;
  name: string;
  slug: string;
  /** Authors assigned to the category in the site's admin. */
  authorIds: number[];
}

export interface SiteAuthor {
  id: number;
  name: string;
}

async function getList<T>(domain: string, apiKey: string, path: string, what: string, fetchImpl: Fetch): Promise<T[]> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${domain}/api/v1/${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error(`Could not reach ${domain} to read its ${what}.`);
  }
  if (!response.ok) throw await siteError(domain, response, `list its ${what}`);
  const body = (await response.json().catch(() => null)) as { items?: unknown } | null;
  return Array.isArray(body?.items) ? (body!.items as T[]) : [];
}

/** The website's categories, with the authors assigned to each (GET /api/v1/categories). */
export async function listCategories(domain: string, apiKey: string, fetchImpl: Fetch = fetch): Promise<SiteCategory[]> {
  const items = await getList<Record<string, unknown>>(domain, apiKey, 'categories', 'categories', fetchImpl);
  return items
    .map((c) => ({
      id: Number(c.id),
      name: String(c.name ?? ''),
      slug: String(c.slug ?? ''),
      authorIds: Array.isArray(c.authorIds) ? c.authorIds.map(Number).filter(Number.isFinite) : [],
    }))
    .filter((c) => Number.isFinite(c.id) && c.name);
}

/** Set a category's intro, the text at the top of its page (POST /api/v1/categories updates the one with that slug). */
export async function saveCategoryIntro(
  domain: string,
  apiKey: string,
  category: { name: string; slug: string; intro: string },
  fetchImpl: Fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${domain}/api/v1/categories`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(category),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`Could not reach ${domain} to save the category intro.`);
  }
  if (!response.ok) throw await siteError(domain, response, 'save the category intro');
}

/** The website's authors (GET /api/v1/authors). */
export async function listAuthors(domain: string, apiKey: string, fetchImpl: Fetch = fetch): Promise<SiteAuthor[]> {
  const items = await getList<Record<string, unknown>>(domain, apiKey, 'authors', 'authors', fetchImpl);
  return items.map((a) => ({ id: Number(a.id), name: String(a.name ?? '') })).filter((a) => Number.isFinite(a.id));
}
