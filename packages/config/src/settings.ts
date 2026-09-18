import { z } from 'zod';
import type { AppSettings } from '@aido/types';
import { defaultAppSettings, DEFAULT_ROUTING_POLICIES } from './defaults.js';

const ScoreWeightsSchema = z.object({
  capabilityMatch: z.number(),
  modelQuality: z.number(),
  quotaAvailability: z.number(),
  reliability: z.number(),
  latency: z.number(),
  taskCompatibility: z.number(),
  providerHealth: z.number(),
  priorityBias: z.number(),
});

const RoutingPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  taskType: z.union([
    z.enum([
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
    ]),
    z.literal('*'),
  ]),
  preferCapabilities: z.array(
    z.enum([
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
    ]),
  ),
  weightOverrides: ScoreWeightsSchema.partial(),
  qualityRequirement: z.enum(['low', 'medium', 'high', 'maximum']),
  maxLatencyMs: z.number().nullable(),
  maxCostUsd: z.number().nullable(),
  allowedQuotaTypes: z.array(z.enum(['free_renewable', 'free_trial', 'paid', 'unknown', 'user_hosted'])),
  minContextWindow: z.number().nullable(),
  failoverDepth: z.number().int().min(1).max(10),
  enabled: z.boolean(),
  description: z.string(),
});

export const AppSettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']),
  denseMode: z.boolean(),
  executionMode: z.enum(['auto', 'supervised', 'manual']),
  freeOnlyMode: z.boolean(),
  telemetryRetentionDays: z.number().int().min(1).max(3650),
  eventRetentionDays: z.number().int().min(1).max(3650),
  router: z.object({
    weights: ScoreWeightsSchema,
    freeOnlyMode: z.boolean(),
    allowTrialCredits: z.boolean(),
    spreadAcrossProviders: z.boolean(),
    quotaReserveFloor: z.number().min(0).max(0.9),
    blockUnknownPricing: z.boolean(),
    policies: z.array(RoutingPolicySchema),
    learningEnabled: z.boolean(),
  }),
  sandbox: z.object({
    workspaceRoot: z.string(),
    deniedPaths: z.array(z.string()),
    commandTimeoutMs: z.number().int().min(1000).max(3_600_000),
    outputByteLimit: z.number().int().min(1024).max(64 * 1024 * 1024),
    allowNetwork: z.boolean(),
    allowedCommandPrefixes: z.array(z.string()),
    approvalRequiredPrefixes: z.array(z.string()),
  }),
  quota: z.object({
    reserveFraction: z.number().min(0).max(0.5),
    reservationTtlMs: z.number().int().min(1000).max(3_600_000),
    defaultCooldownMs: z.number().int().min(0).max(3_600_000),
    cooldownBackoffMultiplier: z.number().min(1).max(10),
    maxCooldownMs: z.number().int().min(0).max(24 * 3_600_000),
    learnFromHeaders: z.boolean(),
    assumeUnknownIsUnlimited: z.boolean(),
  }),
  supervisor: z.object({
    maxRetriesPerTask: z.number().int().min(0).max(20),
    maxTokensPerTask: z.number().int().min(1000),
    maxTaskRuntimeMs: z.number().int().min(10_000),
    maxAgentIterations: z.number().int().min(1).max(100),
    maxParallelAgents: z.number().int().min(1).max(16),
    maxTotalRunTokens: z.number().int().nullable(),
    failureCircuitBreaker: z.object({ failures: z.number().int().min(1), windowMs: z.number().int().min(1000) }),
    retryWithDifferentModel: z.boolean(),
    loopDetectionWindow: z.number().int().min(2).max(100),
    enabled: z.boolean(),
  }),
  security: z.object({
    encryptCredentials: z.boolean(),
    redactLogs: z.boolean(),
    promptInjectionDefense: z.boolean(),
    alwaysConfirmDestructive: z.boolean(),
    secretFileGlobs: z.array(z.string()),
    allowRepoContentToProviders: z.boolean(),
  }),
  notifications: z.object({
    approvals: z.boolean(),
    failures: z.boolean(),
    quota: z.boolean(),
    desktop: z.boolean(),
  }),
});

/**
 * Deep-merges stored settings over defaults. Unknown/invalid stored values fall
 * back to defaults per-field rather than nuking the whole settings object, and
 * every repair is reported so the UI can surface it.
 */
export function normalizeSettings(raw: unknown): { settings: AppSettings; repairs: string[] } {
  const defaults = defaultAppSettings();
  const repairs: string[] = [];
  if (!raw || typeof raw !== 'object') {
    return { settings: defaults, repairs: raw === undefined ? [] : ['stored settings were not an object; defaults applied'] };
  }
  const parsed = AppSettingsSchema.safeParse({ ...defaults, ...(raw as Record<string, unknown>) });
  if (parsed.success) {
    const settings = parsed.data as unknown as AppSettings;
    if (settings.router.policies.length === 0) {
      settings.router.policies = DEFAULT_ROUTING_POLICIES;
      repairs.push('router.policies was empty; default policies restored');
    }
    return { settings, repairs };
  }
  // Partial recovery: validate section by section so one bad field cannot wipe config.
  const merged = structuredCloneSafe(defaults);
  const incoming = raw as Record<string, unknown>;
  for (const key of Object.keys(incoming)) {
    if (!(key in merged)) continue;
    const fieldSchema = (AppSettingsSchema.shape as Record<string, z.ZodTypeAny>)[key];
    if (!fieldSchema) continue;
    const result = fieldSchema.safeParse(incoming[key]);
    if (result.success) {
      (merged as unknown as Record<string, unknown>)[key] = result.data;
    } else {
      repairs.push(`settings.${key} failed validation and was reset to default`);
    }
  }
  if (merged.router.policies.length === 0) merged.router.policies = DEFAULT_ROUTING_POLICIES;
  return { settings: merged, repairs };
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
