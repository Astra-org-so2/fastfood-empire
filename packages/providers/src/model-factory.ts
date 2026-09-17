import {
  EMPTY_CAPABILITIES,
  type ModelCapabilities,
  type ModelInfo,
  type ModelPerformance,
  type ModelQuotaLimits,
  type ModelStatus,
  type ProviderDefinition,
  type ProviderSeedModel,
  type Provenance,
  type QuotaType,
  type TaskType,
} from '@aido/types';

/**
 * Builds normalised `ModelInfo` records from provider data or discovery results.
 *
 * This is the only place that decides a model's quota classification, and it
 * follows one rule: **never claim renewable free access without evidence** (§3).
 *
 *  - explicit zero pricing from the provider's own API  -> free_renewable
 *  - non-zero pricing                                   -> paid
 *  - provider declaration of a free tier                -> inherit (still labelled
 *    with the provider-level provenance, which is usually `provider_docs` at
 *    confidence 0.35 — the UI shows that as "unverified")
 *  - anything else                                      -> unknown
 */

export interface ModelFactoryContext {
  definition: ProviderDefinition;
  /** Free models explicitly discovered (e.g. OpenRouter ':free' suffix or price 0). */
  freeByPricing?: boolean | null;
  /** Pricing reported by the provider, USD per 1M tokens. */
  pricing?: { inputPerMillionTokens: number | null; outputPerMillionTokens: number | null; source: Provenance['source']; reference?: string } | null;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: Partial<ModelCapabilities>;
  metadata?: Record<string, unknown>;
  /** Operator overrides carried across discovery refreshes. */
  existing?: ModelInfo | null;
}

const TASK_STRENGTH_HINTS: { pattern: RegExp; strengths: TaskType[] }[] = [
  { pattern: /coder|code|starcoder|codestral|deepseek-coder|qwen.*coder|devstral|gpt-oss/i, strengths: ['code_generation', 'refactor', 'test_generation'] },
  { pattern: /reason|o[134](-|$)|r1|thinking|qwq|magistral/i, strengths: ['architecture', 'planning', 'security_audit', 'performance_analysis'] },
  { pattern: /vision|vl|llava|pixtral|multimodal/i, strengths: [] },
  { pattern: /embed/i, strengths: [] },
  { pattern: /mini|small|instant|flash-lite|nano|8b|7b|3b/i, strengths: ['documentation', 'summarization', 'classification', 'refactor'] },
  { pattern: /large|70b|120b|235b|405b|pro|ultra|max/i, strengths: ['architecture', 'code_generation', 'security_audit', 'database_design'] },
];

/** Heuristic capability inference from the model id and provider metadata. */
export function inferCapabilities(modelId: string, contextWindow: number | null, providerCapabilities: ModelCapabilities, explicit?: Partial<ModelCapabilities>): ModelCapabilities {
  const id = modelId.toLowerCase();
  const inferred: ModelCapabilities = {
    ...EMPTY_CAPABILITIES,
    // Chat is implied by being in a chat-capable provider's catalogue.
    chat: true,
    streaming: providerCapabilities.streaming,
    tools: providerCapabilities.tools,
    jsonMode: providerCapabilities.jsonMode,
    structuredOutput: providerCapabilities.structuredOutput,
    embeddings: /embed/i.test(id),
    imageGeneration: /(image|dall|flux|stable-diffusion|imagen)/i.test(id),
    vision: /(vision|vl|llava|pixtral|multimodal|4o|omni)/i.test(id),
    reasoning: /(reason|thinking|o[134]-|r1|qwq|magistral|deepseek-r)/i.test(id),
    codeGeneration: /(coder|code|starcoder|codestral|devstral|gpt-oss|qwen|deepseek|llama|mistral|gemma|granite|kimi|glm)/i.test(id),
    longContext: (contextWindow ?? 0) >= 100_000,
  };
  if (inferred.embeddings) {
    // Embedding models are not chat models; do not advertise chat for them.
    inferred.chat = false;
    inferred.streaming = false;
    inferred.tools = false;
  }
  return { ...inferred, ...cleanPartial(explicit) };
}

function cleanPartial(partial: Partial<ModelCapabilities> | undefined): Partial<ModelCapabilities> {
  if (!partial) return {};
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(partial)) {
    if (typeof value === 'boolean') out[key] = value;
  }
  return out as Partial<ModelCapabilities>;
}

export function inferStrengths(modelId: string): TaskType[] {
  const found = new Set<TaskType>();
  for (const hint of TASK_STRENGTH_HINTS) {
    if (hint.pattern.test(modelId)) for (const task of hint.strengths) found.add(task);
  }
  return [...found];
}

export function classifyQuotaType(context: ModelFactoryContext): { quotaType: QuotaType; provenance: Provenance } {
  const pricing = context.pricing;
  if (pricing && pricing.inputPerMillionTokens !== null && pricing.outputPerMillionTokens !== null) {
    const isFree = pricing.inputPerMillionTokens === 0 && pricing.outputPerMillionTokens === 0;
    return {
      quotaType: isFree ? 'free_renewable' : 'paid',
      provenance: {
        source: pricing.source,
        confidence: isFree ? 0.9 : 1,
        reference: pricing.reference,
        observedAt: new Date().toISOString(),
        note: isFree
          ? 'Provider reports zero price for this model. Zero-cost access can still change; treat as renewable-free until the provider says otherwise.'
          : 'Provider reports a non-zero price for this model.',
      },
    };
  }
  if (context.freeByPricing === true) {
    return {
      quotaType: 'free_renewable',
      provenance: { source: 'api_reported', confidence: 0.8, observedAt: new Date().toISOString(), note: 'Provider metadata marks this model as zero-cost.' },
    };
  }
  if (context.definition.freeTier.quotaType === 'user_hosted') {
    return { quotaType: 'user_hosted', provenance: { source: 'user_configured', confidence: 1, note: 'Locally hosted provider.' } };
  }
  if (context.definition.freeTier.available === true) {
    return {
      quotaType: context.definition.freeTier.quotaType,
      provenance: {
        source: context.definition.metadataVerified ? 'provider_docs' : 'unknown',
        confidence: context.definition.metadataVerified ? 0.6 : 0.35,
        reference: context.definition.documentationUrl ?? undefined,
        observedAt: context.definition.lastVerifiedAt ?? undefined,
        note: `Inherited from the ${context.definition.name} provider declaration. Per-model free eligibility is not asserted by the provider API, so verify before relying on it.`,
      },
    };
  }
  return {
    quotaType: 'unknown',
    provenance: {
      source: 'unknown',
      confidence: 0,
      note: 'No pricing information and no verified free-tier declaration. Excluded from FREE ONLY routing until verified.',
    },
  };
}

const DEFAULT_PERFORMANCE: ModelPerformance = {
  averageLatency: null,
  averageFirstTokenLatency: null,
  throughput: null,
  successRate: null,
  samples: 0,
};

export function buildModelInfo(input: {
  definition: ProviderDefinition;
  providerModelId: string;
  displayName?: string;
  context: ModelFactoryContext;
  status?: ModelStatus;
}): ModelInfo {
  const { definition, providerModelId, context } = input;
  const existing = context.existing ?? null;
  const providerCapabilities: ModelCapabilities = {
    ...EMPTY_CAPABILITIES,
    chat: true,
    streaming: definition.capabilities.includes('streaming'),
    tools: definition.capabilities.includes('tools'),
    jsonMode: definition.capabilities.includes('jsonMode'),
    structuredOutput: definition.capabilities.includes('structuredOutput'),
    vision: definition.capabilities.includes('vision'),
    reasoning: definition.capabilities.includes('reasoning'),
    codeGeneration: definition.capabilities.includes('codeGeneration'),
    longContext: definition.capabilities.includes('longContext'),
    embeddings: definition.capabilities.includes('embeddings'),
    imageGeneration: definition.capabilities.includes('imageGeneration'),
  };

  const contextWindow = context.contextWindow ?? existing?.contextWindow ?? null;
  const capabilities = inferCapabilities(providerModelId, contextWindow, providerCapabilities, context.capabilities);
  const classification = classifyQuotaType(context);

  /**
   * A declared price is only used where it cannot contradict the provider's own terms:
   * a renewable free tier or a locally hosted model has a marginal cost of zero *inside
   * its free window*, which is where the quota engine keeps requests. Paid and trial
   * models are never priced from a definition.
   */
  const declaredPricing =
    definition.defaultPricing && (classification.quotaType === 'free_renewable' || classification.quotaType === 'user_hosted')
      ? definition.defaultPricing
      : null;

  // `existing` is only present when a caller passes the stored row in; do not read
  // through it without checking, and never let an unknown price replace a known one.
  const existingPricing = existing && existing.pricing.provenance.source !== 'unknown' ? existing.pricing : null;

  const pricing: ModelInfo['pricing'] = context.pricing
    ? {
        inputPerMillionTokens: context.pricing.inputPerMillionTokens,
        outputPerMillionTokens: context.pricing.outputPerMillionTokens,
        provenance: {
          source: context.pricing.source,
          confidence: 0.9,
          reference: context.pricing.reference,
          observedAt: new Date().toISOString(),
        },
      }
    : (existingPricing
        ? existingPricing
        : declaredPricing
          ? {
              inputPerMillionTokens: declaredPricing.inputPerMillionTokens,
              outputPerMillionTokens: declaredPricing.outputPerMillionTokens,
              provenance: {
                source: declaredPricing.source,
                confidence: declaredPricing.source === 'provider_docs' ? 0.5 : 0.4,
                reference: definition.documentationUrl ?? undefined,
                observedAt: new Date().toISOString(),
                note:
                  declaredPricing.note ??
                  'Price declared in the provider definition, not reported by the provider. Edit the definition to change it.',
              },
            }
          : {
              inputPerMillionTokens: null,
              outputPerMillionTokens: null,
              provenance: { source: 'unknown', confidence: 0, note: 'Provider does not publish per-model pricing.' },
            });

  const quota: ModelQuotaLimits = existing?.quota ?? {
    requestsPerMinute: definition.quotaLimits?.requestsPerMinute ?? null,
    requestsPerHour: definition.quotaLimits?.requestsPerHour ?? null,
    requestsPerDay: definition.quotaLimits?.requestsPerDay ?? null,
    requestsPerMonth: definition.quotaLimits?.requestsPerMonth ?? null,
    tokensPerMinute: definition.quotaLimits?.tokensPerMinute ?? null,
    tokensPerDay: definition.quotaLimits?.tokensPerDay ?? null,
    tokensPerMonth: definition.quotaLimits?.tokensPerMonth ?? null,
    concurrentRequests: definition.quotaLimits?.concurrentRequests ?? null,
    resetStrategy: definition.freeTier.resetStrategy,
    resetTimezone: definition.freeTier.resetTimezone,
    provenance: definition.quotaLimits
      ? {
          source: 'provider_docs',
          confidence: 0.35,
          reference: definition.documentationUrl ?? undefined,
          note: 'Provider-level limit applied to every model. Per-model limits differ in practice; observed response headers overwrite this.',
        }
      : {
          source: 'unknown',
          confidence: 0,
          note: 'No configured limits. The quota engine learns the real values from provider response headers and 429 responses.',
        },
  };

  const now = new Date().toISOString();
  return {
    id: `${definition.id}:${providerModelId}`,
    providerId: definition.id,
    providerModelId,
    displayName: input.displayName ?? existing?.displayName ?? providerModelId,
    contextWindow,
    maxOutputTokens: context.maxOutputTokens ?? existing?.maxOutputTokens ?? null,
    capabilities,
    pricing,
    quota,
    quotaType: existing?.quotaType && existing.quotaType !== 'unknown' ? existing.quotaType : classification.quotaType,
    performance: existing?.performance ?? { ...DEFAULT_PERFORMANCE },
    status: input.status ?? existing?.status ?? 'unknown',
    enabled: existing?.enabled ?? true,
    priority: existing?.priority ?? 0,
    qualityPrior: existing?.qualityPrior ?? defaultQualityPrior(providerModelId),
    strengths: existing?.strengths?.length ? existing.strengths : inferStrengths(providerModelId),
    discoveredAt: existing?.discoveredAt ?? now,
    updatedAt: now,
    metadata: { ...(context.metadata ?? {}), quotaProvenance: classification.provenance, ...(existing?.metadata ?? {}) },
  };
}

/** Subjective quality prior (0..1). Operator-editable; only a starting point. */
export function defaultQualityPrior(modelId: string): number {
  const id = modelId.toLowerCase();
  if (/(70b|120b|235b|405b|pro|ultra|large|opus|sonnet|gpt-5|gpt-4\.[5-9]|kimi|deepseek-v3|glm-4)/i.test(id)) return 0.8;
  if (/(32b|34b|27b|medium|8x7b|mixtral)/i.test(id)) return 0.65;
  if (/(13b|14b|12b|9b|8b|7b|small|mini|flash|instant|haiku|nano|3b|1b|2b)/i.test(id)) return 0.45;
  return 0.5;
}

export function buildSeedModels(definition: ProviderDefinition): ProviderSeedModel[] {
  return definition.seedModels ?? [];
}

export function emptyQuotaLimits(strategy: ProviderDefinition['freeTier']['resetStrategy']): Omit<ModelQuotaLimits, 'provenance'> {
  return {
    requestsPerMinute: null,
    requestsPerHour: null,
    requestsPerDay: null,
    requestsPerMonth: null,
    tokensPerMinute: null,
    tokensPerDay: null,
    tokensPerMonth: null,
    concurrentRequests: null,
    resetStrategy: strategy,
    resetTimezone: null,
  };
}
