import type { ChatMessage } from '@aido/types';

/**
 * Token estimation (§38: "token estimation" is a tested unit).
 *
 * We cannot ship a per-model BPE tokenizer for every provider (that would be tens
 * of megabytes and would rot as models change), and we must never *invent* usage
 * numbers. So:
 *
 *  - estimate locally with a documented heuristic (used for *reservation sizing*
 *    and pre-flight checks only),
 *  - always prefer provider-reported usage for accounting, and
 *  - keep a per-model calibration factor derived from the difference between our
 *    estimate and the provider's real count, so estimates converge on reality.
 *
 * The estimator is intentionally conservative: over-estimating costs a little
 * headroom, under-estimating causes a 400 mid-run and wastes the whole request.
 */

export interface TokenEstimate {
  tokens: number;
  /** True when this is a heuristic (always, for local estimation). */
  estimated: true;
}

export interface TokenEstimatorOptions {
  /** Global fudge factor applied on top of the heuristic (1.0 = as-is). */
  globalFactor?: number;
  /** Per-model calibration factors, keyed by model id. */
  calibration?: (modelId: string) => number;
}

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

export class TokenEstimator {
  constructor(private readonly options: TokenEstimatorOptions = {}) {}

  /**
   * Heuristic character-class accounting:
   *   - ASCII prose: ~4 chars/token
   *   - ASCII code/punctuation: ~3 chars/token (many 1-char tokens: `{`, `}`, `;`)
   *   - CJK: ~1 token/char
   *   - emoji: ~2 tokens each
   *   - newlines/indentation: ~0.5 token each (whitespace runs often collapse)
   */
  estimate(text: string, kind: 'prose' | 'code' | 'mixed' = 'mixed'): TokenEstimate {
    if (!text) return { tokens: 0, estimated: true };

    let asciiNonspace = 0;
    let whitespace = 0;
    let cjk = 0;
    let emoji = 0;
    let other = 0;

    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code === 32 || code === 9 || code === 10 || code === 13) whitespace += 1;
      else if (code < 128) asciiNonspace += 1;
      else if (CJK.test(char)) cjk += 1;
      else if (EMOJI.test(char)) emoji += 1;
      else other += 1;
    }

    const charsPerToken = kind === 'code' ? 2.9 : kind === 'prose' ? 4.0 : 3.4;
    const core = asciiNonspace / charsPerToken;
    const accents = other / 2.2; // accented latin/cyrillic/greek: ~2.2 chars per token
    const whitespaceTokens = whitespace * 0.5;

    const raw = core + accents + cjk + emoji * 2 + whitespaceTokens;
    const scaled = raw * (this.options.globalFactor ?? 1.05); // small safety margin
    return { tokens: Math.max(1, Math.ceil(scaled)), estimated: true };
  }

  /** Chat overhead: each message costs a few tokens of framing for `<role>` markers. */
  estimateMessages(messages: ChatMessage[], modelId?: string): TokenEstimate {
    let total = 0;
    for (const message of messages) {
      const kind = looksLikeCode(message.content) ? 'code' : 'mixed';
      total += this.estimate(message.content, kind).tokens;
      total += 4; // role + delimiters, per OpenAI-style accounting guidance
    }
    total += 3; // priming for the assistant reply
    const factor = (this.options.calibration?.(modelId ?? '') ?? 1) * (this.options.globalFactor ?? 1.05);
    return { tokens: Math.max(1, Math.ceil(total * factor)), estimated: true };
  }

  /**
   * Updates the calibration factor for a model from observed reality.
   * Ratio is clamped to [0.5, 2.5] so a single pathological response cannot
   * permanently skew every future reservation.
   */
  calibrationUpdate(previous: number | null, estimatedTokens: number, actualInputTokens: number, alpha = 0.2): number {
    if (estimatedTokens <= 0 || actualInputTokens <= 0) return previous ?? 1;
    const ratio = clamp(actualInputTokens / estimatedTokens, 0.5, 2.5);
    if (previous === null || !Number.isFinite(previous)) return ratio;
    return previous * (1 - alpha) + ratio * alpha;
  }
}

export function looksLikeCode(text: string): boolean {
  if (!text) return false;
  const signalPatterns = [/[{};]\s*$/m, /^\s*(function|const|let|class|def|import|export|return|if|for|while)\b/m, /=>/, /<\/?[a-z][\w-]*>/i, /\b(SELECT|INSERT|UPDATE|CREATE TABLE)\b/i, /^\s*#\s*\w+/m];
  const matches = signalPatterns.reduce((count, re) => count + (re.test(text) ? 1 : 0), 0);
  return matches >= 2;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Splits text into chunks that fit a token budget, preferring paragraph and
 * sentence boundaries so summarisation of a large file stays coherent.
 */
export function chunkByTokens(estimator: TokenEstimator, text: string, maxTokens: number, kind: 'prose' | 'code' | 'mixed' = 'mixed'): string[] {
  if (estimator.estimate(text, kind).tokens <= maxTokens) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (estimator.estimate(candidate, kind).tokens > maxTokens && current) {
      chunks.push(current);
      current = paragraph;
      if (estimator.estimate(current, kind).tokens > maxTokens) {
        // A single paragraph exceeds the budget: fall back to hard slicing.
        const sliceSize = Math.max(1, Math.floor(paragraph.length * (maxTokens / Math.max(1, estimator.estimate(paragraph, kind).tokens))));
        for (let i = 0; i < paragraph.length; i += sliceSize) chunks.push(paragraph.slice(i, i + sliceSize));
        current = '';
      }
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((c) => c.trim().length > 0);
}
