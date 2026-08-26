import type {
  Decision,
  KeywordView,
  LinkView,
  SelectionResult,
  SiteView,
} from './types.js';

/**
 * The selector: given the current state of the world, produce at most one
 * valid publishing task and a full account of how that conclusion was reached.
 *
 * This function is deliberately pure. No database, no HTTP, no `new Date()` —
 * `now` is a parameter. Three arrays in, a decision out. That is what makes it
 * testable, and being testable is what makes the system supportable.
 *
 * TERMINATION IS STRUCTURAL. This is a bounded iteration over a finite list
 * with no back edge. The system it replaces looped forever because a node
 * wired back to an earlier node while re-reading the same first row; there is
 * no equivalent here because there is nowhere to loop back to. The rule from
 * section 12 of the specification — "if no eligible site remains for this
 * keyword, skip it and move to the next" — is not enforced by a counter, it
 * is simply what `continue` does.
 */

export interface SelectorOptions {
  /** Treat `now` as the reference time for interval and daily-window checks. */
  now: Date;
  /** IANA timezone used to decide which calendar day "today" refers to. */
  timezone: string;
}

/** Format a Date as YYYY-MM-DD in the given IANA timezone. */
export function localDateKey(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes elapsed between two instants; null when `since` is unusable. */
function minutesSince(since: string | null, now: Date): number | null {
  if (!since) return null;

  const parsed = new Date(since);
  if (Number.isNaN(parsed.getTime())) {
    // The old system wrote the literal string "{{ $json.now_iso }}" here and
    // then treated the unparseable result as "interval satisfied", silently
    // disabling rate limiting. We treat it as a data problem instead.
    return null;
  }

  return (now.getTime() - parsed.getTime()) / 60_000;
}

/** Render a minute count the way a person would say it. */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface SiteEligibility {
  site: SiteView;
  eligible: boolean;
  reason: string;
}

/**
 * Filter 1 of the specification: is this site able to publish right now,
 * on purely operational grounds?
 */
export function evaluateSite(site: SiteView, options: SelectorOptions): SiteEligibility {
  const reject = (reason: string): SiteEligibility => ({ site, eligible: false, reason });

  if (site.status !== 'active') {
    return reject('Site is not active');
  }

  if (site.dailyTarget <= 0) {
    return reject('Daily target is 0');
  }

  const remaining = site.dailyTarget - site.publishedToday;
  if (remaining <= 0) {
    return reject(
      `Daily publishing limit reached (${site.publishedToday}/${site.dailyTarget})`,
    );
  }

  const elapsed = minutesSince(site.lastPublishAt, options.now);

  if (site.lastPublishAt !== null && elapsed === null) {
    // Explicitly a rejection, not a free pass. An unreadable timestamp is a
    // problem to surface, not to ignore.
    return reject(`Unreadable last_publish value: ${JSON.stringify(site.lastPublishAt)}`);
  }

  if (elapsed !== null && elapsed < site.intervalMinutes) {
    return reject(
      `Minimum interval not elapsed (${formatMinutes(Math.floor(elapsed))} of ` +
        `${formatMinutes(site.intervalMinutes)}; ` +
        `${formatMinutes(Math.ceil(site.intervalMinutes - elapsed))} remaining)`,
    );
  }

  return {
    site,
    eligible: true,
    reason: `${remaining} of ${site.dailyTarget} posts remaining today`,
  };
}

/** Prefer the site that has waited longest. Never published sorts first. */
function leastRecentlyPublished(a: SiteView, b: SiteView): number {
  const ta = a.lastPublishAt ? new Date(a.lastPublishAt).getTime() : 0;
  const tb = b.lastPublishAt ? new Date(b.lastPublishAt).getTime() : 0;
  const va = Number.isNaN(ta) ? 0 : ta;
  const vb = Number.isNaN(tb) ? 0 : tb;
  if (va !== vb) return va - vb;
  return a.id - b.id; // stable tiebreak, so behaviour is reproducible
}

export function selectTask(
  sites: SiteView[],
  keywords: KeywordView[],
  links: LinkView[],
  options: SelectorOptions,
): SelectionResult {
  const decisions: Decision[] = [];

  // -- Filter 1: which sites can publish at all? -----------------------------
  const eligibleSites: SiteView[] = [];

  for (const site of sites) {
    const verdict = evaluateSite(site, options);

    decisions.push({
      subjectType: 'site',
      subjectId: site.id,
      subjectLabel: site.domain,
      decision: verdict.eligible ? 'eligible' : 'rejected',
      reason: verdict.reason,
    });

    if (verdict.eligible) eligibleSites.push(site);
  }

  if (eligibleSites.length === 0) {
    decisions.push({
      subjectType: 'cycle',
      subjectId: null,
      subjectLabel: '',
      decision: 'none',
      reason: `No eligible site (checked ${sites.length})`,
    });
    return { task: null, decisions };
  }

  const eligibleById = new Map(eligibleSites.map((s) => [s.id, s]));

  // Index the matrix once so the keyword loop stays linear.
  const linksByKeyword = new Map<number, LinkView[]>();
  for (const link of links) {
    const bucket = linksByKeyword.get(link.keywordId);
    if (bucket) bucket.push(link);
    else linksByKeyword.set(link.keywordId, [link]);
  }

  // -- Filter 2: which keyword can run, and on which of those sites? ---------
  for (const keyword of keywords) {
    if (keyword.status !== 'go') {
      decisions.push({
        subjectType: 'keyword',
        subjectId: keyword.id,
        subjectLabel: keyword.seedKeyword,
        decision: 'skipped',
        reason: `Keyword status is '${keyword.status}'`,
      });
      continue;
    }

    const candidates = (linksByKeyword.get(keyword.id) ?? [])
      .filter((link) => link.status === 'go')
      .map((link) => eligibleById.get(link.siteId))
      .filter((site): site is SiteView => site !== undefined)
      .sort(leastRecentlyPublished);

    if (candidates.length === 0) {
      // Section 11 and 12: do not retry this keyword, move to the next one.
      // This `continue` is the entire fix for the original infinite loop.
      decisions.push({
        subjectType: 'keyword',
        subjectId: keyword.id,
        subjectLabel: keyword.seedKeyword,
        decision: 'skipped',
        reason: 'No eligible site remains for this keyword',
      });
      continue;
    }

    const chosen = candidates[0]!;

    decisions.push({
      subjectType: 'pair',
      subjectId: keyword.id,
      subjectLabel: `${keyword.seedKeyword} → ${chosen.domain}`,
      decision: 'selected',
      reason: 'Keyword is go, site is go for this keyword, site is eligible',
    });

    return {
      task: {
        siteId: chosen.id,
        siteDomain: chosen.domain,
        siteName: chosen.name,
        keywordId: keyword.id,
        seedKeyword: keyword.seedKeyword,
      },
      decisions,
    };
  }

  decisions.push({
    subjectType: 'cycle',
    subjectId: null,
    subjectLabel: '',
    decision: 'none',
    reason: `No valid keyword + site pair (checked ${keywords.length} keywords)`,
  });

  return { task: null, decisions };
}
