/** Model routing policy + scoring weights (§10, §11, §27). */
import type { CapabilityName, Priority, QuotaType, TaskType } from './provider.js';

export interface TaskRequest {
  taskType: TaskType;
  prompt: string;
  /** Rough budget the caller will actually send. */
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  requiredCapabilities: CapabilityName[];
  /** Soft preferences that boost score without excluding. */
  preferredCapabilities?: CapabilityName[];
  minContextWindow?: number;
  priority: Priority;
  maxLatencyMs?: number | null;
  qualityRequirement?: 'low' | 'medium' | 'high' | 'maximum';
  /** Restrict to a single provider (used for pinned/debug runs). */
  providerId?: string | null;
  /** Restrict to a set of models. */
  allowedModelIds?: string[] | null;
  /** Cost ceiling per request in USD; 0 = free only. */
  maxCostUsd?: number | null;
  /** Allow models whose quota type is trial (promotional credit). */
  allowTrialCredits?: boolean;
  /** Require renewable free quota. */
  requireRenewableFree?: boolean;
  agentId?: string | null;
  projectId?: string | null;
}

export interface ScoreWeights {
  capabilityMatch: number;
  modelQuality: number;
  quotaAvailability: number;
  reliability: number;
  latency: number;
  taskCompatibility: number;
  providerHealth: number;
  priorityBias: number;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  capabilityMatch: 1.35,
  modelQuality: 1.1,
  quotaAvailability: 1.25,
  reliability: 1.0,
  latency: 0.7,
  taskCompatibility: 1.0,
  providerHealth: 0.8,
  priorityBias: 0.35,
};

/** Per-task-type routing policy. Editable in the UI (Model Routing screen). */
export interface RoutingPolicy {
  id: string;
  name: string;
  taskType: TaskType | '*';
  preferCapabilities: CapabilityName[];
  /** Weight multipliers applied on top of the global weights. */
  weightOverrides: Partial<ScoreWeights>;
  qualityRequirement: 'low' | 'medium' | 'high' | 'maximum';
  maxLatencyMs: number | null;
  /** Hard cost ceiling; 0 means free-only for this policy. */
  maxCostUsd: number | null;
  allowedQuotaTypes: QuotaType[];
  /** Minimum context window the model must offer. */
  minContextWindow: number | null;
  /** Keep N best candidates for failover ordering. */
  failoverDepth: number;
  enabled: boolean;
  description: string;
}

export interface RouterSettings {
  weights: ScoreWeights;
  freeOnlyMode: boolean;
  allowTrialCredits: boolean;
  /** Nudge scores toward under-used providers to spread quota consumption. */
  spreadAcrossProviders: boolean;
  /** Penalty applied to providers whose daily quota is nearly exhausted. */
  quotaReserveFloor: number;
  /** Require confirmation before using a model whose pricing is unknown. */
  blockUnknownPricing: boolean;
  policies: RoutingPolicy[];
  /** Refresh learned model strengths from history every N minutes. */
  learningEnabled: boolean;
}
