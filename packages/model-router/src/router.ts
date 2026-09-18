import {
  TASK_TYPES,
  type AppSettings,
  type ModelInfo,
  type RoutingPolicy,
  type RoutingRationale,
  type TaskRequest,
  type TaskType,
} from '@aido/types';
import type { Logger } from '@aido/observability';
import type { Store } from '@aido/storage';
import type { QuotaManager } from '@aido/quota-engine';
import { capabilityList, estimateCostUsd, scoreModel, taskCompatibility, type ModelScore, type ScoringContext } from './scoring.js';

/**
 * Smart Model Router (§10, §11, §27, §28).
 *
 * Pipeline:
 *   1. HARD FILTERS — a model that cannot do the job is removed before scoring:
 *      disabled model/provider, missing capability, context window too small,
 *      estimated cost above the ceiling, quota type not allowed by FREE ONLY or by
 *      the policy, provider in cooldown, provider offline.
 *   2. SCORING — weighted, explainable score per surviving candidate.
 *   3. RANKING + FAILOVER CHAIN — the top candidate plus the next N by score, so a
 *      failure at request time has a deterministic next choice.
 *
 * Every decision produces a `RoutingRationale` that is persisted with the trace, so
 * "why did it pick this model?" is answerable after the fact (§32, §51.24).
 */

export interface RoutingContextInput {
  taskRequest: TaskRequest;
  settings: AppSettings;
  /** Optional policy override (e.g. from a project-level override). */
  policyOverride?: RoutingPolicy | null;
}

export interface ScoredCandidate extends ModelScore {
  providerId: string;
  modelId: string;
}

export interface RoutingDecision {
  /** Ordered chain: index 0 is the primary choice, the rest are failover options. */
  chain: ScoredCandidate[];
  selected: ScoredCandidate | null;
  rationale: RoutingRationale;
  policy: RoutingPolicy;
}

export interface ModelRouterOptions {
  store: Store;
  quota: QuotaManager;
  settings: () => AppSettings;
  logger: Logger;
  providerSummary: (providerId: string) => {
    enabled: boolean;
    configured: boolean;
    health: 'online' | 'degraded' | 'offline' | 'unconfigured' | 'disabled' | 'unknown';
  } | null;
  now?: () => Date;
}

export class ModelRouter {
  private readonly store: Store;
  private readonly quota: QuotaManager;
  private readonly settings: () => AppSettings;
  private readonly logger: Logger;
  private readonly providerSummary: ModelRouterOptions['providerSummary'];
  private readonly now: () => Date;

  constructor(options: ModelRouterOptions) {
    this.store = options.store;
    this.quota = options.quota;
    this.settings = options.settings;
    this.logger = options.logger.child?.({ scope: 'router' }) ?? options.logger;
    this.providerSummary = options.providerSummary;
    this.now = options.now ?? (() => new Date());
  }

  policyFor(taskRequest: TaskRequest, override?: RoutingPolicy | null): RoutingPolicy {
    if (override) return override;
    const settings = this.settings();
    const policies = settings.router.policies.filter((p) => p.enabled);
    return (
      policies.find((p) => p.taskType === taskRequest.taskType) ??
      policies.find((p) => p.taskType === '*') ?? {
        id: 'implicit-fallback',
        name: 'Implicit fallback',
        taskType: '*',
        preferCapabilities: [],
        weightOverrides: {},
        qualityRequirement: 'medium',
        maxLatencyMs: null,
        maxCostUsd: 0,
        allowedQuotaTypes: ['free_renewable', 'user_hosted'],
        minContextWindow: null,
        failoverDepth: 3,
        enabled: true,
        description: 'Generated because no policy matched and no catch-all policy is enabled.',
      }
    );
  }

  /** Computes the routing decision without executing anything. */
  decide(input: RoutingContextInput): RoutingDecision {
    const settings = this.settings();
    const policy = this.policyFor(input.taskRequest, input.policyOverride);
    const freeOnly = settings.freeOnlyMode;
    const request = input.taskRequest;

    const requiredTokens = (request.estimatedInputTokens ?? 0) + (request.estimatedOutputTokens ?? 0);
    const rejected: RoutingRationale['rejected'] = [];
    const candidates: ScoredCandidate[] = [];

    const allModels = this.store.models.list({ enabled: true, limit: 5000 });
    const providerLoad = this.todayLoadByProvider();

    for (const model of allModels) {
      const reasons = this.hardFilterReasons(model, request, policy, settings, freeOnly, requiredTokens);
      if (reasons.length) {
        rejected.push({ modelId: model.id, reasons });
        continue;
      }

      const learned = this.learnedStats(model, request.taskType);
      const providerId = model.providerId;
      const summary = this.providerSummary(providerId);
      const usage = this.quota.usage(providerId, model);
      const record = this.store.providers.get(providerId);
      const inCooldown = record?.cooldownUntil ? new Date(record.cooldownUntil) > this.now() : false;

      const context: ScoringContext = {
        weights: settings.router.weights,
        policy,
        taskRequest: request,
        learned,
        quota: {
          remainingFraction: usage.remainingFraction,
          inCooldown,
          reportedRemainingFraction: reportedFraction(usage.reported),
          unknownLimits: usage.unknownLimits,
        },
        providerHealth: summary?.health ?? 'unknown',
        providerLoad: providerLoad.get(providerId) ?? { requests: 0, shareOfTotal: 0 },
        spreadAcrossProviders: settings.router.spreadAcrossProviders,
        reserveFloor: settings.router.quotaReserveFloor,
        now: this.now(),
      };

      const score = scoreModel(model, context);

      // Learning-based soft exclusion: a model that has failed repeatedly *for this
      // task type* is dropped even if its generic score is acceptable.
      if (settings.router.learningEnabled && learned && learned.consecutiveFailures >= 3 && learned.attempts >= 3) {
        rejected.push({
          modelId: model.id,
          reasons: [`${learned.consecutiveFailures} consecutive failures on ${request.taskType}; removed from rotation until it succeeds elsewhere`],
        });
        continue;
      }

      candidates.push({ ...score, providerId, modelId: model.id });
    }

    candidates.sort((a, b) => b.total - a.total);
    const depth = Math.max(1, policy.failoverDepth);
    const chain = candidates.slice(0, depth);
    const selected = chain[0] ?? null;

    const rationale: RoutingRationale = {
      selectedModelId: selected?.modelId ?? '',
      policyId: policy.id,
      totalScore: selected?.total ?? 0,
      components: selected?.components ?? [],
      positives: selected?.positives ?? [],
      negatives: selected?.negatives ?? [],
      rejected,
      considered: allModels.length,
      freeOnlyApplied: freeOnly,
    };

    if (!selected) {
      this.logger.warn('no model satisfied the request', {
        taskType: request.taskType,
        requiredCapabilities: request.requiredCapabilities,
        considered: allModels.length,
        rejected: rejected.length,
        freeOnly,
      });
    } else {
      this.logger.debug('model selected', {
        model: selected.modelId,
        score: Number(selected.total.toFixed(3)),
        alternatives: chain.length - 1,
        considered: allModels.length,
        freeOnly,
      });
    }

    return { chain, selected, rationale, policy };
  }

  /**
   * Hard filters. Each returns a human-readable reason so the UI can explain
   * exclusions ("Rejected Gemini: quota type UNKNOWN while FREE ONLY is active").
   */
  private hardFilterReasons(
    model: ModelInfo,
    request: TaskRequest,
    policy: RoutingPolicy,
    settings: AppSettings,
    freeOnly: boolean,
    requiredTokens: number,
  ): string[] {
    const reasons: string[] = [];

    if (request.allowedModelIds?.length && !request.allowedModelIds.includes(model.id)) {
      reasons.push('not in the explicitly allowed model list for this request');
    }
    if (request.providerId && model.providerId !== request.providerId) {
      reasons.push(`pinned to provider ${request.providerId}`);
    }
    if (!model.capabilities.chat) reasons.push('model does not support chat completions');
    if (model.status === 'offline') reasons.push('model is marked offline by its provider');
    if (model.maxOutputTokens !== null && request.estimatedOutputTokens > model.maxOutputTokens) {
      reasons.push(`requested ${request.estimatedOutputTokens} output tokens but the model caps at ${model.maxOutputTokens}`);
    }

    const missingCapabilities = request.requiredCapabilities.filter((cap) => !model.capabilities[cap]);
    if (missingCapabilities.length) reasons.push(`missing required capability: ${missingCapabilities.join(', ')}`);

    const minContext = Math.max(policy.minContextWindow ?? 0, request.minContextWindow ?? 0);
    if (minContext > 0 && model.contextWindow !== null && model.contextWindow < minContext) {
      reasons.push(`context window ${model.contextWindow} is below the required ${minContext}`);
    }
    if (requiredTokens > 0 && model.contextWindow !== null && requiredTokens > model.contextWindow * 0.95) {
      // Leave headroom for the response: a prompt that exactly fills the window
      // leaves no room to answer.
      reasons.push(`estimated ${requiredTokens} tokens would leave no room to answer inside a ${model.contextWindow} token window`);
    }

    // --- quota type gating (FREE ONLY / policy) --------------------------------
    const allowedTypes = new Set(policy.allowedQuotaTypes);
    if (freeOnly) {
      if (model.quotaType === 'paid') reasons.push('PAID model excluded by FREE ONLY mode');
      else if (model.quotaType === 'free_trial') reasons.push('FREE_TRIAL (promotional credit) excluded by FREE ONLY mode');
      else if (model.quotaType === 'unknown') reasons.push('quota type UNKNOWN excluded by FREE ONLY mode — verify its terms before use');
      else if (!allowedTypes.has(model.quotaType)) reasons.push(`quota type ${model.quotaType} is not permitted by policy "${policy.name}"`);
    } else {
      if (model.quotaType === 'paid' && (policy.maxCostUsd === 0 || policy.maxCostUsd === null)) {
        reasons.push(`PAID model excluded: policy "${policy.name}" allows $${policy.maxCostUsd ?? 0} of spend`);
      }
      if (model.quotaType === 'free_trial' && !settings.router.allowTrialCredits && policy.maxCostUsd === 0) {
        reasons.push('FREE_TRIAL credits excluded: trial credits are promotional and expiring');
      }
    }

    // --- cost ceiling ---------------------------------------------------------
    const cost = estimateCostUsd(model, request.estimatedInputTokens, request.estimatedOutputTokens);
    const ceiling = request.maxCostUsd ?? policy.maxCostUsd;
    if (ceiling !== null && ceiling !== undefined) {
      if (cost === null && ceiling === 0) {
        reasons.push('cost is unknown and the policy allows $0 of spend');
      } else if (cost !== null && cost > ceiling) {
        reasons.push(`estimated cost $${cost.toFixed(4)} exceeds the $${ceiling} ceiling`);
      }
    }

    // --- provider availability -------------------------------------------------
    const summary = this.providerSummary(model.providerId);
    if (!summary) reasons.push('provider is not registered');
    else {
      if (!summary.enabled) reasons.push('provider is disabled');
      if (!summary.configured) reasons.push('provider has no credentials configured');
      if (summary.health === 'offline') reasons.push('provider health check reports offline');
      const record = this.store.providers.get(model.providerId);
      if (record?.cooldownUntil && new Date(record.cooldownUntil) > this.now()) {
        reasons.push(`provider is in cooldown until ${record.cooldownUntil}`);
      }
    }

    return reasons;
  }

  /**
   * Task-type compatibility for one model, with the evidence behind it.
   *
   * Used by the Models screen to show what a model is good at *and* whether that
   * judgement is measured or merely a declared strength / neutral prior (§12).
   */
  compatibilityFor(model: ModelInfo, taskType: TaskType): { score: number; source: 'measured' | 'declared' | 'neutral'; detail: string } {
    const learned = this.learnedStats(model, taskType);
    const score = taskCompatibility(model, taskType, learned);
    if (learned && learned.attempts >= 5) {
      return {
        score,
        source: 'measured',
        detail: `measured ${((learned.successes / learned.attempts) * 100).toFixed(0)}% success over ${learned.attempts} attempt(s)`,
      };
    }
    if (model.strengths.includes(taskType)) return { score, source: 'declared', detail: `declared strength: ${taskType}` };
    return { score, source: 'neutral', detail: model.strengths.length ? `no ${taskType} evidence; declared strengths: ${model.strengths.join(', ')}` : 'no evidence recorded' };
  }

  /** Every task type this model can be considered for, with scores. */
  compatibilityMatrix(model: ModelInfo): { taskType: TaskType; score: number; source: string; detail: string }[] {
    return TASK_TYPES.map((taskType) => ({ taskType, ...this.compatibilityFor(model, taskType) }));
  }

  private learnedStats(model: ModelInfo, taskType: TaskRequest['taskType']): ScoringContext['learned'] {
    if (!this.settings().router.learningEnabled) return null;
    const stat = this.store.modelTaskStats.get(model.providerId, model.providerModelId, taskType);
    if (!stat) return null;
    return {
      attempts: stat.attempts,
      successes: stat.successes,
      failures: stat.failures,
      consecutiveFailures: stat.consecutiveFailures,
      avgLatencyMs: stat.avgLatencyMs,
      avgInputTokens: stat.avgInputTokens,
      avgOutputTokens: stat.avgOutputTokens,
    };
  }

  private todayLoadByProvider(): Map<string, { requests: number; shareOfTotal: number }> {
    const since = new Date(this.now().getTime() - 24 * 60 * 60 * 1000).toISOString();
    const stats = this.store.traces.providerStats(since);
    const total = stats.reduce((sum, s) => sum + s.requests, 0);
    const map = new Map<string, { requests: number; shareOfTotal: number }>();
    for (const stat of stats) {
      map.set(stat.providerId, { requests: stat.requests, shareOfTotal: total > 0 ? stat.requests / total : 0 });
    }
    return map;
  }

  /** Record the outcome so future routing decisions learn from it (§11). */
  recordOutcome(input: {
    providerId: string;
    modelId: string;
    taskType: TaskRequest['taskType'];
    outcome: 'success' | 'failure';
    latencyMs?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  }): void {
    this.store.modelTaskStats.record({
      providerId: input.providerId,
      modelId: input.modelId,
      taskType: input.taskType,
      outcome: input.outcome,
      latencyMs: input.latencyMs ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
    });
  }

  /** Human-readable summary used by the UI's "why this model" panel. */
  explain(decision: RoutingDecision): string {
    if (!decision.selected) {
      return `No eligible model was found among ${decision.rationale.considered} candidates. ${describeRejections(decision.rationale)}`;
    }
    const lines = [
      `Selected ${decision.selected.model.displayName} (${decision.selected.model.id}) with score ${decision.selected.total.toFixed(3)}.`,
      `Policy: ${decision.policy.name}.`,
    ];
    for (const component of decision.rationale.components) {
      lines.push(`  ${component.raw >= 0.66 ? '+' : component.raw <= 0.33 ? '-' : '~'} ${component.name}: ${(component.raw * 100).toFixed(0)}% — ${component.note}`);
    }
    if (decision.chain.length > 1) {
      lines.push(`Failover chain: ${decision.chain.slice(1).map((c) => `${c.model.displayName} (${c.total.toFixed(2)})`).join(' → ')}`);
    }
    return lines.join('\n');
  }
}

function describeRejections(rationale: RoutingRationale): string {
  if (!rationale.rejected.length) return 'No models are configured or enabled.';
  const summary = new Map<string, number>();
  for (const rejection of rationale.rejected) {
    for (const reason of rejection.reasons) {
      const key = reason.split(':')[0] ?? reason;
      summary.set(key, (summary.get(key) ?? 0) + 1);
    }
  }
  return [...summary.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => `${count}× ${reason}`)
    .join('; ');
}

function reportedFraction(reported: { requestsRemaining?: number; requestsLimit?: number; tokensRemaining?: number; tokensLimit?: number } | null): number | null {
  if (!reported) return null;
  const fractions: number[] = [];
  if (reported.requestsRemaining !== undefined && reported.requestsLimit) fractions.push(reported.requestsRemaining / reported.requestsLimit);
  if (reported.tokensRemaining !== undefined && reported.tokensLimit) fractions.push(reported.tokensRemaining / reported.tokensLimit);
  if (!fractions.length) return null;
  return Math.min(...fractions);
}

export { capabilityList };
