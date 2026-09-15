import type { AppSettings, Project } from '@aido/types';
import type { EventBus, Logger } from '@aido/observability';
import type { Store } from '@aido/storage';
import type { RunEngine, TickResult } from './run-engine.js';

/**
 * Background run controller (§18, §43).
 *
 * Owns the lifetime of a project's agent run: planning, ticking the scheduler,
 * pausing, resuming, stopping and reporting. Both the API process (foreground runs
 * started from the UI) and the worker process (headless background execution) use
 * this identical controller, so behaviour does not depend on which shell started
 * the work (§54 — one product, two shells).
 *
 * Every state change is persisted before it is emitted, so a restart resumes from
 * the database rather than from memory.
 */

export interface ProjectRunnerOptions {
  store: Store;
  events: EventBus;
  logger: Logger;
  settings: () => AppSettings;
  /** Builds an engine bound to the current settings (so limit changes apply). */
  engineFactory: (project: Project) => RunEngine;
  /** Runs the two-stage planning pipeline. Returns the created task count. */
  planProject: (project: Project) => Promise<{ createdTasks: unknown[] }>;
  /** Delay between scheduler passes. */
  intervalMs?: number;
  /** Hard ceiling on scheduler passes per run. */
  maxTicks?: number;
  /** Called after every tick (metrics refresh, notifications). */
  onTick?: (projectId: string, tick: TickResult) => void;
}

export interface RunStatus {
  projectId: string;
  running: boolean;
  paused: boolean;
  cancelled: boolean;
  ticks: number;
  startedAt: string | null;
  lastTickAt: string | null;
  lastResult: TickResult | null;
  lastError: string | null;
}

export class ProjectRunner {
  private readonly loops = new Map<string, Promise<void>>();
  private readonly statuses = new Map<string, RunStatus>();
  private readonly stopRequested = new Set<string>();
  private disposed = false;

  constructor(private readonly options: ProjectRunnerOptions) {}

  /** Starts a run. Plans first when the project has no tasks yet. */
  async start(projectId: string, options: { plan?: boolean } = {}): Promise<RunStatus> {
    if (this.loops.has(projectId)) return this.status(projectId);

    const project = this.options.store.projects.get(projectId);
    if (!project) throw new Error(`Project ${projectId} does not exist.`);

    const status: RunStatus = {
      projectId,
      running: true,
      paused: false,
      cancelled: false,
      ticks: 0,
      startedAt: new Date().toISOString(),
      lastTickAt: null,
      lastResult: null,
      lastError: null,
    };
    this.statuses.set(projectId, status);
    this.stopRequested.delete(projectId);
    this.options.store.runSignals.set(projectId, { runState: 'running', paused: false, cancelRequested: false });
    this.options.store.projects.setStatus(projectId, 'building');
    this.options.events.emit('run.started', { projectId }, { message: `Run started for ${project.name}`, projectId });

    const shouldPlan = options.plan ?? this.options.store.tasks.listByProject(projectId).length === 0;
    const loop = (async () => {
      try {
        if (shouldPlan) {
          this.options.events.emit('system.notice', { phase: 'planning' }, { message: 'Planning the project (architect → project manager)', projectId, severity: 'info' });
          await this.options.planProject(project);
        }
        await this.loop(projectId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.tryWrite(() => this.options.store.runSignals.set(projectId, { runState: 'idle' }));
        const current = this.statuses.get(projectId);
        if (current) {
          current.lastError = message;
          current.running = false;
        }
        this.options.logger.error('run failed', { projectId, error: message });
        this.options.events.emit(
          'run.finished',
          { projectId, ok: false, error: message },
          { message: `Run failed: ${message}`, projectId, severity: 'error' },
        );
        this.tryWrite(() => this.options.store.projects.setStatus(projectId, 'blocked'));
      } finally {
        this.loops.delete(projectId);
        const current = this.statuses.get(projectId);
        if (current) current.running = false;
      }
    })();

    this.loops.set(projectId, loop);
    return this.status(projectId);
  }

  /** Requests a cooperative stop. In-flight tasks finish their current turn. */
  async stop(projectId: string, reason = 'stopped by the operator'): Promise<RunStatus> {
    this.stopRequested.add(projectId);
    this.tryWrite(() => this.options.store.runSignals.set(projectId, { runState: 'stopping', paused: true, cancelRequested: true }));
    const engine = this.engineFor(projectId);
    await engine?.stop(projectId, reason);
    const status = this.status(projectId);
    status.cancelled = true;
    status.running = false;
    this.options.events.emit(
      'run.finished',
      { projectId, ok: false, error: reason },
      { message: `Run stopped: ${reason}`, projectId, severity: 'warning' },
    );
    return status;
  }

  pause(projectId: string, reason = 'paused by the operator'): RunStatus {
    this.options.store.runSignals.set(projectId, { runState: 'paused', paused: true });
    this.engineFor(projectId)?.pause(projectId, reason);
    const status = this.status(projectId);
    status.paused = true;
    return status;
  }

  resume(projectId: string): RunStatus {
    this.options.store.runSignals.set(projectId, { runState: 'running', paused: false, cancelRequested: false });
    this.stopRequested.delete(projectId);
    this.engineFor(projectId)?.resume(projectId);
    const status = this.status(projectId);
    status.paused = false;
    // A resumed run whose loop already exited needs a fresh loop.
    if (!this.loops.has(projectId)) void this.start(projectId, { plan: false });
    return this.status(projectId);
  }

  status(projectId: string): RunStatus {
    const signal = this.options.store.runSignals.get(projectId);
    const existing = this.statuses.get(projectId);
    const status: RunStatus = existing ?? {
      projectId,
      running: this.loops.has(projectId),
      paused: signal.paused,
      cancelled: signal.cancelRequested,
      ticks: 0,
      startedAt: null,
      lastTickAt: null,
      lastResult: null,
      lastError: null,
    };
    status.running = this.loops.has(projectId);
    status.paused = signal.paused;
    return status;
  }

  listActive(): string[] {
    return [...this.loops.keys()];
  }

  /** Reaps abandoned reservations and stale runs (called on a timer by the host). */
  maintenance(): void {
    try {
      const expired = this.options.store.quota.expireReservations(new Date().toISOString());
      if (expired.length) {
        for (const reservation of expired) {
          for (const bucketId of reservation.bucketIds) {
            this.options.store.quota.release(bucketId, reservation.estimatedTokens, 1);
          }
        }
        this.options.logger.warn('released reservations from abandoned runs', { count: expired.length });
      }
      this.options.store.approvals.expireStale(new Date().toISOString());
    } catch (err) {
      this.options.logger.warn('maintenance pass failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Stops every active run and waits for the loops to settle.
   *
   * A run in progress is a promise that writes to the database between model calls;
   * closing the store underneath it would crash the process and leave tasks stuck in
   * `running`. Callers therefore await this before closing storage.
   */
  async shutdown(timeoutMs = 15_000): Promise<{ stopped: number; abandoned: number }> {
    this.disposed = true;
    const active = [...this.loops.entries()];
    for (const projectId of this.loops.keys()) {
      this.stopRequested.add(projectId);
      this.tryWrite(() => this.options.store.runSignals.set(projectId, { runState: 'stopping', paused: true, cancelRequested: true }));
      this.tryWrite(() => {
        for (const task of this.options.store.tasks.listByProject(projectId)) {
          if (task.status === 'running') {
            this.options.store.tasks.update(task.id, { status: 'ready', lastError: 'paused: the run was interrupted' });
          }
        }
      });
    }

    const settled = await Promise.all(
      active.map(([, loop]) => Promise.race([loop.then(() => true).catch(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref?.())])),
    );
    const abandoned = settled.filter((finished) => !finished).length;
    this.loops.clear();
    return { stopped: active.length, abandoned };
  }

  /** Legacy synchronous dispose: requests cancellation without waiting. */
  dispose(): void {
    this.disposed = true;
    for (const projectId of this.loops.keys()) {
      this.stopRequested.add(projectId);
      this.tryWrite(() => this.options.store.runSignals.set(projectId, { runState: 'stopping', paused: true, cancelRequested: true }));
    }
    this.loops.clear();
  }

  /**
   * Runs a bookkeeping write, tolerating a store that is already closed.
   *
   * During shutdown a run may still be finishing a model call; that last write must
   * not turn a clean exit into an unhandled database error.
   */
  private tryWrite(write: () => void): void {
    try {
      write();
    } catch (err) {
      this.options.logger.debug('skipped a bookkeeping write during shutdown', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ---------------------------------------------------------------------------

  private async loop(projectId: string): Promise<void> {
    const intervalMs = this.options.intervalMs ?? 500;
    const maxTicks = this.options.maxTicks ?? 2_000;
    let idleTicks = 0;

    while (!this.disposed && !this.stopRequested.has(projectId)) {
      const signal = this.options.store.runSignals.get(projectId);
      if (signal.cancelRequested) break;
      if (signal.paused) {
        await sleep(intervalMs);
        continue;
      }

      const project = this.options.store.projects.get(projectId);
      if (!project) break;
      const engine = this.engineFor(projectId);
      if (!engine) break;

      const current = this.statuses.get(projectId);
      if (current && current.ticks >= maxTicks) {
        this.options.events.emit(
          'supervisor.limit_reached',
          { projectId, limit: 'maxTicks', ticks: current.ticks },
          { message: `Run stopped after ${current.ticks} scheduler passes without completing.`, projectId, severity: 'error' },
        );
        break;
      }

      const tick = await engine.tick(project);
      if (current) {
        current.ticks += 1;
        current.lastTickAt = new Date().toISOString();
        current.lastResult = tick;
      }
      this.options.onTick?.(projectId, tick);

      if (tick.complete || tick.failed) {
        // The run is over: clear the "running" intent, otherwise a worker would pick
        // the project up again and retry work the operator has not asked for (§19).
        this.tryWrite(() => this.options.store.runSignals.set(projectId, { runState: 'idle' }));
        this.options.events.emit(
          'run.finished',
          { projectId, ok: tick.complete, tasks: this.options.store.tasks.listByProject(projectId).length },
          {
            message: tick.complete ? 'Run finished: every task completed' : 'Run halted: tasks failed and nothing else can proceed',
            projectId,
            severity: tick.complete ? 'info' : 'error',
          },
        );
        break;
      }

      const progressed = tick.started.length > 0 || tick.unblocked.length > 0 || tick.finished.length > 0;
      idleTicks = progressed ? 0 : idleTicks + 1;
      if (idleTicks >= 4) {
        // Nothing has moved for several passes. Do not spin: report and stop.
        const pending = this.options.store.tasks.listByProject(projectId).filter((task) => task.status !== 'done' && task.status !== 'cancelled');
        this.tryWrite(() => this.options.store.runSignals.set(projectId, { runState: 'idle' }));
        this.options.events.emit(
          'system.notice',
          { projectId, pending: pending.length, reasons: tick.notes },
          {
            message: `Run is idle: ${pending.length} task(s) remain but nothing is runnable (${pending.map((task) => `${task.title.slice(0, 40)} [${task.status}]`).join(', ')}).`,
            projectId,
            severity: 'warning',
          },
        );
        break;
      }

      await sleep(intervalMs);
    }
  }

  private engineFor(projectId: string): RunEngine | null {
    const project = this.options.store.projects.get(projectId);
    if (!project) return null;
    return this.options.engineFactory(project);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
