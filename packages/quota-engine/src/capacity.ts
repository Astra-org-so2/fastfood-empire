import type { ModelInfo, QuotaType } from '@aido/types';
import type { Store } from '@aido/storage';
import type { EffectiveLimits } from './manager.js';

/**
 * Capacity estimate for FREE ONLY mode (§28: "Today's estimated available capacity").
 *
 * This is the one number in the product that is genuinely an *estimate*, so it is
 * computed conservatively and reported with its basis:
 *   - per-model remaining budget = min over known dimensions (tokens, requests),
 *   - unknown limits contribute 0 to the headline number but are listed separately
 *     as "unmetered" providers rather than being silently counted as infinite,
 *   - the total is the sum over *eligible* models, discounted by the reserve
 *     fraction the quota engine keeps in hand.
 */

export interface ProviderCapacity {
  providerId: string;
  name: string;
  quotaType: QuotaType;
  enabled: boolean;
  configured: boolean;
  usable: boolean;
  /** Sum of remaining tokens across this provider's eligible models (may be 0). */
  remainingTokens: number | null;
  remainingRequests: number | null;
  /** Percentage of the daily budget still available, when known. */
  remainingFraction: number | null;
  resetsAt: string | null;
  resetsInMs: number | null;
  resetIsEstimated: boolean;
  limitsKnown: boolean;
  reason: string;
}

export interface CapacityEstimate {
  freeOnlyMode: boolean;
  totalRemainingTokens: number | null;
  totalRemainingRequests: number | null;
  activeProviders: number;
  totalProviders: number;
  providers: ProviderCapacity[];
  /** Providers excluded because their quota type is not renewable-free. */
  excluded: { providerId: string; name: string; reason: string }[];
  /** Notes that explain how the number was derived (shown in the UI). */
  basis: string[];
}

export interface CapacityOptions {
  store: Store;
  effectiveLimits: (providerId: string, model: ModelInfo | null) => EffectiveLimits;
  usage: (providerId: string, model: ModelInfo | null) => {
    day: { tokensUsed: number; tokensLimit: number | null; requestsUsed: number; requestsLimit: number | null; resetsAt: string | null; resetsInMs: number | null; estimated: boolean };
    remainingFraction: number | null;
  };
  reserveFraction: number;
  freeOnlyMode: boolean;
  providerSummaries: () => { id: string; name: string; enabled: boolean; configured: boolean; simulated: boolean }[];
  now?: () => Date;
}

export function estimateCapacity(options: CapacityOptions): CapacityEstimate {
  const summaries = options.providerSummaries();
  const providers: ProviderCapacity[] = [];
  const excluded: CapacityEstimate['excluded'] = [];
  const basis: string[] = [];
  let totalTokens: number | null = 0;
  let totalRequests: number | null = 0;
  let freeCapableModels = 0;
  let unknownLimitModels = 0;

  for (const summary of summaries) {
    const models = options.store.models.list({ providerId: summary.id, enabled: true, limit: 5000 }).filter((m) => m.capabilities.chat);
    if (!models.length) continue;

    // In FREE ONLY mode only models with renewable-free or user-hosted quota are usable.
    const eligible = models.filter((model) => {
      if (!options.freeOnlyMode) return true;
      return model.quotaType === 'free_renewable' || model.quotaType === 'user_hosted';
    });
    const ineligible = models.length - eligible.length;
    if (options.freeOnlyMode && ineligible > 0) {
      const types = [...new Set(models.filter((m) => !eligible.includes(m)).map((m) => m.quotaType))];
      excluded.push({
        providerId: summary.id,
        name: summary.name,
        reason: `${ineligible} model(s) excluded by FREE ONLY mode (quota type: ${types.join(', ')}).`,
      });
    }
    if (!eligible.length) continue;
    freeCapableModels += eligible.length;

    // The provider's remaining budget is the *maximum* across its models, because
    // failover lets us use the least-consumed model. Summing would double-count a
    // shared provider-level limit.
    let bestFraction: number | null = null;
    let bestTokensRemaining: number | null = null;
    let bestRequestsRemaining: number | null = null;
    let resetsAt: string | null = null;
    let resetsInMs: number | null = null;
    let resetEstimated = true;
    let limitsKnown = false;

    for (const model of eligible) {
      const limits = options.effectiveLimits(summary.id, model);
      const usage = options.usage(summary.id, model);
      const modelKnown = !limits.unknown;
      if (modelKnown) limitsKnown = true;

      const tokenRemaining = usage.day.tokensLimit === null ? null : Math.max(0, usage.day.tokensLimit - usage.day.tokensUsed);
      const requestRemaining = usage.day.requestsLimit === null ? null : Math.max(0, usage.day.requestsLimit - usage.day.requestsUsed);

      if (tokenRemaining !== null) {
        bestTokensRemaining = bestTokensRemaining === null ? tokenRemaining : Math.max(bestTokensRemaining, tokenRemaining);
      }
      if (requestRemaining !== null) {
        bestRequestsRemaining = bestRequestsRemaining === null ? requestRemaining : Math.max(bestRequestsRemaining, requestRemaining);
      }
      if (usage.remainingFraction !== null) {
        bestFraction = bestFraction === null ? usage.remainingFraction : Math.max(bestFraction, usage.remainingFraction);
      }
      if (usage.day.resetsAt) {
        resetsAt = usage.day.resetsAt;
        resetsInMs = usage.day.resetsInMs;
        resetEstimated = usage.day.estimated;
      }
    }

    if (!limitsKnown) {
      unknownLimitModels += eligible.length;
      basis.push(`${summary.name}: limits unknown — usage is metered but remaining capacity cannot be computed.`);
    }

    // Apply the same reserve the engine keeps so the estimate is achievable, not theoretical.
    const discountedTokens = bestTokensRemaining === null ? null : Math.floor(bestTokensRemaining * (1 - options.reserveFraction));
    const discountedRequests = bestRequestsRemaining === null ? null : Math.floor(bestRequestsRemaining * (1 - options.reserveFraction));

    if (discountedTokens === null) {
      // Unknown token budget: do not add 0 silently to the total, but do not claim
      // tokens either. Mark the total as "at least" by keeping it numeric.
      totalTokens = totalTokens === null ? null : totalTokens;
    } else {
      totalTokens = (totalTokens ?? 0) + discountedTokens;
    }
    if (discountedRequests !== null) totalRequests = (totalRequests ?? 0) + discountedRequests;

    providers.push({
      providerId: summary.id,
      name: summary.name,
      quotaType: eligible[0]?.quotaType ?? 'unknown',
      enabled: summary.enabled,
      configured: summary.configured,
      usable: summary.enabled && summary.configured && !(bestFraction !== null && bestFraction <= 0),
      remainingTokens: discountedTokens,
      remainingRequests: discountedRequests,
      remainingFraction: bestFraction,
      resetsAt,
      resetsInMs,
      resetIsEstimated: resetEstimated,
      limitsKnown,
      reason: limitsKnown
        ? 'Remaining budget computed from configured/observed limits and locally metered usage.'
        : 'No reliable limits known for this provider; capacity is metered but not predictable.',
    });
  }

  basis.push(
    `Total counts ${freeCapableModels} eligible chat model(s) across ${providers.length} provider(s), after removing the ${Math.round(options.reserveFraction * 100)}% safety reserve.`,
  );
  if (unknownLimitModels > 0) {
    basis.push(`${unknownLimitModels} model(s) have unknown limits; their capacity is excluded from the token total rather than assumed unlimited.`);
  }
  if (options.freeOnlyMode) {
    basis.push('FREE ONLY mode is active: models classified as PAID, FREE_TRIAL or UNKNOWN are excluded from routing and from this total.');
  }

  return {
    freeOnlyMode: options.freeOnlyMode,
    totalRemainingTokens: totalTokens,
    totalRemainingRequests: totalRequests,
    activeProviders: providers.filter((p) => p.usable).length,
    totalProviders: summaries.length,
    providers,
    excluded,
    basis,
  };
}
