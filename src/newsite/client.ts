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
