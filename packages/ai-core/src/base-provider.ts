import { randomUUID } from 'node:crypto';
import {
  EMPTY_CAPABILITIES,
  ProviderError,
  type AuthResult,
  type ChatChunk,
  type ChatRequest,
  type ChatResponse,
  type CredentialStatus,
  type ModelCapabilities,
  type ModelInfo,
  type ProviderDefinition,
  type QuotaSnapshot,
  type UsageInfo,
} from '@aido/types';
import type { LLMProviderCapabilities } from '@aido/types';
import type { Logger } from '@aido/observability';
import { HttpClient, type RequestOptions } from './http.js';
import { TokenEstimator } from './tokens.js';
import { NOT_SUPPORTED, type HealthStatus, type LLMProvider, type ProviderConstructorOptions } from './provider.js';

/**
 * Shared adapter skeleton.
 *
 * Everything that is identical across providers lives here; adapters only supply
 * wire-format specifics (paths, headers, body shape, response parsing). This is
 * what keeps "add a provider" down to a single file (§52).
 */
export abstract class BaseProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly definition: ProviderDefinition;
  readonly capabilities: LLMProviderCapabilities;
  protected readonly http: HttpClient;
  protected readonly estimator: TokenEstimator;
  protected readonly logger: Logger;
  protected readonly timeoutMs: number;

  /** Discovered models keyed by provider model id (populated by listModels). */
  private readonly modelCache = new Map<string, ModelInfo>();
  /** Per-model estimate calibration; shared with the quota engine through the router. */
  private readonly calibration = new Map<string, number>();

  constructor(options: ProviderConstructorOptions, capabilities: LLMProviderCapabilities = NOT_SUPPORTED) {
    this.id = options.definition.id;
    this.name = options.definition.name;
    this.definition = options.definition;
    this.capabilities = capabilities;
    this.logger = options.logger.child({ provider: options.definition.id, scope: 'provider' });
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.http = new HttpClient({
      fetchImpl: options.fetchImpl,
      baseUrl: options.apiBaseUrl ?? options.definition.apiBaseUrl,
      defaultHeaders: {},
    });
    this.estimator = new TokenEstimator({ calibration: (modelId) => this.calibration.get(modelId) ?? 1 });
    this.resolveCredential = options.resolveCredential;
  }

  protected readonly resolveCredential: (field: string) => string | null;

  // -------------------------------------------------------------------------
  // Credential handling
  // -------------------------------------------------------------------------

  protected requireCredential(field = 'apiKey'): string {
    const value = this.resolveCredential(field);
    if (!value) {
      throw new ProviderError({
        category: 'authentication',
        message: `No credential configured for ${this.name}. Add it in Settings → Providers.`,
        providerId: this.id,
      });
    }
    return value;
  }

  protected hasCredential(field = 'apiKey'): boolean {
    return this.resolveCredential(field) !== null;
  }

  async authenticate(): Promise<AuthResult> {
    if (this.definition.authenticationType === 'none') return { ok: true, detail: 'No authentication required.' };
    const required = this.definition.credentialFields?.filter((f) => f.required) ?? [{ key: 'apiKey' }];
    const missing = required.filter((f) => !this.hasCredential(f.key)).map((f) => f.key);
    if (missing.length) return { ok: false, error: `Missing credential field(s): ${missing.join(', ')}` };
    return { ok: true };
  }

  async validateCredentials(): Promise<CredentialStatus> {
    const auth = await this.authenticate();
    const checkedAt = new Date().toISOString();
    if (!auth.ok) return { state: 'unconfigured', checkedAt, detail: auth.error ?? 'not configured' };
    try {
      const health = await this.healthCheck();
      return health.ok
        ? { state: 'valid', checkedAt, detail: health.message ?? undefined }
        : { state: 'invalid', checkedAt, detail: health.message ?? 'credential check failed' };
    } catch (err) {
      const error = err instanceof ProviderError ? err : null;
      if (error?.category === 'authentication') return { state: 'invalid', checkedAt, detail: error.message };
      // A network problem is not proof that the key is wrong — say so explicitly
      // instead of showing a false "invalid key" (§46).
      return { state: 'unverified', checkedAt, detail: error?.message ?? String(err) };
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    const checkedAt = new Date().toISOString();
    const endpoint = this.definition.healthEndpoint;
    if (!endpoint || !this.capabilities.usageReporting === false) {
      // Fall through to a model listing when a dedicated health endpoint is absent.
    }
    if (!endpoint) {
      return { ok: false, status: 'offline', latencyMs: null, message: 'No health endpoint defined for this provider.', checkedAt };
    }
    try {
      const started = Date.now();
      await this.http.request(endpoint, this.requestOptions({ method: 'GET', timeoutMs: 15_000, detectDailyQuota: false }));
      const latencyMs = Date.now() - started;
      return {
        ok: true,
        status: latencyMs > 5_000 ? 'degraded' : 'online',
        latencyMs,
        message: latencyMs > 5_000 ? `Responded slowly (${latencyMs}ms)` : null,
        checkedAt,
      };
    } catch (err) {
      const error = err instanceof ProviderError ? err : null;
      return {
        ok: false,
        status: 'offline',
        latencyMs: null,
        message: error ? `${error.category}: ${error.message}` : String(err),
        checkedAt,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Defaults that most providers share
  // -------------------------------------------------------------------------

  async estimateTokens(input: string): Promise<number> {
    return this.estimator.estimate(input, 'mixed').tokens;
  }

  /** Calibration hook used after a real response arrives. */
  protected calibrate(modelId: string, estimatedTokens: number, actualTokens: number): void {
    const previous = this.calibration.get(modelId) ?? null;
    this.calibration.set(modelId, this.estimator.calibrationUpdate(previous, estimatedTokens, actualTokens));
  }

  async getUsage(): Promise<UsageInfo> {
    // Providers that do not expose usage must return nulls, never a guess.
    return {
      requestsToday: null,
      tokensToday: null,
      provenance: { source: 'unknown', confidence: 0, note: `${this.name} does not expose usage totals through its API.` },
    };
  }

  async getQuota(): Promise<QuotaSnapshot[]> {
    const limits = this.definition.quotaLimits;
    if (!limits) return [];
    return [
      {
        providerId: this.id,
        modelId: null,
        quotaType: this.definition.freeTier.quotaType,
        window: limits.requestsPerDay || limits.tokensPerDay ? 'per_day' : 'per_minute',
        limit: limits.tokensPerDay ?? limits.tokensPerMinute ?? limits.requestsPerDay ?? limits.requestsPerMinute,
        used: 0,
        remaining: null,
        remainingFraction: null,
        resetsAt: null,
        resetStrategy: this.definition.freeTier.resetStrategy,
        resetIsEstimated: true,
        provenance: {
          source: 'provider_docs',
          confidence: 0.2,
          note: 'Configured limit; actual remaining budget is learned from responses or the operator.',
        },
        cooldownUntil: null,
      },
    ];
  }

  async getModel(modelId: string): Promise<ModelInfo | null> {
    const cached = this.modelCache.get(modelId);
    if (cached) return cached;
    const models = await this.listModels();
    return models.find((m) => m.providerModelId === modelId || m.id === modelId) ?? null;
  }

  protected cacheModels(models: ModelInfo[]): void {
    for (const model of models) this.modelCache.set(model.providerModelId, model);
  }

  // -------------------------------------------------------------------------
  // Adapter hooks
  // -------------------------------------------------------------------------

  abstract listModels(): Promise<ModelInfo[]>;
  abstract chat(request: ChatRequest): Promise<ChatResponse>;
  abstract stream(request: ChatRequest): AsyncIterable<ChatChunk>;

  /** Builds the base request options every adapter call needs. */
  protected requestOptions(options: Partial<RequestOptions> & { method?: RequestOptions['method'] }): RequestOptions {
    return {
      providerId: this.id,
      telemetryMap: this.definition.telemetry as RequestOptions['telemetryMap'],
      timeoutMs: this.timeoutMs,
      ...options,
    };
  }

  protected authHeaders(): Record<string, string> {
    switch (this.definition.authenticationType) {
      case 'bearer':
      case 'api_key':
        return { authorization: `Bearer ${this.requireCredential()}` };
      case 'api_key_pair':
        // Providers using a pair (Cloudflare) override this.
        return { authorization: `Bearer ${this.requireCredential()}` };
      case 'none':
        return {};
      default:
        return { authorization: `Bearer ${this.requireCredential()}` };
    }
  }

  protected traceIdFor(request: ChatRequest): string {
    return request.traceId || randomUUID();
  }

  protected mergeCapabilities(partial: Partial<ModelCapabilities>): ModelCapabilities {
    return { ...EMPTY_CAPABILITIES, chat: true, ...partial };
  }
}
