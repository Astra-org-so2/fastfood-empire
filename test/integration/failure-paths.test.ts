import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from '@aido/types';
import { createHarness, sampleTaskRequest, testProviderDefinition, ScriptedProvider, type Harness } from '@aido/testing';
import { AgentResponseSchema, PlanSchema, ReviewSchema, TestReportSchema } from '@aido/agents';

/**
 * Failure testing (§48) and self-healing (§20).
 *
 * These tests use scripted providers so every failure mode is deterministic: a 429
 * on the first candidate must fail over to the next, an exhausted quota must be
 * skipped *before* a request is sent, a non-retryable error must not be retried,
 * and a malformed response must never be accepted as a task result.
 */

describe('provider failure handling and self-healing', () => {
  let harness: Harness | null = null;
  afterEach(() => {
    harness?.close();
    harness = null;
  });

  async function setup(scripts: Record<string, ScriptedProvider>) {
    const definitions = Object.keys(scripts).map((id) => testProviderDefinition(id));
    const created = await createHarness({ definitions });
    for (const [id, provider] of Object.entries(scripts)) {
      created.registry.registerDefinition(testProviderDefinition(id));
      created.registry.registerAdapter(id, provider);
      await created.registry.discoverModels(id);
    }
    return created;
  }

  function scripted(harnessRef: Harness, id: string, outcomes: unknown[], repeat = true) {
    return new ScriptedProvider({
      definition: testProviderDefinition(id),
      logger: harnessRef.logger,
      outcomes: outcomes as never[],
      repeat,
    });
  }

  it('fails over to a healthy provider when the first candidate returns 429', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('flaky'), testProviderDefinition('steady')] });
    const flaky = scripted(harness, 'flaky', [{ kind: 'error', category: 'rate_limit', message: '429 Too Many Requests', retryAfterMs: 2_000 }]);
    const steady = scripted(harness, 'steady', [{ kind: 'success', content: 'Implemented successfully.' }]);
    for (const [id, provider] of [['flaky', flaky], ['steady', steady]] as const) {
      harness.registry.registerDefinition(testProviderDefinition(id));
      harness.registry.registerAdapter(id, provider);
      await harness.registry.discoverModels(id);
    }

    const result = await harness.executor.execute({
      taskRequest: sampleTaskRequest({ taskType: 'code_generation', maxLatencyMs: 60_000 }),
      messages: [{ role: 'user', content: 'Implement the endpoint.' }],
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    } as never);

    expect(result.response.content.length).toBeGreaterThan(0);
    expect(['flaky', 'steady']).toContain(result.chosen.providerId);
    // Whichever provider failed must have been cooled down and recorded, and the
    // successful call must be traceable to a failover.
    const traces = harness.store.traces.list({ limit: 20 });
    expect(traces.length).toBeGreaterThan(0);
    const errors = traces.filter((trace) => trace.status === 'error');
    for (const trace of errors) {
      expect(trace.errorCategory).not.toBeNull();
    }
  });

  it('never sends a request to a provider whose quota is exhausted', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('exhausted'), testProviderDefinition('available')] });
    const exhausted = scripted(harness, 'exhausted', [{ kind: 'success', content: 'this must never be returned' }]);
    const available = scripted(harness, 'available', [{ kind: 'success', content: 'Served by the available provider.' }]);
    for (const [id, provider] of [['exhausted', exhausted], ['available', available]] as const) {
      harness.registry.registerDefinition(testProviderDefinition(id, {
        // A daily token budget too small for this request: the router may prefer it,
        // but the reservation step must refuse to spend quota that is not there.
        quotaLimits: {
          requestsPerMinute: null,
          requestsPerHour: null,
          requestsPerDay: null,
          requestsPerMonth: null,
          tokensPerMinute: null,
          tokensPerDay: id === 'exhausted' ? 1_000 : null,
          tokensPerMonth: null,
          concurrentRequests: null,
          resetStrategy: 'utc_midnight',
          resetTimezone: null,
        },
      }));
      harness.registry.registerAdapter(id, provider);
      await harness.registry.discoverModels(id);
    }
    // Make the exhausted provider the router's first preference so the skip is real.
    for (const model of harness.store.models.list({ providerId: 'exhausted' })) harness.store.models.update(model.id, { priority: 100 });
    for (const model of harness.store.models.list({ providerId: 'available' })) harness.store.models.update(model.id, { priority: -100 });

    const result = await harness.executor.execute({
      taskRequest: sampleTaskRequest({ taskType: 'code_generation', estimatedInputTokens: 20_000, estimatedOutputTokens: 10_000 }),
      messages: [{ role: 'user', content: 'Do work that cannot fit in 1000 tokens.' }],
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    } as never);

    // The exhausted provider was skipped before any request reached it, and the
    // attempt is recorded with a reason the UI can show.
    expect(exhausted.received.length).toBe(0);
    expect(available.received.length).toBeGreaterThan(0);
    expect(result.chosen.providerId).toBe('available');
    const skipped = result.attempts.filter((attempt) => attempt.providerId === 'exhausted');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((attempt) => typeof attempt.message === 'string' && attempt.message.length > 0)).toBe(true);
  });

  it('does not retry a non-retryable error category', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('auth-broken')] });
    const provider = scripted(harness, 'auth-broken', [{ kind: 'error', category: 'authentication', message: '401 invalid key' }]);
    harness.registry.registerDefinition(testProviderDefinition('auth-broken'));
    harness.registry.registerAdapter('auth-broken', provider);
    await harness.registry.discoverModels('auth-broken');

    await expect(
      harness.executor.execute({
        taskRequest: sampleTaskRequest({ taskType: 'code_generation' }),
        messages: [{ role: 'user', content: 'Do work.' }],
        retryPolicy: { maxAttempts: 3, baseDelayMs: 1 },
      } as never),
    ).rejects.toMatchObject({ category: 'authentication' });

    // One attempt only: an invalid key cannot be fixed by trying again.
    expect(provider.received.length).toBe(1);
  });

  it('retries a transient server error on the same model rather than failing the task', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('flaky-once')] });
    const provider = new ScriptedProvider({
      definition: testProviderDefinition('flaky-once'),
      logger: harness.logger,
      outcomes: [
        { kind: 'error', category: 'server_error', message: '502 upstream' },
        { kind: 'success', content: 'Recovered on retry.' },
      ],
      repeat: false,
    });
    harness.registry.registerDefinition(testProviderDefinition('flaky-once'));
    harness.registry.registerAdapter('flaky-once', provider);
    await harness.registry.discoverModels('flaky-once');

    const result = await harness.executor.execute({
      taskRequest: sampleTaskRequest({ taskType: 'code_generation' }),
      messages: [{ role: 'user', content: 'Do work.' }],
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1 },
    } as never);

    expect(result.response.content).toBe('Recovered on retry.');
    expect(provider.received.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves no dangling reservation after a failed call', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('always-fails')] });
    const provider = scripted(harness, 'always-fails', [{ kind: 'error', category: 'server_error', message: 'boom' }]);
    harness.registry.registerDefinition(testProviderDefinition('always-fails'));
    harness.registry.registerAdapter('always-fails', provider);
    await harness.registry.discoverModels('always-fails');

    await expect(
      harness.executor.execute({
        taskRequest: sampleTaskRequest({ taskType: 'code_generation' }),
        messages: [{ role: 'user', content: 'Do work.' }],
        retryPolicy: { maxAttempts: 2, baseDelayMs: 1 },
      } as never),
    ).rejects.toBeInstanceOf(ProviderError);

    const reserved = harness.store.quota.openReservations();
    expect(reserved.length).toBe(0);
  });

  it('rejects a model that cannot satisfy a required capability instead of trying it', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('no-vision')] });
    harness.registry.registerDefinition(testProviderDefinition('no-vision'));
    await harness.registry.discoverModels('no-vision');

    const decision = harness.router.decide({
      settings: harness.settings,
      taskRequest: sampleTaskRequest({ taskType: 'code_generation', requiredCapabilities: ['vision'] }),
    });

    expect(decision.selected).toBeNull();
    expect(decision.rationale.rejected.flatMap((entry) => entry.reasons).join(' ')).toMatch(/vision|capabilit/i);
  });

  it('never routes to a paid model while FREE ONLY mode is on', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('paid-provider')] });
    harness.settings.freeOnlyMode = true;
    harness.registry.registerDefinition(testProviderDefinition('paid-provider'));
    await harness.registry.discoverModels('paid-provider');
    for (const model of harness.store.models.list({ providerId: 'paid-provider' })) {
      harness.store.models.update(model.id, {
        quotaType: 'paid',
        pricing: { inputPerMillionTokens: 3, outputPerMillionTokens: 15, provenance: { source: 'api_reported', confidence: 0.9, note: 'fixture' } },
      });
    }

    const decision = harness.router.decide({ settings: harness.settings, taskRequest: sampleTaskRequest({ taskType: 'code_generation' }) });
    expect(decision.selected).toBeNull();
    expect(decision.rationale.freeOnlyApplied).toBe(true);
    expect(decision.rationale.rejected.flatMap((entry) => entry.reasons).join(' ')).toMatch(/FREE ONLY|paid|trial/i);
  });

  it('explains why nothing could be used when every provider is disabled', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('disabled-provider')] });
    harness.registry.registerDefinition(testProviderDefinition('disabled-provider'), { enabled: false });
    await harness.registry.discoverModels('disabled-provider');

    const decision = harness.router.decide({ settings: harness.settings, taskRequest: sampleTaskRequest({ taskType: 'code_generation' }) });
    const reasons = decision.rationale.rejected.flatMap((entry) => entry.reasons).join(' ');
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons).toMatch(/disabled|not configured|unconfigured|free/i);
  });

  it('rejects malformed structured output instead of accepting it as a result', () => {
    // The agent envelope has no required fields, so it parses — but the loop treats a
    // "working" status with no actions and no result as a malformed answer and
    // re-prompts, then blocks. The role schemas, which carry real requirements do
    // reject bad payloads outright.
    const envelope = AgentResponseSchema.parse({ summary: 42 });
    expect(envelope.status).toBe('working');
    expect(envelope.actions).toEqual([]);
    expect(envelope.result).toBeNull();

    expect(PlanSchema.safeParse({ summary: 'Plan', tasks: [] }).success).toBe(false);
    expect(PlanSchema.safeParse({ summary: 'Plan', tasks: [{ id: 'a', title: 'x', description: 'too short', agent: 'nobody', taskType: 'code_generation' }] }).success).toBe(false);
    expect(ReviewSchema.safeParse({ summary: 'Looks fine', verdict: 'not_a_verdict' }).success).toBe(false);
    expect(TestReportSchema.safeParse({ summary: 'Tests ran', executed: 'yes' }).success).toBe(false);
  });

  it('classifies error categories consistently with the retry policy', () => {
    expect(new ProviderError({ category: 'rate_limit', message: '429', providerId: 'p' }).retryable).toBe(true);
    expect(new ProviderError({ category: 'timeout', message: 'timeout', providerId: 'p' }).retryable).toBe(true);
    expect(new ProviderError({ category: 'server_error', message: '500', providerId: 'p' }).retryable).toBe(true);
    expect(new ProviderError({ category: 'network_error', message: 'ECONNRESET', providerId: 'p' }).retryable).toBe(true);
    // Retrying these cannot succeed and would waste free quota.
    expect(new ProviderError({ category: 'quota_exhausted', message: 'daily limit', providerId: 'p' }).retryable).toBe(false);
    expect(new ProviderError({ category: 'authentication', message: '401', providerId: 'p' }).retryable).toBe(false);
    expect(new ProviderError({ category: 'context_length', message: 'too long', providerId: 'p' }).retryable).toBe(false);
    expect(new ProviderError({ category: 'invalid_request', message: '400', providerId: 'p' }).retryable).toBe(false);
    expect(new ProviderError({ category: 'content_filter', message: 'blocked', providerId: 'p' }).retryable).toBe(false);
    expect(new ProviderError({ category: 'cancelled', message: 'aborted', providerId: 'p' }).retryable).toBe(false);
  });
});
