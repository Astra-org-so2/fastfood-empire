import crypto from 'node:crypto';
import type { AgentId, AgentLimits, AppSettings, Task } from '@aido/types';
import type { EventBus, Logger } from '@aido/observability';
import type { Store } from '@aido/storage';

/**
 * Supervisor (§19).
 *
 * Observes the team and intervenes — it does not do the work. The analysis is a
 * pure function of persisted state so it can be unit-tested and so every
 * intervention can be justified from evidence rather than vibes.
 *
 * Detections implemented:
 *   - STALL            an agent has been "working" on a task far longer than that
 *                      task's historical median, or holds a task with no activity.
 *   - REPEATED_FAILURE a task has exhausted its attempts or is failing in a loop.
 *   - LOOP             the same agent produced the same outcome signature N times
 *                      (classic "agent keeps retrying the same broken approach").
 *   - CONTRADICTION    two memory decisions assert different choices for the same
 *                      subject, which usually means two agents disagree silently.
 *   - LIMIT_BREACH     a task's token/runtime budget is exhausted.
 *   - CIRCUIT_BREAKER  too many failures inside the configured window: stop the run.
 */

export interface SupervisionIssue {
  kind: 'stall' | 'repeated_failure' | 'loop' | 'contradiction' | 'limit_breach' | 'circuit_breaker' | 'idle_team';
  severity: 'info' | 'warning' | 'critical';
  agentId: AgentId | null;
  taskId: string | null;
  message: string;
  evidence: Record<string, unknown>;
}

export type Intervention =
  | { type: 'retry_task'; taskId: string; reason: string; withDifferentModel: boolean }
  | { type: 'reassign_task'; taskId: string; fromAgent: AgentId; toAgent: AgentId; reason: string }
  | { type: 'reduce_context'; taskId: string; reason: string }
  | { type: 'pause_agent'; agentId: AgentId; reason: string }
  | { type: 'terminate_task'; taskId: string; reason: string }
  | { type: 'stop_run'; projectId: string; reason: string }
  | { type: 'notify'; message: string; severity: SupervisionIssue['severity'] };

export interface SupervisionReport {
  projectId: string;
  inspectedAt: string;
  issues: SupervisionIssue[];
  interventions: Intervention[];
  stats: {
    running: number;
    ready: number;
    blocked: number;
    failed: number;
    done: number;
    pendingApprovals: number;
    queueDepth: number;
  };
}

/**
 * How long "nothing is running" must persist before it is reported. The run engine
 * dispatches and awaits inside one pass, so an instantaneous sample is meaningless.
 */
const IDLE_CONFIRMATION_MS = 6_000;

export interface SupervisorOptions {
  store: Store;
  events: EventBus;
  logger: Logger;
  settings: () => AppSettings;
  /** Roles that could take over a task, in preference order. */
  alternativeAgentsFor: (task: Task) => AgentId[];
  now?: () => number;
}

export class Supervisor {
  /** When each project first looked idle, so a transient gap is not reported. */
  private readonly idleSince = new Map<string, number>();

  constructor(private readonly options: SupervisorOptions) {}

  inspect(projectId: string): SupervisionReport {
    const { store, settings } = this.options;
    const now = this.options.now?.() ?? Date.now();
    const issues: SupervisionIssue[] = [];
    const interventions: Intervention[] = [];
    const supervisorSettings = settings().supervisor;

    const tasks = store.tasks.listByProject(projectId);
    const agents = store.agents.list(projectId);
    const pendingApprovals = store.approvals.listPending(projectId);

    const stats = {
      running: tasks.filter((t) => t.status === 'running').length,
      ready: tasks.filter((t) => t.status === 'ready' || t.status === 'backlog').length,
      blocked: tasks.filter((t) => t.status === 'blocked').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      done: tasks.filter((t) => t.status === 'done').length,
      pendingApprovals: pendingApprovals.length,
      queueDepth: store.queue.list(projectId).length,
    };

    // ---- stalls -------------------------------------------------------------
    for (const agent of agents) {
      if (agent.state !== 'working' || !agent.currentTaskId) continue;
      const task = tasks.find((t) => t.id === agent.currentTaskId);
      if (!task) continue;
      const lastAction = agent.lastActionAt ? Date.parse(agent.lastActionAt) : Date.parse(task.startedAt ?? task.updatedAt);
      const idleMs = now - lastAction;
      const history = store.executions.durationStats(projectId, agent.agentId);
      // A stall is relative to how long this agent's tasks normally take, with a
      // floor so fast agents are not flagged for a normal pause.
      const threshold = Math.max(120_000, (history.medianMs ?? 180_000) * 3);
      if (idleMs > threshold) {
        issues.push({
          kind: 'stall',
          severity: idleMs > threshold * 2 ? 'critical' : 'warning',
          agentId: agent.agentId,
          taskId: task.id,
          message: `${agent.agentId} has produced no activity on "${task.title}" for ${Math.round(idleMs / 1000)}s (its median task takes ${Math.round((history.medianMs ?? 0) / 1000)}s).`,
          evidence: { idleMs, threshold, medianMs: history.medianMs, samples: history.samples },
        });
        interventions.push({ type: 'pause_agent', agentId: agent.agentId, reason: 'stalled agent' });
        interventions.push({
          type: 'retry_task',
          taskId: task.id,
          reason: 'stalled; retry so a different model/provider can be selected',
          withDifferentModel: supervisorSettings.retryWithDifferentModel,
        });
      }
    }

    // ---- repeated failures, loops and limits -------------------------------
    for (const task of tasks) {
      if (task.status === 'done' || task.status === 'cancelled') continue;
      const executions = store.executions.listForTask(task.id);
      const failures = executions.filter((e) => e.status === 'failed' || e.status === 'blocked');

      if (failures.length > 0 && task.attempts >= task.maxAttempts) {
        issues.push({
          kind: 'repeated_failure',
          severity: 'critical',
          agentId: task.agentRole,
          taskId: task.id,
          message: `"${task.title}" failed ${task.attempts} times (limit ${task.maxAttempts}). Last error: ${task.lastError ?? 'unknown'}`,
          evidence: { attempts: task.attempts, maxAttempts: task.maxAttempts, lastError: task.lastError },
        });
        const alternatives = this.options.alternativeAgentsFor(task).filter((agent) => agent !== task.agentRole);
        if (alternatives.length) {
          interventions.push({
            type: 'reassign_task',
            taskId: task.id,
            fromAgent: task.agentRole,
            toAgent: alternatives[0]!,
            reason: `handing off to ${alternatives[0]} after ${task.attempts} failed attempts by ${task.agentRole}`,
          });
        } else {
          interventions.push({ type: 'terminate_task', taskId: task.id, reason: 'no alternative agent available and the retry budget is exhausted' });
        }
      }

      // Loop detection: identical failure signatures repeated.
      if (failures.length >= supervisorSettings.loopDetectionWindow) {
        const signatures = failures.slice(-supervisorSettings.loopDetectionWindow).map((execution) => signatureOf(execution.error ?? ''));
        const unique = new Set(signatures);
        if (unique.size === 1 && failures.length >= 3) {
          issues.push({
            kind: 'loop',
            severity: 'critical',
            agentId: task.agentRole,
            taskId: task.id,
            message: `"${task.title}" is looping: the last ${signatures.length} attempts produced the same failure signature.`,
            evidence: { signature: signatures[0], attempts: failures.length },
          });
          interventions.push({ type: 'reduce_context', taskId: task.id, reason: 'identical repeated failure — shrink the context and change approach' });
          interventions.push({ type: 'retry_task', taskId: task.id, reason: 'loop detected', withDifferentModel: true });
        }
      }

      // Budget breach.
      const tokens = executions.reduce((sum, execution) => sum + execution.tokenInput + execution.tokenOutput, 0);
      if (supervisorSettings.maxTokensPerTask > 0 && tokens > supervisorSettings.maxTokensPerTask) {
        issues.push({
          kind: 'limit_breach',
          severity: 'critical',
          agentId: task.agentRole,
          taskId: task.id,
          message: `"${task.title}" consumed ${tokens.toLocaleString()} tokens, exceeding the per-task budget of ${supervisorSettings.maxTokensPerTask.toLocaleString()}.`,
          evidence: { tokens, budget: supervisorSettings.maxTokensPerTask },
        });
        interventions.push({ type: 'terminate_task', taskId: task.id, reason: 'token budget exhausted' });
      }
    }

    // ---- contradictory decisions -------------------------------------------
    const decisions = store.memory.list(projectId, { kinds: ['decision'], limit: 200 });
    const bySubject = new Map<string, { title: string; body: string; at: string }[]>();
    for (const decision of decisions) {
      const subject = subjectOf(decision.title);
      if (!subject) continue;
      const list = bySubject.get(subject) ?? [];
      list.push({ title: decision.title, body: decision.body, at: decision.updatedAt });
      bySubject.set(subject, list);
    }
    for (const [subject, entries] of bySubject) {
      if (entries.length < 2) continue;
      const distinct = new Set(entries.map((entry) => signatureOf(entry.title + entry.body.slice(0, 200))));
      if (distinct.size > 1) {
        issues.push({
          kind: 'contradiction',
          severity: 'warning',
          agentId: null,
          taskId: null,
          message: `${entries.length} decisions about "${subject}" disagree: ${entries.map((entry) => entry.title).join(' | ')}`,
          evidence: { subject, decisions: entries.map((entry) => entry.title) },
        });
        interventions.push({ type: 'notify', message: `Conflicting decisions recorded for "${subject}". Review them before continuing.`, severity: 'warning' });
      }
    }

    // ---- circuit breaker ----------------------------------------------------
    const windowStart = new Date(now - supervisorSettings.failureCircuitBreaker.windowMs).toISOString();
    const recentFailures = store.traces.list({ projectId, status: 'error', since: windowStart, limit: 500 }).length;
    if (supervisorSettings.enabled && recentFailures >= supervisorSettings.failureCircuitBreaker.failures) {
      issues.push({
        kind: 'circuit_breaker',
        severity: 'critical',
        agentId: null,
        taskId: null,
        message: `${recentFailures} failed model calls in the last ${Math.round(supervisorSettings.failureCircuitBreaker.windowMs / 60_000)} minutes; stopping the run instead of burning quota.`,
        evidence: { recentFailures, threshold: supervisorSettings.failureCircuitBreaker.failures },
      });
      interventions.push({ type: 'stop_run', projectId, reason: 'failure circuit breaker tripped' });
    }

    // ---- nothing to do ------------------------------------------------------
    //
    // A scheduler that is momentarily between passes also has "nothing running".
    // Reporting that as a stuck team would be noise, so the condition must persist
    // before it counts, and the message states the evidence it actually has.
    const idle = stats.running === 0 && stats.ready === 0 && stats.queueDepth === 0 && pendingApprovals.length === 0 && stats.done < tasks.length;
    const unfinished = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    if (idle && unfinished.length > 0) {
      const since = this.idleSince.get(projectId) ?? now;
      this.idleSince.set(projectId, since);
      const idleForMs = now - since;
      if (idleForMs >= IDLE_CONFIRMATION_MS) {
        const terminal = new Set(['failed', 'cancelled']);
        const byDependency: string[] = [];
        for (const task of unfinished) {
          const broken = task.dependsOn.filter((dependencyId) => {
            const dependency = tasks.find((candidate) => candidate.id === dependencyId);
            return !dependency || terminal.has(dependency.status);
          });
          if (broken.length) byDependency.push(`${task.title.slice(0, 60)} (blocked by ${broken.map((id) => tasks.find((candidate) => candidate.id === id)?.title.slice(0, 40) ?? id).join(', ')})`);
        }
        const deadlocked = byDependency.length > 0;
        issues.push({
          kind: 'idle_team',
          severity: 'warning',
          agentId: null,
          taskId: null,
          message: deadlocked
            ? `Nothing has run for ${Math.round(idleForMs / 1000)}s and ${byDependency.length} task(s) depend on work that will never complete: ${byDependency.slice(0, 3).join('; ')}`
            : `Nothing has run for ${Math.round(idleForMs / 1000)}s and no task is runnable, though ${unfinished.length} task(s) remain and none of their dependencies failed. The scheduler may be unable to dispatch them.`,
          evidence: {
            idleForMs,
            deadlocked,
            unfinished: unfinished.slice(0, 10).map((t) => ({ id: t.id, title: t.title, status: t.status, dependsOn: t.dependsOn.length })),
          },
        });
        interventions.push({
          type: 'notify',
          message: deadlocked
            ? `${unfinished.length} task(s) cannot proceed: their dependencies failed or are missing.`
            : `${unfinished.length} task(s) are unfinished but not runnable after ${Math.round(idleForMs / 1000)}s of inactivity.`,
          severity: 'warning',
        });
      }
    } else {
      this.idleSince.delete(projectId);
    }

    return { projectId, inspectedAt: new Date(now).toISOString(), issues, interventions, stats };
  }

  /** Applies the safe subset of interventions. Risky ones are returned for the caller. */
  apply(report: SupervisionReport): { applied: string[]; deferred: Intervention[] } {
    const applied: string[] = [];
    const deferred: Intervention[] = [];

    for (const intervention of report.interventions) {
      switch (intervention.type) {
        case 'pause_agent':
          this.options.store.agents.patch(report.projectId, intervention.agentId, { state: 'idle', paused: true, currentTaskId: null });
          applied.push(`paused ${intervention.agentId}`);
          break;
        case 'retry_task': {
          const task = this.options.store.tasks.get(intervention.taskId);
          if (!task) break;
          // Retries are bounded by maxAttempts and the counter is never reset:
          // resetting it here would create the unbounded loop §19 forbids.
          if (task.attempts >= task.maxAttempts) {
            deferred.push({ type: 'terminate_task', taskId: task.id, reason: `retry budget exhausted (${task.attempts}/${task.maxAttempts})` });
            break;
          }
          this.options.store.tasks.update(task.id, { status: 'ready' });
          applied.push(`requeued ${task.id} (attempt ${task.attempts + 1}/${task.maxAttempts})`);
          break;
        }
        case 'terminate_task':
          this.options.store.tasks.update(intervention.taskId, { status: 'failed', lastError: intervention.reason });
          applied.push(`terminated ${intervention.taskId}`);
          break;
        case 'notify':
          this.options.events.emit(
            'supervisor.intervention',
            { message: intervention.message, severity: intervention.severity },
            { message: intervention.message, severity: intervention.severity, projectId: report.projectId },
          );
          applied.push(`notified: ${intervention.message}`);
          break;
        case 'stop_run':
          this.options.store.runSignals.set(report.projectId, { runState: 'paused', paused: true });
          this.options.events.emit(
            'supervisor.limit_reached',
            { reason: intervention.reason },
            { message: `Run stopped by the supervisor: ${intervention.reason}`, severity: 'critical', projectId: report.projectId },
          );
          applied.push('stopped run');
          break;
        // Reassignment and context reduction need the scheduler's cooperation.
        case 'reassign_task':
        case 'reduce_context':
        default:
          deferred.push(intervention);
          break;
      }
    }

    for (const issue of report.issues) {
      if (issue.severity === 'info') continue;
      this.options.logger.warn('supervisor finding', { kind: issue.kind, severity: issue.severity, taskId: issue.taskId, message: issue.message });
    }

    return { applied, deferred };
  }

  /** Limits used by the agent loop, with hard ceilings applied. */
  agentLimits(agentId: AgentId, base: AgentLimits): AgentLimits {
    const supervisorSettings = this.options.settings().supervisor;
    return {
      ...base,
      maxTokens: Math.min(base.maxTokens, supervisorSettings.maxTokensPerTask),
      maxRuntimeMs: Math.min(base.maxRuntimeMs, supervisorSettings.maxTaskRuntimeMs),
      maxRetries: Math.min(base.maxRetries, supervisorSettings.maxRetriesPerTask),
    };
  }
}

/** Normalises an error message so "attempt 3 failed" and "attempt 4 failed" match. */
export function signatureOf(text: string, max = 200): string {
  const normalised = text
    .toLowerCase()
    .replace(/\b\d+(\.\d+)?\b/g, 'N')
    .replace(/[0-9a-f]{7,40}/g, 'HASH')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/**
 * Extracts the subject of a decision title, e.g. "Use PostgreSQL for persistence"
 * and "Use SQLite for persistence" both reduce to "persistence".
 */
export function subjectOf(title: string): string | null {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !['use', 'using', 'with', 'for', 'the', 'and', 'will', 'from'].includes(word));
  if (words.length < 2) return null;
  return words.slice(-2).join(' ');
}
