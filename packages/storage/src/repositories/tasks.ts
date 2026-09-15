import type { AgentId, Priority, Task, TaskResult, TaskStatus, TaskType } from '@aido/types';
import type { Database, Row } from '../db.js';
import { fromBool, nowIso, parseJson, toBool, toNumber } from './helpers.js';

export interface TaskRepository {
  listByProject(projectId: string): Task[];
  get(id: string): Task | null;
  create(task: Task): Task;
  update(id: string, patch: Partial<Omit<Task, 'id' | 'projectId'>>): Task | null;
  delete(id: string): boolean;
  /** Tasks whose every dependency is `done`. */
  readyTasks(projectId: string): Task[];
  /** Status of each dependency for the given tasks, used for blocking checks. */
  dependencyStatuses(taskIds: string[]): Map<string, { id: string; status: TaskStatus }[]>;
  dependencyCounts(projectId: string): Map<string, { total: number; done: number }>;
  countsByStatus(projectId: string): Record<string, number>;
  countsByAgent(projectId: string): { agentRole: AgentId; status: TaskStatus; count: number }[];
  nextOrderIndex(projectId: string): number;
}

export function createTaskRepository(db: Database): TaskRepository {
  const map = (row: Row): Task => ({
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    description: String(row.description ?? ''),
    agentRole: String(row.agent_role) as AgentId,
    taskType: String(row.task_type) as TaskType,
    status: String(row.status) as TaskStatus,
    priority: String(row.priority) as Priority,
    dependsOn: parseJson<string[]>(row.depends_on, []),
    resourceLocks: parseJson<string[]>(row.resource_locks, []),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    orderIndex: Number(row.order_index ?? 0),
    estimatedInputTokens: toNumber(row.estimated_input_tokens),
    estimatedOutputTokens: toNumber(row.estimated_output_tokens),
    result: parseJson<TaskResult | null>(row.result, null),
    attempts: Number(row.attempts ?? 0),
    maxAttempts: Number(row.max_attempts ?? 3),
    lastError: row.last_error === null ? null : String(row.last_error),
    lastModelId: row.last_model_id === null ? null : String(row.last_model_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    completedAt: row.completed_at === null ? null : String(row.completed_at),
  });

  return {
    listByProject(projectId) {
      return db
        .all<Row>('SELECT * FROM tasks WHERE project_id = ? ORDER BY order_index, created_at', [projectId])
        .map(map);
    },
    get(id) {
      const row = db.get<Row>('SELECT * FROM tasks WHERE id = ?', [id]);
      return row ? map(row) : null;
    },
    create(task) {
      db.transaction(() => {
        db.run(
          `INSERT INTO tasks (id, project_id, parent_id, title, description, agent_role, task_type, status, priority,
              depends_on, resource_locks, order_index, estimated_input_tokens, estimated_output_tokens, result, attempts,
              max_attempts, last_error, last_model_id, created_at, updated_at, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            task.id,
            task.projectId,
            task.parentId,
            task.title,
            task.description,
            task.agentRole,
            task.taskType,
            task.status,
            task.priority,
            JSON.stringify(task.dependsOn),
            JSON.stringify(task.resourceLocks),
            task.orderIndex,
            task.estimatedInputTokens,
            task.estimatedOutputTokens,
            task.result ? JSON.stringify(task.result) : null,
            task.attempts,
            task.maxAttempts,
            task.lastError,
            task.lastModelId,
            task.createdAt,
            task.updatedAt,
            task.startedAt,
            task.completedAt,
          ],
        );
        for (const dep of task.dependsOn) {
          db.run('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)', [task.id, dep]);
        }
      });
      return task;
    },
    update(id, patch) {
      const existing = this.get(id);
      if (!existing) return null;
      const next: Task = { ...existing, ...patch, updatedAt: nowIso() };
      db.transaction(() => {
        db.run(
          `UPDATE tasks SET parent_id = ?, title = ?, description = ?, agent_role = ?, task_type = ?, status = ?, priority = ?,
             depends_on = ?, resource_locks = ?, order_index = ?, estimated_input_tokens = ?, estimated_output_tokens = ?,
             result = ?, attempts = ?, max_attempts = ?, last_error = ?, last_model_id = ?, updated_at = ?, started_at = ?, completed_at = ?
           WHERE id = ?`,
          [
            next.parentId,
            next.title,
            next.description,
            next.agentRole,
            next.taskType,
            next.status,
            next.priority,
            JSON.stringify(next.dependsOn),
            JSON.stringify(next.resourceLocks),
            next.orderIndex,
            next.estimatedInputTokens,
            next.estimatedOutputTokens,
            next.result ? JSON.stringify(next.result) : null,
            next.attempts,
            next.maxAttempts,
            next.lastError,
            next.lastModelId,
            next.updatedAt,
            next.startedAt,
            next.completedAt,
            id,
          ],
        );
        if (patch.dependsOn) {
          db.run('DELETE FROM task_dependencies WHERE task_id = ?', [id]);
          for (const dep of next.dependsOn) {
            db.run('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)', [id, dep]);
          }
        }
      });
      return next;
    },
    delete(id) {
      return db.run('DELETE FROM tasks WHERE id = ?', [id]).changes > 0;
    },
    readyTasks(projectId) {
      const rows = db.all<Row>(
        `SELECT t.* FROM tasks t
         WHERE t.project_id = ?
           AND t.status IN ('ready', 'backlog')
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies d
             JOIN tasks dep ON dep.id = d.depends_on_id
             WHERE d.task_id = t.id AND dep.status != 'done'
           )
         ORDER BY
           CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           t.order_index`,
        [projectId],
      );
      return rows.map(map);
    },
    dependencyStatuses(taskIds) {
      const result = new Map<string, { id: string; status: TaskStatus }[]>();
      if (!taskIds.length) return result;
      const placeholders = taskIds.map(() => '?').join(', ');
      const rows = db.all<Row>(
        `SELECT d.task_id, dep.id AS dep_id, dep.status AS dep_status
         FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on_id
         WHERE d.task_id IN (${placeholders})`,
        taskIds,
      );
      for (const row of rows) {
        const key = String(row.task_id);
        const list = result.get(key) ?? [];
        list.push({ id: String(row.dep_id), status: String(row.dep_status) as TaskStatus });
        result.set(key, list);
      }
      return result;
    },
    dependencyCounts(projectId) {
      const rows = db.all<Row>(
        `SELECT t.id, COUNT(d.depends_on_id) AS total, SUM(CASE WHEN dep.status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks t
         LEFT JOIN task_dependencies d ON d.task_id = t.id
         LEFT JOIN tasks dep ON dep.id = d.depends_on_id
         WHERE t.project_id = ?
         GROUP BY t.id`,
        [projectId],
      );
      const result = new Map<string, { total: number; done: number }>();
      for (const row of rows) {
        result.set(String(row.id), { total: Number(row.total ?? 0), done: Number(row.done ?? 0) });
      }
      return result;
    },
    countsByStatus(projectId) {
      const rows = db.all<Row>('SELECT status, COUNT(*) AS c FROM tasks WHERE project_id = ? GROUP BY status', [projectId]);
      const out: Record<string, number> = {};
      for (const row of rows) out[String(row.status)] = Number(row.c ?? 0);
      return out;
    },
    countsByAgent(projectId) {
      const rows = db.all<Row>(
        'SELECT agent_role, status, COUNT(*) AS c FROM tasks WHERE project_id = ? GROUP BY agent_role, status',
        [projectId],
      );
      return rows.map((row) => ({
        agentRole: String(row.agent_role) as AgentId,
        status: String(row.status) as TaskStatus,
        count: Number(row.c ?? 0),
      }));
    },
    nextOrderIndex(projectId) {
      const row = db.get<Row>('SELECT COALESCE(MAX(order_index), -1) AS m FROM tasks WHERE project_id = ?', [projectId]);
      return Number(row?.m ?? -1) + 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Scheduler queue + run signals
// ---------------------------------------------------------------------------

export interface QueueItem {
  id: string;
  projectId: string;
  taskId: string;
  priority: number;
  availableAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface SchedulerQueueRepository {
  enqueue(item: Omit<QueueItem, 'id' | 'createdAt' | 'claimedAt' | 'claimedBy' | 'attempts' | 'lastError'> & { id?: string }): QueueItem;
  /** Atomically claim the next available item for this worker. */
  claim(workerId: string, projectId?: string): QueueItem | null;
  complete(id: string): void;
  fail(id: string, error: string, retryAt?: string): void;
  releaseStale(timeoutMs: number): number;
  list(projectId: string): QueueItem[];
  clear(projectId: string): number;
  size(): number;
}

export function createSchedulerQueueRepository(db: Database): SchedulerQueueRepository {
  const map = (row: Row): QueueItem => ({
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: String(row.task_id),
    priority: Number(row.priority ?? 0),
    availableAt: String(row.available_at),
    claimedAt: row.claimed_at === null ? null : String(row.claimed_at),
    claimedBy: row.claimed_by === null ? null : String(row.claimed_by),
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error === null ? null : String(row.last_error),
    createdAt: String(row.created_at),
  });

  return {
    enqueue(item) {
      const id = item.id ?? crypto.randomUUID();
      const record: QueueItem = {
        id,
        projectId: item.projectId,
        taskId: item.taskId,
        priority: item.priority,
        availableAt: item.availableAt,
        claimedAt: null,
        claimedBy: null,
        attempts: 0,
        lastError: null,
        createdAt: nowIso(),
      };
      // Idempotent enqueue: a task already queued (unclaimed) must not double-run.
      db.run(
        `INSERT INTO scheduler_queue (id, project_id, task_id, priority, available_at, claimed_at, claimed_by, attempts, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, NULL, ?)
         ON CONFLICT(id) DO NOTHING`,
        [record.id, record.projectId, record.taskId, record.priority, record.availableAt, record.createdAt],
      );
      return record;
    },
    claim(workerId, projectId) {
      return db.transaction(() => {
        const params: unknown[] = [nowIso()];
        let sql = `SELECT * FROM scheduler_queue WHERE claimed_at IS NULL AND available_at <= ?`;
        if (projectId) {
          sql += ' AND project_id = ?';
          params.push(projectId);
        }
        sql += ' ORDER BY priority DESC, available_at LIMIT 1';
        const row = db.get<Row>(sql, params);
        if (!row) return null;
        const claimed = db.run(
          `UPDATE scheduler_queue SET claimed_at = ?, claimed_by = ?, attempts = attempts + 1
           WHERE id = ? AND claimed_at IS NULL`,
          [nowIso(), workerId, String(row.id)],
        );
        // Lost the race to another worker: report nothing rather than a phantom claim.
        if (claimed.changes === 0) return null;
        return map({ ...row, claimed_at: nowIso(), claimed_by: workerId, attempts: Number(row.attempts ?? 0) + 1 });
      });
    },
    complete(id) {
      db.run('DELETE FROM scheduler_queue WHERE id = ?', [id]);
    },
    fail(id, error, retryAt) {
      if (retryAt) {
        db.run('UPDATE scheduler_queue SET claimed_at = NULL, claimed_by = NULL, last_error = ?, available_at = ? WHERE id = ?', [
          error,
          retryAt,
          id,
        ]);
      } else {
        db.run('DELETE FROM scheduler_queue WHERE id = ?', [id]);
      }
    },
    releaseStale(timeoutMs) {
      const cutoff = new Date(Date.now() - timeoutMs).toISOString();
      return db.run(
        'UPDATE scheduler_queue SET claimed_at = NULL, claimed_by = NULL, last_error = COALESCE(last_error, ?) WHERE claimed_at IS NOT NULL AND claimed_at < ?',
        ['worker restarted while this task was claimed', cutoff],
      ).changes;
    },
    list(projectId) {
      return db.all<Row>('SELECT * FROM scheduler_queue WHERE project_id = ? ORDER BY priority DESC, available_at', [projectId]).map(map);
    },
    clear(projectId) {
      return db.run('DELETE FROM scheduler_queue WHERE project_id = ?', [projectId]).changes;
    },
    size() {
      const row = db.get<Row>('SELECT COUNT(*) AS c FROM scheduler_queue WHERE claimed_at IS NULL');
      return Number(row?.c ?? 0);
    },
  };
}

export interface RunSignal {
  projectId: string;
  runState: 'idle' | 'running' | 'paused' | 'stopping';
  paused: boolean;
  cancelRequested: boolean;
  updatedAt: string;
}

export interface RunSignalRepository {
  get(projectId: string): RunSignal;
  set(projectId: string, patch: Partial<Omit<RunSignal, 'projectId' | 'updatedAt'>>): RunSignal;
}

export function createRunSignalRepository(db: Database): RunSignalRepository {
  const map = (row: Row): RunSignal => ({
    projectId: String(row.project_id),
    runState: String(row.run_state) as RunSignal['runState'],
    paused: toBool(row.paused),
    cancelRequested: toBool(row.cancel_requested),
    updatedAt: String(row.updated_at),
  });
  const defaults = (projectId: string): RunSignal => ({
    projectId,
    runState: 'idle',
    paused: false,
    cancelRequested: false,
    updatedAt: nowIso(),
  });

  return {
    get(projectId) {
      const row = db.get<Row>('SELECT * FROM run_signals WHERE project_id = ?', [projectId]);
      return row ? map(row) : defaults(projectId);
    },
    set(projectId, patch) {
      const current = this.get(projectId);
      const next: RunSignal = { ...current, ...patch, projectId, updatedAt: nowIso() };
      db.run(
        `INSERT INTO run_signals (project_id, run_state, paused, cancel_requested, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET run_state = excluded.run_state, paused = excluded.paused,
           cancel_requested = excluded.cancel_requested, updated_at = excluded.updated_at`,
        [projectId, next.runState, fromBool(next.paused), fromBool(next.cancelRequested), next.updatedAt],
      );
      return next;
    },
  };
}
