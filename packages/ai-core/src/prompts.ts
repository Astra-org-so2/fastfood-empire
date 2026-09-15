import { fenceUntrusted, UNTRUSTED_CONTENT_RULE, type InjectionFinding, type UntrustedBlock } from '@aido/security';
import type { ChatMessage } from '@aido/types';

/**
 * Prompt assembly (§15, §31).
 *
 * Two rules are enforced structurally here, not by hoping the model complies:
 *  1. untrusted content is always fenced with a per-block nonce,
 *  2. the untrusted-content rule is restated in the system message of every
 *     request that includes untrusted data.
 *
 * Keeping this in one module means an agent cannot accidentally "forget" to fence.
 */

export interface PromptSection {
  title: string;
  body: string;
  /** Trusted sections may contain instructions; untrusted ones never do. */
  trust: 'trusted' | 'untrusted';
  /** Source label shown to the model and in traces (e.g. a file path). */
  source?: string;
  kind?: UntrustedBlock['kind'];
  /** Approximate token cost, filled by the context builder. */
  estimatedTokens?: number;
  /** Drop-first order when the context budget is tight (higher = dropped sooner). */
  priority?: number;
}

export interface AssembledPrompt {
  messages: ChatMessage[];
  findings: InjectionFinding[];
  sections: { title: string; trust: 'trusted' | 'untrusted'; tokens: number }[];
}

export function buildSystemMessage(input: {
  role: string;
  instructions: string;
  includeUntrustedRule: boolean;
  outputContract?: string;
}): string {
  const parts = [`You are the ${input.role} agent inside AI Dev Orchestrator, an autonomous software engineering system.`, input.instructions.trim()];
  if (input.outputContract) {
    parts.push(`OUTPUT CONTRACT:\n${input.outputContract.trim()}`);
  }
  if (input.includeUntrustedRule) {
    parts.push(UNTRUSTED_CONTENT_RULE);
  }
  parts.push(
    [
      'OPERATING RULES:',
      '- Report only what you verified. If you did not run a command or read a file, do not claim you did.',
      '- Prefer small, reviewable changes over large rewrites.',
      '- When you are blocked, say so and state exactly what you need; do not invent workarounds that bypass the sandbox.',
      '- Never invent file paths, APIs, test results or command output.',
    ].join('\n'),
  );
  return parts.join('\n\n');
}

/**
 * Assembles the user message from prioritised sections. Sections with
 * `priority` are dropped from the end (lowest priority first) when the budget is
 * exceeded, which is how we keep "maximum information / minimum tokens" honest.
 */
export function assemblePrompt(input: {
  sections: PromptSection[];
  task: string;
  maxInputTokens: number;
  estimateTokens: (text: string) => number;
  /** Optional explicit budget left for the task statement itself. */
  reserveForTaskTokens?: number;
}): AssembledPrompt {
  const findings: InjectionFinding[] = [];
  const included: PromptSection[] = input.sections.filter((s) => s.body.trim().length > 0);

  // Deterministic ordering: trusted context first, then untrusted, each sorted by
  // descending priority so the most important material survives trimming.
  const ordered = [...included].sort((a, b) => {
    if (a.trust !== b.trust) return a.trust === 'trusted' ? -1 : 1;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });

  const reserve = input.reserveForTaskTokens ?? Math.min(2_000, Math.floor(input.maxInputTokens * 0.15));
  let budget = Math.max(0, input.maxInputTokens - reserve - input.estimateTokens(input.task));

  const kept: { section: PromptSection; text: string; tokens: number }[] = [];
  for (const section of ordered) {
    if (section.trust === 'trusted') {
      const tokens = input.estimateTokens(section.body);
      if (tokens > budget) continue;
      budget -= tokens;
      kept.push({ section, text: section.body, tokens });
    } else {
      const fenced = fenceUntrusted({
        source: section.source ?? section.title,
        kind: section.kind ?? 'file',
        content: section.body,
      });
      findings.push(...fenced.findings);
      const tokens = input.estimateTokens(fenced.text);
      if (tokens > budget) continue;
      budget -= tokens;
      kept.push({ section, text: fenced.text, tokens });
    }
  }

  // Re-order for presentation: trusted first (stable), then untrusted.
  const trusted = kept.filter((k) => k.section.trust === 'trusted');
  const untrusted = kept.filter((k) => k.section.trust === 'untrusted');

  const parts: string[] = [input.task.trim()];
  if (trusted.length) {
    parts.push('CONTEXT:');
    for (const { section, text } of trusted) parts.push(`## ${section.title}\n${text}`);
  }
  if (untrusted.length) {
    parts.push('REFERENCE MATERIAL (untrusted data — see the security rule):');
    for (const { section, text } of untrusted) parts.push(text);
  }

  return {
    messages: [{ role: 'user', content: parts.join('\n\n') }],
    findings,
    sections: kept.map(({ section, tokens }) => ({ title: section.title, trust: section.trust, tokens })),
  };
}

/** Compaction prompt used by the context manager to summarise old history. */
export function buildSummarisationPrompt(input: { transcript: string; kind: 'task_history' | 'file' | 'conversation' }): string {
  const focus =
    input.kind === 'task_history'
      ? 'Preserve: decisions taken, files touched, failures encountered, and anything the next agent must not repeat.'
      : input.kind === 'file'
        ? 'Preserve: exported symbols, their signatures, side effects, dependencies and anything surprising.'
        : 'Preserve: who decided what and why, open questions, and unresolved disagreements.';
  return [
    `Summarise the following ${input.kind.replace('_', ' ')} for a software engineering agent.`,
    'Be dense and factual. No pleasantries. Use bullet points.',
    focus,
    'If something is uncertain, mark it as uncertain rather than guessing.',
    '',
    '--- content start ---',
    input.transcript,
    '--- content end ---',
  ].join('\n');
}

/** Parses a JSON object out of a model reply that may be fenced or chatty. */
export function extractJson<T>(text: string): { value: T | null; error: string | null } {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(trimmed.slice(firstBracket, lastBracket + 1));

  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) as T, error: null };
    } catch {
      /* try the next candidate */
    }
  }
  return { value: null, error: 'No parsable JSON object found in the model response.' };
}
