import crypto from 'node:crypto';
import type { AgentId, AgentRuntimeStatus, AgentLimits, AgentState } from '@aido/types';
import type { Database, Row } from '../db.js';
import { fromBool, nowIso, parseJson, toBool, toNumber } from './helpers.js';

export interface AgentMessage {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: string | null;
  role: 'system' | 'user' | 'assistant' | 'tool' | 'event';
  content: string;
  trust: 'trusted' | 'untrusted';
  tokens: number | null;
  modelId: string | null;
  providerId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface MessageRepository {
  append(message: Omit<AgentMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): AgentMessage;
  listForTask(taskId: string, limit?: number): AgentMessage[];
  listForAgent(projectId: string, agentId: AgentId, limit?: number): AgentMessage[];
  recentForProject(projectId: string, limit?: number): AgentMessage[];
  countForTask(taskId: string): number;
  deleteForProject(projectId: string): number;
}

function mapMessage(row: Row): AgentMessage {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    role: String(row.role) as AgentMessage['role'],
    content: String(row.content),
    trust: String(row.trust) as AgentMessage['trust'],
    tokens: toNumber(row.tokens),
    modelId: row.model_id === null ? null : String(row.model_id),
    providerId: row.provider_id === null ? null : String(row.provider_id),
    meta: parseJson<Record<string, unknown>>(row.meta, {}),
    createdAt: String(row.created_at),
  };
}

export function createMessageRepository(db: Database): MessageRepository {
  return {
    append(message) {
      const record: AgentMessage = {
        ...message,
        id: message.id ?? crypto.randomUUID(),
        createdAt: message.createdAt ?? nowIso(),
      };
      db.run(
        `INSERT INTO messages (id, project_id, task_id, agent_id, role, content, trust, tokens, model_id, provider_id, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.projectId,
          record.taskId,
          record.agentId,
          record.role,
          record.content,
          record.trust,
          record.tokens,
          record.modelId,
          record.providerId,
          JSON.stringify(record.meta),
          record.createdAt,
        ],
      );
      return record;
    },
    listForTask(taskId, limit = 200) {
      return db.all<Row>('SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC LIMIT ?', [taskId, limit]).map(mapMessage);
    },
    listForAgent(projectId, agentId, limit = 200) {
      return db
        .all<Row>('SELECT * FROM messages WHERE project_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, agentId, limit])
        .map(mapMessage)
        .reverse();
    },
    recentForProject(projectId, limit = 100) {
      return db.all<Row>('SELECT * FROM messages WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', [projectId, limit]).map(mapMessage).reverse();
    },
    countForTask(taskId) {
      const row = db.get<Row>('SELECT COUNT(*) AS c FROM messages WHERE task_id = ?', [taskId]);
      return Number(row?.c ?? 0);
    },
    deleteForProject(projectId) {
      return db.run('DELETE FROM messages WHERE project_id = ?', [projectId]).changes;
    },
  };
}

// ---------------------------------------------------------------------------
// Executions (one agent attempt on one task)
// ---------------------------------------------------------------------------

export interface ExecutionRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  agentRole: AgentId;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  modelId: string | null;
  providerId: string | null;
  traceIds: string[];
  tokenInput: number;
  tokenOutput: number;
  durationMs: number | null;
  iterations: number;
  error: string | null;
  outcome: Record<string, unknown> | null;
}

export interface ExecutionRepository {
  start(record: Omit<ExecutionRecord, 'finishedAt'> & { finishedAt?: string | null }): ExecutionRecord;
  finish(id: string, patch: Partial<Pick<ExecutionRecord, 'status' | 'tokenInput' | 'tokenOutput' | 'durationMs' | 'iterations' | 'error' | 'outcome' | 'traceIds'>>): void;
  listForTask(taskId: string): ExecutionRecord[];
  listForProject(projectId: string, limit?: number): ExecutionRecord[];
  /** Median duration for an agent role, used by the supervisor's stall detector. */
  durationStats(projectId: string, agentRole: AgentId): { medianMs: number | null; samples: number };
}

function mapExecution(row: Row): ExecutionRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    agentRole: String(row.agent_role) as AgentId,
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    status: String(row.status),
    modelId: row.model_id === null ? null : String(row.model_id),
    providerId: row.provider_id === null ? null : String(row.provider_id),
    traceIds: parseJson<string[]>(row.trace_ids, []),
    tokenInput: Number(row.token_input ?? 0),
    tokenOutput: Number(row.token_output ?? 0),
    durationMs: toNumber(row.duration_ms),
    iterations: Number(row.iterations ?? 0),
    error: row.error === null ? null : String(row.error),
    outcome: parseJson<Record<string, unknown> | null>(row.outcome, null),
  };
}

export function createExecutionRepository(db: Database): ExecutionRepository {
  return {
    start(record) {
      db.run(
        `INSERT INTO executions (id, project_id, task_id, agent_role, started_at, finished_at, status, model_id, provider_id, trace_ids, token_input, token_output, duration_ms, iterations, error, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          record.projectId,
          record.taskId,
          record.agentRole,
          record.startedAt,
          (record as { finishedAt?: string | null }).finishedAt ?? null,
          record.status,
          record.modelId,
          record.providerId,
          JSON.stringify(record.traceIds),
          record.tokenInput,
          record.tokenOutput,
          record.durationMs,
          record.iterations,
          record.error,
          record.outcome ? JSON.stringify(record.outcome) : null,
        ],
      );
      return { ...record, finishedAt: (record as { finishedAt?: string | null }).finishedAt ?? null };
    },
    finish(id, patch) {
      const sets: string[] = ['finished_at = ?'];
      const params: unknown[] = [nowIso()];
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.tokenInput !== undefined) {
        sets.push('token_input = ?');
        params.push(patch.tokenInput);
      }
      if (patch.tokenOutput !== undefined) {
        sets.push('token_output = ?');
        params.push(patch.tokenOutput);
      }
      if (patch.durationMs !== undefined) {
        sets.push('duration_ms = ?');
        params.push(patch.durationMs);
      }
      if (patch.iterations !== undefined) {
        sets.push('iterations = ?');
        params.push(patch.iterations);
      }
      if (patch.error !== undefined) {
        sets.push('error = ?');
        params.push(patch.error);
      }
      if (patch.outcome !== undefined) {
        sets.push('outcome = ?');
        params.push(patch.outcome ? JSON.stringify(patch.outcome) : null);
      }
      if (patch.traceIds !== undefined) {
        sets.push('trace_ids = ?');
        params.push(JSON.stringify(patch.traceIds));
      }
      params.push(id);
      db.run(`UPDATE executions SET ${sets.join(', ')} WHERE id = ?`, params);
    },
    listForTask(taskId) {
      return db.all<Row>('SELECT * FROM executions WHERE task_id = ? ORDER BY started_at', [taskId]).map(mapExecution);
    },
    listForProject(projectId, limit = 50) {
      return db.all<Row>('SELECT * FROM executions WHERE project_id = ? ORDER BY started_at DESC LIMIT ?', [projectId, limit]).map(mapExecution);
    },
    durationStats(projectId, agentRole) {
      const rows = db.all<Row>(
        'SELECT duration_ms FROM executions WHERE project_id = ? AND agent_role = ? AND duration_ms IS NOT NULL ORDER BY duration_ms',
        [projectId, agentRole],
      );
      const values = rows.map((r) => Number(r.duration_ms)).filter((n) => Number.isFinite(n));
      if (!values.length) return { medianMs: null, samples: 0 };
      return { medianMs: values[Math.floor(values.length / 2)] ?? null, samples: values.length };
    },
  };
}

// ---------------------------------------------------------------------------
// Agent runtime state
// ---------------------------------------------------------------------------

export interface AgentStateRecord extends AgentRuntimeStatus {
  projectId: string;
  limits: AgentLimits;
  errorStreak: number;
  paused: boolean;
}

export interface AgentCounters {
  tasksCompleted?: number;
  tasksFailed?: number;
  iterations?: number;
  tokensUsedToday?: number;
  requestsToday?: number;
}

export interface AgentStateRepository {
  list(projectId: string): AgentStateRecord[];
  get(projectId: string, agentId: AgentId): AgentStateRecord | null;
  upsert(record: AgentStateRecord): AgentStateRecord;
  patch(projectId: string, agentId: AgentId, patch: Partial<Omit<AgentStateRecord, 'projectId' | 'agentId'>>): void;
  /**
   * Adds to an agent's counters in one statement.
   *
   * Counters cannot go through `patch`, which takes absolute values: two tasks settling
   * close together would each write their own idea of the total and one increment would be
   * lost. `success_rate` is recomputed from the post-increment counts in the same
   * statement, and a missing row is created rather than ignored.
   */
  increment(projectId: string, agentId: AgentId, delta: AgentCounters): void;
  /** Resets all agents to idle — used when a run stops or the worker restarts. */
  resetAll(projectId: string): void;
}

export function createAgentStateRepository(db: Database): AgentStateRepository {
  const map = (row: Row): AgentStateRecord => ({
    projectId: String(row.project_id),
    agentId: String(row.role) as AgentId,
    state: String(row.state) as AgentState,
    currentTaskId: row.current_task_id === null ? null : String(row.current_task_id),
    currentModelId: row.current_model_id === null ? null : String(row.current_model_id),
    currentProviderId: row.current_provider_id === null ? null : String(row.current_provider_id),
    iterations: Number(row.iterations ?? 0),
    tokensUsedToday: Number(row.tokens_used_today ?? 0),
    requestsToday: Number(row.requests_today ?? 0),
    tasksCompleted: Number(row.tasks_completed ?? 0),
    tasksFailed: Number(row.tasks_failed ?? 0),
    successRate: toNumber(row.success_rate),
    lastActionAt: row.last_action_at === null ? null : String(row.last_action_at),
    lastError: row.last_error === null ? null : String(row.last_error),
    enabled: toBool(row.enabled),
    limits: parseJson<AgentLimits>(row.limits, {
      maxTokens: 200_000,
      maxRequests: 50,
      maxRuntimeMs: 600_000,
      maxRetries: 3,
      maxFilesChanged: 20,
      maxShellCommands: 30,
    }),
    errorStreak: Number(row.error_streak ?? 0),
    paused: toBool(row.paused),
  });

  return {
    list(projectId) {
      return db.all<Row>('SELECT * FROM agents WHERE project_id = ? ORDER BY role', [projectId]).map(map);
    },
    get(projectId, agentId) {
      const row = db.get<Row>('SELECT * FROM agents WHERE project_id = ? AND role = ?', [projectId, agentId]);
      return row ? map(row) : null;
    },
    upsert(record) {
      db.run(
        `INSERT INTO agents (project_id, role, enabled, state, current_task_id, current_model_id, current_provider_id, iterations,
           tokens_used_today, requests_today, tasks_completed, tasks_failed, success_rate, limits, last_action_at, last_error, error_streak, paused, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, role) DO UPDATE SET
           enabled = excluded.enabled, state = excluded.state, current_task_id = excluded.current_task_id,
           current_model_id = excluded.current_model_id, current_provider_id = excluded.current_provider_id,
           iterations = excluded.iterations, tokens_used_today = excluded.tokens_used_today, requests_today = excluded.requests_today,
           tasks_completed = excluded.tasks_completed, tasks_failed = excluded.tasks_failed, success_rate = excluded.success_rate,
           limits = excluded.limits, last_action_at = excluded.last_action_at, last_error = excluded.last_error,
           error_streak = excluded.error_streak, paused = excluded.paused, updated_at = excluded.updated_at`,
        [
          record.projectId,
          record.agentId,
          fromBool(record.enabled),
          record.state,
          record.currentTaskId,
          record.currentModelId,
          record.currentProviderId,
          record.iterations,
          record.tokensUsedToday,
          record.requestsToday,
          record.tasksCompleted,
          record.tasksFailed,
          record.successRate,
          JSON.stringify(record.limits),
          record.lastActionAt,
          record.lastError,
          record.errorStreak,
          fromBool(record.paused),
          nowIso(),
        ],
      );
      return record;
    },
    patch(projectId, agentId, patch) {
      // A PATCH IS ALSO AN UPSERT. `add()` may never have run for this project/agent pair
      // (the roster is declared in config, not seeded per project), and a bare UPDATE would
      // then silently write nothing — leaving a project whose dashboard shows no agents at
      // all even though the run engine just moved one to `working`.
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [nowIso()];
      const map2: Record<string, string> = {
        state: 'state',
        currentTaskId: 'current_task_id',
        currentModelId: 'current_model_id',
        currentProviderId: 'current_provider_id',
        iterations: 'iterations',
        tokensUsedToday: 'tokens_used_today',
        requestsToday: 'requests_today',
        tasksCompleted: 'tasks_completed',
        tasksFailed: 'tasks_failed',
        successRate: 'success_rate',
        lastActionAt: 'last_action_at',
        lastError: 'last_error',
        errorStreak: 'error_streak',
        paused: 'paused',
        enabled: 'enabled',
        limits: 'limits',
      };
      for (const [key, column] of Object.entries(map2)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue;
        sets.push(`${column} = ?`);
        params.push(key === 'limits' ? JSON.stringify(value) : typeof value === 'boolean' ? fromBool(value) : value);
      }
      if (sets.length === 1) return;
      params.push(projectId, agentId);
      const updated = db.run(`UPDATE agents SET ${sets.join(', ')} WHERE project_id = ? AND role = ?`, params).changes;
      if (updated === 0) {
        // `limits` is NOT NULL without a schema default, so a first-time insert must supply
        // every NOT NULL column explicitly rather than relying on the table defaults.
        const columns = ['project_id', 'role', 'updated_at', 'enabled', 'state', 'iterations', 'tokens_used_today', 'requests_today', 'tasks_completed', 'tasks_failed', 'error_streak', 'paused', 'limits'];
        const values: unknown[] = [projectId, agentId, nowIso(), 1, 'idle', 0, 0, 0, 0, 0, 0, 0, '{}'];
        for (const [key, column] of Object.entries(map2)) {
          const value = (patch as Record<string, unknown>)[key];
          if (value === undefined) continue;
          const index = columns.indexOf(column);
          const encoded = key === 'limits' ? JSON.stringify(value) : typeof value === 'boolean' ? fromBool(value) : value;
          if (index === -1) {
            columns.push(column);
            values.push(encoded);
          } else {
            values[index] = encoded;
          }
        }
        db.run(
          `INSERT INTO agents (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT(project_id, role) DO NOTHING`,
          values,
        );
      }
    },
    increment(projectId, agentId, delta) {
      const completed = delta.tasksCompleted ?? 0;
      const failed = delta.tasksFailed ?? 0;
      const sets: string[] = ['updated_at = ?', 'tasks_completed = tasks_completed + ?', 'tasks_failed = tasks_failed + ?'];
      const params: unknown[] = [nowIso(), completed, failed];
      if (delta.iterations) {
        sets.push('iterations = iterations + ?');
        params.push(delta.iterations);
      }
      if (delta.tokensUsedToday) {
        sets.push('tokens_used_today = tokens_used_today + ?');
        params.push(delta.tokensUsedToday);
      }
      if (delta.requestsToday) {
        sets.push('requests_today = requests_today + ?');
        params.push(delta.requestsToday);
      }
      // SQLite resolves every right-hand side against the pre-update row, so these
      // references are the counts before this increment, plus the deltas applied above.
      sets.push(
        `success_rate = CASE WHEN (tasks_completed + ? + tasks_failed + ?) > 0
           THEN CAST(tasks_completed + ? AS REAL) / (tasks_completed + ? + tasks_failed + ?) ELSE NULL END`,
      );
      params.push(completed, failed, completed, completed, failed);
      params.push(projectId, agentId);
      const changed = db.run(`UPDATE agents SET ${sets.join(', ')} WHERE project_id = ? AND role = ?`, params).changes;
      if (changed === 0) {
        const rate = completed + failed > 0 ? completed / (completed + failed) : null;
        db.run(
          `INSERT INTO agents (project_id, role, updated_at, enabled, state, iterations, tokens_used_today, requests_today,
             tasks_completed, tasks_failed, error_streak, paused, limits, success_rate)
           VALUES (?, ?, ?, 1, 'idle', ?, ?, ?, ?, ?, 0, 0, '{}', ?)
           ON CONFLICT(project_id, role) DO NOTHING`,
          [projectId, agentId, nowIso(), delta.iterations ?? 0, delta.tokensUsedToday ?? 0, delta.requestsToday ?? 0, completed, failed, rate],
        );
      }
    },
    resetAll(projectId) {
      db.run(
        "UPDATE agents SET state = 'idle', current_task_id = NULL, iterations = 0, updated_at = ? WHERE project_id = ?",
        [nowIso(), projectId],
      );
    },
  };
}
