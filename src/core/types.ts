/** Domain types shared across the platform. */

export type SiteStatus = 'active' | 'paused';
export type LinkStatus = 'go' | 'done' | 'no';

/** A site as the selector sees it: config plus derived runtime facts. */
export interface SiteView {
  id: number;
  name: string;
  domain: string;
  status: SiteStatus;
  dailyTarget: number;
  hoursBetween: number;
  /** Derived: COUNT(runs published today). Never stored. */
  publishedToday: number;
  /** Derived: MAX(runs.published_at). Never stored. ISO string or null. */
  lastPublishAt: string | null;
}

export interface KeywordView {
  id: number;
  seedKeyword: string;
  spyTitle: string;
  status: LinkStatus;
}

/** One cell of the keyword x site matrix. */
export interface LinkView {
  keywordId: number;
  siteId: number;
  status: LinkStatus;
}

export type DecisionKind = 'selected' | 'eligible' | 'rejected' | 'skipped' | 'none';
export type SubjectType = 'site' | 'keyword' | 'pair' | 'cycle';

export interface Decision {
  subjectType: SubjectType;
  subjectId: number | null;
  subjectLabel: string;
  decision: DecisionKind;
  reason: string;
}

/** The single valid publishing task the selector exists to produce. */
export interface PublishingTask {
  siteId: number;
  siteDomain: string;
  siteName: string;
  keywordId: number;
  seedKeyword: string;
}

export interface SelectionResult {
  task: PublishingTask | null;
  decisions: Decision[];
}
