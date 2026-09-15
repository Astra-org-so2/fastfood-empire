import type {
  CredentialStatus,
  ModelInfo,
  ProviderDefinition,
  ProviderHealth,
  ProviderKind,
  QuotaSnapshot,
  UsageInfo,
} from '@aido/types';
import type { Logger } from '@aido/observability';
import type { CredentialVault } from '@aido/security';
import type { Store } from '@aido/storage';
import type { HealthStatus, LLMProvider, ProviderConstructor, ProviderConstructorOptions } from '@aido/ai-core';

/**
 * An adapter may be a constructor (the normal case) or a ready-made provider
 * instance. Instances make tests and plugins able to inject a fully configured
 * client without re-implementing the constructor contract.
 */
export type ProviderAdapter = ProviderConstructor | LLMProvider;
import { OpenAiCompatibleProvider } from './adapters/openai-compatible.js';
import { GoogleGenerativeProvider } from './adapters/google-generative.js';
import { SimulatedProvider } from './adapters/simulated.js';

/**
 * Provider Registry (§6).
 *
 * Single source of truth for "what providers exist, are they usable, and what can
 * they do". The orchestration layer talks only to this class, never to an adapter
 * type — which is what makes adding a provider a registration instead of a code
 * change in the agent loop (§52).
 *
 * Adapters are constructed lazily and cached, so a disabled or unconfigured
 * provider costs nothing at runtime.
 */
export interface ProviderSummary {
  id: string;
  name: string;
  kind: ProviderKind;
  simulated: boolean;
  enabled: boolean;
  configured: boolean;
  missingCredentialFields: string[];
  credentialStatus: CredentialStatus;
  credentialDisplay: string | null;
  health: ProviderHealth;
  modelCount: number;
  enabledModelCount: number;
  freeModelCount: number;
  documentationUrl: string | null;
  freeTier: ProviderDefinition['freeTier'];
  quotaLimits: ProviderDefinition['quotaLimits'];
  adapter: { registered: boolean; name: string | null };
  capabilities: string[];
  lastSyncAt: string | null;
  notes: string;
  metadataVerified: boolean;
  cooldownUntil: string | null;
  lastError: string | null;
}

export interface ProviderRegistryOptions {
  store: Store;
  vault: CredentialVault;
  definitions: ProviderDefinition[];
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** Extra adapters keyed by provider id (overrides the kind-based default). */
  adapters?: Map<string, ProviderConstructor>;
}

/** True when a definition describes the bundled local simulator. */
function isLocalSimulator(definition: ProviderDefinition): boolean {
  return definition.simulated === true || definition.kind === 'simulated';
}

function isProviderInstance(value: ProviderAdapter): value is LLMProvider {
  return typeof value === 'object' && value !== null && typeof (value as LLMProvider).chat === 'function';
}

export class ProviderRegistry {
  private readonly store: Store;
  private readonly vault: CredentialVault;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly definitions = new Map<string, ProviderDefinition>();
  private readonly instances = new Map<string, LLMProvider>();

  constructor(options: ProviderRegistryOptions) {
    this.store = options.store;
    this.vault = options.vault;
    this.logger = options.logger.child?.( { scope: 'provider-registry' }) ?? options.logger;
    this.fetchImpl = options.fetchImpl;
    for (const definition of options.definitions) this.definitions.set(definition.id, definition);
    for (const [id, ctor] of options.adapters ?? []) this.adapters.set(id, ctor);
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Adds a provider definition at runtime and persists it.
   *
   * This is what makes "adding a provider needs only an adapter plus a
   * registration" true in practice: `providers/*.json` is read at boot, and this
   * method covers definitions created later (imported, edited, or supplied by a
   * plugin) without restarting the process or touching orchestration code.
   */
  registerDefinition(definition: ProviderDefinition, options: { enabled?: boolean; persist?: boolean } = {}): ProviderSummary | null {
    this.definitions.set(definition.id, definition);
    if (options.persist !== false) {
      this.store.providers.upsertFromDefinition(definition, { enabled: options.enabled ?? true });
    }
    this.invalidate(definition.id);
    this.logger.info('provider definition registered', { providerId: definition.id, kind: definition.kind });
    return this.summary(definition.id);
  }

  /** Replaces the whole definition set (used when config files are reloaded). */
  reloadDefinitions(definitions: ProviderDefinition[], options: { persist?: boolean } = {}): ProviderSummary[] {
    this.definitions.clear();
    for (const definition of definitions) {
      this.definitions.set(definition.id, definition);
      if (options.persist !== false) this.store.providers.upsertFromDefinition(definition, { enabled: true });
    }
    this.instances.clear();
    this.logger.info('provider definitions reloaded', { count: definitions.length });
    return this.summaries();
  }

  /**
   * Registers an adapter for a provider id. Required for providers whose wire
   * protocol is not one of the built-in kinds. Returns an unregister function so
   * tests and plugins can clean up.
   */
  registerAdapter(providerId: string, adapter: ProviderAdapter): () => void {
    this.adapters.set(providerId, adapter);
    this.instances.delete(providerId);
    return () => {
      this.adapters.delete(providerId);
      this.instances.delete(providerId);
    };
  }

  definitionsList(): ProviderDefinition[] {
    return [...this.definitions.values()];
  }

  definition(providerId: string): ProviderDefinition | null {
    return this.definitions.get(providerId) ?? null;
  }

  /** Ids that currently have a resolvable adapter. */
  registeredProviderIds(): string[] {
    return [...this.definitions.keys()].filter((id) => this.adapterFor(this.definitions.get(id)!) !== null);
  }

  /**
   * Reconciles the DB with the definition files. Safe to call on every startup:
   * it refreshes metadata but never clobbers operator state (enabled flag, model
   * overrides, learned limits).
   */
  syncDefinitions(): { providers: number; modelsSeeded: number } {
    let modelsSeeded = 0;
    for (const definition of this.definitions.values()) {
      this.store.providers.upsertFromDefinition(definition);
      const existingModels = this.store.models.list({ providerId: definition.id, limit: 1 });
      if (existingModels.length === 0 && definition.seedModels?.length) {
        modelsSeeded += this.seedModels(definition);
      }
    }
    return { providers: this.definitions.size, modelsSeeded };
  }

  /**
   * Writes the seed models from the definition as a bootstrap catalogue.
   *
   * These are explicitly marked `status: 'unknown'` with unverified provenance —
   * they exist so the UI is not empty before the first discovery, not so that the
   * application can claim to know a provider's live model list (§46).
   */
  private seedModels(definition: ProviderDefinition): number {
    let count = 0;
    for (const seed of definition.seedModels ?? []) {
      const existing = this.store.models.getByProviderModelId(definition.id, seed.id);
      if (existing) continue;
      const capabilities = seed.capabilities ?? {};
      const model: ModelInfo = {
        id: `${definition.id}:${seed.id}`,
        providerId: definition.id,
        providerModelId: seed.id,
        displayName: seed.displayName,
        contextWindow: seed.contextWindow ?? null,
        maxOutputTokens: seed.maxOutputTokens ?? null,
        capabilities: {
          chat: true,
          streaming: definition.capabilities.includes('streaming'),
          reasoning: capabilities.reasoning ?? false,
          vision: capabilities.vision ?? false,
          tools: capabilities.tools ?? definition.capabilities.includes('tools'),
          structuredOutput: capabilities.structuredOutput ?? definition.capabilities.includes('structuredOutput'),
          jsonMode: definition.capabilities.includes('jsonMode'),
          codeGeneration: capabilities.codeGeneration ?? definition.capabilities.includes('codeGeneration'),
          longContext: capabilities.longContext ?? (seed.contextWindow ?? 0) >= 100_000,
          imageGeneration: definition.capabilities.includes('imageGeneration'),
          embeddings: definition.capabilities.includes('embeddings'),
        },
        // A locally simulated provider declares its own cost: there is no network
        // call and nothing is billed, so charging 0 is a fact, not an assumption.
        // For every real provider the price stays unknown until discovery reports it.
        pricing: isLocalSimulator(definition)
          ? {
              inputPerMillionTokens: 0,
              outputPerMillionTokens: 0,
              provenance: { source: 'provider_docs', confidence: 1, note: 'Local simulator: no network request is made and nothing is billed.' },
            }
          : {
              inputPerMillionTokens: null,
              outputPerMillionTokens: null,
              provenance: { source: 'unknown', confidence: 0, note: 'Not asserted by the provider API; run model discovery for authoritative data.' },
            },
        quota: {
          requestsPerMinute: definition.quotaLimits?.requestsPerMinute ?? null,
          requestsPerHour: null,
          requestsPerDay: definition.quotaLimits?.requestsPerDay ?? null,
          requestsPerMonth: null,
          tokensPerMinute: definition.quotaLimits?.tokensPerMinute ?? null,
          tokensPerDay: definition.quotaLimits?.tokensPerDay ?? null,
          tokensPerMonth: null,
          concurrentRequests: definition.quotaLimits?.concurrentRequests ?? null,
          resetStrategy: definition.freeTier.resetStrategy,
          resetTimezone: definition.freeTier.resetTimezone,
          provenance: {
            source: definition.quotaLimits ? 'provider_docs' : 'unknown',
            confidence: definition.quotaLimits ? 0.35 : 0,
            note: 'Seed metadata. Overwritten by observed provider headers or operator edits.',
          },
        },
        quotaType: seed.quotaType ?? definition.freeTier.quotaType,
        performance: { averageLatency: null, averageFirstTokenLatency: null, throughput: null, successRate: null, samples: 0 },
        status: 'unknown',
        enabled: true,
        priority: 0,
        qualityPrior: 0.5,
        strengths: [],
        discoveredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: { seeded: true },
      };
      this.store.models.upsert(model);
      count += 1;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Instances
  // -------------------------------------------------------------------------

  /** Returns the adapter for a provider, constructing it on first use. */
  provider(providerId: string): LLMProvider | null {
    const cached = this.instances.get(providerId);
    if (cached) return cached;
    const definition = this.definitions.get(providerId);
    if (!definition) return null;
    const adapter = this.adapterFor(definition);
    if (!adapter) return null;

    const record = this.store.providers.get(providerId);
    const baseUrl = this.resolveBaseUrl(definition);
    const options: ProviderConstructorOptions = {
      definition: { ...definition, apiBaseUrl: baseUrl },
      apiBaseUrl: baseUrl,
      resolveCredential: (field) => this.vault.resolve(providerId, field)?.value ?? null,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
    };
    // One construction path for every provider: `adapterFor` resolves the kind to
    // a built-in adapter, and explicit registrations (tests, plugins, custom wire
    // protocols) always win. No provider may be special-cased here.
    const instance = isProviderInstance(adapter) ? adapter : new adapter(options);
    this.instances.set(providerId, instance);
    if (record && record.health.status === 'unconfigured' && this.isConfigured(providerId)) {
      this.store.providers.updateRuntime(providerId, { healthStatus: 'unknown' });
    }
    return instance;
  }

  /** Drops a cached instance so rotated credentials take effect immediately. */
  invalidate(providerId: string): void {
    this.instances.delete(providerId);
  }

  adapterFor(definition: ProviderDefinition): ProviderAdapter | null {
    const explicit = this.adapters.get(definition.id);
    if (explicit) return explicit;
    switch (definition.kind) {
      case 'openai_compatible':
        return OpenAiCompatibleProvider;
      case 'google_generative':
        return GoogleGenerativeProvider;
      case 'simulated':
        return SimulatedProvider;
      case 'anthropic_messages':
      case 'custom':
      default:
        // No adapter => the UI shows "adapter not registered" instead of pretending
        // the provider works. This is the extension point for new wire protocols.
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  isConfigured(providerId: string): boolean {
    const definition = this.definitions.get(providerId);
    if (!definition) return false;
    if (definition.authenticationType === 'none') return true;
    const fields = definition.credentialFields ?? [{ key: 'apiKey', label: 'API key', required: true, secret: true }];
    return fields.filter((f) => f.required).every((f) => this.vault.resolve(providerId, f.key) !== null);
  }

  credentialStatus(providerId: string): CredentialStatus {
    const definition = this.definitions.get(providerId);
    if (!definition) return { state: 'unconfigured', checkedAt: new Date().toISOString(), detail: 'Unknown provider' };
    if (definition.authenticationType === 'none') {
      return { state: 'valid', checkedAt: new Date().toISOString(), detail: 'This provider does not require credentials.' };
    }
    const fields = definition.credentialFields ?? [{ key: 'apiKey', label: 'API key', required: true, secret: true }];
    const missing = fields.filter((f) => f.required && this.vault.resolve(providerId, f.key) === null).map((f) => f.label);
    if (missing.length) {
      return { state: 'unconfigured', checkedAt: new Date().toISOString(), detail: `Missing: ${missing.join(', ')}` };
    }
    const record = this.store.credentials.get(providerId, 'apiKey') ?? this.store.credentials.list(providerId)[0] ?? null;
    if (!record) {
      return { state: 'unverified', checkedAt: new Date().toISOString(), detail: 'Configured from an environment variable.' };
    }
    const checkedAt = record.lastValidatedAt ?? record.updatedAt;
    if (record.validationState === 'valid') return { state: 'valid', checkedAt, detail: record.validationDetail ?? undefined };
    if (record.validationState === 'invalid') {
      return { state: 'invalid', checkedAt, detail: record.validationDetail ?? 'Credential was rejected by the provider.' };
    }
    return { state: 'unverified', checkedAt, detail: record.validationDetail ?? undefined };
  }

  setCredential(providerId: string, field: string, value: string): void {
    this.vault.set(providerId, field, value);
    this.invalidate(providerId);
  }

  deleteCredential(providerId: string, field: string): boolean {
    const removed = this.vault.delete(providerId, field);
    this.invalidate(providerId);
    return removed;
  }

  // -------------------------------------------------------------------------
  // Lifecycle operations
  // -------------------------------------------------------------------------

  async testConnection(providerId: string): Promise<CredentialStatus> {
    const definition = this.definitions.get(providerId);
    if (!definition) return { state: 'unconfigured', checkedAt: new Date().toISOString(), detail: 'Unknown provider' };
    if (!this.adapterFor(definition)) {
      return {
        state: 'unverified',
        checkedAt: new Date().toISOString(),
        detail: `No adapter is registered for provider "${providerId}" (kind: ${definition.kind}). Register one before testing.`,
      };
    }
    const provider = this.provider(providerId);
    if (!provider) return { state: 'unconfigured', checkedAt: new Date().toISOString(), detail: 'Provider is not available' };
    const status = await provider.validateCredentials();
    if (status.state === 'valid') {
      this.store.providers.updateRuntime(providerId, {
        healthStatus: 'online',
        healthMessage: status.detail ?? null,
        healthLatencyMs: null,
        consecutiveFailures: 0,
        lastError: null,
      });
    } else if (status.state === 'invalid') {
      this.store.providers.updateRuntime(providerId, { healthStatus: 'offline', healthMessage: status.detail, lastError: status.detail });
    }
    const field = (definition.credentialFields ?? [{ key: 'apiKey' }])[0]?.key ?? 'apiKey';
    if (this.store.credentials.get(providerId, field)) {
      this.vault.markValidated(providerId, field, status.state === 'valid' ? 'valid' : 'invalid', status.detail ?? null);
    }
    return status;
  }

  async healthCheck(providerId: string): Promise<ProviderHealth> {
    const definition = this.definitions.get(providerId);
    const now = new Date().toISOString();
    if (!definition) {
      return { providerId, status: 'offline', checkedAt: now, latencyMs: null, message: `Unknown provider "${providerId}"`, consecutiveFailures: 0 };
    }
    const current = this.store.providers.get(providerId);
    if (current && !current.enabled) {
      const health: ProviderHealth = { providerId, status: 'disabled', checkedAt: now, latencyMs: null, message: 'Provider is disabled.', consecutiveFailures: current.health.consecutiveFailures };
      this.store.providers.updateRuntime(providerId, { healthStatus: 'disabled', healthMessage: health.message });
      return health;
    }
    if (!this.isConfigured(providerId)) {
      const health: ProviderHealth = { providerId, status: 'unconfigured', checkedAt: now, latencyMs: null, message: 'No credentials configured.', consecutiveFailures: 0 };
      this.store.providers.updateRuntime(providerId, { healthStatus: 'unconfigured', healthMessage: health.message });
      return health;
    }
    const provider = this.provider(providerId);
    if (!provider) {
      const health: ProviderHealth = {
        providerId,
        status: 'offline',
        checkedAt: now,
        latencyMs: null,
        message: `No adapter registered for kind "${definition.kind}".`,
        consecutiveFailures: 0,
      };
      this.store.providers.updateRuntime(providerId, { healthStatus: 'offline', healthMessage: health.message });
      return health;
    }

    const result: HealthStatus = await provider.healthCheck();
    const previousFailures = current?.health.consecutiveFailures ?? 0;
    const health: ProviderHealth = {
      providerId,
      status: result.ok ? result.status : 'offline',
      checkedAt: result.checkedAt,
      latencyMs: result.latencyMs,
      message: result.message,
      consecutiveFailures: result.ok ? 0 : previousFailures + 1,
    };
    this.store.providers.updateRuntime(providerId, {
      healthStatus: health.status,
      healthLatencyMs: health.latencyMs,
      healthMessage: health.message,
      consecutiveFailures: health.consecutiveFailures,
      lastError: result.ok ? null : result.message,
    });
    return health;
  }

  async healthCheckAll(): Promise<ProviderHealth[]> {
    const results: ProviderHealth[] = [];
    for (const definition of this.definitions.values()) {
      const record = this.store.providers.get(definition.id);
      if (!record?.enabled) continue;
      results.push(await this.healthCheck(definition.id));
    }
    return results;
  }

  /**
   * Discovers models from the provider API and persists them.
   *
   * Never falls back to a fabricated list: if discovery fails, the previous
   * catalogue is kept and the error is reported to the caller.
   */
  async discoverModels(providerId: string): Promise<{ models: ModelInfo[]; added: number; updated: number; error: string | null }> {
    const definition = this.definitions.get(providerId);
    if (!definition) return { models: [], added: 0, updated: 0, error: `Unknown provider "${providerId}"` };
    if (!this.isConfigured(providerId)) {
      return { models: [], added: 0, updated: 0, error: 'Provider has no credentials configured.' };
    }
    const provider = this.provider(providerId);
    if (!provider) return { models: [], added: 0, updated: 0, error: `No adapter registered for provider "${providerId}".` };
    if (!provider.capabilities.modelDiscovery) {
      return { models: [], added: 0, updated: 0, error: `${definition.name} does not expose a model listing endpoint.` };
    }

    let models: ModelInfo[];
    try {
      models = await provider.listModels();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.store.providers.updateRuntime(providerId, { lastError: message });
      this.logger.warn('model discovery failed', { providerId, error: message });
      return { models: [], added: 0, updated: 0, error: message };
    }

    let added = 0;
    let updated = 0;
    this.store.db.transaction(() => {
      for (const model of models) {
        const existing = this.store.models.get(model.id);
        if (existing) {
          // Operator-owned fields (enabled/priority/quality/strengths) survive discovery.
          this.store.models.update(model.id, {
            ...model,
            enabled: existing.enabled,
            priority: existing.priority,
            qualityPrior: existing.qualityPrior,
            strengths: existing.strengths.length ? existing.strengths : model.strengths,
            performance: existing.performance,
            quota: existing.quota,
            quotaType: existing.quotaType === 'unknown' ? model.quotaType : existing.quotaType,
            discoveredAt: existing.discoveredAt,
          });
          updated += 1;
        } else {
          this.store.models.upsert(model);
          added += 1;
        }
      }
      this.store.models.markMissingAsOffline(
        providerId,
        models.map((m) => m.providerModelId),
      );
    });

    this.store.providers.updateRuntime(providerId, {
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      healthStatus: 'online',
      consecutiveFailures: 0,
    });
    this.logger.info('model discovery stored', { providerId, added, updated });
    return { models, added, updated, error: null };
  }

  async usage(providerId: string): Promise<UsageInfo | null> {
    const provider = this.provider(providerId);
    if (!provider) return null;
    try {
      return await provider.getUsage();
    } catch (err) {
      this.logger.warn('usage query failed', { providerId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async quotaSnapshots(providerId: string): Promise<QuotaSnapshot[]> {
    const provider = this.provider(providerId);
    if (!provider) return [];
    try {
      return await provider.getQuota();
    } catch (err) {
      this.logger.warn('quota query failed', { providerId, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  setEnabled(providerId: string, enabled: boolean): void {
    this.store.providers.setEnabled(providerId, enabled);
    if (!enabled) this.store.providers.updateRuntime(providerId, { healthStatus: 'disabled', healthMessage: 'Disabled by operator.' });
    else this.store.providers.updateRuntime(providerId, { healthStatus: 'unknown', healthMessage: null });
  }

  // -------------------------------------------------------------------------
  // Summaries for the UI
  // -------------------------------------------------------------------------

  summary(providerId: string): ProviderSummary | null {
    const definition = this.definitions.get(providerId);
    const record = this.store.providers.get(providerId);
    if (!definition) return null;
    const ctor = this.adapterFor(definition);
    const models = this.store.models.list({ providerId, limit: 5000 });
    const fields = definition.credentialFields ?? (definition.authenticationType === 'none' ? [] : [{ key: 'apiKey', label: 'API key', required: true, secret: true }]);
    const missing = fields.filter((f) => f.required && this.vault.resolve(providerId, f.key) === null).map((f) => f.key);
    const credential = this.store.credentials.get(providerId, fields[0]?.key ?? 'apiKey');

    return {
      id: providerId,
      name: definition.name,
      kind: definition.kind,
      simulated: Boolean(definition.simulated),
      enabled: record?.enabled ?? false,
      configured: missing.length === 0,
      missingCredentialFields: missing,
      credentialStatus: this.credentialStatus(providerId),
      credentialDisplay: credential?.displayHint ?? null,
      health: record?.health ?? {
        providerId,
        status: 'unconfigured',
        checkedAt: '',
        latencyMs: null,
        message: null,
        consecutiveFailures: 0,
      },
      modelCount: models.length,
      enabledModelCount: models.filter((m) => m.enabled).length,
      freeModelCount: models.filter((m) => m.quotaType === 'free_renewable' || m.quotaType === 'user_hosted').length,
      documentationUrl: definition.documentationUrl,
      freeTier: definition.freeTier,
      quotaLimits: definition.quotaLimits,
      adapter: { registered: ctor !== null, name: ctor ? ctor.name : null },
      capabilities: definition.capabilities,
      lastSyncAt: record?.lastSyncAt ?? null,
      notes: definition.notes,
      metadataVerified: definition.metadataVerified,
      cooldownUntil: record?.cooldownUntil ?? null,
      lastError: record?.lastError ?? null,
    };
  }

  summaries(): ProviderSummary[] {
    return [...this.definitions.keys()].map((id) => this.summary(id)).filter((summary): summary is ProviderSummary => summary !== null);
  }

  /**
   * Substitutes runtime values into an API base URL. Cloudflare's base URL embeds
   * the account id, which is a credential field, so this cannot be a static string.
   */
  private resolveBaseUrl(definition: ProviderDefinition): string {
    const record = this.store.providers.get(definition.id);
    const template = record?.apiBaseUrl ?? definition.apiBaseUrl;
    return template.replace(/\{(\w+)\}/g, (match, key: string) => {
      const value = this.vault.resolve(definition.id, key)?.value;
      if (value) return value;
      const camel = key.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase());
      const camelValue = this.vault.resolve(definition.id, camel)?.value;
      return camelValue ?? match;
    });
  }
}
