import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ModelQuotaLimits, ProviderDefinition, QuotaType, ResetStrategy } from '@aido/types';

/**
 * Provider definitions are *data*. They live in `config/providers/*.json`, can be
 * overridden by the operator from the UI (persisted in the DB), and are validated
 * here at load time. Adding a provider means dropping a JSON file in (plus an
 * adapter if its wire protocol is not OpenAI-compatible) — never touching
 * orchestration code (§52).
 */

const ProvenanceSchema = z.object({
  source: z.enum(['observed_header', 'api_reported', 'provider_docs', 'user_configured', 'inferred', 'unknown']),
  observedAt: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reference: z.string().optional(),
  note: z.string().optional(),
});

const QuotaTypeSchema = z.enum(['free_renewable', 'free_trial', 'paid', 'unknown', 'user_hosted']);
const ResetStrategySchema = z.enum([
  'utc_midnight',
  'provider_timezone',
  'rolling_24h',
  'explicit_timestamp',
  'api_reported',
  'unknown',
]);

const CapabilitySchema = z.enum([
  'chat',
  'streaming',
  'reasoning',
  'vision',
  'tools',
  'structuredOutput',
  'jsonMode',
  'codeGeneration',
  'longContext',
  'imageGeneration',
  'embeddings',
]);

const QuotaLimitsSchema = z.object({
  requestsPerMinute: z.number().nullable(),
  requestsPerHour: z.number().nullable(),
  requestsPerDay: z.number().nullable(),
  requestsPerMonth: z.number().nullable(),
  tokensPerMinute: z.number().nullable(),
  tokensPerDay: z.number().nullable(),
  tokensPerMonth: z.number().nullable(),
  concurrentRequests: z.number().nullable(),
  resetStrategy: ResetStrategySchema,
  resetTimezone: z.string().nullable(),
  provenance: ProvenanceSchema,
});

const ProviderDefinitionSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_-]+$/, 'provider id must be lowercase alphanumeric with - or _')
    .max(64),
  name: z.string().min(1),
  kind: z.enum(['openai_compatible', 'google_generative', 'anthropic_messages', 'custom', 'simulated']),
  documentationUrl: z.string().nullable().default(null),
  apiBaseUrl: z.string().min(1),
  authenticationType: z.enum(['api_key', 'api_key_pair', 'bearer', 'none', 'oauth']),
  credentialFields: z
    .array(z.object({ key: z.string(), label: z.string(), required: z.boolean(), secret: z.boolean() }))
    .optional(),
  freeTier: z.object({
    available: z.boolean().nullable(),
    quotaType: QuotaTypeSchema,
    resetStrategy: ResetStrategySchema,
    resetTimezone: z.string().nullable(),
    note: z.string(),
  }),
  capabilities: z.array(CapabilitySchema),
  envKeys: z.array(z.string()),
  modelsEndpoint: z.string().nullable(),
  usageEndpoint: z.string().nullable(),
  healthEndpoint: z.string().nullable(),
  telemetry: z.record(z.array(z.string())).optional(),
  telemetrySemantics: z
    .object({
      requests: z.enum(['per_minute', 'per_hour', 'per_day', 'per_month', 'lifetime', 'none']).optional(),
      tokens: z.enum(['per_minute', 'per_hour', 'per_day', 'per_month', 'lifetime', 'none']).optional(),
    })
    .optional(),
  quotaLimits: QuotaLimitsSchema.nullable(),
  seedModels: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string(),
        contextWindow: z.number().optional(),
        maxOutputTokens: z.number().optional(),
        capabilities: z.record(z.boolean()).optional(),
        quotaType: QuotaTypeSchema.optional(),
      }),
    )
    .optional(),
  notes: z.string().default(''),
  metadataVerified: z.boolean().default(false),
  lastVerifiedAt: z.string().nullable().default(null),
  simulated: z.boolean().optional(),
});

export interface CatalogLoadIssue {
  file: string;
  error: string;
}

export interface ProviderCatalog {
  definitions: ProviderDefinition[];
  issues: CatalogLoadIssue[];
  sourceDir: string;
  get(providerId: string): ProviderDefinition | undefined;
  require(providerId: string): ProviderDefinition;
}

/** Operator overrides persisted in the DB, layered over the file definition. */
export interface ProviderOverride {
  providerId: string;
  enabled?: boolean;
  quotaType?: QuotaType;
  resetStrategy?: ResetStrategy;
  resetTimezone?: string | null;
  quotaLimits?: Partial<Omit<ModelQuotaLimits, 'provenance'>> | null;
  apiBaseUrl?: string;
  notes?: string;
}

export function loadProviderCatalog(options: {
  dir: string;
  overrides?: ProviderOverride[];
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}): ProviderCatalog {
  const { dir, overrides = [], logger } = options;
  const issues: CatalogLoadIssue[] = [];
  const definitions: ProviderDefinition[] = [];

  if (!fs.existsSync(dir)) {
    issues.push({ file: dir, error: `provider definition directory does not exist: ${dir}` });
  } else {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const raw = JSON.parse(fs.readFileSync(full, 'utf8')) as unknown;
        const parsed = ProviderDefinitionSchema.parse(raw);
        definitions.push(parsed as unknown as ProviderDefinition);
      } catch (err) {
        const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(err);
        issues.push({ file, error: message });
        logger?.warn('provider definition rejected', { file, error: message });
      }
    }
  }

  const byId = new Map(definitions.map((d) => [d.id, d] as const));

  // Duplicate id detection: silently shadowing a provider is a footgun.
  const seen = new Set<string>();
  for (const d of definitions) {
    if (seen.has(d.id)) {
      issues.push({ file: `${d.id}.json`, error: `duplicate provider id "${d.id}"` });
      logger?.warn('duplicate provider id', { providerId: d.id });
    }
    seen.add(d.id);
  }

  for (const override of overrides) {
    const base = byId.get(override.providerId);
    if (!base) {
      issues.push({ file: 'db-overrides', error: `override for unknown provider "${override.providerId}" ignored` });
      continue;
    }
    const merged: ProviderDefinition = {
      ...base,
      apiBaseUrl: override.apiBaseUrl ?? base.apiBaseUrl,
      notes: override.notes ?? base.notes,
      freeTier: {
        ...base.freeTier,
        quotaType: override.quotaType ?? base.freeTier.quotaType,
        resetStrategy: override.resetStrategy ?? base.freeTier.resetStrategy,
        resetTimezone: override.resetTimezone === undefined ? base.freeTier.resetTimezone : override.resetTimezone,
      },
      quotaLimits: mergeQuotaLimits(base.quotaLimits, override.quotaLimits ?? undefined),
    };
    byId.set(override.providerId, merged);
  }

  const mergedDefinitions = definitions.map((d) => byId.get(d.id)!).filter(Boolean);

  return {
    definitions: mergedDefinitions,
    issues,
    sourceDir: dir,
    get: (id) => byId.get(id),
    require: (id) => {
      const found = byId.get(id);
      if (!found) throw new Error(`Unknown provider "${id}". Known providers: ${[...byId.keys()].join(', ')}`);
      return found;
    },
  };
}

export function mergeQuotaLimits(
  base: Omit<ModelQuotaLimits, 'provenance'> | null,
  override?: Partial<Omit<ModelQuotaLimits, 'provenance'>> | null | undefined,
): Omit<ModelQuotaLimits, 'provenance'> | null {
  if (!base && !override) return null;
  const fallback: Omit<ModelQuotaLimits, 'provenance'> = {
    requestsPerMinute: null,
    requestsPerHour: null,
    requestsPerDay: null,
    requestsPerMonth: null,
    tokensPerMinute: null,
    tokensPerDay: null,
    tokensPerMonth: null,
    concurrentRequests: null,
    resetStrategy: 'unknown',
    resetTimezone: null,
  };
  return { ...fallback, ...(base ?? {}), ...(override ?? {}) };
}

export { ProviderDefinitionSchema, QuotaLimitsSchema, ProvenanceSchema };
