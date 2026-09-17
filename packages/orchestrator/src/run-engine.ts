import crypto from 'node:crypto';
import type {
  AgentId,
  AppSettings,
  ApprovalRequest,
  Project,
  Task,
  TaskResult,
} from '@aido/types';
import type { EventBus, Logger } from '@aido/observability';
import type { Store } from '@aido/storage';
import { agentBranchName, type GitRepository } from '@aido/git';
import type { Workspace } from '@aido/sandbox';
import type { ProjectMemory } from '@aido/project-memory';
import type { BaseAgent, AgentRunResult } from '@aido/agents';
import { Supervisor, type SupervisionReport } from '@aido/agents';

/**
 * Run engine / DAG scheduler (§15, §19, §20, §51).
 *
 * This is what makes the team work in parallel without stepping on itself:
 *
 *  - a task is startable when every dependency is done, no other in-flight task
 *    holds a conflicting resource lock, its agent is not paused, and there is
 *    spare concurrency (maxParallelAgents),
 *  - `file:`-style resource locks give mutual exclusion between tasks that would
 *    otherwise write the same file,
 *  - retries are bounded by maxAttempts and re-select the model on retry, so a
 *    broken provider or model cannot fail a task forever (§20),
 *  - failures cascade honestly: dependents are marked blocked with an explanation
 *    instead of being retried until the quota runs out,
 *  - the supervisor inspects the run on every tick and can pause, requeue,
 *    terminate or stop it.
 *
 * Persist-before-emit: state is written to the database before the corresponding
 * event is published, so a crashed process resumes from durable state (§51.23) and
 * the UI never shows work that did not happen.
 */

export interface RunEngineOptions {
  store: Store;
  events: EventBus;
  logger: Logger;
  settings: () => AppSettings;
  memory: ProjectMemory;
  createAgent: (agentId: AgentId) => BaseAgent;
  workspaceFor: (project: Project) => Workspace;
  gitFor: (project: Project) => GitRepository;
  approvals: {
    request: (input: {
      projectId: string;
      taskId?: string | null;
      agentId?: AgentId | null;
      action: string;
      reason: string;
      risk: 'low' | 'medium' | 'high';
      payload?: Record<string, unknown>;
    }) => ApprovalRequest;
  };
  /** Called after every tick so the caller can refresh dashboard metrics. */
  onRunTick?: (projectId: string) => void;
  now?: () => number;
}

export interface TickResult {
  projectId: string;
  started: { taskId: string; agentId: AgentId }[];
  finished: { taskId: string; status: string; error?: string | null }[];
  unblocked: string[];
  supervision: SupervisionReport | null;
  paused: boolean;
  complete: boolean;
  failed: boolean;
  notes: string[];
}

/** Hard cap on scheduler passes for a single `runToCompletion` call (§19). */
const DEFAULT_MAX_TICKS = 200;

export class RunEngine {
  private stopped = false;
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly options: RunEngineOptions) {}

  /**
   * One scheduling pass: unblock → dispatch up to the concurrency limit → await
   * the dispatched work → supervise. Returns a machine-readable summary so the
   * API, the worker and the tests all reason about the same facts.
   */
  async tick(project: Project): Promise<TickResult> {
    const { store, events } = this.options;
    const started: TickResult['started'] = [];
    const finished: TickResult['finished'] = [];
    const notes: string[] = [];

    if (this.stopped) {
      return { projectId: project.id, started, finished, unblocked: [], supervision: null, paused: true, complete: false, failed: false, notes: ['engine stopped'] };
    }

    // ---- 1. Unblock ---------------------------------------------------------
    const unblocked = this.unblock(project.id);
    for (const taskId of unblocked) {
      const task = store.tasks.get(taskId);
      events.emit(
        'task.unblocked',
        { taskId, title: task?.title ?? null },
        { message: `Dependencies satisfied: ${task?.title ?? taskId}`, projectId: project.id, taskId, agentId: task?.agentRole ?? null },
      );
    }

    // ---- 2. Dispatch --------------------------------------------------------
    const parallel = Math.max(1, this.options.settings().supervisor.maxParallelAgents);
    const capacity = Math.max(0, parallel - this.active.size);
    if (capacity > 0) {
      // Locks are claimed as the batch is built, not only from tasks already in flight:
      // two tasks that share a lock can both be ready in the same tick, and filtering each
      // of them against a snapshot taken before either started would let both run at once.
      // That is precisely the conflicting-edit case the locks exist to prevent (§17, §48),
      // so the second one waits for the next tick instead.
      const heldLocks = [...this.activeLocks()];
      const candidates: ReturnType<typeof store.tasks.readyTasks> = [];
      for (const task of store.tasks.readyTasks(project.id)) {
        if (candidates.length >= capacity) break;
        if (task.status !== 'ready') continue;
        if (store.agents.get(project.id, task.agentRole)?.paused) continue;
        if (conflicts(task.resourceLocks, heldLocks)) continue;
        candidates.push(task);
        heldLocks.push(...task.resourceLocks);
      }

      for (const task of candidates) {
        const promise = this.runTask(project, task)
          .then((result) => {
            finished.push({ taskId: task.id, status: result.status, error: result.error ?? null });
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            this.options.store.tasks.update(task.id, { status: 'failed', lastError: message });
            this.options.events.emit(
              'task.failed',
              { taskId: task.id, error: message },
              { projectId: project.id, taskId: task.id, agentId: task.agentRole, severity: 'error', message: `Task failed: ${task.title}` },
            );
            finished.push({ taskId: task.id, status: 'failed', error: message });
          })
          .finally(() => {
            this.active.delete(task.id);
          });
        this.active.set(task.id, promise);
        started.push({ taskId: task.id, agentId: task.agentRole });
      }

      if (started.length) {
        await Promise.all(started.map((entry) => this.active.get(entry.taskId) ?? Promise.resolve()));
      }
    } else if (this.active.size) {
      notes.push(`concurrency limit reached (${parallel}); waiting for in-flight tasks`);
    }

    // ---- 3. Supervise -------------------------------------------------------
    const supervision = this.supervise(project);
    this.options.onRunTick?.(project.id);

    // ---- 4. Terminal state --------------------------------------------------
    const tasks = this.options.store.tasks.listByProject(project.id);
    const open = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'failed');
    const failedTasks = tasks.filter((task) => task.status === 'failed');
    const complete = open.length === 0 && failedTasks.length === 0 && tasks.length > 0;
    const halted = open.length === 0 && failedTasks.length > 0;

    if (complete) {
      this.options.store.projects.setStatus(project.id, 'reviewing');
      events.emit(
        'project.updated',
        { status: 'reviewing', tasks: tasks.length },
        { message: `All ${tasks.length} tasks completed; awaiting review`, projectId: project.id },
      );
    } else if (halted) {
      this.options.store.projects.setStatus(project.id, 'blocked');
      events.emit(
        'project.updated',
        { status: 'blocked', failed: failedTasks.length },
        { message: `Run halted: ${failedTasks.length} task(s) failed and nothing else can proceed`, projectId: project.id, severity: 'error' },
      );
    }

    return {
      projectId: project.id,
      started,
      finished,
      unblocked,
      supervision,
      paused: this.options.store.runSignals.get(project.id).paused,
      complete,
      failed: halted,
      notes,
    };
  }

  /**
   * Marks everything that depends on `taskId` as blocked.
   *
   * Used when a task stops for a reason outside the scheduler's own loop — a denied
   * approval, most importantly. Its dependents would otherwise sit in `blocked` waiting
   * for a task that is never going to finish, and the run would idle out with no
   * explanation of why.
   */
  blockDependents(projectId: string, taskId: string, reason: string): void {
    const project = this.options.store.projects.get(projectId);
    const task = this.options.store.tasks.get(taskId);
    if (!project || !task) return;
    this.cascadeBlock(project, task, reason);
  }

  /** Runs the loop until the project is complete, stopped, or the tick cap is hit. */
  async runToCompletion(project: Project, options: { maxTicks?: number } = {}): Promise<TickResult[]> {
    const results: TickResult[] = [];
    // Bounded by default: an unbounded scheduler loop is exactly the infinite
    // autonomous loop §19 forbids, and `runToCompletion` is called from workers.
    const maxTicks = options.maxTicks ?? DEFAULT_MAX_TICKS;
    for (let index = 0; index < maxTicks; index += 1) {
      const signal = this.options.store.runSignals.get(project.id);
      if (this.stopped || signal.paused || signal.cancelRequested) break;
      const result = await this.tick(project);
      results.push(result);
      if (result.complete || result.failed) break;
      if (!result.started.length && !result.unblocked.length) {
        // Nothing can move: report it rather than spinning on the same state.
        this.options.logger.warn('scheduler made no progress', { projectId: project.id, tick: index, notes: result.notes });
        break;
      }
    }
    return results;
  }

  /** Cooperative stop: no new tasks start; in-flight tasks are awaited. */
  async stop(projectId: string, reason = 'stopped by user'): Promise<void> {
    this.stopped = true;
    this.options.store.runSignals.set(projectId, { runState: 'stopping', paused: true, cancelRequested: true });
    this.options.events.emit('system.notice', { phase: 'stopped', reason }, { message: `Run stopped: ${reason}`, projectId, severity: 'warning' });
    await Promise.allSettled([...this.active.values()]);
  }

  pause(projectId: string, reason: string): void {
    this.options.store.runSignals.set(projectId, { runState: 'paused', paused: true });
    this.options.events.emit('system.notice', { phase: 'paused', reason }, { message: `Run paused: ${reason}`, projectId, severity: 'warning' });
  }

  resume(projectId: string): void {
    this.stopped = false;
    this.options.store.runSignals.set(projectId, { runState: 'running', paused: false, cancelRequested: false });
    this.options.events.emit('system.notice', { phase: 'running' }, { message: 'Run resumed', projectId });
  }

  get inFlight(): string[] {
    return [...this.active.keys()];
  }

  get isRunning(): boolean {
    return this.active.size > 0;
  }

  // ---------------------------------------------------------------------------

  /**
   * Moves every dependency-satisfied blocked task to `ready`.
   * Undone in one place so the whole graph obeys the same rule.
   */
  private unblock(projectId: string): string[] {
    const { store } = this.options;
    const tasks = store.tasks.listByProject(projectId);
    const blocked = tasks.filter((task) => task.status === 'blocked' && task.dependsOn.length > 0);
    if (!blocked.length) return [];

    // `dependencyStatuses` is keyed by the task whose dependencies you ask about,
    // so it must be called with the blocked task ids — not with dependency ids.
    const statuses = store.tasks.dependencyStatuses(blocked.map((task) => task.id));
    const changed: string[] = [];
    for (const task of blocked) {
      const dependencies = statuses.get(task.id) ?? [];
      if (!dependencies.length) continue;
      if (!dependencies.every((dependency) => dependency.status === 'done')) continue;
      store.tasks.update(task.id, { status: 'ready' });
      changed.push(task.id);
    }
    if (changed.length) this.options.logger.debug('unblocked tasks', { projectId, count: changed.length });
    return changed;
  }

  private async runTask(project: Project, task: Task): Promise<AgentRunResult> {
    const { store, events } = this.options;
    const startedAt = new Date().toISOString();
    const agentId = task.agentRole;
    const attempt = task.attempts + 1;

    store.tasks.update(task.id, { status: 'running', startedAt, attempts: attempt });
    store.agents.patch(project.id, agentId, { state: 'working', currentTaskId: task.id, lastActionAt: startedAt });

    const execution = store.executions.start({
      // The repository takes a caller-supplied id so a retry can be linked to the
      // original attempt before the row exists.
      id: crypto.randomUUID(),
      projectId: project.id,
      taskId: task.id,
      agentRole: agentId,
      modelId: null,
      providerId: null,
      tokenInput: 0,
      tokenOutput: 0,
      durationMs: 0,
      status: 'running',
      iterations: 0,
      error: null,
      startedAt,
      finishedAt: null,
      outcome: null,
      traceIds: [],
    });

    events.emit(
      'task.started',
      { taskId: task.id, agentId, attempt, taskType: task.taskType },
      { message: `${agentId} started: ${task.title}`, projectId: project.id, taskId: task.id, agentId },
    );

    const workspace = this.options.workspaceFor(project);
    const git = this.options.gitFor(project);

    // Each agent works on its own branch so a failed task cannot contaminate the
    // main line and merges stay explicit (§17).
    try {
      await this.ensureAgentBranch(git, agentId, task);
    } catch (err) {
      this.options.logger.warn('could not prepare agent branch', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const agent = this.options.createAgent(agentId);
    const granted = this.grantedApprovalKeys(project.id, task.id, attempt);

    let result: AgentRunResult;
    try {
      result = await agent.run({
        projectId: project.id,
        task,
        workspace,
        git,
        grantedApprovals: granted,
        limitsOverride: this.supervisorLimits(),
        requestApproval: async (request) => {
          this.options.approvals.request({
            projectId: project.id,
            taskId: task.id,
            agentId,
            action: request.action,
            reason: request.reason,
            risk: request.risk,
            // The attempt this grant would unblock: an approval scoped to a single step
            // is honoured on that attempt and nowhere else.
            payload: { ...request.payload, grantedForAttempt: attempt + 1 },
          });
          // 'paused' is the persisted signal that a task is waiting on a human; the pending
          // approval row carries the detail.
          store.tasks.update(task.id, { status: 'paused' });
          store.agents.patch(project.id, agentId, { state: 'waiting', lastActionAt: new Date().toISOString() });
          // Returning null is the whole point of the gate: a request is not a permission.
          // The tool sees "no approval", refuses the action, and the agent reports that it
          // is blocked. Handing back the request object here would let a destructive write
          // proceed while the operator is still reading the prompt — the approval row would
          // look pending in the UI at the same time as the file was already overwritten.
          return null;
        },
      });
    } finally {
      // The agent loop always resolves; this guard keeps a thrown error from
      // leaving an execution row stuck in "running" forever.
    }

    this.settleTask(project, task, agentId, result, execution.id, attempt, git);
    return result;
  }

  private settleTask(
    project: Project,
    task: Task,
    agentId: AgentId,
    result: AgentRunResult,
    executionId: string,
    attempt: number,
    git: GitRepository,
  ): void {
    const { store, events, memory } = this.options;
    const finishedAt = new Date().toISOString();
    const tokens = (result.tokenUsage?.input ?? 0) + (result.tokenUsage?.output ?? 0);

    store.executions.finish(executionId, {
      status: result.status,
      durationMs: result.durationMs,
      tokenInput: result.tokenUsage?.input ?? 0,
      tokenOutput: result.tokenUsage?.output ?? 0,
      iterations: result.iterations ?? 0,
      error: result.error ?? null,
      outcome: { status: result.status, attempt },
    });

    store.metrics.recordMany([
      { scope: 'agent', scopeId: agentId, metric: 'agent_tokens', value: tokens, unit: 'tokens', at: finishedAt, bucket: finishedAt.slice(0, 13) },
      { scope: 'agent', scopeId: agentId, metric: 'agent_duration_ms', value: result.durationMs, unit: 'ms', at: finishedAt, bucket: finishedAt.slice(0, 13) },
      { scope: 'agent', scopeId: agentId, metric: result.status === 'completed' ? 'agent_tasks_completed' : 'agent_tasks_failed', value: 1, unit: 'tasks', at: finishedAt, bucket: finishedAt.slice(0, 13) },
    ]);

    switch (result.status) {
      case 'completed': {
        const taskResult: TaskResult = result.result ?? { summary: 'Completed.', artifacts: [], tokenUsage: { input: 0, output: 0 } };
        store.tasks.update(task.id, {
          status: 'done',
          completedAt: finishedAt,
          result: taskResult,
          lastModelId: result.modelId ?? null,
          lastError: null,
        });
        store.agents.patch(project.id, agentId, { state: 'idle', currentTaskId: null, lastActionAt: finishedAt });
        void this.refreshCodeState(project.id, agentId, task.id, taskResult, git);
        events.emit(
          'task.completed',
          { taskId: task.id, agentId, artifacts: taskResult.artifacts?.length ?? 0, modelId: result.modelId ?? null },
          { message: `${agentId} completed: ${task.title}`, projectId: project.id, taskId: task.id, agentId },
        );
        break;
      }

      case 'awaiting_approval':
        // The task stays put; the approval decision is what resumes it.
        store.tasks.update(task.id, { status: 'paused', result: result.result ?? null });
        store.agents.patch(project.id, agentId, { state: 'waiting', lastActionAt: finishedAt });
        break;

      case 'blocked':
      case 'failed':
      default: {
        // Only genuine failures are retried. A task the agent explicitly reported
        // as blocked needs a human, a different approach or a different agent —
        // retrying it unchanged just burns quota (§19, §20).
        const retryable = result.status === 'failed' && attempt < task.maxAttempts;
        store.tasks.update(task.id, {
          status: retryable ? 'ready' : 'blocked',
          lastError: result.error ?? 'unknown failure',
          result: result.result ?? null,
        });
        store.agents.patch(project.id, agentId, { state: 'idle', currentTaskId: null, lastActionAt: finishedAt });
        events.emit(
          result.status === 'blocked' ? 'task.blocked' : 'task.failed',
          { taskId: task.id, agentId, error: result.error ?? null, retryable, attempt },
          {
            message: retryable
              ? `${agentId} failed "${task.title}" (attempt ${attempt}/${task.maxAttempts}); will retry — model re-selected`
              : `${agentId} ${result.status} on "${task.title}": ${result.error ?? 'unknown failure'}`,
            projectId: project.id,
            taskId: task.id,
            agentId,
            severity: retryable ? 'warning' : 'error',
          },
        );
        if (!retryable) this.cascadeBlock(project, task, result.error ?? 'failed');
        break;
      }
    }

    // The agent row carries its own counters so the roster can be read without
    // aggregating traces. Tokens and iterations accrue on every attempt; a task counts
    // as completed or failed once, when it reaches a terminal state — a retry that
    // eventually succeeds is a success, not a success plus a failure.
    const terminalFailure = (result.status === 'failed' && attempt >= task.maxAttempts) || result.status === 'blocked';
    store.agents.increment(project.id, agentId, {
      tokensUsedToday: tokens,
      iterations: result.iterations ?? 0,
      requestsToday: 1,
      ...(result.status === 'completed' ? { tasksCompleted: 1 } : {}),
      ...(terminalFailure ? { tasksFailed: 1 } : {}),
    });
  }

  /** Re-indexes the memory view of the repository after a task touched files. */
  private async refreshCodeState(projectId: string, agentId: AgentId, taskId: string, result: TaskResult, git: GitRepository): Promise<void> {
    try {
      const status = await git.status();
      if (!status.isRepository) return;
      const [headSha, log] = await Promise.all([git.headSha(), status.isRepository ? git.log({ limit: 5 }) : Promise.resolve([])]);
      this.options.memory.setCodeState(
        projectId,
        {
          branch: status.branch ?? null,
          headSha,
          changedFiles: status.entries.map((entry) => ({ path: entry.path, status: entry.code })),
          commits: log.map((entry) => ({ sha: entry.sha, message: entry.message })),
          summary: result.summary.slice(0, 500),
        },
        { agentId, taskId, trust: 'system' },
      );
    } catch (err) {
      this.options.logger.debug('could not refresh code state', { projectId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Marks transitive dependents of a dead task as blocked, with a reason. */
  private cascadeBlock(project: Project, task: Task, reason: string): void {
    const { store } = this.options;
    const all = store.tasks.listByProject(project.id);
    const byDependency = new Map<string, Task[]>();
    for (const candidate of all) {
      for (const dependency of candidate.dependsOn) {
        const list = byDependency.get(dependency) ?? [];
        list.push(candidate);
        byDependency.set(dependency, list);
      }
    }

    const seen = new Set<string>([task.id]);
    const queue = [task.id];
    while (queue.length) {
      const current = queue.shift()!;
      for (const dependent of byDependency.get(current) ?? []) {
        if (seen.has(dependent.id) || dependent.status === 'done' || dependent.status === 'cancelled') continue;
        seen.add(dependent.id);
        const message = `Dependency "${task.title}" ${reason}.`;
        store.tasks.update(dependent.id, { status: 'blocked', lastError: message });
        this.options.events.emit(
          'task.blocked',
          { taskId: dependent.id, blockedBy: task.id, reason },
          { message: `"${dependent.title}" is blocked: ${message}`, projectId: project.id, taskId: dependent.id, severity: 'warning' },
        );
        queue.push(dependent.id);
      }
    }
  }

  private supervise(project: Project): SupervisionReport | null {
    if (!this.options.settings().supervisor.enabled) return null;
    const supervisor = new Supervisor({
      store: this.options.store,
      events: this.options.events,
      logger: this.options.logger,
      settings: this.options.settings,
      alternativeAgentsFor: (task) => fallbackAlternatives(task.agentRole),
      now: this.options.now,
    });
    const report = supervisor.inspect(project.id);
    if (!report.issues.length) return report;

    this.options.logger.info('supervisor report', { projectId: project.id, issues: report.issues.length, interventions: report.interventions.length });
    const { applied } = supervisor.apply(report);
    if (applied.length) {
      this.options.events.emit(
        'supervisor.intervention',
        { actions: applied },
        { message: `Supervisor intervened: ${applied.join('; ')}`, projectId: project.id, severity: 'warning' },
      );
    }
    return report;
  }

  private supervisorLimits() {
    const supervisor = this.options.settings().supervisor;
    return {
      maxTokens: supervisor.maxTokensPerTask,
      maxRuntimeMs: supervisor.maxTaskRuntimeMs,
      maxRetries: supervisor.maxRetriesPerTask,
    };
  }

  private async ensureAgentBranch(git: GitRepository, agentId: AgentId, task: Task): Promise<void> {
    const status = await git.status();
    if (!status.isRepository) await git.init();
    // A branch cannot exist before the first commit, so an empty repository gets
    // one empty root commit rather than silently running agents without a branch.
    if (!(await git.hasCommits())) {
      await git.commit({ message: 'chore: initialise repository', allowEmpty: true, paths: [] });
    }
    const branch = agentBranchName(agentId, task.title);
    const branches = await git.branches();
    const existing = branches.find((entry) => entry.name === branch);
    if (existing) {
      if (!existing.current) await git.checkout(branch);
      return;
    }
    await git.createBranch(branch, { checkout: true });
  }

  private activeLocks(): string[] {
    const locks = new Set<string>();
    for (const taskId of this.active.keys()) {
      for (const lock of this.options.store.tasks.get(taskId)?.resourceLocks ?? []) locks.add(lock);
    }
    return [...locks];
  }

  /**
   * Rebuilds the set of action keys this attempt may perform without asking again.
   *
   * A grant's reach depends on how the operator answered the prompt:
   *  - `task` — "approve this for the rest of the task": valid on every later attempt;
   *  - `once` — "approve this step": valid only for the attempt the request was raised
   *    in, which is what the dispatcher stored in `grantedForAttempt` when it asked.
   *
   * The distinction is the whole point of offering the choice: without it, approving one
   * write would silently license the same destructive call on every future retry.
   */
  private grantedApprovalKeys(projectId: string, taskId: string, attempt: number): Set<string> {
    const keys = new Set<string>();
    for (const approval of this.options.store.approvals.list(projectId, 500)) {
      if (approval.taskId !== taskId || approval.status !== 'approved') continue;
      const key = approval.payload?.key;
      if (typeof key !== 'string') continue;
      const scopedToTask = approval.decisionScope === 'task' || approval.decisionScope === null;
      const grantedForAttempt = approval.payload?.grantedForAttempt;
      if (scopedToTask || grantedForAttempt === attempt) keys.add(key);
    }
    return keys;
  }
}

/** Two tasks conflict when they declare the same resource lock. */
export function conflicts(candidate: string[], inFlight: string[]): boolean {
  if (!candidate.length || !inFlight.length) return false;
  const active = new Set(inFlight);
  return candidate.some((lock) => active.has(lock));
}

function fallbackAlternatives(agent: AgentId): AgentId[] {
  const order: AgentId[] = ['backend', 'frontend', 'database', 'devops', 'qa', 'architect', 'project_manager', 'code_review', 'research', 'performance', 'security'];
  return order.filter((candidate) => candidate !== agent);
}
