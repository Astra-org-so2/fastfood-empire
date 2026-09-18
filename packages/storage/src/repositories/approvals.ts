import crypto from 'node:crypto';
import type { AgentId, ApprovalRequest } from '@aido/types';
import type { Database, Row } from '../db.js';
import { nowIso, parseJson } from './helpers.js';

export interface ApprovalRepository {
  request(input: Omit<ApprovalRequest, 'id' | 'requestedAt' | 'decidedAt' | 'decidedBy' | 'decisionNote' | 'decisionScope' | 'status'> & { expiresAt?: string | null }): ApprovalRequest;
  get(id: string): ApprovalRequest | null;
  decide(
    id: string,
    decision: 'approved' | 'denied' | 'expired',
    decidedBy: string,
    note: string | null,
    scope?: 'once' | 'task',
  ): ApprovalRequest | null;
  listPending(projectId?: string): ApprovalRequest[];
  list(projectId: string, limit?: number): ApprovalRequest[];
  hasPendingForTask(taskId: string): ApprovalRequest | null;
  expireStale(now: string): number;
}

function map(row: Row): ApprovalRequest {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    agentId: row.agent_id === null ? null : (String(row.agent_id) as AgentId),
    action: String(row.action),
    reason: String(row.reason),
    risk: String(row.risk) as ApprovalRequest['risk'],
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    status: String(row.status) as ApprovalRequest['status'],
    requestedAt: String(row.requested_at),
    decidedAt: row.decided_at === null ? null : String(row.decided_at),
    decidedBy: row.decided_by === null ? null : String(row.decided_by),
    decisionNote: row.decision_note === null ? null : String(row.decision_note),
    decisionScope: row.decision_scope === null || row.decision_scope === undefined ? null : (String(row.decision_scope) as ApprovalRequest['decisionScope']),
  };
}

export function createApprovalRepository(db: Database): ApprovalRepository {
  return {
    request(input) {
      const record: ApprovalRequest = {
        ...input,
        id: crypto.randomUUID(),
        status: 'pending',
        requestedAt: nowIso(),
        decidedAt: null,
        decidedBy: null,
        decisionNote: null,
        decisionScope: null,
      };
      db.run(
        `INSERT INTO approvals (id, project_id, task_id, agent_id, action, reason, risk, payload, status, requested_at, decided_at, decided_by, decision_note, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?)`,
        [
          record.id,
          record.projectId,
          record.taskId,
          record.agentId,
          record.action,
          record.reason,
          record.risk,
          JSON.stringify(record.payload),
          record.requestedAt,
          (input as { expiresAt?: string | null }).expiresAt ?? null,
        ],
      );
      return record;
    },
    get(id) {
      const row = db.get<Row>('SELECT * FROM approvals WHERE id = ?', [id]);
      return row ? map(row) : null;
    },
    decide(id, decision, decidedBy, note, scope) {
      const existing = this.get(id);
      if (!existing) return null;
      const decidedAt = nowIso();
      // An expiry is a timeout, not a verdict: it has no reach, so it never carries a scope.
      const decisionScope = decision === 'approved' ? (scope ?? 'once') : null;
      db.run('UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_note = ?, decision_scope = ? WHERE id = ?', [
        decision,
        decidedAt,
        decidedBy,
        note,
        decisionScope,
        id,
      ]);
      return { ...existing, status: decision, decidedAt, decidedBy, decisionNote: note, decisionScope };
    },
    listPending(projectId) {
      const rows = projectId
        ? db.all<Row>("SELECT * FROM approvals WHERE status = 'pending' AND project_id = ? ORDER BY requested_at", [projectId])
        : db.all<Row>("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at");
      return rows.map(map);
    },
    list(projectId, limit = 100) {
      return db.all<Row>('SELECT * FROM approvals WHERE project_id = ? ORDER BY requested_at DESC LIMIT ?', [projectId, limit]).map(map);
    },
    hasPendingForTask(taskId) {
      const row = db.get<Row>("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending' ORDER BY requested_at DESC LIMIT 1", [taskId]);
      return row ? map(row) : null;
    },
    expireStale(now) {
      return db.run("UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?", [
        now,
        now,
      ]).changes;
    },
  };
}
