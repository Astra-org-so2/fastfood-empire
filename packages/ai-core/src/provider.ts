import type {
  AuthResult,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  CredentialStatus,
  ModelInfo,
  ProviderDefinition,
  QuotaSnapshot,
  UsageInfo,
} from '@aido/types';
import type { LLMProviderCapabilities } from '@aido/types';
import { ProviderError } from '@aido/types';
import type { Logger } from '@aido/observability';

/**
 * The provider contract (§4).
 *
 * Deliberately shaped so an adapter never has to implement something it cannot do:
 *  - `capabilities` advertises what is real for this provider today,
 *  - unimplemented optional operations return a `not_supported` result via
 *    `BaseProvider` rather than throwing or lying,
 *  - `chat` and `stream` are the only methods with no safe default; adapters that
 *    lack streaming keep `capabilities.streaming = false` and `stream()` throws a
 *    typed `ProviderError` with category `invalid_request` (the router never calls
 *    it for such a provider).
 */
export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly definition: ProviderDefinition;
  readonly capabilities: LLMProviderCapabilities;

  /** Prepares whatever client state the provider needs (no network by default). */
  authenticate(): Promise<AuthResult>;

  /** Performs a real, cheap network call to verify the key works. */
  validateCredentials(): Promise<CredentialStatus>;

  /** Enumerates models from the provider API (never from a stale hard-coded list). */
  listModels(): Promise<ModelInfo[]>;

  getModel(modelId: string): Promise<ModelInfo | null>;

  estimateTokens(input: string): Promise<number>;

  chat(request: ChatRequest): Promise<ChatResponse>;

  stream(request: ChatRequest): AsyncIterable<ChatChunk>;

  /** Real usage if the provider exposes it; `null` fields when it does not. */
  getUsage(): Promise<UsageInfo>;

  /** Real remaining budget if known; otherwise snapshots with `remaining: null`. */
  getQuota(): Promise<QuotaSnapshot[]>;

  healthCheck(): Promise<HealthStatus>;
}

export interface HealthStatus {
  ok: boolean;
  status: 'online' | 'degraded' | 'offline';
  latencyMs: number | null;
  message: string | null;
  checkedAt: string;
}

export const NOT_SUPPORTED: LLMProviderCapabilities = {
  streaming: false,
  modelDiscovery: false,
  usageReporting: false,
  rateLimitTelemetry: false,
  tools: false,
  jsonMode: false,
};

export function notSupported(providerId: string, operation: string): ProviderError {
  return new ProviderError({
    category: 'invalid_request',
    message: `Provider "${providerId}" does not support ${operation}. Capability flags must be checked before calling it.`,
    providerId,
  });
}

export interface ProviderConstructorOptions {
  definition: ProviderDefinition;
  /** Resolved at call time so a rotated key is picked up without a restart. */
  resolveCredential: (field: string) => string | null;
  logger: Logger;
  /** Overridable for tests (MSW-free: we inject a fetch implementation). */
  fetchImpl?: typeof fetch;
  /** Base URL override from provider settings. */
  apiBaseUrl?: string;
  /** Extra request timeout. */
  timeoutMs?: number;
}

export type ProviderConstructor = new (options: ProviderConstructorOptions) => LLMProvider;
