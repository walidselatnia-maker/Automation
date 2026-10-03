import { findDuplicate } from '../core/similar-title.js';
import { getSite } from '../db/repos.js';
import { NoEndpointAvailableError } from '../llm/client.js';
import { createLogger, errorMessage } from '../lib/logger.js';
import { tryParseJson } from '../pipeline/json.js';
import {
  addMessage,
  existingKeywordsForSite,
  getCursor,
  getResult,
  listMessages,
  siteContext,
} from './state.js';
import { stepDef, validateResult, type KeywordsResult, type StepKey } from './steps.js';

const log = createLogger('guide');

/**
 * The guide's assistant: one model call per message, with the site's own
 * decisions folded into the variables so it never asks twice.
 *
 * The model is reached through `ask`, which the server wires to askPrompt --
 * the same endpoint pool and failover the pipeline uses -- and tests replace.
 */

export type Ask = (promptName: string, variables: Record<string, unknown>) => Promise<string>;
export type Suggest = (seeds: string[]) => Promise<string[]>;

export interface AssistantDeps {
  ask: Ask;
  suggest: Suggest;
}

export interface AssistantReply {
  message: string;
  choices: string[];
  multi: boolean;
  draft: unknown | null;
}

export interface ParsedReply {
  reply: AssistantReply;
  /** Step 4 only: phrases to check against Google before picking. */
  seeds: string[];
  pillar: string;
  /** Why a draft was rejected, to hand back to the model once. */
  problem: string | null;
}

/** What the "I'm stuck" button sends. */
export const STUCK_TEXT = "I'm stuck. Break this into tiny steps and ask me one easy question.";

const CONFUSED: AssistantReply = {
  message: 'I got confused — tap 🔄 to try again.',
  choices: ['🔄 Try again'],
  multi: false,
  draft: null,
};

const UNREACHABLE: AssistantReply = {
  message: "The assistant can't reach a model right now. You can still type your answer in the box below.",
  choices: [],
  multi: false,
  draft: null,
};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    : [];

export function parseReply(raw: string, step: StepKey): ParsedReply | null {
  const parsed = tryParseJson<Record<string, unknown>>(raw);
  if (!parsed) return null;
  const v = parsed.value;

  const message = typeof v.message === 'string' ? v.message.trim() : '';
  if (!message) return null;

  let draft: unknown = null;
  let problem: string | null = null;
  if (v.draft !== null && v.draft !== undefined) {
    const checked = validateResult(step, v.draft);
    if (checked.ok) draft = checked.value;
    else problem = checked.problem;
  }

  return {
    reply: { message, choices: strings(v.choices).slice(0, 8), multi: v.multi === true, draft },
    seeds: strings(v.seeds),
    pillar: typeof v.pillar === 'string' ? v.pillar.trim() : '',
    problem,
  };
}

function historyText(siteId: number, step: StepKey, round: number): string {
  const lines = listMessages(siteId, step, round)
    .slice(-20)
    .map((m) => `${m.role === 'user' ? 'THEM' : 'YOU'}: ${m.content}`);
  return lines.length ? lines.join('\n') : '(nothing yet)';
}

/** Step-specific data the prompt needs, computed fresh each call. */
function initialExtra(siteId: number, step: StepKey, round: number): Record<string, unknown> {
  if (step === 'keywords') return { phase: 'start' };
  if (step === 'shortlist') {
    const collected = getResult<KeywordsResult>(siteId, 'keywords', round);
    const existing = existingKeywordsForSite(siteId).map((title) => ({ title, url: null }));
    const keywords: string[] = [];
    const alreadyHave: string[] = [];
    for (const keyword of collected?.keywords ?? []) {
      (findDuplicate(keyword, existing) ? alreadyHave : keywords).push(keyword);
    }
    return { pillar: collected?.pillar ?? '', keywords, already_have: alreadyHave };
  }
  return {};
}

export async function respond(
  deps: AssistantDeps,
  siteId: number,
  userText: string | null,
): Promise<AssistantReply> {
  const cursor = getCursor(siteId);
  const def = stepDef(cursor.step);
  const site = getSite(siteId);
  if (!def.prompt || !site) {
    return { message: 'There is no assistant on this step.', choices: [], multi: false, draft: null };
  }
  const prompt = def.prompt;

  const text = (userText ?? '').trim();
  // History first, so it holds what came before this message, not the message itself.
  const history = historyText(siteId, cursor.step, cursor.round);
  if (text) addMessage(siteId, cursor.step, cursor.round, 'user', text);

  const ctx = siteContext(siteId, cursor.round);
  const base = {
    site_name: site.name,
    site_domain: site.domain,
    identity: ctx.identity || '(not decided yet)',
    pillars: ctx.pillars.join(', ') || '(not decided yet)',
    current_pillar: ctx.currentPillar || '(not chosen yet)',
    step_title: def.title,
    step_goal: def.goal,
    user_text: text,
    history,
  };

  const call = async (extra: Record<string, unknown>): Promise<ParsedReply | null> =>
    parseReply(await deps.ask(prompt, { ...base, extra }), cursor.step);

  try {
    let extra = initialExtra(siteId, cursor.step, cursor.round);
    let parsed = await call(extra);

    // Step 4: the model proposes seeds, Google says what people really type,
    // and the model picks only from that. The "checking…" reply is not kept.
    if (parsed && cursor.step === 'keywords' && parsed.seeds.length) {
      let suggestions: string[] = [];
      try {
        suggestions = await deps.suggest(parsed.seeds);
      } catch {
        // If Google check fails, degrade to unverified keywords rather than stopping the step
      }
      extra = {
        phase: 'pick',
        pillar: parsed.pillar || ctx.currentPillar,
        suggestions,
        verified: suggestions.length > 0,
      };
      parsed = await call(extra);
    }

    // One second chance for a draft that did not fit its shape.
    if (parsed?.problem) {
      parsed = await call({ ...extra, problem: parsed.problem });
      if (parsed?.problem) parsed = null;
    }

    if (!parsed) return CONFUSED;

    const out = parsed.reply;
    if (cursor.step === 'keywords' && out.draft && extra.verified === false) {
      (out.draft as KeywordsResult).verified = false;
    }

    addMessage(siteId, cursor.step, cursor.round, 'assistant', out.message, {
      choices: out.choices,
      multi: out.multi,
      draft: out.draft,
    });
    return out;
  } catch (err) {
    if (err instanceof NoEndpointAvailableError) return UNREACHABLE;
    log.warn(`guide assistant failed on ${cursor.step}: ${errorMessage(err)}`);
    return CONFUSED;
  }
}
