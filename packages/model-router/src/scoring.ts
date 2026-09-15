import type { CapabilityName, ModelInfo, Priority, RoutingPolicy, ScoreWeights, TaskRequest, TaskType } from '@aido/types';

/**
 * Pure scoring functions (§10). Kept dependency-free and side-effect-free so the
 * routing algorithm is directly unit-testable and so the "why was this model
 * chosen?" explanation can quote exact numbers.
 *
 * Every component returns a value in [0,1] plus a human-readable note. Components
 * that lack evidence return a *documented neutral prior* (0.5), never a
 * fabrication — and the note says "no data yet" so the UI does not imply knowledge
 * it does not have.
 */

export interface ScoreComponent {
  name: keyof ScoreWeights;
  raw: number;
  weight: number;
  contribution: number;
  note: string;
}

export interface ModelScore {
  model: ModelInfo;
  total: number;
  components: ScoreComponent[];
  positives: string[];
  negatives: string[];
}

export interface ScoringContext {
  weights: ScoreWeights;
  policy: RoutingPolicy;
  taskRequest: TaskRequest;
  /** Learned per (model, taskType) statistics. */
  learned: {
    attempts: number;
    successes: number;
    failures: number;
    consecutiveFailures: number;
    avgLatencyMs: number | null;
    avgInputTokens: number | null;
    avgOutputTokens: number | null;
  } | null;
  /** Live quota signal from the quota engine. */
  quota: {
    /** 0..1 remaining on the governing window; null when limits are unknown. */
    remainingFraction: number | null;
    inCooldown: boolean;
    /** Provider-reported remaining, when available. */
    reportedRemainingFraction: number | null;
    unknownLimits: boolean;
  };
  providerHealth: 'online' | 'degraded' | 'offline' | 'unconfigured' | 'disabled' | 'unknown';
  /** Consumption already recorded today for this provider, used to spread load. */
  providerLoad: { requests: number; shareOfTotal: number };
  spreadAcrossProviders: boolean;
  reserveFloor: number;
  now: Date;
}

export function scoreModel(model: ModelInfo, context: ScoringContext): ModelScore {
  const components: ScoreComponent[] = [];
  const positives: string[] = [];
  const negatives: string[] = [];
  const weights = applyPolicyWeights(context.weights, context.policy);

  const push = (name: keyof ScoreWeights, raw: number, note: string) => {
    const weight = weights[name];
    components.push({ name, raw, weight, contribution: raw * weight, note });
  };

  // --- capability match -----------------------------------------------------
  const required = context.taskRequest.requiredCapabilities;
  const preferred = context.policy.preferCapabilities;
  const missingRequired = required.filter((cap) => !model.capabilities[cap]);
  const matchedPreferred = preferred.filter((cap) => model.capabilities[cap]);
  const capabilityRaw = missingRequired.length ? 0 : Math.min(1, 0.75 + 0.25 * (preferred.length ? matchedPreferred.length / preferred.length : 1));
  push(
    'capabilityMatch',
    capabilityRaw,
    missingRequired.length
      ? `missing required capability: ${missingRequired.join(', ')}`
      : preferred.length
        ? `${matchedPreferred.length}/${preferred.length} preferred capabilities (${preferred.join(', ')})`
        : 'all required capabilities present',
  );
  if (matchedPreferred.length) positives.push(`supports ${matchedPreferred.join(', ')}`);
  for (const capability of missingRequired) negatives.push(`lacks required ${capability}`);

  // --- model quality --------------------------------------------------------
  const learnedQuality = context.learned && context.learned.attempts > 0 ? context.learned.successes / context.learned.attempts : null;
  const qualityRaw = learnedQuality === null ? model.qualityPrior : clamp(model.qualityPrior * 0.55 + learnedQuality * 0.45 * model.qualityPrior + learnedQuality * 0.45 * (1 - model.qualityPrior) * 0.5, 0, 1);
  push(
    'modelQuality',
    qualityRaw,
    learnedQuality === null
      ? `quality prior ${model.qualityPrior.toFixed(2)} (no measured history for this task type yet)`
      : `quality prior ${model.qualityPrior.toFixed(2)} blended with measured ${(learnedQuality * 100).toFixed(0)}% success over ${context.learned?.attempts} run(s)`,
  );

  // --- quota availability ---------------------------------------------------
  const quotaRaw = quotaAvailability(context.quota, context.reserveFloor);
  push('quotaAvailability', quotaRaw, describeQuota(context.quota, context.reserveFloor));
  if (context.quota.remainingFraction !== null) {
    if (context.quota.remainingFraction > 0.5) positives.push(`${(context.quota.remainingFraction * 100).toFixed(0)}% daily quota remaining`);
    else if (context.quota.remainingFraction < 0.15) negatives.push(`only ${(context.quota.remainingFraction * 100).toFixed(0)}% daily quota remaining`);
  }
  if (context.quota.unknownLimits) negatives.push('provider limits unknown — consumption is unmetered until headers are observed');

  // --- reliability ----------------------------------------------------------
  const reliabilityRaw = reliability(context.learned, model);
  push('reliability', reliabilityRaw, describeReliability(context.learned, model));

  // --- latency --------------------------------------------------------------
  const budget = context.taskRequest.maxLatencyMs ?? context.policy.maxLatencyMs ?? null;
  const latencyRaw = latencyScore(context.learned?.avgLatencyMs ?? model.performance.averageLatency, budget);
  push('latency', latencyRaw, describeLatency(context.learned?.avgLatencyMs ?? model.performance.averageLatency, budget));

  // --- task compatibility ---------------------------------------------------
  const compatibilityRaw = taskCompatibility(model, context.taskRequest.taskType, context.learned);
  push('taskCompatibility', compatibilityRaw, describeCompatibility(model, context.taskRequest.taskType, context.learned));

  // --- provider health ------------------------------------------------------
  const healthRaw = healthScore(context.providerHealth);
  push('providerHealth', healthRaw, `provider health: ${context.providerHealth}`);
  if (context.providerHealth === 'degraded') negatives.push('provider health is degraded');

  // --- priority bias --------------------------------------------------------
  const priorityRaw = priorityBias(context.taskRequest.priority, model.priority);
  push('priorityBias', priorityRaw, `operator priority ${model.priority > 0 ? `+${model.priority}` : model.priority} for a ${context.taskRequest.priority} task`);

  let total = components.reduce((sum, component) => sum + component.contribution, 0);
  const weightSum = components.reduce((sum, component) => sum + component.weight, 0);
  total = weightSum > 0 ? total / weightSum : 0;

  // Load spreading: nudge away from a provider that has already served most of
  // today's traffic, so a single free quota is not drained while others idle.
  if (context.spreadAcrossProviders && context.providerLoad.shareOfTotal > 0) {
    const penalty = Math.min(0.25, context.providerLoad.shareOfTotal * 0.3);
    total = Math.max(0, total - penalty);
    push('quotaAvailability', 0, `load-spreading penalty ${(penalty * 100).toFixed(1)}% (provider already served ${(context.providerLoad.shareOfTotal * 100).toFixed(0)}% of today's requests)`);
  }

  return { model, total, components, positives, negatives };
}

/** Policy weight overrides are multipliers on top of the global weights. */
export function applyPolicyWeights(base: ScoreWeights, policy: RoutingPolicy): ScoreWeights {
  const out = { ...base };
  for (const [key, value] of Object.entries(policy.weightOverrides) as [keyof ScoreWeights, number][]) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = base[key] * value;
  }
  return out;
}

export function quotaAvailability(
  quota: ScoringContext['quota'],
  reserveFloor: number,
): number {
  if (quota.inCooldown) return 0;
  const fraction = quota.reportedRemainingFraction ?? quota.remainingFraction;
  if (fraction === null) return 0.5; // unknown: neutral, documented
  if (fraction <= 0) return 0;
  // Concave curve: the last 10% of a quota is much less useful than the first 10%,
  // because a request that fails at the very end wastes the most context.
  const adjusted = Math.max(0, fraction - reserveFloor) / Math.max(0.0001, 1 - reserveFloor);
  return Math.pow(adjusted, 0.6);
}

function describeQuota(quota: ScoringContext['quota'], reserveFloor: number): string {
  if (quota.inCooldown) return 'provider is in cooldown after a rate limit';
  const fraction = quota.reportedRemainingFraction ?? quota.remainingFraction;
  if (fraction === null) return 'no quota signal available; treated as neutral (limits unknown)';
  const source = quota.reportedRemainingFraction !== null ? 'provider-reported' : 'locally metered';
  return `${(fraction * 100).toFixed(0)}% remaining (${source}), scored against a ${(reserveFloor * 100).toFixed(0)}% reserve floor`;
}

export function reliability(learned: ScoringContext['learned'], model: ModelInfo): number {
  const samples = (learned?.attempts ?? 0) + model.performance.samples;
  if (samples === 0) return 0.7; // documented prior for an unmeasured model
  const learnedRate = learned && learned.attempts > 0 ? learned.successes / learned.attempts : null;
  const measuredRate = model.performance.successRate;
  const rates = [learnedRate, measuredRate].filter((r): r is number => r !== null);
  if (!rates.length) return 0.7;
  const average = rates.reduce((a, b) => a + b, 0) / rates.length;
  // Consecutive failures are a strong signal that something systemic is wrong.
  const streakPenalty = Math.min(0.6, (learned?.consecutiveFailures ?? 0) * 0.2);
  return clamp(average - streakPenalty, 0, 1);
}

function describeReliability(learned: ScoringContext['learned'], model: ModelInfo): string {
  const samples = (learned?.attempts ?? 0) + model.performance.samples;
  if (samples === 0) return 'no reliability data yet; using a neutral prior of 0.70';
  const parts: string[] = [];
  if (learned && learned.attempts > 0) parts.push(`${learned.successes}/${learned.attempts} successful for this task type`);
  if (model.performance.successRate !== null) parts.push(`${(model.performance.successRate * 100).toFixed(0)}% overall (${model.performance.samples} samples)`);
  if ((learned?.consecutiveFailures ?? 0) > 0) parts.push(`${learned?.consecutiveFailures} consecutive failure(s)`);
  return parts.join('; ');
}

export function latencyScore(avgLatencyMs: number | null, budgetMs: number | null): number {
  if (avgLatencyMs === null || !Number.isFinite(avgLatencyMs)) return 0.5; // unknown
  if (budgetMs === null || budgetMs <= 0) {
    // No budget: score relative to a 30s reference so faster is still better.
    return clamp(30_000 / Math.max(avgLatencyMs, 250), 0, 1);
  }
  if (avgLatencyMs >= budgetMs) return 0;
  return clamp(1 - avgLatencyMs / budgetMs, 0, 1);
}

function describeLatency(avgLatencyMs: number | null, budgetMs: number | null): string {
  if (avgLatencyMs === null) return 'latency unknown for this model';
  const measured = `measured average ${Math.round(avgLatencyMs)}ms`;
  return budgetMs ? `${measured} against a ${budgetMs}ms budget` : `${measured}; no latency budget set`;
}

export function taskCompatibility(model: ModelInfo, taskType: TaskType, learned: ScoringContext['learned']): number {
  if (learned && learned.attempts >= 5) {
    const rate = learned.successes / learned.attempts;
    // With enough history, measured performance for exactly this task type is the
    // strongest available signal.
    return clamp(0.4 + rate * 0.6, 0, 1);
  }
  if (model.strengths.includes(taskType)) return 0.9;
  if (model.strengths.length === 0) return 0.5;
  return 0.6;
}

function describeCompatibility(model: ModelInfo, taskType: TaskType, learned: ScoringContext['learned']): string {
  if (learned && learned.attempts >= 5) {
    return `measured ${((learned.successes / learned.attempts) * 100).toFixed(0)}% success on ${taskType} over ${learned.attempts} run(s)`;
  }
  if (model.strengths.includes(taskType)) return `known strength: ${taskType}`;
  if (model.strengths.length) return `no recorded ${taskType} history; model strengths are ${model.strengths.join(', ')}`;
  return 'no task-type history or declared strengths';
}

export function healthScore(health: ScoringContext['providerHealth']): number {
  switch (health) {
    case 'online':
      return 1;
    case 'degraded':
      return 0.55;
    case 'unknown':
      return 0.6;
    case 'offline':
    case 'unconfigured':
    case 'disabled':
      return 0;
    default:
      return 0.5;
  }
}

export function priorityBias(priority: Priority, modelPriority: number): number {
  const urgency = priority === 'critical' ? 1 : priority === 'high' ? 0.75 : priority === 'normal' ? 0.5 : 0.25;
  const normalizedModelPriority = clamp(modelPriority / 10, 0, 1);
  return clamp(0.5 + (urgency - 0.5) * 0.4 + (normalizedModelPriority - 0.5) * 0.6, 0, 1);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Cost of a request in USD, or null when pricing is unknown. */
export function estimateCostUsd(model: ModelInfo, inputTokens: number, outputTokens: number): number | null {
  const { inputPerMillionTokens, outputPerMillionTokens } = model.pricing;
  if (inputPerMillionTokens === null && outputPerMillionTokens === null) return null;
  const inputCost = ((inputPerMillionTokens ?? 0) * inputTokens) / 1_000_000;
  const outputCost = ((outputPerMillionTokens ?? 0) * outputTokens) / 1_000_000;
  return inputCost + outputCost;
}

export function capabilityList(model: ModelInfo): CapabilityName[] {
  return (Object.entries(model.capabilities) as [CapabilityName, boolean][]).filter(([, enabled]) => enabled).map(([name]) => name);
}
