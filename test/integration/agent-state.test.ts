import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, sampleProject, type Harness } from '@aido/testing';

/**
 * Agent state and counters (§14, §21).
 *
 * The roster is declared in configuration, so an agent's row in the `agents` table only
 * comes into existence the first time the run engine writes to it. Two things therefore
 * have to hold, and neither is obvious from the schema:
 *
 *   1. a write to an agent that has no row yet must create it, or every project would
 *      report an empty roster while the run engine happily moved agents to `working`;
 *   2. counters must be incremented in the database rather than read-modify-written in
 *      TypeScript, or two tasks settling together lose one increment — and a lost
 *      increment on a quota-adjacent counter is exactly the kind of drift this platform
 *      cannot afford.
 */
describe('agent state persistence', () => {
  let harness: Harness | null = null;
  afterEach(() => {
    harness?.close();
    harness = null;
  });

  it('creates the agent row on first patch instead of silently writing nothing', async () => {
    harness = await createHarness({ definitions: [] });
    const project = harness.store.projects.create(sampleProject({ id: 'p-roster', slug: 'roster', workspacePath: `${harness.workspaceRoot}/roster` }));

    expect(harness.store.agents.list(project.id)).toHaveLength(0);

    harness.store.agents.patch(project.id, 'backend', { state: 'working', currentTaskId: 't1' });

    const rows = harness.store.agents.list(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: 'backend', state: 'working', currentTaskId: 't1', paused: false, tasksCompleted: 0 });

    // A second patch updates in place rather than adding a row.
    harness.store.agents.patch(project.id, 'backend', { state: 'idle', currentTaskId: null });
    const after = harness.store.agents.list(project.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ state: 'idle', currentTaskId: null });
  });

  it('accumulates counters and derives the success rate from them', async () => {
    harness = await createHarness({ definitions: [] });
    const project = harness.store.projects.create(sampleProject({ id: 'p-counters', slug: 'counters', workspacePath: `${harness.workspaceRoot}/counters` }));

    harness.store.agents.increment(project.id, 'qa', { tasksCompleted: 1, tokensUsedToday: 1_200, iterations: 3, requestsToday: 1 });
    harness.store.agents.increment(project.id, 'qa', { tasksFailed: 1, tokensUsedToday: 400, iterations: 2, requestsToday: 1 });

    const agent = harness.store.agents.get(project.id, 'qa');
    expect(agent).toMatchObject({ tasksCompleted: 1, tasksFailed: 1, tokensUsedToday: 1_600, iterations: 5, requestsToday: 2 });
    expect(agent?.successRate).toBeCloseTo(0.5, 5);

    // Incrementing an agent that has never been written to is also valid.
    harness.store.agents.increment(project.id, 'devops', { tasksCompleted: 2 });
    expect(harness.store.agents.get(project.id, 'devops')).toMatchObject({ tasksCompleted: 2, tasksFailed: 0 });
    expect(harness.store.agents.get(project.id, 'devops')?.successRate).toBe(1);
  });

  it('records completed work on the agent that did it during a real run', async () => {
    harness = await createHarness();
    const project = harness.store.projects.create(sampleProject({ id: 'p-run', slug: 'run-counters', workspacePath: `${harness.workspaceRoot}/run-counters` }));

    // The catalogue ships with the simulator disabled for real use; a test enables it and
    // discovers its models, which is the same path a user takes when they add a provider.
    await harness.registry.setEnabled('simulated', true);
    await harness.registry.discoverModels('simulated');
    expect(harness.store.models.list({ enabled: true }).length).toBeGreaterThan(0);

    const planner = harness.createPlanner();
    await planner.planProject(project);
    const engine = harness.createEngine({ supervisor: { ...harness.settings.supervisor, maxParallelAgents: 1 } } as never);
    await engine.runToCompletion(project, { maxTicks: 40 });

    const tasks = harness.store.tasks.listByProject(project.id);
    const done = tasks.filter((task) => task.status === 'done');
    expect(done.length).toBeGreaterThan(0);

    // Every agent that finished a task must have that task counted on its row.
    const perRole = new Map<string, number>();
    for (const task of done) perRole.set(task.agentRole, (perRole.get(task.agentRole) ?? 0) + 1);

    for (const [role, count] of perRole) {
      const agent = harness.store.agents.get(project.id, role as never);
      expect(agent, `no state row for ${role}`).not.toBeNull();
      expect(agent?.tasksCompleted, `${role} did not count its completed tasks`).toBe(count);
      expect(agent?.state).toBe('idle');
      expect(agent?.currentTaskId).toBeNull();
    }

    const working = harness.store.agents.list(project.id).filter((agent) => agent.state === 'working');
    expect(working).toHaveLength(0);
  });

  it('scopes per-agent statistics to the project being viewed', async () => {
    harness = await createHarness();
    const project = harness.store.projects.create(sampleProject({ id: 'p-stats', slug: 'stats', workspacePath: `${harness.workspaceRoot}/stats` }));
    const other = harness.store.projects.create(
      sampleProject({ id: 'p-other', slug: 'stats-other', workspacePath: `${harness.workspaceRoot}/stats-other`, name: 'Other project' }),
    );

    await harness.registry.setEnabled('simulated', true);
    await harness.registry.discoverModels('simulated');
    await harness.createPlanner().planProject(project);
    const engine = harness.createEngine({ supervisor: { ...harness.settings.supervisor, maxParallelAgents: 1 } } as never);
    await engine.runToCompletion(project, { maxTicks: 40 });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const scoped = harness.store.traces.agentStats(since, project.id);
    const completed = scoped.reduce((total, stat) => total + stat.tasksCompleted, 0);
    const done = harness.store.tasks.listByProject(project.id).filter((task) => task.status === 'done').length;
    expect(completed).toBe(done);
    expect(completed).toBeGreaterThan(0);

    // The roster is shown in the context of one project, so a project that has run nothing
    // must report nothing rather than inheriting another project's activity.
    expect(harness.store.traces.agentStats(since, other.id)).toHaveLength(0);
    // Without a project the numbers are installation-wide, which is what the Performance
    // screen wants.
    expect(harness.store.traces.agentStats(since).length).toBeGreaterThanOrEqual(scoped.length);
  });
});
