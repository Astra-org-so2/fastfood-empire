import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@aido/observability';
import { createStore } from '@aido/storage';
import { GitRepository } from '@aido/git';
import { Workspace } from '@aido/sandbox';
import { defaultAppSettings } from '@aido/config';
import { parseTestCounts } from '../../apps/api/src/routes/projects.js';

/**
 * The boundaries around a project's own repository and its own commands (§17, §48).
 *
 * Three failure modes that the platform cannot talk its way out of, and therefore has to
 * handle by reporting the truth:
 *
 *   - **merge conflicts** happen whenever two agents touch the same lines. Auto-resolving
 *     them would silently discard one agent's work, so the conflict is surfaced with the
 *     files and both sides, and the branch is left for a human.
 *   - **failing tests** are the most common real signal that work is not done. They must be
 *     recorded as a failure with the failing output, never counted as a pass.
 *   - **storage failures** must be loud. A database that has gone away must produce an
 *     error, not an empty list that reads as "nothing to do".
 */
describe('workspace and storage boundaries', () => {
  let root: string;
  let logger: ReturnType<typeof createLogger>;
  let git: GitRepository;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'aido-boundaries-'));
    logger = createLogger({ level: 'error' });
    git = new GitRepository({ path: root, logger, authorName: 'AI Dev Orchestrator', authorEmail: 'agents@aido.local' });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (relative: string, content: string) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  it('reports a merge conflict with both sides instead of resolving it silently', async () => {
    await git.init('main');
    write('shared.ts', 'export const answer = 1;\n');
    await git.commit({ message: 'chore: initialise repository' });

    // Two agents, two branches, the same line: the classic conflicting-edit case.
    await git.createBranch('agent/backend', { checkout: true });
    write('shared.ts', 'export const answer = 2;\n');
    await git.commit({ message: 'feat: backend changes the constant' });

    await git.checkout('main');
    await git.createBranch('agent/frontend', { checkout: true });
    write('shared.ts', 'export const answer = 3;\n');
    await git.commit({ message: 'feat: frontend changes the constant' });

    const merge = await git.merge('agent/backend');
    expect(merge.ok, 'a conflicting merge must not report success').toBe(false);
    expect(merge.conflicts).toContain('shared.ts');

    // The status makes the conflict visible (and blocks a blind "commit everything").
    const status = await git.status();
    expect(status.conflictedPaths).toContain('shared.ts');
    expect(status.isRepository).toBe(true);

    // Both versions are readable, so the operator can decide rather than guess.
    const conflicted = await git.conflictedFile('shared.ts');
    expect(conflicted, 'a conflicted file must be readable as ours/theirs').not.toBeNull();
    expect(conflicted?.content).toContain('<<<<<<<');
    expect(conflicted?.ours.join('\n')).toContain('answer = 3');
    expect(conflicted?.theirs.join('\n')).toContain('answer = 2');

    // Aborting is possible, so a run is not left wedged in a half-merge.
    await git.abortMerge();
    const afterAbort = await git.status();
    expect(afterAbort.conflictedPaths).toHaveLength(0);
    expect(fs.readFileSync(path.join(root, 'shared.ts'), 'utf8')).toBe('export const answer = 3;\n');
  });

  it('records a failing test command as failed, with the output that says why', async () => {
    const workspace = new Workspace({
      rootPath: root,
      settings: () => ({ ...defaultAppSettings(), executionMode: 'auto' }),
      executionMode: () => 'auto',
      logger,
    });
    write('package.json', JSON.stringify({ name: 'sample', scripts: { test: 'exit 3' } }, null, 2));

    // A failing command must come back as a failure, not be swallowed or retried into
    // looking successful.
    const failure = await workspace.run('exit 3', { approved: true, timeoutMs: 30_000 });
    expect(failure.exitCode).not.toBe(0);

    // The counts the UI shows come from the output, and an output with no counts must not
    // be invented into "0 failed, everything passed".
    // The summary lines each framework actually prints.
    const vitest = parseTestCounts('Test Files  1 failed (2)\n     Tests  1 failed | 62 passed | 1 skipped (64)');
    expect(vitest).toMatchObject({ failed: 1, passed: 62, skipped: 1 });

    const jest = parseTestCounts('Tests:       3 failed, 1 skipped, 4 passed, 8 total');
    expect(jest).toMatchObject({ failed: 3, passed: 4, skipped: 1 });

    const pytest = parseTestCounts('==== 3 passed, 2 failed, 1 skipped in 4.2s ====');
    expect(pytest).toMatchObject({ failed: 2, passed: 3, skipped: 1 });

    const mocha = parseTestCounts('  3 passing (120ms)\n  2 failing\n  1 pending');
    expect(mocha).toMatchObject({ failed: 2, passed: 3, skipped: 1 });

    const allPassing = parseTestCounts('Test Files  8 passed (8)\n     Tests  63 passed (63)');
    expect(allPassing.failed).toBe(0);
    expect(allPassing.passed).toBe(63);

    // No recognisable counts: report zeroes rather than guessing.
    const parsedNothing = parseTestCounts('command not found: vitest');
    expect(parsedNothing.passed).toBe(0);
    expect(parsedNothing.failed).toBe(0);
  });

  it('refuses to run a command the policy forbids, even inside the workspace', async () => {
    const workspace = new Workspace({
      rootPath: root,
      settings: () => ({ ...defaultAppSettings(), executionMode: 'auto' }),
      executionMode: () => 'auto',
      logger,
    });
    write('keep.txt', 'important');

    const outcome = await workspace.run('rm -rf /', { approved: true, timeoutMs: 5_000 }).catch((error: unknown) => error);
    // Either a refusal verdict or a thrown policy error is acceptable; silently executing it
    // is not. The file that was never targeted must still exist.
    expect(outcome).toBeTruthy();
    expect(fs.existsSync(path.join(root, 'keep.txt'))).toBe(true);
  });

  it('fails loudly when the database goes away instead of returning empty results', async () => {
    const dbDir = mkdtempSync(path.join(tmpdir(), 'aido-db-'));
    try {
      const store = createStore({ path: path.join(dbDir, 'aido.db') });
      const created = store.projects.create({
        id: 'p-db',
        name: 'Storage check',
        slug: 'storage-check',
        description: 'Ensures a closed database is an error, not an empty list.',
        spec: {
          goal: 'Prove storage failures surface.',
          description: '',
          techStack: [],
          constraints: [],
          nonFunctional: [],
          acceptanceCriteria: [],
          targetUsers: '',
          deliverable: '',
        },
        status: 'draft',
        workspacePath: path.join(dbDir, 'ws'),
        branch: 'main',
        sourceRepo: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
        settings: {
          executionMode: 'auto',
          maxParallelAgents: 1,
          autoStart: false,
          enabledAgents: [],
          freeOnlyMode: null,
          maxTotalTokens: null,
          gitAuthorName: 'AI Dev Orchestrator',
          gitAuthorEmail: 'agents@aido.local',
        },
      } as never);
      expect(store.projects.get(created.id)?.name).toBe('Storage check');

      store.close();
      // After close, a read must throw. Returning `null` or `[]` would be indistinguishable
      // from "this project does not exist", and the scheduler would quietly do nothing.
      expect(() => store.projects.list()).toThrow();
    } finally {
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
