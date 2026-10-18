/**
 * What the New Website wizard accepts.
 *
 * One place decides, for every field, what a good value looks like. The wizard
 * asks it after each step and again on save, so the same rule applies whether
 * the browser's check ran or not.
 */

import { flowProjectProblem } from '../core/project-id.js';

export const PERSONAS = [
  'Expert / Professional',
  'Passionate Enthusiast',
  'Practical Helper',
  'Storyteller',
] as const;

export type FieldName =
  | 'name'
  | 'domain'
  | 'apiKey'
  | 'niche'
  | 'nicheContext'
  | 'persona'
  | 'customPersona'
  | 'status'
  | 'autopilot'
  | 'autoPublish'
  | 'dailyTarget'
  | 'gapAmount'
  | 'gapUnit'
  | 'bufferToken'
  | 'pinUsername'
  | 'projectId';

/** The fields on each wizard step, in order. The last step is only a review. */
export const STEP_FIELDS: FieldName[][] = [
  ['name', 'domain', 'apiKey'],
  ['niche', 'nicheContext'],
  ['persona', 'customPersona'],
  ['status', 'autopilot', 'autoPublish', 'dailyTarget', 'gapAmount', 'gapUnit'],
  ['bufferToken', 'pinUsername', 'projectId'],
  [],
];

export interface CleanWebsite {
  name: string;
  /** Bare host name: lower case, no scheme, no path. */
  domain: string;
  apiKey: string;
  niche: string;
  nicheContext: string;
  persona: string;
  status: 'active' | 'paused';
  /** Makes pictures and publishes on the schedule by itself. Off when left out. */
  autopilot?: boolean;
  autoPublish: boolean;
  dailyTarget: number;
  intervalMinutes: number;
  bufferToken: string;
  pinUsername: string;
  projectId: string;
}

export type Errors = Partial<Record<FieldName, string>>;

export interface Validated {
  errors: Errors;
  clean: Partial<CleanWebsite>;
}

type Raw = Record<string, unknown>;

const text = (raw: Raw, field: FieldName): string => {
  const value = raw[field];
  return typeof value === 'string' ? value.trim() : '';
};

/** Control characters and angle brackets have no place in a name or a sentence. */
const BAD_TEXT = /[\u0000-\u001f\u007f<>{}]/;

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}$/;

/**
 * "https://WWW.Example.com/recipes/" -> "www.example.com".
 * Returns null when what is left is not a host name.
 */
export function normalizeDomain(input: string): string | null {
  const host = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
  return DOMAIN.test(host) ? host : null;
}

const UNIT_MINUTES = { minutes: 1, hours: 60, days: 1440 } as const;
const MAX_INTERVAL_MINUTES = 30 * 1440;

function fieldCheck(field: FieldName, raw: Raw, clean: Partial<CleanWebsite>): string | null {
  switch (field) {
    case 'name': {
      const value = text(raw, field).replace(/\s+/g, ' ');
      if (!value) return 'Enter a name for the website.';
      if (value.length < 2 || value.length > 60) return 'The name must be 2 to 60 characters.';
      if (!/\p{L}/u.test(value) || BAD_TEXT.test(value)) {
        return 'The name must be plain text with at least one letter.';
      }
      clean.name = value;
      return null;
    }
    case 'domain': {
      const value = text(raw, field);
      if (!value) return 'Enter the website address.';
      const host = normalizeDomain(value);
      if (!host) return 'That is not a website address. Use something like blog.example.com.';
      clean.domain = host;
      return null;
    }
    case 'apiKey': {
      const value = text(raw, field);
      if (!value) return 'Enter the API key.';
      if (!/^sk_[A-Za-z0-9_-]{16,128}$/.test(value)) {
        return 'That does not look like an API key. It starts with sk_ and has no spaces.';
      }
      clean.apiKey = value;
      return null;
    }
    case 'niche': {
      const value = text(raw, field).replace(/\s+/g, ' ');
      if (!value) return 'Enter the niche.';
      if (value.length < 2 || value.length > 60) return 'The niche must be 2 to 60 characters.';
      if (!/\p{L}/u.test(value) || BAD_TEXT.test(value)) {
        return 'The niche must be plain text with at least one letter.';
      }
      clean.niche = value;
      return null;
    }
    case 'nicheContext': {
      const value = text(raw, field);
      if (value.length > 500) return 'Keep the detail under 500 characters.';
      if (BAD_TEXT.test(value)) return 'The detail must be plain text.';
      clean.nicheContext = value;
      return null;
    }
    case 'persona': {
      const value = text(raw, field);
      if (value && !(PERSONAS as readonly string[]).includes(value)) {
        return 'Pick one of the personas, or describe your own.';
      }
      return null; // the pair is checked with customPersona
    }
    case 'customPersona': {
      const custom = text(raw, field).replace(/\s+/g, ' ');
      const preset = text(raw, 'persona');
      if (!custom && !preset) return 'Pick a persona or describe your own.';
      if (custom) {
        if (custom.length < 3 || custom.length > 200) {
          return 'Describe the persona in 3 to 200 characters.';
        }
        if (BAD_TEXT.test(custom)) return 'The persona must be plain text.';
        clean.persona = custom;
      } else {
        clean.persona = preset;
      }
      return null;
    }
    case 'status': {
      const value = text(raw, field);
      if (value !== 'active' && value !== 'paused') return 'Choose active or paused.';
      clean.status = value;
      return null;
    }
    case 'autopilot': {
      const value = text(raw, field) || '0';
      if (value !== '1' && value !== '0') return 'Choose on or off.';
      clean.autopilot = value === '1';
      return null;
    }
    case 'autoPublish': {
      const value = text(raw, field);
      if (value !== '1' && value !== '0') return 'Choose how posts are published.';
      clean.autoPublish = value === '1';
      return null;
    }
    case 'dailyTarget': {
      const value = text(raw, field);
      if (!/^\d{1,3}$/.test(value) || Number(value) > 100) {
        return 'Posts per day must be a whole number from 0 to 100.';
      }
      clean.dailyTarget = Number(value);
      return null;
    }
    case 'gapAmount':
    case 'gapUnit': {
      // Judged together: the amount means nothing without its unit.
      const amount = text(raw, 'gapAmount');
      const unit = text(raw, 'gapUnit');
      if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
        return field === 'gapAmount' ? 'The gap must be a number, like 8 or 1.5.' : null;
      }
      if (!(unit in UNIT_MINUTES)) {
        return field === 'gapUnit' ? 'Choose minutes, hours or days.' : null;
      }
      const minutes = Math.round(Number(amount) * UNIT_MINUTES[unit as keyof typeof UNIT_MINUTES]);
      if (minutes > MAX_INTERVAL_MINUTES) {
        return field === 'gapAmount' ? 'The gap cannot be longer than 30 days.' : null;
      }
      clean.intervalMinutes = minutes;
      return null;
    }
    case 'bufferToken': {
      const value = text(raw, field);
      if (value && !/^\S{8,300}$/.test(value)) {
        return 'That does not look like a Buffer token. It has no spaces and is at least 8 characters.';
      }
      clean.bufferToken = value;
      return null;
    }
    case 'pinUsername': {
      const value = text(raw, field).replace(/^@/, '');
      if (value && !/^[A-Za-z0-9._-]{1,60}$/.test(value)) {
        return 'A Pinterest username has only letters, numbers, dots, dashes and underscores.';
      }
      clean.pinUsername = value;
      return null;
    }
    case 'projectId': {
      const value = text(raw, field);
      const problem = flowProjectProblem(value);
      if (problem) return problem;
      clean.projectId = value;
      return null;
    }
  }
}

/** Check the given fields (all of them when none are named). */
export function validate(raw: Raw, fields?: FieldName[]): Validated {
  const wanted: FieldName[] = fields ?? STEP_FIELDS.flat();
  const errors: Errors = {};
  const clean: Partial<CleanWebsite> = {};
  for (const field of wanted) {
    const problem = fieldCheck(field, raw, clean);
    if (problem) errors[field] = problem;
  }
  return { errors, clean };
}

/** The step a field belongs to, so a failed save can jump to it. */
export const stepOf = (field: FieldName): number =>
  STEP_FIELDS.findIndex((fields) => fields.includes(field));
