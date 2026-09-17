import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sampleProject, sampleTaskRequest, testProviderDefinition, ScriptedProvider, type Harness } from '@aido/testing';
import { conflicts } from '@aido/orchestrator';

/**
 * The failure modes §48 requires us to test explicitly.
 *
 * `failure-paths.test.ts` covers the routing and retry decisions. This file covers the
 * modes that change *how much* work happens: a timeout that must be retried before it is
 * given up on, a context overflow that must not be retried at all, a provider that streams
 * half an answer and then dies, discovery that returns nothing, and limits that must stop
 * an agent instead of letting it loop.
 *
 * Each of these has a cheap wrong answer that looks fine in a demo:
 *   - retrying a context overflow forever (burns free quota and can never succeed),
 *   - retrying a mid-stream failure (the consumer already saw half an answer, so a retry
 *     silently duplicates output),
 *   - treating "no models discovered" as "models unknown, therefore try anyway",
 *   - letting an agent loop until the process is killed.
 */

describe('failure modes the platform must survive', () => {
  let harness: Harness | null = null;

  afterEach(() => {
    harness?.close();
    harness = null;
  });

  /** Builds a harness whose providers are scripted, and discovers their models. */
  async function setupWith(scripts: Record<string, { outcomes: unknown[]; repeat?: boolean }>): Promise<Harness> {
    const created = await createHarness({ definitions: Object.keys(scripts).map((id) => testProviderDefinition(id)) });
    for (const [id, script] of Object.entries(scripts)) {
      created.registry.registerDefinition(testProviderDefinition(id));
      created.registry.registerAdapter(
        id,
        new ScriptedProvider({
          definition: testProviderDefinition(id),
          logger: created.logger,
          outcomes: script.outcomes as never[],
          repeat: script.repeat ?? true,
        }),
      );
      await created.registry.discoverModels(id);
    }
    return created;
  }

  const adapterFor = (harnessRef: Harness, id: string): ScriptedProvider => harnessRef.registry.provider(id) as unknown as ScriptedProvider;

  /** Two tasks that both declare the same file lock. */
  const makeTask = (projectId: string, id: string, title: string) => {
    const now = new Date().toISOString();
    return {
      id,
      orderIndex: 0,
      projectId,
      title,
      description: 'Edit the same file.',
      agentRole: 'backend',
      taskType: 'code_generation',
      // `ready` is the status the scheduler dispatches from; a task that is still
      // `pending` has not been through dependency resolution yet.
      status: 'ready',
      priority: 'normal',
      attempts: 0,
      maxAttempts: 3,
      dependsOn: [],
      resourceLocks: ['file:src/shared.ts'],
      acceptanceCriteria: [],
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 500,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      lastError: null,
      lastModelId: null,
      result: null,
    };
  };

  const call = (harnessRef: Harness, overrides: Record<string, unknown> = {}) =>
    harnessRef.executor.execute({
      taskRequest: sampleTaskRequest({ taskType: 'code_generation' }),
      messages: [{ role: 'user', content: 'Do the work.' }],
      retryPolicy: { maxAttempts: 3, baseDelayMs: 1 },
      ...overrides,
    } as never);

  it('retries a timeout, then fails over rather than hanging', async () => {
    harness = await setupWith({
      slow: { outcomes: [{ kind: 'timeout', afterMs: 10 }] },
      patient: { outcomes: [{ kind: 'success', content: 'Served after the timeout.' }] },
    });
    const slow = adapterFor(harness, 'slow');
    const patient = adapterFor(harness, 'patient');

    // Only the timing-out provider is enabled, so the first pass is forced onto it: a
    // timeout is transient, so it must be retried before the candidate is abandoned.
    harness.store.providers.setEnabled('patient', false);
    await expect(call(harness, { retryPolicy: { maxAttempts: 2, baseDelayMs: 1 } })).rejects.toMatchObject({ category: 'timeout' });
    expect(slow.received.length, 'a timeout must be retried, not abandoned after one attempt').toBeGreaterThan(1);
    expect(patient.received.length).toBe(0);

    // With both available, the same failure fails over to a provider that works.
    harness.store.providers.setEnabled('patient', true);
    const result = await call(harness);
    expect(result.response.content).toContain('Served after the timeout');
    expect(patient.received.length).toBeGreaterThan(0);
  });

  it('does not retry a context overflow against the same model', async () => {
    harness = await setupWith({ 'small-window': { outcomes: [{ kind: 'context_length', limit: 8_192 }] } });
    const small = adapterFor(harness, 'small-window');

    // Every model on the provider overflows, so the run fails — but each model is asked at
    // most once. Failing over to a sibling model is legitimate (it may have a larger
    // window); asking the same one twice can never work, because the prompt is unchanged.
    const failure = await call(harness).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { category?: string }).category).toBe('context_length');

    const perModel = new Map<string, number>();
    for (const request of small.received) perModel.set(String(request.modelId), (perModel.get(String(request.modelId)) ?? 0) + 1);
    expect(perModel.size, 'the overflow must have been attempted at least once').toBeGreaterThan(0);
    for (const [modelId, attempts] of perModel) {
      expect(attempts, `${modelId} was asked twice with a prompt that cannot fit`).toBe(1);
    }
  });

  it('delivers partial output and reports a mid-stream failure instead of restarting it', async () => {
    harness = await setupWith({
      'half-answer': { outcomes: [{ kind: 'stream', deltas: ['first ', 'second ', 'third'], failAfterDeltas: 2 }] },
    });
    const provider = adapterFor(harness, 'half-answer');

    const seen: string[] = [];
    let failure: unknown = null;
    try {
      for await (const chunk of harness.executor.stream({
        taskRequest: sampleTaskRequest({ taskType: 'code_generation' }),
        messages: [{ role: 'user', content: 'Stream it.' }],
        retryPolicy: { maxAttempts: 3, baseDelayMs: 1 },
      } as never)) {
        if (chunk.delta) seen.push(chunk.delta);
      }
    } catch (err) {
      failure = err;
    }

    // The consumer keeps the tokens it already received, and knows the answer is truncated:
    // a silent retry would append a second beginning to the first one.
    expect(seen.join(''), 'partial output must reach the consumer as it arrives').toBe('first second ');
    expect(failure, 'a mid-stream failure must surface rather than being swallowed').not.toBeNull();
    expect(adapterFor(harness, 'half-answer').received.length, 'a partially delivered answer must not be retried').toBe(1);
    expect(provider.received.length).toBe(1);
  });

  it('treats a network failure as provider-wide instead of trying sibling models', async () => {
    harness = await setupWith({
      offline: { outcomes: [{ kind: 'error', category: 'network_error', message: 'ECONNREFUSED' }] },
      reachable: { outcomes: [{ kind: 'success', content: 'Reached.' }] },
    });

    // Two models on the unreachable provider, so a model-by-model retry would show up as
    // two distinct requests before the executor moved on.
    await harness.registry.discoverModels('offline');
    const result = await call(harness);

    expect(result.response.content).toBe('Reached.');
    const tried = new Set(adapterFor(harness, 'offline').received.map((request) => request.modelId));
    expect(tried.size, 'a refused connection is not a property of one model').toBe(1);
  });

  it('reports an invalid key and keeps the provider out of routing', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('bad-key')] });
    harness.registry.registerDefinition(testProviderDefinition('bad-key'));
    harness.registry.registerAdapter(
      'bad-key',
      new ScriptedProvider({
        definition: testProviderDefinition('bad-key'),
        logger: harness.logger,
        outcomes: [{ kind: 'invalid_key' }] as never[],
      }),
    );
    // Discovery succeeds — the catalogue is public — so the provider is routable until a
    // request proves the key wrong.
    await harness.registry.discoverModels('bad-key');
    const provider = adapterFor(harness, 'bad-key');

    // A rejected key is never retried: the second attempt would use the same key.
    await expect(call(harness)).rejects.toMatchObject({ category: 'authentication' });
    expect(provider.received.length).toBe(1);

    // Testing the credential records the verdict, and the provider drops out of routing
    // entirely — so the next task costs no request at all.
    const status = await harness.registry.healthCheck('bad-key');
    expect(status.status, 'a rejected key must not read as healthy').not.toBe('online');
    expect(harness.store.providers.get('bad-key')?.health.status).not.toBe('online');

    const before = provider.received.length;
    const outcome = await call(harness).catch((error: unknown) => error);
    expect((outcome as { category?: string }).category).toBe('model_unavailable');
    expect(provider.received.length, 'an unusable provider must not receive another request').toBe(before);
  });

  it('surfaces a provider that discovers no models instead of routing to it', async () => {
    harness = await createHarness({ definitions: [testProviderDefinition('empty-catalogue')] });
    harness.registry.registerDefinition(testProviderDefinition('empty-catalogue'));
    harness.registry.registerAdapter(
      'empty-catalogue',
      new ScriptedProvider({
        definition: testProviderDefinition('empty-catalogue'),
        logger: harness.logger,
        outcomes: [{ kind: 'no_models' }, { kind: 'success' }] as never[],
        repeat: false,
      }),
    );
    const provider = adapterFor(harness, 'empty-catalogue');

    const discovery = await harness.registry.discoverModels('empty-catalogue');
    expect(discovery.models).toHaveLength(0);
    expect(provider.received.length, 'discovery itself is not a chat request').toBe(0);

    // The router must refuse rather than inventing a candidate.
    const outcome = await call(harness).catch((error: unknown) => error);
    expect(outcome, 'a provider with no known models must not be routed to').toBeInstanceOf(Error);
    expect((outcome as { category?: string }).category).toBe('model_unavailable');
    expect(provider.received.length, 'no request may be sent to a provider with no known models').toBe(0);
  });

  it('stops an agent that would otherwise run forever, and says why', async () => {
    harness = await createHarness();
    // With no provider enabled, every attempt fails immediately: the loop's limits are what
    // stops it, and the test would time out if they were not enforced.
    const agent = harness.createAgent('backend');
    const started = Date.now();

    const result = await agent.run({
      projectId: 'p-loop',
      task: {
        id: 't-loop',
        orderIndex: 0,
        projectId: 'p-loop',
        title: 'Never finishes',
        description: 'Keep going until something stops you.',
        agentRole: 'backend',
        taskType: 'code_generation',
        status: 'running',
        priority: 'normal',
        attempts: 1,
        maxAttempts: 1,
        dependsOn: [],
        resourceLocks: [],
        acceptanceCriteria: [],
        estimatedInputTokens: 1_000,
        estimatedOutputTokens: 500,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        lastError: null,
        lastModelId: null,
        result: null,
      } as never,
      workspace: harness.workspaceFor(),
      git: harness.gitFor(),
      requestApproval: async () => null,
      limitsOverride: { maxIterations: 3 },
    } as never);

    const elapsed = Date.now() - started;
    expect(result.status, 'an agent whose work never succeeds must fail, not hang').toBe('failed');
    expect(result.error, 'the failure must carry a reason the operator can read').toBeTruthy();
    expect(elapsed, 'the iteration limit must bound the wall clock, not the test timeout').toBeLessThan(30_000);
    expect(result.iterations ?? 0).toBeLessThanOrEqual(5);
  });

  it('keeps concurrent writers off the same file lock', async () => {
    harness = await createHarness();
    harness.settings.supervisor.maxParallelAgents = 2;
    const project = harness.store.projects.create(
      sampleProject({ id: 'p-locks', slug: 'locks', workspacePath: `${harness.workspaceRoot}/locks` }),
    );
    harness.store.tasks.create(makeTask(project.id, 't-a', 'First writer') as never);
    harness.store.tasks.create(makeTask(project.id, 't-b', 'Second writer') as never);

    // The rule itself: overlapping locks conflict, disjoint ones do not.
    expect(conflicts(['file:src/shared.ts'], ['file:src/shared.ts'])).toBe(true);
    expect(conflicts(['file:src/shared.ts'], ['file:src/other.ts'])).toBe(false);
    expect(conflicts([], ['file:src/shared.ts'])).toBe(false);

    // And the consequence: with capacity for both tasks, the second one waits until the
    // first has released the lock, so the two execution windows never overlap.
    await harness.registry.setEnabled('simulated', true);
    await harness.registry.discoverModels('simulated');
    const engine = harness.createEngine();
    await engine.runToCompletion(project, { maxTicks: 12 });

    const windows = harness.store.executions
      .listForProject(project.id)
      .filter((execution) => execution.taskId === 't-a' || execution.taskId === 't-b')
      .map((execution) => ({
        taskId: execution.taskId as string,
        from: new Date(execution.startedAt).getTime(),
        to: new Date(execution.finishedAt ?? new Date().toISOString()).getTime(),
      }));

    expect(windows.length, 'both locked tasks should have run').toBe(2);
    const [first, second] = windows.sort((a, b) => a.from - b.from);
    expect(first && second && second.from, 'the second writer started while the first still held the lock').toBeGreaterThanOrEqual(
      first?.to ?? 0,
    );
  });
});
