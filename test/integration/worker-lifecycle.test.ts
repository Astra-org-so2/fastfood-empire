import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer, type Container } from '../../apps/api/src/container.js';
import { DEFAULT_TEAM } from '@aido/agents';
import { createBackgroundScheduler, ensureAgentBranch, reclaimInterruptedTasks, resumeRun } from '@aido/orchestrator';
import type { Project } from '@aido/types';

/**
 * Background execution and crash recovery (§18, §43, §48).
 *
 * The worker runs the same orchestration as the API, so these tests exercise the real
 * `ProjectRunner` against a real SQLite database and a real Git repository: the point
 * is that a run survives the process that started it, and that an interrupted task is
 * recovered rather than left hanging.
 */
describe('background runs and recovery', () => {
  let container: Container;
  let dataDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'aido-worker-data-'));
    workspaceRoot = mkdtempSync(path.join(tmpdir(), 'aido-worker-ws-'));
    container = createContainer({
      configOverrides: { dataDir, workspaceRoot, providerDir: path.join(process.cwd(), 'config/providers'), logLevel: 'error' },
      authRequired: false,
    });
    container.updateSettings({ executionMode: 'auto', freeOnlyMode: true, supervisor: { ...container.settings().supervisor, maxParallelAgents: 2 } });
  });

  afterEach(async () => {
    await container.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function createProject(name = 'Worker Test Project'): Promise<Project> {
    const created = container.store.projects.create({
      id: crypto.randomUUID(),
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      description: 'created by the worker integration test',
      spec: {
        goal: 'Build a CLI that reverses a string',
        description: '',
        techStack: [],
        constraints: [],
        nonFunctional: [],
        acceptanceCriteria: [],
        targetUsers: '',
        deliverable: '',
      },
      status: 'draft',
      workspacePath: path.join(workspaceRoot, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')),
      branch: 'main',
      sourceRepo: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      settings: {
        executionMode: 'auto',
        maxParallelAgents: 2,
        autoStart: false,
        enabledAgents: [...DEFAULT_TEAM],
        freeOnlyMode: null,
        maxTotalTokens: null,
        gitAuthorName: 'AI Dev Orchestrator',
        gitAuthorEmail: 'agents@aido.local',
      },
    });
    await container.provisionWorkspace(created);
    return created;
  }

  it('runs a planned project to completion in the background', async () => {
    const project = await createProject();
    await container.planProject(project);
    const planned = container.store.tasks.listByProject(project.id);
    expect(planned.length).toBeGreaterThan(0);

    await ensureAgentBranch(container, project);
    resumeRun(container, project);
    const status = await container.runner.start(project.id, { plan: false });
    expect(status.running).toBe(true);

    // Wait for the runner's loop to settle; the exit condition is state, not a timer.
    const deadline = Date.now() + 90_000;
    while (container.runner.listActive().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(container.runner.listActive()).toHaveLength(0);

    const tasks = container.store.tasks.listByProject(project.id);
    expect(tasks.every((task) => task.status === 'done')).toBe(true);
    // A finished run must not stay "running", or a worker would start it again.
    expect(container.store.runSignals.get(project.id).runState).toBe('idle');
    // Each model call is traced, and the quota engine settled every reservation.
    expect(container.store.traces.list({ projectId: project.id, limit: 500 }).length).toBeGreaterThanOrEqual(tasks.length);
    const buckets = container.store.quota.listBuckets('simulated');
    expect(buckets.reduce((sum, bucket) => sum + bucket.usedRequests, 0)).toBeGreaterThan(0);
    expect(container.store.quota.openReservations()).toHaveLength(0);
    // Work landed on disk, on a per-agent branch, with the task's declared file.
    expect(container.workspaceFor(project).exists('package.json')).toBe(true);
    const git = container.gitFor(project);
    const branches = await git.branches();
    expect(branches.filter((branch) => branch.name.startsWith('agent/')).length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('recovers tasks left running by a stopped process', async () => {
    const project = await createProject('Interrupted Project');
    await container.planProject(project);
    const task = container.store.tasks.listByProject(project.id).find((candidate) => candidate.status === 'ready');
    expect(task).toBeDefined();
    container.store.tasks.update(task!.id, { status: 'running', startedAt: new Date().toISOString(), attempts: 1 });

    const recovery = reclaimInterruptedTasks(container, project);
    expect(recovery.reclaimed).toBe(1);
    const recovered = container.store.tasks.get(task!.id)!;
    expect(recovered.status).toBe('ready');
    expect(recovered.lastError).toContain('interrupted');
    // The attempt counter is preserved, so retry limits still bound the work.
    expect(recovered.attempts).toBe(1);
  }, 60_000);

  it('does not restart a run the operator stopped', async () => {
    const project = await createProject('Stopped Project');
    await container.planProject(project);
    const tasks = container.store.tasks.listByProject(project.id);
    container.store.runSignals.set(project.id, { runState: 'stopping', paused: true, cancelRequested: true });
    for (const task of tasks.filter((candidate) => candidate.status === 'ready')) {
      container.store.tasks.update(task.id, { status: 'running' });
    }

    const recovery = reclaimInterruptedTasks(container, project);
    expect(recovery.cancelled).toBeGreaterThan(0);
    expect(recovery.reclaimed).toBe(0);
    for (const task of container.store.tasks.listByProject(project.id)) {
      if (task.status === 'cancelled') expect(task.lastError).toContain('cancelled');
    }
  }, 60_000);

  it('claims only projects that asked for background work', async () => {
    const scheduler = createBackgroundScheduler({
      context: { store: container.store, runner: container.runner, logger: container.logger, events: container.events, gitFor: (project) => container.gitFor(project) },
      projectFilter: [],
    });

    const idle = await createProject('Idle Project');
    await container.planProject(idle);
    // Planned but never started, and no crashed task: not this process's business.
    expect(scheduler.claimableProjects()).not.toContain(idle.id);

    const requested = await createProject('Requested Project');
    await container.planProject(requested);
    container.store.runSignals.set(requested.id, { runState: 'running', paused: false, cancelRequested: false });
    expect(scheduler.claimableProjects()).toContain(requested.id);

    // A project whose run was cancelled is settled, never restarted.
    container.store.runSignals.set(requested.id, { runState: 'stopping', paused: true, cancelRequested: true });
    const result = await scheduler.tick();
    expect(result.cancelled).toContain(requested.id);
    expect(result.started).not.toContain(requested.id);
    expect(container.store.runSignals.get(requested.id).runState).toBe('idle');
  }, 60_000);

  it('drains an active run instead of closing storage underneath it', async () => {
    const project = await createProject('Drain Project');
    await container.planProject(project);
    await container.runner.start(project.id, { plan: false });

    const drained = await container.runner.shutdown(20_000);
    expect(drained.stopped).toBeGreaterThan(0);
    expect(drained.abandoned).toBe(0);
    expect(container.runner.listActive()).toHaveLength(0);
    // A task interrupted by shutdown is returned to the queue, not left "running".
    const interrupted = container.store.tasks.listByProject(project.id).filter((task) => task.status === 'running');
    expect(interrupted).toHaveLength(0);
  }, 70_000);
});
