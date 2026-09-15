import crypto from 'node:crypto';
import {
  ProviderError,
  type ModelInfo,
  type QuotaReservation,
  type QuotaSnapshot,
  type QuotaWindow,
  type RateLimitTelemetry,
  type ResetStrategy,
} from '@aido/types';
import type { Logger } from '@aido/observability';
import type { Store } from '@aido/storage';
import type { AppSettings } from '@aido/types';
import { computeWindow, describeReset, type QuotaWindowRange } from './windows.js';

/**
 * Quota Manager (§8).
 *
 * The invariant this module exists to guarantee: **two agents can never be
 * promised the same remaining quota**. That is achieved with atomic reservations
 * inside a single transaction, plus SQL-side guard conditions, rather than
 * read-then-decide logic that races.
 *
 * It also tracks cooldowns after rate limits so we stop hammering a provider that
 * just said "no" — the cheapest way to protect a free quota.
 */

export interface QuotaCheckRequest {
  providerId: string;
  modelId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Model metadata from the registry (limits + quota type). */
  model?: ModelInfo | null;
}

export type QuotaDecision =
  | { allowed: true; reservation: QuotaReservation; limits: EffectiveLimits; reasons: string[] }
  | { allowed: false; reason: string; category: 'cooldown' | 'quota_exhausted' | 'provider_disabled' | 'unknown'; limits: EffectiveLimits | null; retryAfterMs: number | null };

export interface EffectiveLimits {
  requestsPerMinute: number | null;
  requestsPerDay: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  resetStrategy: ResetStrategy;
  resetTimezone: string | null;
  /** Where the numbers came from — surfaced in the UI next to every figure. */
  provenance: { source: string; confidence: number; note?: string };
  /** True when we have no reliable limit at all and are relying on 429 feedback. */
  unknown: boolean;
}

export interface QuotaUsageSummary {
  providerId: string;
  modelId: string | null;
  quotaType: ModelInfo['quotaType'];
  minute: { requestsUsed: number; requestsLimit: number | null; tokensUsed: number; tokensLimit: number | null; resetsAt: string | null; resetsInMs: number | null; estimated: boolean };
  day: { requestsUsed: number; requestsLimit: number | null; tokensUsed: number; tokensLimit: number | null; resetsAt: string | null; resetsInMs: number | null; estimated: boolean; resetDescription: string };
  remainingFraction: number | null;
  cooldownUntil: string | null;
  /** Provider-reported remaining values, when the provider exposes them. */
  reported: RateLimitTelemetry | null;
  unknownLimits: boolean;
}

export interface QuotaManagerOptions {
  store: Store;
  settings: () => AppSettings;
  logger: Logger;
  now?: () => Date;
}

export class QuotaManager {
  private readonly store: Store;
  private readonly settings: () => AppSettings;
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(options: QuotaManagerOptions) {
    this.store = options.store;
    this.settings = options.settings;
    this.logger = options.logger.child?.({ scope: 'quota' }) ?? options.logger;
    this.now = options.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Effective limits: configured -> observed -> operator override
  // -------------------------------------------------------------------------

  /**
   * Resolution order (most specific and most recent wins):
   *   1. a limit *observed* in a provider response header (authoritative),
   *   2. per-model limits stored in the catalogue (operator edited or discovered),
   *   3. provider-level configured limits,
   *   4. nothing -> `unknown: true`, and the manager relies on 429 feedback.
   */
  effectiveLimits(providerId: string, model: ModelInfo | null): EffectiveLimits {
    const record = this.store.providers.get(providerId);
    const providerLimits = record?.quotaLimits ?? null;
    const modelLimits = model?.quota ?? null;
    const observed = this.store.quota.observedLimits(providerId, model?.providerModelId ?? '');

    const pick = (observedValue: number | null | undefined, modelValue: number | null | undefined, providerValue: number | null | undefined): number | null => {
      if (observedValue !== null && observedValue !== undefined && observedValue > 0) return observedValue;
      if (modelValue !== null && modelValue !== undefined && modelValue > 0) return modelValue;
      if (providerValue !== null && providerValue !== undefined && providerValue > 0) return providerValue;
      return null;
    };

    // Observed request/token limits are applied to the windows declared by the
    // provider's telemetry semantics (e.g. Groq: requests=day, tokens=minute).
    const semantics = record?.definition.telemetrySemantics;
    const observedRequests = observed?.limitRequests ?? null;
    const observedTokens = observed?.limitTokens ?? null;
    const requestsWindow = semantics?.requests ?? 'per_day';
    const tokensWindow = semantics?.tokens ?? 'per_minute';

    const perDayRequests =
      requestsWindow === 'per_day' ? pick(observedRequests, modelLimits?.requestsPerDay, providerLimits?.requestsPerDay) : modelLimits?.requestsPerDay ?? providerLimits?.requestsPerDay ?? null;
    const perMinuteRequests =
      requestsWindow === 'per_minute'
        ? pick(observedRequests, modelLimits?.requestsPerMinute, providerLimits?.requestsPerMinute)
        : modelLimits?.requestsPerMinute ?? providerLimits?.requestsPerMinute ?? null;
    const perDayTokens =
      tokensWindow === 'per_day' ? pick(observedTokens, modelLimits?.tokensPerDay, providerLimits?.tokensPerDay) : modelLimits?.tokensPerDay ?? providerLimits?.tokensPerDay ?? null;
    const perMinuteTokens =
      tokensWindow === 'per_minute'
        ? pick(observedTokens, modelLimits?.tokensPerMinute, providerLimits?.tokensPerMinute)
        : modelLimits?.tokensPerMinute ?? providerLimits?.tokensPerMinute ?? null;

    const unknown = perDayRequests === null && perDayTokens === null && perMinuteRequests === null && perMinuteTokens === null;
    // `modelLimits` is a full ModelQuotaLimits (has provenance); providerLimits is not.
    const provenance: EffectiveLimits['provenance'] = observed
      ? { source: 'observed_header', confidence: 0.95, note: `Learned from provider response headers at ${observed.observedAt}.` }
      : modelLimits
        ? { source: modelLimits.provenance.source, confidence: modelLimits.provenance.confidence, note: modelLimits.provenance.note }
        : providerLimits
          ? {
              source: 'provider_docs',
              confidence: 0.35,
              note: `Provider-level defaults from ${record?.name ?? providerId}'s definition. Not verified against your account; observed headers replace these as soon as a request succeeds.`,
            }
          : { source: 'unknown', confidence: 0, note: 'No limits configured or observed. The engine will react to provider 429 responses.' };

    return {
      requestsPerMinute: perMinuteRequests,
      requestsPerDay: perDayRequests,
      tokensPerMinute: perMinuteTokens,
      tokensPerDay: perDayTokens,
      resetStrategy: record?.resetStrategy ?? 'unknown',
      resetTimezone: record?.resetTimezone ?? null,
      provenance,
      unknown,
    };
  }

  /** Window ranges for the minute and day buckets of a provider. */
  windowsFor(limits: EffectiveLimits, resetsAt?: string | null): { minute: QuotaWindowRange; day: QuotaWindowRange } {
    const now = this.now();
    const day = computeWindow({
      now,
      resetStrategy: limits.resetStrategy,
      resetTimezone: limits.resetTimezone,
      resetsAt: resetsAt ?? null,
    });
    const minuteStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    return {
      minute: { start: minuteStart, end: new Date(minuteStart.getTime() + 60_000), estimated: false, strategy: 'explicit_timestamp', bucket: 'per_minute' },
      day,
    };
  }

  // -------------------------------------------------------------------------
  // Cooldowns
  // -------------------------------------------------------------------------

  private cooldownActive(providerId: string): { active: boolean; until: string | null; retryAfterMs: number | null } {
    const record = this.store.providers.get(providerId);
    if (!record?.cooldownUntil) return { active: false, until: null, retryAfterMs: null };
    const until = new Date(record.cooldownUntil);
    if (until.getTime() <= this.now().getTime()) return { active: false, until: record.cooldownUntil, retryAfterMs: null };
    return { active: true, until: record.cooldownUntil, retryAfterMs: until.getTime() - this.now().getTime() };
  }

  /** Applies an exponential cooldown after a rate limit or exhausted quota. */
  applyCooldown(providerId: string, error: ProviderError): { until: string; ms: number } {
    const settings = this.settings().quota;
    const record = this.store.providers.get(providerId);
    const previousStreak = record?.health.consecutiveFailures ?? 0;
    const base = error.retryAfterMs && error.retryAfterMs > 0 ? error.retryAfterMs : settings.defaultCooldownMs;
    // quota_exhausted means "come back at the reset boundary", so use the longer of
    // the retry-after hint and the configured default rather than a short backoff.
    const multiplier = error.category === 'quota_exhausted' ? 1 : Math.min(settings.cooldownBackoffMultiplier ** previousStreak, 16);
    const ms = Math.min(settings.maxCooldownMs, Math.max(base, settings.defaultCooldownMs) * multiplier);
    const until = new Date(this.now().getTime() + ms).toISOString();
    this.store.providers.updateRuntime(providerId, { cooldownUntil: until, lastError: error.message });
    this.logger.info('provider cooldown applied', { providerId, category: error.category, ms });
    return { until, ms };
  }

  clearCooldown(providerId: string): void {
    const record = this.store.providers.get(providerId);
    if (record?.cooldownUntil) this.store.providers.updateRuntime(providerId, { cooldownUntil: null });
  }

  // -------------------------------------------------------------------------
  // Reservation lifecycle
  // -------------------------------------------------------------------------

  /**
   * Atomically reserves quota for a request.
   *
   * All bucket increments happen inside one transaction; if any bucket refuses,
   * every increment already applied is rolled back by throwing, which the
   * transaction wrapper turns into a ROLLBACK. That is what makes the accounting
   * race-free without application-level locks.
   */
  check(request: QuotaCheckRequest): QuotaDecision {
    const settings = this.settings();
    const providerRecord = this.store.providers.get(request.providerId);
    const limits = this.effectiveLimits(request.providerId, request.model ?? null);

    if (!providerRecord) {
      return { allowed: false, reason: `Provider "${request.providerId}" is not registered.`, category: 'provider_disabled', limits: null, retryAfterMs: null };
    }
    if (!providerRecord.enabled) {
      return { allowed: false, reason: `${providerRecord.name} is disabled.`, category: 'provider_disabled', limits, retryAfterMs: null };
    }

    const cooldown = this.cooldownActive(request.providerId);
    if (cooldown.active) {
      return {
        allowed: false,
        reason: `${providerRecord.name} is in cooldown until ${cooldown.until} after a rate limit or exhausted quota.`,
        category: 'cooldown',
        limits,
        retryAfterMs: cooldown.retryAfterMs,
      };
    }

    const estimatedTokens = Math.max(1, request.estimatedInputTokens + request.estimatedOutputTokens);
    const { minute, day } = this.windowsFor(limits);

    // Unknown limits with the conservative setting: refuse rather than fire a
    // request whose cost cannot be predicted (§46 — state uncertainty, do not guess).
    if (limits.unknown && !settings.quota.assumeUnknownIsUnlimited) {
      return {
        allowed: false,
        reason: `Limits for ${providerRecord.name} are unknown and "assume unknown is unlimited" is disabled, so the request was not sent. Configure the provider's limits or enable metering of unknown providers.`,
        category: 'unknown',
        limits,
        retryAfterMs: null,
      };
    }

    // Unknown limits: allow, but still record usage against an unlimited bucket so
    // real 429s can be traced back to actual consumption (§46 — no invented limits).
    if (limits.unknown && settings.quota.assumeUnknownIsUnlimited) {
      try {
        const reservation = this.store.db.transaction<QuotaReservation>(() => {
          const bucketIds: string[] = [];
          for (const [window, range] of [
            [day.bucket, day],
            [minute.bucket, minute],
          ] as const) {
            const bucket = this.store.quota.ensureBucket(
              { providerId: request.providerId, scopeModel: '', window: window as QuotaWindow, windowStart: range.start.toISOString() },
              { limitTokens: null, limitRequests: null, windowEnd: range.end.toISOString() },
            );
            bucketIds.push(bucket.id);
            this.store.quota.tryReserve(bucket.id, estimatedTokens, 1, { limitTokens: null, limitRequests: null, reserveFraction: 0 });
          }
          const reservation: QuotaReservation = {
            id: crypto.randomUUID(),
            providerId: request.providerId,
            modelId: request.modelId,
            bucketIds,
            estimatedTokens,
            traceId: crypto.randomUUID(),
            taskId: null,
            agentId: null,
            createdAt: this.now().toISOString(),
            expiresAt: new Date(this.now().getTime() + settings.quota.reservationTtlMs).toISOString(),
            settledAt: null,
            settledTokens: null,
            status: 'reserved',
          };
          return this.store.quota.createReservation(reservation);
        });
        return { allowed: true, reservation, limits, reasons: ['Provider limits are unknown; request allowed and metered for observability.'] };
      } catch (err) {
        return {
          allowed: false,
          reason: `Could not record quota reservation: ${err instanceof Error ? err.message : String(err)}`,
          category: 'unknown',
          limits,
          retryAfterMs: null,
        };
      }
    }

    const reserveFraction = settings.quota.reserveFraction;
    try {
      const reservation = this.store.db.transaction<QuotaReservation>(() => {
        const bucketIds: string[] = [];

        const reserveIn = (
          window: QuotaWindow,
          range: QuotaWindowRange,
          limitTokens: number | null,
          limitRequests: number | null,
          // Rolling windows carry their limit in the trailing span rather than in
          // the bucket, but the bucket still has to be written or the usage would
          // simply vanish (and the trailing check would always see zero).
          force = false,
        ) => {
          if (!force && limitTokens === null && limitRequests === null) return;
          const bucket = this.store.quota.ensureBucket(
            { providerId: request.providerId, scopeModel: '', window, windowStart: range.start.toISOString() },
            { limitTokens, limitRequests, windowEnd: range.end.toISOString() },
          );
          // Keep declared limits fresh: they may have been learned since creation.
          if (bucket.limitTokens !== limitTokens || bucket.limitRequests !== limitRequests) {
            this.store.quota.setLimits(bucket.id, { limitTokens, limitRequests, windowEnd: range.end.toISOString() });
          }
          const reserved = this.store.quota.tryReserve(bucket.id, estimatedTokens, 1, { limitTokens, limitRequests, reserveFraction });
          if (!reserved) {
            // Throwing rolls the whole transaction back, releasing any bucket that
            // was already incremented — no partial reservation can survive.
            throw new QuotaDeniedError(window, limitTokens, limitRequests);
          }
          bucketIds.push(bucket.id);
        };

        // Rolling windows cannot be enforced by a single bucket, so the trailing
        // span is totalled (including in-flight reservations) inside the same
        // transaction that then reserves the current bucket.
        if (day.rolling) {
          const from = new Date(this.now().getTime() - day.rolling.spanMs).toISOString();
          const to = this.now().toISOString();
          const used = this.store.quota.sumBuckets(request.providerId, '', day.rolling.window, from, to);
          const allowance = 1 - reserveFraction;
          if (limits.tokensPerDay !== null && used.tokens + estimatedTokens > limits.tokensPerDay * allowance) {
            throw new QuotaDeniedError('per_day', limits.tokensPerDay, null);
          }
          if (limits.requestsPerDay !== null && used.requests + 1 > limits.requestsPerDay * allowance) {
            throw new QuotaDeniedError('per_day', null, limits.requestsPerDay);
          }
          // The bucket itself carries only usage; limits live in the trailing span.
          reserveIn(day.bucket, day, null, null, true);
        } else {
          reserveIn(day.bucket, day, limits.tokensPerDay, limits.requestsPerDay);
        }
        reserveIn(minute.bucket, minute, limits.tokensPerMinute, limits.requestsPerMinute);

        const reservation: QuotaReservation = {
          id: crypto.randomUUID(),
          providerId: request.providerId,
          modelId: request.modelId,
          bucketIds,
          estimatedTokens,
          traceId: crypto.randomUUID(),
          taskId: null,
          agentId: null,
          createdAt: this.now().toISOString(),
          expiresAt: new Date(this.now().getTime() + settings.quota.reservationTtlMs).toISOString(),
          settledAt: null,
          settledTokens: null,
          status: 'reserved',
        };
        return this.store.quota.createReservation(reservation);
      });
      return { allowed: true, reservation, limits, reasons: ['Quota reserved successfully.'] };
    } catch (err) {
      if (err instanceof QuotaDeniedError) {
        const windowLabel = err.window === 'per_minute' ? 'per-minute' : 'daily';
        const detail = err.limitTokens !== null ? `${err.limitTokens.toLocaleString()} tokens` : `${err.limitRequests?.toLocaleString()} requests`;
        return {
          allowed: false,
          reason: `${providerRecord.name} has insufficient ${windowLabel} quota (${detail} limit, ${Math.round(reserveFraction * 100)}% held in reserve).`,
          category: 'quota_exhausted',
          limits,
          retryAfterMs: null,
        };
      }
      return {
        allowed: false,
        reason: `Quota reservation failed: ${err instanceof Error ? err.message : String(err)}`,
        category: 'unknown',
        limits,
        retryAfterMs: null,
      };
    }
  }

  /** Commits actual usage, reconciling against the reservation estimate. */
  commit(reservationId: string, usage: { inputTokens: number; outputTokens: number }): void {
    const reservation = this.store.quota.getReservation(reservationId);
    if (!reservation || reservation.status !== 'reserved') return;
    const actualTokens = Math.max(0, usage.inputTokens + usage.outputTokens);
    this.store.db.transaction(() => {
      for (const bucketId of reservation.bucketIds) {
        this.store.quota.commit(bucketId, reservation.estimatedTokens, 1, actualTokens, 1);
      }
      this.store.quota.settleReservation(reservationId, { status: 'committed', settledTokens: actualTokens });
    });
  }

  /** Releases a reservation without consuming quota (failed request, no usage). */
  release(reservationId: string, status: 'released' | 'expired' = 'released'): void {
    const reservation = this.store.quota.getReservation(reservationId);
    if (!reservation || reservation.status !== 'reserved') return;
    this.store.db.transaction(() => {
      for (const bucketId of reservation.bucketIds) {
        this.store.quota.release(bucketId, reservation.estimatedTokens, 1);
      }
      this.store.quota.settleReservation(reservationId, { status });
    });
  }

  /** Sweeps reservations abandoned by a crashed worker. */
  expireStaleReservations(): number {
    const expired = this.store.quota.expireReservations(this.now().toISOString());
    for (const reservation of expired) {
      for (const bucketId of reservation.bucketIds) {
        this.store.quota.release(bucketId, reservation.estimatedTokens, 1);
      }
    }
    if (expired.length) this.logger.warn('expired stale quota reservations', { count: expired.length });
    return expired.length;
  }

  // -------------------------------------------------------------------------
  // Learning from real provider behaviour
  // -------------------------------------------------------------------------

  /**
   * Ingests rate-limit telemetry from a real response. This is the mechanism that
   * keeps the app honest: instead of trusting seeded numbers, the engine replaces
   * them with what the provider actually reports, and records usage so the
   * dashboard reflects real consumption.
   */
  ingestTelemetry(input: {
    providerId: string;
    modelId: string;
    telemetry: RateLimitTelemetry;
    scopeModel?: string;
  }): { learned: { requestsLimit: number | null; tokensLimit: number | null }; recorded: boolean } {
    const settings = this.settings();
    const { providerId, telemetry } = input;
    const scopeModel = input.scopeModel ?? '';
    const hasNumbers =
      telemetry.requestsLimit !== undefined ||
      telemetry.tokensLimit !== undefined ||
      telemetry.requestsRemaining !== undefined ||
      telemetry.tokensRemaining !== undefined;
    if (!hasNumbers) return { learned: { requestsLimit: null, tokensLimit: null }, recorded: false };

    this.store.quota.recordObservation({
      providerId,
      scopeModel,
      telemetry,
      source: 'observed_header',
      provenance: {
        source: 'observed_header',
        confidence: 0.95,
        observedAt: this.now().toISOString(),
        note: 'Read directly from a provider response header.',
      },
    });

    if (!settings.quota.learnFromHeaders) return { learned: { requestsLimit: telemetry.requestsLimit ?? null, tokensLimit: telemetry.tokensLimit ?? null }, recorded: true };

    const record = this.store.providers.get(providerId);
    const semantics = record?.definition.telemetrySemantics;
    const requestsWindow = semantics?.requests ?? 'per_day';
    const tokensWindow = semantics?.tokens ?? 'per_minute';

    // Persist newly learned ceilings onto the model so pre-flight checks use them.
    const model = this.store.models.getByProviderModelId(providerId, input.modelId) ?? this.store.models.get(`${providerId}:${input.modelId}`);
    if (model) {
      const updatedQuota = { ...model.quota };
      let changed = false;
      if (telemetry.requestsLimit && telemetry.requestsLimit > 0) {
        if (requestsWindow === 'per_day' && updatedQuota.requestsPerDay !== telemetry.requestsLimit) {
          updatedQuota.requestsPerDay = telemetry.requestsLimit;
          changed = true;
        } else if (requestsWindow === 'per_minute' && updatedQuota.requestsPerMinute !== telemetry.requestsLimit) {
          updatedQuota.requestsPerMinute = telemetry.requestsLimit;
          changed = true;
        }
      }
      if (telemetry.tokensLimit && telemetry.tokensLimit > 0) {
        if (tokensWindow === 'per_day' && updatedQuota.tokensPerDay !== telemetry.tokensLimit) {
          updatedQuota.tokensPerDay = telemetry.tokensLimit;
          changed = true;
        } else if (tokensWindow === 'per_minute' && updatedQuota.tokensPerMinute !== telemetry.tokensLimit) {
          updatedQuota.tokensPerMinute = telemetry.tokensLimit;
          changed = true;
        }
      }
      if (changed) {
        updatedQuota.provenance = {
          source: 'observed_header',
          confidence: 0.95,
          observedAt: this.now().toISOString(),
          note: `Limit observed directly in a ${record?.name ?? providerId} response header (${requestsWindow} requests / ${tokensWindow} tokens). Overrides configured estimates.`,
        };
        this.store.models.updateQuota(model.id, updatedQuota, model.quotaType);
        this.logger.info('learned quota limit from provider header', {
          providerId,
          model: input.modelId,
          requestsPerDay: updatedQuota.requestsPerDay,
          tokensPerMinute: updatedQuota.tokensPerMinute,
        });
      }

      // A header saying "0 remaining" is a hard stop for the current window.
      if (telemetry.requestsRemaining === 0 || telemetry.tokensRemaining === 0) {
        this.applyCooldown(
          providerId,
          new ProviderError({
            category: 'quota_exhausted',
            message: `Provider reports 0 remaining (requests: ${telemetry.requestsRemaining ?? 'n/a'}, tokens: ${telemetry.tokensRemaining ?? 'n/a'}).`,
            providerId,
            modelId: input.modelId,
            retryAfterMs: null,
          }),
        );
      }
    }

    return { learned: { requestsLimit: telemetry.requestsLimit ?? null, tokensLimit: telemetry.tokensLimit ?? null }, recorded: true };
  }

  /** Called when a request fails with rate_limit/quota_exhausted. */
  recordFailure(providerId: string, error: ProviderError): void {
    if (error.category === 'rate_limit' || error.category === 'quota_exhausted') {
      this.applyCooldown(providerId, error);
      const maxObservedWindow = this.consumeObservedRateLimit(providerId, error);
      this.logger.warn('rate limited by provider', { providerId, category: error.category, cooldown: maxObservedWindow });
    }
    this.store.providers.updateRuntime(providerId, { lastError: error.message });
  }

  /**
   * When a provider refuses a request, the *effective* limit is at most what we
   * already used in the current window. Recording that turns repeated 429s into a
   * converging estimate instead of an infinite loop of optimistic requests.
   */
  private consumeObservedRateLimit(providerId: string, error: ProviderError): string | null {
    const { day } = this.windowsFor(this.effectiveLimits(providerId, null));
    const bucket = this.store.quota.getBucket({
      providerId,
      scopeModel: '',
      window: 'per_day',
      windowStart: day.start.toISOString(),
    });
    if (bucket && bucket.usedRequests > 0 && (bucket.limitRequests === null || bucket.limitRequests > bucket.usedRequests)) {
      this.logger.debug('inferring a lower daily request ceiling from a 429', {
        providerId,
        previousLimit: bucket.limitRequests,
        inferredLimit: bucket.usedRequests,
      });
      this.store.quota.setLimits(bucket.id, {
        limitTokens: bucket.limitTokens,
        limitRequests: bucket.usedRequests,
        windowEnd: bucket.windowEnd,
      });
      const model = this.store.models.list({ providerId, limit: 200 });
      for (const m of model) {
        const quota = { ...m.quota };
        if (quota.requestsPerDay === null || quota.requestsPerDay > bucket.usedRequests) {
          quota.requestsPerDay = bucket.usedRequests;
          quota.provenance = {
            source: 'inferred',
            confidence: 0.5,
            observedAt: this.now().toISOString(),
            note: `Inferred from a ${error.category} response: the provider refused after ${bucket.usedRequests} requests in this window, so the real ceiling is at most that.`,
          };
          this.store.models.updateQuota(m.id, quota, m.quotaType);
        }
      }
      return `${bucket.usedRequests} requests/day (inferred)`;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  usage(providerId: string, model: ModelInfo | null): QuotaUsageSummary {
    const limits = this.effectiveLimits(providerId, model);
    const { minute, day } = this.windowsFor(limits);
    const dayBucket = this.store.quota.getBucket({ providerId, scopeModel: '', window: day.bucket, windowStart: day.start.toISOString() });
    const minuteBucket = this.store.quota.getBucket({ providerId, scopeModel: '', window: minute.bucket, windowStart: minute.start.toISOString() });
    const record = this.store.providers.get(providerId);
    const observation = this.store.quota.latestObservation(providerId, '');

    // Rolling strategies report and enforce the trailing span, not one bucket.
    const dayUsed: { requests: number; tokens: number } = day.rolling
      ? (() => {
          const totals = this.store.quota.sumBuckets(
            providerId,
            '',
            day.rolling.window,
            new Date(this.now().getTime() - day.rolling.spanMs).toISOString(),
            this.now().toISOString(),
          );
          return { requests: totals.requests, tokens: totals.tokens };
        })()
      : { requests: dayBucket?.usedRequests ?? 0, tokens: dayBucket?.usedTokens ?? 0 };
    const minuteUsed: { requests: number; tokens: number } = {
      requests: minuteBucket?.usedRequests ?? 0,
      tokens: minuteBucket?.usedTokens ?? 0,
    };

    // Compute how much of the *governed* budget remains. When the only known limits
    // are per-minute, the daily picture is reported as unknown rather than guessed.
    const fractions: number[] = [];
    if (limits.requestsPerDay) fractions.push(Math.max(0, 1 - dayUsed.requests / limits.requestsPerDay));
    if (limits.tokensPerDay) fractions.push(Math.max(0, 1 - dayUsed.tokens / limits.tokensPerDay));
    const remainingFraction = fractions.length ? Math.min(...fractions) : null;

    return {
      providerId,
      modelId: model?.id ?? null,
      quotaType: model?.quotaType ?? record?.quotaType ?? 'unknown',
      minute: {
        requestsUsed: minuteUsed.requests,
        requestsLimit: limits.requestsPerMinute,
        tokensUsed: minuteUsed.tokens,
        tokensLimit: limits.tokensPerMinute,
        resetsAt: minute.end.toISOString(),
        resetsInMs: minute.end.getTime() - this.now().getTime(),
        estimated: false,
      },
      day: {
        requestsUsed: dayUsed.requests,
        requestsLimit: limits.requestsPerDay,
        tokensUsed: dayUsed.tokens,
        tokensLimit: limits.tokensPerDay,
        resetsAt: day.end.toISOString(),
        resetsInMs: day.end.getTime() - this.now().getTime(),
        estimated: day.estimated,
        resetDescription: describeReset(day, limits.resetTimezone),
      },
      remainingFraction,
      cooldownUntil: record?.cooldownUntil ?? null,
      reported: observation
        ? {
            requestsRemaining: observation.remaining_requests === null ? undefined : Number(observation.remaining_requests),
            requestsLimit: observation.limit_requests === null ? undefined : Number(observation.limit_requests),
            tokensRemaining: observation.remaining_tokens === null ? undefined : Number(observation.remaining_tokens),
            tokensLimit: observation.limit_tokens === null ? undefined : Number(observation.limit_tokens),
            resetRequests: observation.reset_requests === null ? undefined : String(observation.reset_requests),
            resetTokens: observation.reset_tokens === null ? undefined : String(observation.reset_tokens),
          }
        : null,
      unknownLimits: limits.unknown,
    };
  }

  /** Compact snapshots for the provider list / dashboard. */
  snapshots(models: ModelInfo[]): QuotaSnapshot[] {
    return models.map((model) => {
      const usage = this.usage(model.providerId, model);
      return {
        providerId: model.providerId,
        modelId: model.id,
        quotaType: model.quotaType,
        window: 'per_day',
        limit: usage.day.tokensLimit ?? usage.day.requestsLimit,
        used: usage.day.tokensLimit ? usage.day.tokensUsed : usage.day.requestsUsed,
        remaining:
          usage.day.tokensLimit !== null
            ? Math.max(0, usage.day.tokensLimit - usage.day.tokensUsed)
            : usage.day.requestsLimit !== null
              ? Math.max(0, usage.day.requestsLimit - usage.day.requestsUsed)
              : null,
        remainingFraction: usage.remainingFraction,
        resetsAt: usage.day.resetsAt,
        resetStrategy: model.quota.resetStrategy,
        resetIsEstimated: usage.day.estimated,
        provenance: model.quota.provenance,
        cooldownUntil: usage.cooldownUntil,
      };
    });
  }
}

class QuotaDeniedError extends Error {
  constructor(
    readonly window: QuotaWindow,
    readonly limitTokens: number | null,
    readonly limitRequests: number | null,
  ) {
    super(`Quota reservation denied for window ${window}`);
    this.name = 'QuotaDeniedError';
  }
}
