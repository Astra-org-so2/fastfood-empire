/**
 * Provider + model domain types.
 *
 * IMPORTANT: nothing in this file encodes a *current* commercial fact as truth.
 * Every quota figure is optional and carries provenance (see `Provenance`) so the
 * UI can distinguish "we observed this from an API response header" from
 * "a human typed this in once" from "unknown". Free tiers change; we never
 * invent numbers.
 */

/** How a free/paid arrangement is funded. Only `free_renewable` is a renewable quota. */
export type QuotaType =
  | 'free_renewable'
  | 'free_trial'
  | 'paid'
  | 'unknown'
  | 'user_hosted';

export const QUOTA_TYPE_LABELS: Record<QuotaType, string> = {
  free_renewable: 'FREE_RENEWABLE',
  free_trial: 'FREE_TRIAL',
  paid: 'PAID',
  unknown: 'UNKNOWN',
  user_hosted: 'USER_HOSTED',
};

/** When a quota window rolls over. Never assume UTC midnight. */
export type ResetStrategy =
  | 'utc_midnight'
  | 'provider_timezone'
  | 'rolling_24h'
  | 'explicit_timestamp'
  | 'api_reported'
  | 'unknown';

export type QuotaWindow =
  | 'per_minute'
  | 'per_hour'
  | 'per_day'
  | 'per_month'
  | 'lifetime'
  | 'none';

/** Where a number came from. Drives UI trust labelling and routing confidence. */
export interface Provenance {
  source:
    | 'observed_header' // parsed from a live provider response
    | 'api_reported' // fetched from a provider usage/limits endpoint
    | 'provider_docs' // transcribed from official documentation (may be stale)
    | 'user_configured' // entered by the operator in Settings
    | 'inferred' // derived from measured behaviour (e.g. work backwards from 429s)
    | 'unknown';
  /** ISO timestamp of when this value was last confirmed. */
  observedAt?: string;
  /** Confidence in [0,1]; 1 = authoritative, 0.2 = guess. */
  confidence: number;
  /** Link to the documentation/endpoint that justifies the value, if any. */
  reference?: string;
  note?: string;
}

export type ProviderKind =
  | 'openai_compatible' // /chat/completions + /models
  | 'google_generative' // generateContent / streamGenerateContent
  | 'anthropic_messages' // reserved for future adapters
  | 'custom' // adapter implements everything itself
  | 'simulated'; // local simulator provider (never counts as a real provider)

export type AuthenticationType = 'api_key' | 'api_key_pair' | 'bearer' | 'none' | 'oauth';

export interface ModelCapabilities {
  chat: boolean;
  streaming: boolean;
  reasoning: boolean;
  vision: boolean;
  tools: boolean;
  structuredOutput: boolean;
  jsonMode: boolean;
  codeGeneration: boolean;
  longContext: boolean;
  imageGeneration: boolean;
  embeddings: boolean;
}

export const EMPTY_CAPABILITIES: ModelCapabilities = {
  chat: false,
  streaming: false,
  reasoning: false,
  vision: false,
  tools: false,
  structuredOutput: false,
  jsonMode: false,
  codeGeneration: false,
  longContext: false,
  imageGeneration: false,
  embeddings: false,
};

export type CapabilityName = keyof ModelCapabilities;

export type ModelStatus = 'online' | 'degraded' | 'offline' | 'unknown';

export interface ModelPricing {
  /** USD per 1M tokens. `null` when the provider does not publish it for this model. */
  inputPerMillionTokens: number | null;
  outputPerMillionTokens: number | null;
  provenance: Provenance;
}

export interface ModelQuotaLimits {
  requestsPerMinute: number | null;
  requestsPerHour: number | null;
  requestsPerDay: number | null;
  requestsPerMonth: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  /** Provider-side concurrency cap if documented. */
  concurrentRequests: number | null;
  resetStrategy: ResetStrategy;
  resetTimezone: string | null;
  provenance: Provenance;
}

export interface ModelPerformance {
  /** EWMA of full-response latency in ms for successful calls. */
  averageLatency: number | null;
  /** Time to first token EWMA in ms (streaming calls only). */
  averageFirstTokenLatency: number | null;
  /** Output tokens per second EWMA. */
  throughput: number | null;
  /** Successful / total, EWMA in [0,1]. */
  successRate: number | null;
  /** Number of samples behind the above metrics. */
  samples: number;
}

export interface ModelInfo {
  /** Globally unique: `${providerId}:${providerModelId}`. */
  id: string;
  providerId: string;
  /** The identifier the provider's API expects on the wire. */
  providerModelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  quota: ModelQuotaLimits;
  quotaType: QuotaType;
  performance: ModelPerformance;
  status: ModelStatus;
  enabled: boolean;
  /** Higher = preferred when everything else is equal. Operator controlled. */
  priority: number;
  /** 0..1 subjective quality prior used by the router; operator controlled. */
  qualityPrior: number;
  /** Which task types this model is known-good at (learned or configured). */
  strengths: TaskType[];
  discoveredAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

/** Provider-level declaration loaded from config/providers/*.json (data, not code). */
export interface ProviderDefinition {
  id: string;
  name: string;
  kind: ProviderKind;
  documentationUrl: string | null;
  apiBaseUrl: string;
  authenticationType: AuthenticationType;
  /** Extra credential fields, e.g. Cloudflare's account id. */
  credentialFields?: { key: string; label: string; required: boolean; secret: boolean }[];
  freeTier: {
    available: boolean | null;
    quotaType: QuotaType;
    resetStrategy: ResetStrategy;
    resetTimezone: string | null;
    note: string;
  };
  capabilities: CapabilityName[];
  /** Env var fallbacks, in priority order. */
  envKeys: string[];
  modelsEndpoint: string | null;
  /** REST path returning current usage/limits, when the provider exposes one. */
  usageEndpoint: string | null;
  /** Health probe: a cheap GET that returns 2xx when the key works. */
  healthEndpoint: string | null;
  /** Map of provider header names -> telemetry keys. Avoids hard-coding in core. */
  telemetry?: Partial<Record<TelemetryField, string[]>>;
  /**
   * Semantic meaning of the telemetry a provider reports. Providers use the same
   * header names for different windows (Groq's `x-ratelimit-limit-requests` is a
   * *daily* request cap while `x-ratelimit-limit-tokens` is a *per-minute* token
   * cap), so the interpretation must be declared as data rather than assumed.
   */
  telemetrySemantics?: {
    requests?: QuotaWindow;
    tokens?: QuotaWindow;
  };
  /** Documented limits, editable. `null` means "not asserted". */
  quotaLimits: Omit<ModelQuotaLimits, 'provenance'> | null;
  /** Known model ids with capability hints; discovery augments/overrides this. */
  seedModels?: ProviderSeedModel[];
  /** True when this definition is a local simulator, not a real provider. */
  simulated?: boolean;
  notes: string;
  /** Whether the operator/author verified the metadata against provider docs. */
  metadataVerified: boolean;
  lastVerifiedAt: string | null;
}

export interface ProviderSeedModel {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: Partial<ModelCapabilities>;
  quotaType?: QuotaType;
}

export type TelemetryField =
  | 'requestsRemaining'
  | 'requestsLimit'
  | 'tokensRemaining'
  | 'tokensLimit'
  | 'resetRequests'
  | 'resetTokens'
  | 'retryAfter';

export interface RateLimitTelemetry {
  requestsRemaining?: number;
  requestsLimit?: number;
  tokensRemaining?: number;
  tokensLimit?: number;
  resetRequests?: string;
  resetTokens?: string;
  retryAfter?: string;
}

export type ProviderHealthStatus = 'online' | 'degraded' | 'offline' | 'unconfigured' | 'disabled' | 'unknown';

export interface ProviderHealth {
  providerId: string;
  status: ProviderHealthStatus;
  checkedAt: string;
  latencyMs: number | null;
  message: string | null;
  consecutiveFailures: number;
}

export type CredentialStatus =
  | { state: 'valid'; checkedAt: string; detail?: string }
  | { state: 'invalid'; checkedAt: string; detail: string }
  | { state: 'unconfigured'; checkedAt: string; detail?: string }
  | { state: 'unverified'; checkedAt: string; detail?: string };

export type AuthResult = { ok: true; detail?: string } | { ok: false; error: string };

export interface UsageInfo {
  requestsToday: number | null;
  tokensToday: number | null;
  /** Provider-reported remaining budget, when the provider exposes it. */
  reportedRemaining?: Record<string, number | string | null> | undefined;
  provenance: Provenance;
}

export interface QuotaSnapshot {
  providerId: string;
  modelId: string | null;
  quotaType: QuotaType;
  /** Window the snapshot describes. */
  window: QuotaWindow;
  limit: number | null;
  used: number;
  remaining: number | null;
  /** 0..1; null when the limit is unknown. */
  remainingFraction: number | null;
  resetsAt: string | null;
  resetStrategy: ResetStrategy;
  resetIsEstimated: boolean;
  provenance: Provenance;
  cooldownUntil: string | null;
}

/**
 * Quota bucket persisted in the DB. Composite key is
 * (providerId, modelId|null, window, windowStart).
 */
export interface QuotaBucket {
  id: string;
  providerId: string;
  /** null = provider-wide bucket. */
  modelId: string | null;
  window: QuotaWindow;
  windowStart: string;
  windowEnd: string;
  limitTokens: number | null;
  usedTokens: number;
  reservedTokens: number;
  limitRequests: number | null;
  usedRequests: number;
  reservedRequests: number;
  updatedAt: string;
}

export interface QuotaReservation {
  id: string;
  providerId: string;
  modelId: string;
  bucketIds: string[];
  estimatedTokens: number;
  traceId: string;
  taskId: string | null;
  agentId: string | null;
  createdAt: string;
  expiresAt: string;
  settledAt: string | null;
  settledTokens: number | null;
  status: 'reserved' | 'committed' | 'released' | 'expired';
}

export type TaskType =
  | 'architecture'
  | 'planning'
  | 'code_generation'
  | 'refactor'
  | 'test_generation'
  | 'test_execution_analysis'
  | 'security_audit'
  | 'code_review'
  | 'documentation'
  | 'research'
  | 'devops'
  | 'database_design'
  | 'performance_analysis'
  | 'summarization'
  | 'classification'
  | 'general';

/** Runtime list of every task type, so UIs and policies can enumerate them. */
export const TASK_TYPES: readonly TaskType[] = [
  'architecture',
  'planning',
  'code_generation',
  'refactor',
  'test_generation',
  'test_execution_analysis',
  'security_audit',
  'code_review',
  'documentation',
  'research',
  'devops',
  'database_design',
  'performance_analysis',
  'summarization',
  'classification',
  'general',
];

export type Priority = 'low' | 'normal' | 'high' | 'critical';
