import type { Project } from '@aido/types';
import type { Logger, EventBus } from '@aido/observability';
import type { Store } from '@aido/storage';
import type { GitRepository } from '@aido/git';
import { agentBranchName } from '@aido/git';
import type { ProjectRunner } from './runner.js';

/**
 * Background execution (§43, §54).
 *
 * The same scheduler serves the headless worker and the desktop shell: both need to
 * pick up a project whose run was requested, recover whatever a dead process left
 * behind, and keep working until there is nothing left to do. It lives in the
 * orchestrator (not in `apps/worker`) precisely so the desktop shell does not
 * reimplement it.
 *
 * It talks to the rest of the system through a narrow port, so it can be tested with a
 * real store and a real runner, or with a fake.
 */

export interface BackgroundContext {
  store: Store;
  runner: ProjectRunner;
  logger: Logger;
  events: EventBus;
  gitFor(project: Project): GitRepository;
}

/**
 * Makes sure the repository has at least one commit and that the project has its own
 * working branch, so agent branches have a parent to branch from. Re-entrant: calling
 * this on an already initialised repository is a no-op.
 */
export async function ensureAgentBranch(context: BackgroundContext, project: Project): Promise<{ initialised: boolean; branch: string }> {
  const git = context.gitFor(project);
  let initialised = false;

  if (!(await git.isRepository())) {
    await git.init(project.branch || 'main');
    initialised = true;
  }
  if (!(await git.hasCommits())) {
    // An empty root commit is what makes per-agent feature branches possible at all.
    await git.commit({ message: 'chore: initialise repository', allowEmpty: true });
    initialised = true;
  }

  const current = await git.currentBranch();
  const branch = project.branch || 'main';
  if (!current) {
    await git.checkout(branch);
    return { initialised, branch };
  }
  if (current !== branch && !(await git.branches()).some((entry) => entry.name === branch)) {
    await git.createBranch(branch, { checkout: false });
  }
  return { initialised, branch: current };
}

/**
 * A task marked `running` is not running: the process that owned it is gone. Returning
 * it to the queue is what makes an interrupted run resumable instead of permanently
 * stuck, and the attempt counter is preserved so retry limits still hold.
 */
export function reclaimInterruptedTasks(context: BackgroundContext, project: Project): { reclaimed: number; cancelled: number } {
  let reclaimed = 0;
  let cancelled = 0;
  const signal = context.store.runSignals.get(project.id);

  for (const task of context.store.tasks.listByProject(project.id)) {
    if (task.status !== 'running') continue;
    if (signal.cancelRequested) {
      context.store.tasks.update(task.id, { status: 'cancelled', lastError: 'cancelled while no background process was running' });
      cancelled += 1;
      continue;
    }
    context.store.tasks.update(task.id, { status: 'ready', lastError: 'reclaimed after an interrupted run' });
    reclaimed += 1;
  }

  if (reclaimed) {
    context.events.emit(
      'system.notice',
      { projectId: project.id, reclaimed },
      { message: `Recovered ${reclaimed} task(s) interrupted by a stopped process; they will run again.`, projectId: project.id, severity: 'warning' },
    );
  }
  return { reclaimed, cancelled };
}

/**
 * Prepares the database for a resumed run and reports what was found, so the log and
 * the UI can both say "this is a continuation" rather than pretending it is new work.
 */
export function resumeRun(context: BackgroundContext, project: Project): { running: number; ready: number; blocked: number; done: number; resuming: boolean } {
  const tasks = context.store.tasks.listByProject(project.id);
  const counts = {
    running: tasks.filter((task) => task.status === 'running').length,
    ready: tasks.filter((task) => task.status === 'ready').length,
    blocked: tasks.filter((task) => task.status === 'blocked').length,
    done: tasks.filter((task) => task.status === 'done').length,
  };
  const resuming = counts.done > 0 || counts.blocked > 0;
  context.store.projects.setStatus(project.id, 'building');
  context.store.runSignals.set(project.id, { runState: 'running', paused: false, cancelRequested: false });
  if (resuming) {
    context.events.emit(
      'run.started',
      { projectId: project.id, resumed: true, ...counts },
      { message: `Resuming: ${counts.done} done, ${counts.ready} ready, ${counts.blocked} blocked`, projectId: project.id, severity: 'info' },
    );
  }
  return { ...counts, resuming };
}

export interface BackgroundSchedulerOptions {
  context: BackgroundContext;
  /** Restrict work to these projects (empty means every project). */
  projectFilter?: string[];
  pollIntervalMs?: number;
  maintenanceIntervalMs?: number;
  /** Ceiling for one `runOnce()` pass, so a stuck project cannot hold a process forever. */
  onceTimeoutMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BackgroundTickResult {
  started: string[];
  cancelled: string[];
  recovered: number;
}

export interface BackgroundScheduler {
  claimableProjects(): string[];
  tick(): Promise<BackgroundTickResult>;
  waitForRunsToFinish(timeoutMs?: number): Promise<boolean>;
  /** Drains everything currently claimable and returns the projects still unfinished. */
  runOnce(): Promise<{ remaining: string[] }>;
  /** Starts polling; returns the stop function. */
  start(): () => Promise<void>;
}

/**
 * Decides which projects this process may work on.
 *
 * A project is claimable when it still has unfinished tasks and its run intent says
 * "running" or "stopping" (what the API/UI writes), or when it has a task left in
 * `running` by a process that died. Active runs are excluded, because a second worker
 * must never pick up a project another one is already driving.
 */
export function createBackgroundScheduler(options: BackgroundSchedulerOptions): BackgroundScheduler {
  const { context } = options;
  const projectFilter = options.projectFilter ?? [];
  const onceTimeoutMs = options.onceTimeoutMs ?? 30 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 3_000;
  const maintenanceIntervalMs = options.maintenanceIntervalMs ?? 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));

  const claimableProjects = (): string[] => {
    const active = context.runner.listActive();
    const candidates = context.store.projects
      .list()
      .filter((project) => !project.archivedAt)
      .filter((project) => (projectFilter.length ? projectFilter.includes(project.id) : true))
      .filter((project) => !active.includes(project.id));

    const claimable: string[] = [];
    for (const project of candidates) {
      const tasks = context.store.tasks.listByProject(project.id);
      if (!tasks.length) continue;
      if (tasks.every((task) => task.status === 'done' || task.status === 'cancelled')) continue;
      const signal = context.store.runSignals.get(project.id);
      const crashed = tasks.some((task) => task.status === 'running');
      if (signal.runState === 'running' || signal.runState === 'stopping' || crashed) claimable.push(project.id);
    }
    return claimable;
  };

  const tick = async (): Promise<BackgroundTickResult> => {
    const result: BackgroundTickResult = { started: [], cancelled: [], recovered: 0 };
    for (const projectId of claimableProjects()) {
      const project = context.store.projects.get(projectId);
      if (!project) continue;
      const signal = context.store.runSignals.get(projectId);

      if (signal.cancelRequested) {
        // A run that was stopped while this process was down: settle it rather than
        // silently restarting work the operator cancelled.
        context.store.tasks
          .listByProject(projectId)
          .filter((task) => task.status === 'running' || task.status === 'ready')
          .forEach((task) => context.store.tasks.update(task.id, { status: 'cancelled', lastError: 'cancelled while no background process was running' }));
        context.store.runSignals.set(projectId, { runState: 'idle', paused: true, cancelRequested: false });
        context.store.projects.setStatus(projectId, 'blocked');
        context.logger.warn('cancelled an interrupted run', { projectId });
        result.cancelled.push(projectId);
        continue;
      }

      await ensureAgentBranch(context, project);
      const recovery = reclaimInterruptedTasks(context, project);
      if (recovery.reclaimed || recovery.cancelled) {
        context.logger.warn('recovered interrupted tasks', { projectId, ...recovery });
        result.recovered += recovery.reclaimed;
      }

      const resumed = resumeRun(context, project);
      context.logger.info('run resumed in the background', { projectId, ...resumed });
      const status = await context.runner.start(projectId, { plan: false });
      context.logger.info('run started in the background', { projectId, running: status.running, paused: status.paused, ticks: status.ticks });
      result.started.push(projectId);
    }
    return result;
  };

  const waitForRunsToFinish = async (timeoutMs = onceTimeoutMs): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (context.runner.listActive().length > 0 && Date.now() < deadline) {
      await sleep(500);
    }
    return context.runner.listActive().length === 0;
  };

  const runOnce = async (): Promise<{ remaining: string[] }> => {
    let previousSignature = '';
    for (let round = 0; round < 50; round += 1) {
      await tick();
      // Always wait for the runs this round started: `claimableProjects()` deliberately
      // excludes active projects, so checking before draining would look like "no work".
      if (!(await waitForRunsToFinish())) {
        context.logger.error('a run did not finish before the timeout', { timeoutMs: onceTimeoutMs });
        break;
      }
      const claimable = claimableProjects();
      context.logger.info('background round', { round, claimable: claimable.length, active: context.runner.listActive().length });
      if (!claimable.length) break;
      const signature = claimable.join(',');
      if (signature === previousSignature) {
        context.logger.warn('no progress in the last round; stopping', { projects: claimable });
        break;
      }
      previousSignature = signature;
    }
    const remaining = claimableProjects();
    if (remaining.length) context.logger.warn('projects still unfinished after the run', { projects: remaining });
    return { remaining };
  };

  const start = (): (() => Promise<void>) => {
    let stopping = false;
    const timer = setInterval(() => {
      if (stopping) return;
      void tick().catch((err: unknown) => context.logger.error('background tick failed', { error: err instanceof Error ? err.message : String(err) }));
    }, pollIntervalMs);
    const maintenance = setInterval(() => context.runner.maintenance(), maintenanceIntervalMs);

    return async () => {
      stopping = true;
      clearInterval(timer);
      clearInterval(maintenance);
    };
  };

  return { claimableProjects, tick, waitForRunsToFinish, runOnce, start };
}

export { agentBranchName };
