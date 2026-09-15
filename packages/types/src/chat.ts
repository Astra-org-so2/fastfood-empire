/**
 * Chat / completion transport types shared by every provider adapter.
 * Providers that cannot support a field simply ignore it (capability flags tell
 * the router what is safe to request).
 */
import type { RateLimitTelemetry, TelemetryField } from './provider.js';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Set for role='tool'. */
  name?: string;
  /** Untrusted-content marker: adapters/prompt builders fence these. */
  trust?: 'trusted' | 'untrusted';
}

export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; schema: Record<string, unknown>; name: string };

export interface ChatRequest {
  modelId: string;
  messages: ChatMessage[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stop?: string[];
  tools?: ChatToolDefinition[];
  responseFormat?: ResponseFormat;
  seed?: number;
  /** Trace correlation. */
  traceId: string;
  taskId?: string | null;
  agentId?: string | null;
  /** Milliseconds before the adapter aborts. */
  timeoutMs?: number;
  /** Ask the adapter to actively report rate-limit telemetry when available. */
  collectTelemetry?: boolean;
  /** Arbitrary provider-specific passthrough (validated by adapters). */
  extra?: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** True when numbers came from a local estimator rather than the provider. */
  estimated: boolean;
}

export interface ChatResponse {
  traceId: string;
  providerId: string;
  modelId: string;
  content: string;
  finishReason: 'stop' | 'length' | 'tool_call' | 'content_filter' | 'error' | 'unknown';
  toolCalls?: { id: string; name: string; arguments: string }[];
  usage: TokenUsage;
  latencyMs: number;
  firstTokenLatencyMs?: number;
  telemetry?: RateLimitTelemetry;
  raw?: unknown;
}

export interface ChatChunk {
  traceId: string;
  delta: string;
  finishReason?: ChatResponse['finishReason'];
  usage?: TokenUsage;
  telemetry?: RateLimitTelemetry;
}

/** Error taxonomy: retrying the wrong class of error wastes free quota. */
export type ErrorCategory =
  | 'timeout'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'authentication'
  | 'invalid_request'
  | 'context_length'
  | 'server_error'
  | 'model_unavailable'
  | 'network_error'
  | 'content_filter'
  | 'cancelled'
  | 'unknown';

const RETRYABLE: Record<ErrorCategory, boolean> = {
  timeout: true,
  rate_limit: true,
  quota_exhausted: false, // retrying immediately cannot help; fail over instead
  authentication: false,
  invalid_request: false,
  context_length: false, // must shrink the prompt first
  server_error: true,
  model_unavailable: true,
  network_error: true,
  content_filter: false,
  cancelled: false,
  unknown: true,
};

export class ProviderError extends Error {
  readonly category: ErrorCategory;
  readonly providerId: string;
  readonly modelId: string | null;
  readonly retryAfterMs: number | null;
  readonly attempts: number;
  readonly retryable: boolean;
  override readonly cause?: unknown;
  readonly telemetry?: RateLimitTelemetry;

  constructor(init: {
    category: ErrorCategory;
    message: string;
    providerId: string;
    modelId?: string | null;
    retryAfterMs?: number | null;
    attempts?: number;
    cause?: unknown;
    telemetry?: RateLimitTelemetry;
    retryable?: boolean;
  }) {
    super(init.message);
    this.name = 'ProviderError';
    this.category = init.category;
    this.providerId = init.providerId;
    this.modelId = init.modelId ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
    this.attempts = init.attempts ?? 1;
    this.retryable = init.retryable ?? RETRYABLE[init.category];
    this.cause = init.cause;
    this.telemetry = init.telemetry;
  }

  static isRetryableCategory(category: ErrorCategory): boolean {
    return RETRYABLE[category];
  }

  toJSON() {
    return {
      name: this.name,
      category: this.category,
      message: this.message,
      providerId: this.providerId,
      modelId: this.modelId,
      retryAfterMs: this.retryAfterMs,
      retryable: this.retryable,
      attempts: this.attempts,
    };
  }
}

export interface LLMProviderCapabilities {
  /** Can the adapter stream? */
  streaming: boolean;
  /** Can the adapter enumerate models over the network? */
  modelDiscovery: boolean;
  /** Can the adapter report real usage/limits from the provider? */
  usageReporting: boolean;
  /** Does the provider emit rate-limit telemetry we can parse? */
  rateLimitTelemetry: boolean;
  tools: boolean;
  jsonMode: boolean;
  /**
   * Whether an explicit `optional*` method is implemented at all. Methods that
   * are not implemented return a `not_supported` stub instead of throwing.
   */
  [key: string]: boolean;
}

export type { TelemetryField, RateLimitTelemetry };
