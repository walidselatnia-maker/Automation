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
      });
    }
    const pages = Number(body.pages);
    if (!Number.isFinite(pages) || page >= pages || body.items.length === 0) break;
  }
  return posts;
}
