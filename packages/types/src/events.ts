/** Event bus contracts (§34) — every domain change is an event. */

export type EventType =
  | 'project.created'
  | 'project.updated'
  | 'project.archived'
  | 'task.created'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.blocked'
  | 'task.unblocked'
  | 'task.retried'
  | 'task.cancelled'
  | 'task.paused'
  | 'task.resumed'
  | 'plan.created'
  | 'agent.selected'
  | 'agent.state_changed'
  | 'agent.message'
  | 'agent.iteration_limit'
  | 'provider.registered'
  | 'provider.enabled'
  | 'provider.disabled'
  | 'provider.health_changed'
  | 'provider.credentials_updated'
  | 'model.discovered'
  | 'model.enabled'
  | 'model.disabled'
  | 'model.status_changed'
  | 'llm.request_started'
  | 'llm.request_completed'
  | 'llm.request_failed'
  | 'llm.failover'
  | 'quota.updated'
  | 'quota.exhausted'
  | 'quota.reset'
  | 'quota.reservation_denied'
  | 'router.selected'
  | 'router.rejected'
  | 'code.changed'
  | 'file.changed'
  | 'test.started'
  | 'test.completed'
  | 'test.failed'
  | 'test.passed'
  | 'review.requested'
  | 'review.completed'
  | 'security.issue_found'
  | 'performance.regression'
  | 'git.branch_created'
  | 'git.commit_created'
  | 'git.conflict'
  | 'approval.requested'
  | 'approval.decided'
  | 'supervisor.intervention'
  | 'supervisor.limit_reached'
  | 'sandbox.command_started'
  | 'sandbox.command_completed'
  | 'run.started'
  | 'run.finished'
  | 'system.notice'
  | 'system.error';

export type EventSeverity = 'debug' | 'info' | 'warning' | 'error' | 'critical';

export interface OrchestratorEvent<T = unknown> {
  id: string;
  type: EventType;
  severity: EventSeverity;
  projectId: string | null;
  taskId: string | null;
  agentId: string | null;
  traceId: string | null;
  /** Human readable one-liner shown in the Activity stream. */
  message: string;
  /** Structured payload for machines. */
  payload: T;
  at: string;
}

export interface EventQuery {
  projectId?: string | null;
  types?: EventType[];
  severity?: EventSeverity[];
  since?: string;
  limit?: number;
  taskId?: string | null;
  agentId?: string | null;
}
