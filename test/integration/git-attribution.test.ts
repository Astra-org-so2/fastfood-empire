import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepository } from '@aido/git';
import { createHarness, sampleProject, sampleTask, testProviderDefinition, ScriptedProvider, type Harness } from '@aido/testing';

/**
 * Git attribution (§17).
 *
 * "Which agent wrote this?" has to be answerable from the product, not from reading
 * `git log` by hand: the `git_commits` table exists for that, and the Git screen renders
 * its per-agent panels. Nothing used to write to it — the table was created by migration 1
 * and never filled, so attribution was always empty even though commits carried an
 * `Agent:` trailer.
 *
 * These tests cover both halves: a commit made through the repository is recorded against
 * the agent and task, and a task that finishes in AUTO mode leaves its work committed on
 * its own branch even when the model never called `git_commit`. In SUPERVISED mode it
 * deliberately does not — writing history is the operator's decision there.
 */

const ENVELOPE = JSON.stringify({
  reasoning_summary: 'Writing the module and committing it.',
  actions: [{ tool: 'write_file', args: { path: 'src/index.ts', content: 'export const answer = 42;\n' }, purpose: 'create the module' }],
  status: 'working',
  blocker: null,
});

const FINISH = JSON.stringify({
  reasoning_summary: 'The module is in place.',
  actions: [],
  result: { summary: 'Created src/index.ts', artifacts: [{ path: 'src/index.ts', action: 'created' }] },
  status: 'completed',
  blocker: null,
});

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

describe('git attribution', () => {
  let harness: Harness | null = null;
  afterEach(() => {
    harness?.close();
    harness = null;
  });

  async function runProject(executionMode: 'auto' | 'supervised') {
    const definition = testProviderDefinition('scripted-git', {
      name: 'Scripted git provider',
      seedModels: [{ id: 'scripted-coder', displayName: 'Scripted coder', contextWindow: 32_000, maxOutputTokens: 4_096 }],
    });
    const created = await createHarness({
      definitions: [definition],
      settingsPatch: (settings) => {
        settings.executionMode = executionMode;
      },
    });
    const provider = new ScriptedProvider({
      definition,
      logger: created.logger,
      outcomes: [
        { kind: 'success', content: ENVELOPE },
        { kind: 'success', content: FINISH },
      ] as never[],
      repeat: true,
    });
    created.registry.registerDefinition(definition);
    created.registry.registerAdapter(definition.id, provider);
    await created.registry.discoverModels(definition.id);

    const projectId = 'p-git';
    created.store.projects.create(
      sampleProject({ id: projectId, slug: 'git-attribution', workspacePath: created.workspaceRoot }),
    );
    created.store.tasks.create(
      sampleTask({
        id: 'task-git',
        projectId,
        agentRole: 'backend',
        taskType: 'code_generation',
        status: 'ready',
        resourceLocks: ['file:src/index.ts'],
        maxAttempts: 5,
      }),
    );

    harness = created;
    const runner = created.createRunner({ intervalMs: 15, maxTicks: 200 });
    await runner.start(projectId, { plan: false });
    await waitFor(
      () => (created.store.tasks.get('task-git')?.status === 'done' ? created.store.tasks.get('task-git') : null),
      'the task to complete',
    );
    return created;
  }

  it('records every commit against the agent and task that made it', async () => {
    const created = await createHarness({ definitions: [] });
    harness = created;
    const project = created.store.projects.create(
      sampleProject({ id: 'p-record', slug: 'record', workspacePath: created.workspaceRoot }),
    );

    let recorded = 0;
    const git = new GitRepository({
      path: created.workspaceRoot,
      logger: created.logger,
      authorName: 'AI Dev Orchestrator',
      authorEmail: 'agents@aido.local',
      onCommit: (commit) => {
        recorded += 1;
        created.store.commits.record({
          projectId: project.id,
          sha: commit.sha,
          branch: commit.branch ?? 'main',
          message: commit.message,
          authorName: commit.authorName,
          authorEmail: commit.authorEmail,
          agentId: commit.agentId,
          taskId: commit.taskId,
          filesChanged: commit.filesChanged,
          insertions: commit.insertions,
          deletions: commit.deletions,
          committedAt: commit.committedAt,
        });
      },
    });

    await git.init();
    fs.mkdirSync(`${created.workspaceRoot}/src`, { recursive: true });
    fs.writeFileSync(`${created.workspaceRoot}/src/index.ts`, 'export const answer = 42;\n');
    fs.writeFileSync(`${created.workspaceRoot}/README.md`, '# Project\n');

    const commit = await git.commit({ message: 'backend: add the module', agentId: 'backend', taskId: 'task-1', paths: 'all' });
    expect(commit).not.toBeNull();
    expect(recorded).toBe(1);

    const rows = created.store.commits.list(project.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sha: commit!.sha, agentId: 'backend', taskId: 'task-1', filesChanged: 2 });
    expect(rows[0]?.insertions).toBeGreaterThan(0);

    // The attribution the Git screen shows is a real aggregate, not a recount of authors.
    const byAgent = created.store.commits.byAgent(project.id);
    expect(byAgent).toEqual([expect.objectContaining({ agentId: 'backend', commits: 1 })]);

    // A commit with nothing staged must not create a record either.
    await git.commit({ message: 'backend: no-op', agentId: 'backend', taskId: 'task-1', paths: 'all' });
    expect(created.store.commits.list(project.id, 10)).toHaveLength(1);
  });

  it('commits a finished task on its agent branch in AUTO mode', async () => {
    const created = await runProject('auto');
    const git = created.gitFor();

    // The commit is made as the task settles; wait for it rather than assume it beat us.
    const agentCommit = await waitFor(
      async () => (await git.log({ limit: 20 })).find((entry) => entry.message.startsWith('backend:')),
      'the finished task to be committed',
    );
    expect(agentCommit.message).toContain('backend:');
    expect(fs.readFileSync(`${created.workspaceRoot}/src/index.ts`, 'utf8')).toContain('answer = 42');
    // The work is committed, not merely present: a clean tree is what "done" claims.
    expect((await git.status()).clean).toBe(true);

    // Attribution is written just after the commit itself, so wait for the row rather than
    // racing it.
    const recorded = await waitFor(
      () => created.store.commits.list('p-git', 20).find((row) => row.agentId === 'backend' && row.taskId === 'task-git'),
      'the commit to be recorded against the agent',
    );
    expect(recorded.filesChanged).toBe(1);
    expect(recorded.branch).toContain('agent/backend');
    // The aggregate keeps unattributed commits (the repository bootstrap) separate from
    // the agent's work instead of quietly crediting them to whoever ran first.
    const byAgent = created.store.commits.byAgent('p-git');
    expect(byAgent.find((entry) => entry.agentId === 'backend')).toMatchObject({ commits: 1 });
    expect(byAgent.find((entry) => entry.agentId === null)?.commits).toBe(1);
  });

  it('leaves the tree uncommitted in SUPERVISED mode, where the operator decides', async () => {
    const created = await runProject('supervised');
    const git = created.gitFor();
    const log = await git.log({ limit: 20 });

    expect(log.some((entry) => entry.message.startsWith('backend:'))).toBe(false);
    // The work is still there — it just has not been written into history without a human.
    expect((await git.status()).clean).toBe(false);
    // Only the repository's own bootstrap commit is recorded; no agent owns it.
    const recorded = created.store.commits.list('p-git', 20);
    expect(recorded.filter((row) => row.agentId !== null)).toHaveLength(0);
  });
});
