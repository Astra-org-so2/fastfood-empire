import { afterEach, describe, expect, it } from 'vitest';
import type { ModelInfo } from '@aido/types';
import { createHarness, testProviderDefinition, type Harness } from '@aido/testing';

/**
 * Quota accounting is the most safety-critical part of the platform: a race here
 * means two agents spend the same allowance and the second one gets a 429 (§8, §51.7).
 */

function modelFor(providerId: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: `${providerId}:test-model`,
    providerId,
    providerModelId: 'test-model',
    displayName: 'Test model',
    contextWindow: 32_768,
    maxOutputTokens: 4_096,
    capabilities: { chat: true, streaming: true },
    pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0, source: 'user_configured' },
    quota: {
      requestsPerMinute: null,
      requestsPerHour: null,
      requestsPerDay: null,
      requestsPerMonth: null,
      tokensPerMinute: null,
      tokensPerDay: null,
      tokensPerMonth: null,
      concurrentRequests: null,
      resetStrategy: 'utc_midnight',
      resetTimezone: null,
      provenance: { source: 'user_configured', confidence: 1, note: 'test fixture' },
    },
    quotaType: 'free_renewable',
    performance: { averageLatencyMs: null, averageFirstTokenLatencyMs: null, successRate: null, samples: 0, consecutiveFailures: 0, lastUsedAt: null, lastErrorAt: null, lastErrorCategory: null },
    status: 'online',
    enabled: true,
    priority: 0,
    qualityPrior: 0.5,
    strengths: [],
    discoveredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  } as ModelInfo;
}

describe('quota engine', () => {
  let harness: Harness | null = null;
  afterEach(() => {
    harness?.close();
    harness = null;
  });

  it('never lets concurrent reservations exceed the bucket (atomicity)', async () => {
    harness = await createHarness();
    const { store, quota, settings } = harness;
    settings.quota.reserveFraction = 0.05;

    settings.quota.reserveFraction = 0.05;
    store.providers.upsertFromDefinition(testProviderDefinition('quota-race'), { enabled: true });
    const model = modelFor('quota-race', {
      quota: { ...modelFor('quota-race').quota, requestsPerDay: 5, tokensPerDay: 100_000, provenance: { source: 'user_configured', confidence: 1, note: 'fixture' } },
    });

    // Twenty simultaneous checks against a five-request daily allowance: the 5%
    // reserve must hold, and the database must contain exactly as many reservations
    // as were admitted — never more.
    const decisions = Array.from({ length: 20 }, () =>
      quota.check({ providerId: 'quota-race', modelId: 'test-model', estimatedInputTokens: 100, estimatedOutputTokens: 100, model }),
    );

    const allowed = decisions.filter((decision) => decision.allowed);
    const counts = store.db.all(`SELECT COUNT(*) AS n FROM quota_reservations WHERE provider_id = 'quota-race'`);
    expect(Number((counts[0] as { n: number }).n)).toBe(allowed.length);
    expect(allowed.length).toBeLessThanOrEqual(5);
    expect(allowed.length).toBeGreaterThan(0);
    for (const decision of decisions.filter((entry) => !entry.allowed)) {
      expect(decision.reason.length).toBeGreaterThan(0);
    }

    // A second wave must be refused: nothing may slip through after the allowance
    // (minus the reserve) is spent.
    const second = quota.check({ providerId: 'quota-race', modelId: 'test-model', estimatedInputTokens: 100, estimatedOutputTokens: 100, model });
    expect(second.allowed).toBe(false);
  });

  it('enforces a rolling window across the trailing span, including in-flight reservations', async () => {
    harness = await createHarness();
    const { store, quota } = harness;
    store.providers.upsertFromDefinition(testProviderDefinition('rolling-provider'), { enabled: true });
    const model = modelFor('rolling-provider', {
      quota: {
        ...modelFor('rolling-provider').quota,
        tokensPerDay: 1_000,
        resetStrategy: 'rolling_24h',
        provenance: { source: 'user_configured', confidence: 1, note: 'fixture' },
      },
    });

    const first = quota.check({ providerId: 'rolling-provider', modelId: 'test-model', estimatedInputTokens: 500, estimatedOutputTokens: 400, model });
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    quota.commit(first.reservation.id, { inputTokens: 500, outputTokens: 400 });

    // The committed 900 tokens are inside the trailing 24h, so this must be denied
    // even though the current hour bucket is far from full.
    const second = quota.check({ providerId: 'rolling-provider', modelId: 'test-model', estimatedInputTokens: 200, estimatedOutputTokens: 200, model });
    expect(second.allowed).toBe(false);
    if (second.allowed) return;
    expect(second.category).toBe('quota_exhausted');

    const usage = quota.usage('rolling-provider', model);
    expect(usage.day.tokensUsed).toBe(900);
  });

  it('denies instead of inventing limits when nothing is known', async () => {
    harness = await createHarness();
    const { store, quota, settings } = harness;
    settings.quota.assumeUnknownIsUnlimited = false;

    store.providers.upsertFromDefinition(testProviderDefinition('unknown-quota'), { enabled: true });
    const model = modelFor('unknown-quota', {
      quotaType: 'unknown',
      quota: {
        ...modelFor('unknown-quota').quota,
        provenance: { source: 'unknown', confidence: 0, note: 'no published limits' },
      },
    });

    const decision = quota.check({ providerId: 'unknown-quota', modelId: 'test-model', estimatedInputTokens: 10, estimatedOutputTokens: 10, model });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.category).toBe('unknown');
    expect(decision.reason).toMatch(/unknown|not known|limits/i);
  });

  it('meters unknown providers instead of pretending they are unlimited', async () => {
    harness = await createHarness();
    const { store, quota, settings } = harness;
    settings.quota.assumeUnknownIsUnlimited = true;

    store.providers.upsertFromDefinition(testProviderDefinition('metered-unknown'), { enabled: true });
    const model = modelFor('metered-unknown', {
      quotaType: 'unknown',
      quota: { ...modelFor('metered-unknown').quota, provenance: { source: 'unknown', confidence: 0, note: 'unknown' } },
    });

    const decision = quota.check({ providerId: 'metered-unknown', modelId: 'test-model', estimatedInputTokens: 500, estimatedOutputTokens: 500, model });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.reasons.join(' ')).toMatch(/meter|unknown/i);
    quota.commit(decision.reservation.id, { inputTokens: 400, outputTokens: 600 });
    const usage = quota.usage('metered-unknown', model);
    expect(usage.day.tokensUsed).toBe(1_000);
  });

  it('shuts a provider down in cooldown after a rate-limit error instead of retrying into it', async () => {
    harness = await createHarness();
    const { store, quota } = harness;
    store.providers.upsertFromDefinition(testProviderDefinition('cool-down'), { enabled: true });
    const model = modelFor('cool-down');

    const { ProviderError } = await import('@aido/types');
    quota.recordFailure('cool-down', new ProviderError({ category: 'rate_limit', message: '429 with retry-after', providerId: 'cool-down', retryAfterMs: 60_000 }));

    const decision = quota.check({ providerId: 'cool-down', modelId: 'test-model', estimatedInputTokens: 10, estimatedOutputTokens: 10, model });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.category).toBe('cooldown');
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it('releases an unused reservation so the allowance is available again', async () => {
    harness = await createHarness();
    const { store, quota } = harness;
    store.providers.upsertFromDefinition(testProviderDefinition('release-provider'), { enabled: true });
    const model = modelFor('release-provider', {
      quota: { ...modelFor('release-provider').quota, requestsPerDay: 5, tokensPerDay: 50_000, provenance: { source: 'user_configured', confidence: 1, note: 'fixture' } },
    });

    const decision = quota.check({ providerId: 'release-provider', modelId: 'test-model', estimatedInputTokens: 500, estimatedOutputTokens: 500, model });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const before = quota.usage('release-provider', model);
    quota.release(decision.reservation.id);
    const after = quota.usage('release-provider', model);
    expect(after.day.requestsUsed).toBeLessThanOrEqual(before.day.requestsUsed);
    expect(store.quota.getReservation(decision.reservation.id)?.status).toBe('released');
  });

  it('reports every window as either provider-reported or explicitly estimated', async () => {
    harness = await createHarness();
    const { store, quota } = harness;
    store.providers.upsertFromDefinition(testProviderDefinition('estimate-provider'), { enabled: true });
    const usage = quota.usage('estimate-provider', modelFor('estimate-provider'));
    // A locally derived reset time is never presented as fact.
    expect(usage.day.resetDescription.length).toBeGreaterThan(0);
    expect(typeof usage.day.estimated).toBe('boolean');
  });

  it('expires stale reservations so a crashed agent does not leak allowance', async () => {
    harness = await createHarness();
    const { store, quota, settings } = harness;
    settings.quota.reservationTtlMs = 1;
    store.providers.upsertFromDefinition(testProviderDefinition('stale-provider'), { enabled: true });
    const model = modelFor('stale-provider', {
      quota: { ...modelFor('stale-provider').quota, requestsPerDay: 5, tokensPerDay: 50_000, provenance: { source: 'user_configured', confidence: 1, note: 'fixture' } },
    });

    const decision = quota.check({ providerId: 'stale-provider', modelId: 'test-model', estimatedInputTokens: 100, estimatedOutputTokens: 100, model });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const expired = quota.expireStaleReservations();
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(store.quota.getReservation(decision.reservation.id)?.status).not.toBe('reserved');
  });

  it('applies per-model limits from the catalogue rather than a global default', async () => {
    harness = await createHarness();
    const { store, quota } = harness;
    store.providers.upsertFromDefinition(
      testProviderDefinition('scoped-provider', {
        freeTier: {
          ...testProviderDefinition('scoped-provider').freeTier,
          // Declared resets are provider-wide semantics, so the timezone lives here.
          resetStrategy: 'provider_timezone',
          resetTimezone: 'America/Los_Angeles',
        },
      }),
      { enabled: true },
    );
    const strict = modelFor('scoped-provider', {
      quota: { ...modelFor('scoped-provider').quota, tokensPerDay: 1_000, resetStrategy: 'provider_timezone', resetTimezone: 'America/Los_Angeles', provenance: { source: 'provider_docs', confidence: 0.6, note: 'fixture' } },
    });

    const limits = quota.effectiveLimits('scoped-provider', strict);
    expect(limits.tokensPerDay).toBe(1_000);
    // A non-UTC reset strategy must carry its timezone through to the UI.
    expect(limits.resetStrategy).toBe('provider_timezone');
    expect(limits.resetTimezone).toBe('America/Los_Angeles');

    const decision = quota.check({ providerId: 'scoped-provider', modelId: 'test-model', estimatedInputTokens: 3_000, estimatedOutputTokens: 3_000, model: strict });
    expect(decision.allowed).toBe(false);
  });
});
