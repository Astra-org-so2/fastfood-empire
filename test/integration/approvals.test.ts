import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalService } from '@aido/orchestrator';
import {
  createHarness,
  sampleProject,
  sampleTask,
  testProviderDefinition,
  ScriptedProvider,
  type Harness,
} from '@aido/testing';

/**
 * Dangerous-action approvals (§44, §51.22–23, §43).
 *
 * A pending approval is a *paused task*, not a badge: the entity that asked for
 * permission must not act while the request is open, and the operator's answer must be
 * what continues or closes the work. Both halves were previously missing — the run
 * engine handed the tool the request object (truthy, so a supervised overwrite went
 * ahead while the UI still showed "pending") and nothing consumed the decision, so an
 * approval only changed a row and the task stayed paused for good.
 *
 * These tests drive the real path: scripted model → tool gate → approval row → decision →
 * resumed run, with the file system as the witness that nothing happened early.
 */

const TARGET = 'README.md';
const DENIED_WRITE = '# Rewritten by the agent\n';
const FILE_ON_DISK = '# Project\n\nOriginal content the agent must not clobber.\n';

/** Envelope asking to overwrite an existing file — the canonical dangerous action. */
function overwriteEnvelope(): string {
  return JSON.stringify({
    reasoning_summary: 'The README predates the new endpoint, so I am rewriting it.',
    actions: [{ tool: 'write_file', args: { path: TARGET, content: DENIED_WRITE }, purpose: 'Rewrite the README' }],
    status: 'working',
    blocker: null,
  });
}

function completionEnvelope(): string {
  return JSON.stringify({
    reasoning_summary: 'The README now documents the endpoint.',
    actions: [],
    result: { summary: 'README updated', artifacts: [{ path: TARGET, action: 'modified' }] },
    status: 'completed',
    blocker: null,
  });
}

async function waitFor<T>(
  check: () => T | null | undefined | Promise<T | null | undefined>,
  label: string,
  timeoutMs = 8_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10);
      timer.unref?.();
    });
  }
}

describe('dangerous actions and approval decisions', () => {
  let harness: Harness | null = null;
  afterEach(() => {
    harness?.close();
    harness = null;
  });

  /**
   * A supervised project with one task that wants to overwrite a file that already
   * exists. The scripted provider returns the overwrite twice, then a completion: the
   * first call is refused by the gate, the second (after approval) must actually write.
   */
  async function supervisedProject(options: { dependent?: boolean } = {}) {
    const definition = testProviderDefinition('scripted-writer', {
      name: 'Scripted writer',
      // The router infers capability flags from the model id, and the simulator ids
      // ("sim-small") are not code models, so the scripted catalogue declares one.
      seedModels: [{ id: 'scripted-coder', displayName: 'Scripted coder', contextWindow: 32_000, maxOutputTokens: 4_096 }],
    });
    const created = await createHarness({
      definitions: [definition],
      settingsPatch: (settings) => {
        settings.executionMode = 'supervised';
      },
    });
    const provider = new ScriptedProvider({
      definition,
      logger: created.logger,
      outcomes: [
        { kind: 'success', content: overwriteEnvelope() },
        { kind: 'success', content: overwriteEnvelope() },
        { kind: 'success', content: completionEnvelope() },
      ] as never[],
      repeat: true,
    });
    created.registry.registerDefinition(definition);
    created.registry.registerAdapter(definition.id, provider);
    await created.registry.discoverModels(definition.id);

    const projectId = 'p-approval';
    // The harness builds the workspace (and the git repository) at its own root, so the
    // project points there too — the assertion below reads the file the agent writes.
    const workspacePath = created.workspaceRoot;
    created.store.projects.create(sampleProject({ id: projectId, slug: 'approval', workspacePath }));
    const file = `${workspacePath}/${TARGET}`;
    fs.mkdirSync(workspacePath, { recursive: true });
    fs.writeFileSync(file, FILE_ON_DISK, 'utf8');

    created.store.tasks.create(
      sampleTask({
        id: 'task-write',
        projectId,
        agentRole: 'backend',
        taskType: 'code_generation',
        status: 'ready',
        resourceLocks: [`file:${TARGET}`],
        maxAttempts: 10,
      }),
    );
    if (options.dependent) {
      created.store.tasks.create(
        sampleTask({
          id: 'task-docs',
          projectId,
          title: 'Document the endpoint',
          agentRole: 'backend',
          status: 'blocked',
          dependsOn: ['task-write'],
          resourceLocks: ['file:docs/api.md'],
          orderIndex: 1,
        }),
      );
    }

    const runner = created.createRunner({ intervalMs: 15, maxTicks: 200 });
    harness = created;
    return { created, runner, projectId, file };
  }

  it('refuses a destructive tool call while its approval is undecided, then performs it once approved', async () => {
    const { created, runner, projectId, file } = await supervisedProject();

    await runner.start(projectId, { plan: false });

    const pending = await waitFor(
      () => created.store.approvals.listPending(projectId)[0] ?? null,
      'the approval request to be raised',
    );
    expect(pending).toMatchObject({ taskId: 'task-write', agentId: 'backend', status: 'pending', risk: 'medium' });
    expect(pending.action).toContain(TARGET);

    // The gate held: the operator has not decided, so the file is untouched, and the
    // task is parked in a state that says so rather than pretending to be running.
    expect(fs.readFileSync(file, 'utf8')).toBe(FILE_ON_DISK);
    const paused = created.store.tasks.get('task-write');
    expect(paused?.status).toBe('paused');
    expect(paused?.result?.summary).toContain('Waiting for approval');
    expect(created.store.agents.get(projectId, 'backend')?.state).toBe('waiting');

    // Approving queues the task again and wakes the run.
    created.approvals.decide(pending.id, 'approved', 'operator', 'Read the new endpoint, looks correct.');

    const done = await waitFor(
      () => (created.store.tasks.get('task-write')?.status === 'done' ? created.store.tasks.get('task-write') : null),
      'the task to finish after approval',
    );
    expect(done?.status).toBe('done');
    // The approval was what allowed the write — the same tool call that was refused
    // before the decision now goes through.
    expect(fs.readFileSync(file, 'utf8')).toBe(DENIED_WRITE);
    expect(created.store.approvals.get(pending.id)?.status).toBe('approved');
  });

  it('fails the task and releases its dependents when the operator denies the action', async () => {
    const { created, runner, projectId, file } = await supervisedProject({ dependent: true });

    await runner.start(projectId, { plan: false });
    const pending = await waitFor(() => created.store.approvals.listPending(projectId)[0] ?? null, 'the approval request');

    created.approvals.decide(pending.id, 'denied', 'operator', 'Do not touch the README.');

    const failed = await waitFor(
      () => (created.store.tasks.get('task-write')?.status === 'failed' ? created.store.tasks.get('task-write') : null),
      'the task to be failed by the denial',
    );
    // The reason survives in the task row: "nothing happened" is not an explanation.
    expect(failed?.lastError).toContain('Denied by the operator');
    expect(failed?.lastError).toContain('Do not touch the README.');
    expect(failed?.lastError).toContain(TARGET);
    expect(fs.readFileSync(file, 'utf8')).toBe(FILE_ON_DISK);
    expect(created.store.agents.get(projectId, 'backend')?.state).toBe('idle');

    // A task that can never finish must not leave its dependents waiting on it forever.
    const dependent = created.store.tasks.get('task-docs');
    expect(dependent?.status).toBe('blocked');
    expect(dependent?.lastError).toContain('denied');
  });

  /**
   * A grant's reach is the difference between "approve once" and "approve for the rest of
   * the task". Both used to behave as the latter, so an operator choosing "once" was in
   * fact licensing that destructive call on every future attempt of the task.
   */
  async function approveThenRerun(scope: 'once' | 'task') {
    const { created, runner, projectId, file } = await supervisedProject();
    await runner.start(projectId, { plan: false });
    const first = await waitFor(() => created.store.approvals.listPending(projectId)[0] ?? null, 'the first approval request');
    created.approvals.decide(first.id, 'approved', 'operator', 'Go ahead.', scope);
    await waitFor(
      () => (created.store.tasks.get('task-write')?.status === 'done' ? created.store.tasks.get('task-write') : null),
      'the task to finish after approval',
    );
    expect(created.store.approvals.get(first.id)?.decisionScope).toBe(scope);

    // The operator runs the same task again — as they would after a failed test run or
    // to reproduce something. The scripted model asks to overwrite the file once more.
    created.store.tasks.update('task-write', { status: 'ready' });
    await runner.start(projectId, { plan: false });
    return { created, projectId, file };
  }

  it('honours a "once" grant only for the attempt it was approved for', async () => {
    const { created, projectId, file } = await approveThenRerun('once');

    // The next attempt is a new situation, so the gate asks again instead of reusing the
    // old answer.
    const second = await waitFor(() => created.store.approvals.listPending(projectId)[0] ?? null, 'a second approval request');
    expect(second.action).toContain(TARGET);
    const rows = created.store.approvals.list(projectId, 50);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === 'approved')).toHaveLength(1);
    expect(created.store.tasks.get('task-write')?.status).toBe('paused');
    // And nothing was written on the back of the stale grant.
    expect(fs.readFileSync(file, 'utf8')).toBe(DENIED_WRITE);
  });

  it('lets a "task"-scoped grant cover later attempts without asking again', async () => {
    const { created, projectId } = await approveThenRerun('task');

    await waitFor(
      () => (created.store.tasks.get('task-write')?.status === 'done' ? created.store.tasks.get('task-write') : null),
      'the re-run to finish without a new prompt',
    );
    expect(created.store.approvals.listPending(projectId)).toHaveLength(0);
    expect(created.store.approvals.list(projectId, 50)).toHaveLength(1);
  });

  it('resolves an expired request as "no", never as an approval, and does not report a decision', async () => {
    const created = await createHarness({ definitions: [] });
    harness = created;
    created.store.projects.create(sampleProject({ id: 'p-expiry', slug: 'expiry', workspacePath: `${created.workspaceRoot}/expiry` }));
    const decisions: string[] = [];
    const service = new ApprovalService({
      store: created.store,
      events: created.events,
      logger: created.logger,
      onDecided: (_request, decision) => decisions.push(decision),
    });

    const request = service.request({
      projectId: 'p-expiry',
      action: 'Overwrite README.md',
      reason: 'test',
      risk: 'medium',
      payload: { key: 'modify_file:README.md' },
    });

    const answer = await service.waitForDecision(request.id, 25);
    expect(answer).toBeNull();
    expect(created.store.approvals.get(request.id)?.status).toBe('expired');
    // Expiry is a timeout, not a verdict: the decision handler must not treat it as one.
    expect(decisions).toEqual([]);
    service.dispose();
  });

  it('keeps a decision even when the listener that continues the work throws', async () => {
    const created = await createHarness({ definitions: [] });
    harness = created;
    created.store.projects.create(sampleProject({ id: 'p-listener', slug: 'listener', workspacePath: `${created.workspaceRoot}/listener` }));
    const service = new ApprovalService({
      store: created.store,
      events: created.events,
      logger: created.logger,
      onDecided: () => {
        throw new Error('downstream failure');
      },
    });

    const request = service.request({
      projectId: 'p-listener',
      taskId: 'task-1',
      action: 'Run: rm -rf build',
      reason: 'test',
      risk: 'high',
    });

    const decided = service.decide(request.id, 'approved', 'operator');
    // The row is the source of truth; a broken listener must not un-decide it or throw
    // back at the API caller who just approved something.
    expect(decided?.status).toBe('approved');
    expect(created.store.approvals.get(request.id)?.status).toBe('approved');
    service.dispose();
  });
});
