import type { AgentId, ApprovalRequest } from '@aido/types';
import type { EventBus, Logger } from '@aido/observability';
import type { Store } from '@aido/storage';

/**
 * Human-in-the-loop approvals (§44).
 *
 * Three execution modes are implemented consistently:
 *   AUTO        destructive operations still ask when `alwaysConfirmDestructive`
 *               is enabled (default), everything else proceeds.
 *   SUPERVISED  writes to existing files, commits and shell commands ask.
 *   MANUAL      nothing proceeds without a decision.
 *
 * The service also supports `waitForDecision`, which is what lets an agent pause
 * mid-task and resume with the human's answer instead of throwing away the work
 * it has already done (§51.23 "resume interrupted work").
 */

export interface ApprovalServiceOptions {
  store: Store;
  events: EventBus;
  logger: Logger;
  /** Poll interval while waiting for a decision. */
  pollIntervalMs?: number;
  /** How long a request stays open before it expires. */
  ttlMs?: number;
}

export class ApprovalService {
  private readonly waiters = new Map<string, { resolve: (request: ApprovalRequest | null) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly options: ApprovalServiceOptions) {}

  request(input: {
    projectId: string;
    taskId?: string | null;
    agentId?: AgentId | null;
    action: string;
    reason: string;
    risk: 'low' | 'medium' | 'high';
    payload?: Record<string, unknown>;
  }): ApprovalRequest {
    const ttl = this.options.ttlMs ?? 30 * 60_000;
    const request = this.options.store.approvals.request({
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      action: input.action,
      reason: input.reason,
      risk: input.risk,
      payload: input.payload ?? {},
      expiresAt: new Date(Date.now() + ttl).toISOString(),
    });

    this.options.events.emit(
      'approval.requested',
      { approvalId: request.id, action: request.action, risk: request.risk, reason: request.reason },
      {
        message: `Approval required (${request.risk} risk): ${request.action}`,
        severity: request.risk === 'high' ? 'error' : 'warning',
        projectId: request.projectId,
        taskId: request.taskId,
        agentId: request.agentId,
      },
    );

    this.options.logger.info('approval requested', { approvalId: request.id, action: request.action, risk: request.risk });
    return request;
  }

  decide(approvalId: string, decision: 'approved' | 'denied', decidedBy: string, note?: string): ApprovalRequest | null {
    const request = this.options.store.approvals.decide(approvalId, decision, decidedBy, note ?? null);
    if (!request) return null;

    this.options.events.emit(
      'approval.decided',
      { approvalId: request.id, decision, decidedBy, note: note ?? null },
      {
        message: `${decision === 'approved' ? 'Approved' : 'Denied'}: ${request.action}${note ? ` — ${note}` : ''}`,
        severity: decision === 'approved' ? 'info' : 'warning',
        projectId: request.projectId,
        taskId: request.taskId,
        agentId: request.agentId,
      },
    );

    const waiter = this.waiters.get(approvalId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(approvalId);
      waiter.resolve(decision === 'approved' ? request : null);
    }
    return request;
  }

  /** Blocks until a decision arrives, the request expires, or the timeout elapses. */
  waitForDecision(approvalId: string, timeoutMs = 10 * 60_000): Promise<ApprovalRequest | null> {
    const existing = this.options.store.approvals.get(approvalId);
    if (existing && existing.status !== 'pending') {
      return Promise.resolve(existing.status === 'approved' ? existing : null);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(approvalId);
        this.options.store.approvals.decide(approvalId, 'expired', 'system', 'Timed out waiting for a decision.');
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(approvalId, { resolve, timer });
    });
  }

  pending(projectId?: string): ApprovalRequest[] {
    return this.options.store.approvals.listPending(projectId);
  }

  expireStale(): number {
    return this.options.store.approvals.expireStale(new Date().toISOString());
  }

  /** Cancels all outstanding waits (used on shutdown so the process can exit). */
  dispose(): void {
    for (const [, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.waiters.clear();
  }
}
