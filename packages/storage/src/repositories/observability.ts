import crypto from 'node:crypto';
import type {
  AgentStats,
  EventQuery,
  LLMTrace,
  MetricSample,
  MetricTimeseries,
  OrchestratorEvent,
  ProviderStats,
  RoutingRationale,
} from '@aido/types';
import type { Database, Row } from '../db.js';
import { grainToSql, inClause, nowIso, parseJson, toBool, toNumber } from './helpers.js';

export interface TraceQuery {
  projectId?: string;
  taskId?: string;
  agentId?: string;
  providerId?: string;
  modelId?: string;
  status?: LLMTrace['status'];
  since?: string;
  limit?: number;
}

export interface TraceRepository {
  insert(trace: LLMTrace): void;
  finish(traceId: string, patch: Partial<LLMTrace>): void;
  list(query?: TraceQuery): LLMTrace[];
  get(traceId: string): LLMTrace | null;
  providerStats(since: string): ProviderStats[];
  /**
   * Per-agent activity. `projectId` scopes it to one project — the roster is shown in the
   * context of a project, so its numbers must come from that project, not from every
   * project the installation has ever run.
   */
  agentStats(since: string, projectId?: string): AgentStats[];
  modelStats(since: string): (ProviderStats & { modelId: string })[];
  totals(since: string): { requests: number; tokensIn: number; tokensOut: number; avgLatencyMs: number | null; successRate: number | null; failovers: number };
  latencySeries(since: string, granularity: 'minute' | 'hour' | 'day'): MetricTimeseries;
  purgeBefore(cutoff: string): number;
}

export function createTraceRepository(db: Database): TraceRepository {
  const map = (row: Row): LLMTrace => ({
    traceId: String(row.trace_id),
    projectId: row.project_id === null ? null : String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    taskType: row.task_type === null ? null : String(row.task_type),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    latencyMs: toNumber(row.latency_ms),
    firstTokenLatencyMs: toNumber(row.first_token_latency_ms),
    usage: {
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      estimated: toBool(row.tokens_estimated),
    },
    status: String(row.status) as LLMTrace['status'],
    errorCategory: row.error_category === null ? null : (String(row.error_category) as LLMTrace['errorCategory']),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    attempt: Number(row.attempt ?? 1),
    failoverDepth: Number(row.failover_depth ?? 0),
    quotaBefore: parseJson(row.quota_before, null),
    quotaAfter: parseJson(row.quota_after, null),
    telemetry: parseJson(row.telemetry, null),
    routingRationale: parseJson<RoutingRationale | null>(row.routing_rationale, null),
    streamed: toBool(row.streamed),
    costEstimateUsd: toNumber(row.cost_estimate_usd),
  });

  return {
    insert(trace) {
      db.run(
        `INSERT INTO traces (trace_id, project_id, task_id, agent_id, provider_id, model_id, task_type, started_at, finished_at,
           latency_ms, first_token_latency_ms, input_tokens, output_tokens, total_tokens, tokens_estimated, status, error_category,
           error_message, attempt, failover_depth, quota_before, quota_after, telemetry, routing_rationale, streamed, cost_estimate_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(trace_id) DO NOTHING`,
        [
          trace.traceId,
          trace.projectId,
          trace.taskId,
          trace.agentId,
          trace.providerId,
          trace.modelId,
          trace.taskType,
          trace.startedAt,
          trace.finishedAt,
          trace.latencyMs,
          trace.firstTokenLatencyMs ?? null,
          trace.usage?.inputTokens ?? null,
          trace.usage?.outputTokens ?? null,
          trace.usage?.totalTokens ?? null,
          trace.usage?.estimated ? 1 : 0,
          trace.status,
          trace.errorCategory,
          trace.errorMessage,
          trace.attempt,
          trace.failoverDepth,
          trace.quotaBefore ? JSON.stringify(trace.quotaBefore) : null,
          trace.quotaAfter ? JSON.stringify(trace.quotaAfter) : null,
          trace.telemetry ? JSON.stringify(trace.telemetry) : null,
          trace.routingRationale ? JSON.stringify(trace.routingRationale) : null,
          trace.streamed ? 1 : 0,
          trace.costEstimateUsd,
        ],
      );
    },
    finish(traceId, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      const push = (col: string, value: unknown) => {
        sets.push(`${col} = ?`);
        params.push(value);
      };
      if (patch.finishedAt !== undefined) push('finished_at', patch.finishedAt);
      if (patch.latencyMs !== undefined) push('latency_ms', patch.latencyMs);
      if (patch.firstTokenLatencyMs !== undefined) push('first_token_latency_ms', patch.firstTokenLatencyMs);
      if (patch.usage !== undefined) {
        push('input_tokens', patch.usage?.inputTokens ?? null);
        push('output_tokens', patch.usage?.outputTokens ?? null);
        push('total_tokens', patch.usage?.totalTokens ?? null);
        push('tokens_estimated', patch.usage?.estimated ? 1 : 0);
      }
      if (patch.status !== undefined) push('status', patch.status);
      if (patch.errorCategory !== undefined) push('error_category', patch.errorCategory);
      if (patch.errorMessage !== undefined) push('error_message', patch.errorMessage);
      if (patch.quotaAfter !== undefined) push('quota_after', patch.quotaAfter ? JSON.stringify(patch.quotaAfter) : null);
      if (patch.telemetry !== undefined) push('telemetry', patch.telemetry ? JSON.stringify(patch.telemetry) : null);
      if (patch.failoverDepth !== undefined) push('failover_depth', patch.failoverDepth);
      if (patch.costEstimateUsd !== undefined) push('cost_estimate_usd', patch.costEstimateUsd);
      if (patch.routingRationale !== undefined) push('routing_rationale', patch.routingRationale ? JSON.stringify(patch.routingRationale) : null);
      if (!sets.length) return;
      params.push(traceId);
      db.run(`UPDATE traces SET ${sets.join(', ')} WHERE trace_id = ?`, params);
    },
    list(query = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.projectId) {
        where.push('project_id = ?');
        params.push(query.projectId);
      }
      if (query.taskId) {
        where.push('task_id = ?');
        params.push(query.taskId);
      }
      if (query.agentId) {
        where.push('agent_id = ?');
        params.push(query.agentId);
      }
      if (query.providerId) {
        where.push('provider_id = ?');
        params.push(query.providerId);
      }
      if (query.modelId) {
        where.push('model_id = ?');
        params.push(query.modelId);
      }
      if (query.status) {
        where.push('status = ?');
        params.push(query.status);
      }
      if (query.since) {
        where.push('started_at >= ?');
        params.push(query.since);
      }
      const sql = `SELECT * FROM traces ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
      params.push(query.limit ?? 200);
      return db.all<Row>(sql, params).map(map);
    },
    get(traceId) {
      const row = db.get<Row>('SELECT * FROM traces WHERE trace_id = ?', [traceId]);
      return row ? map(row) : null;
    },
    providerStats(since) {
      const rows = db.all<Row>(
        `SELECT provider_id,
                COUNT(*) AS requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS failures,
                AVG(CASE WHEN status = 'success' THEN latency_ms END) AS avg_latency,
                SUM(COALESCE(input_tokens, 0)) AS tokens_in,
                SUM(COALESCE(output_tokens, 0)) AS tokens_out,
                SUM(CASE WHEN status = 'rejected_by_quota' THEN 1 ELSE 0 END) AS quota_rejections,
                SUM(CASE WHEN failover_depth > 0 THEN 1 ELSE 0 END) AS failovers
         FROM traces WHERE started_at >= ? GROUP BY provider_id`,
        [since],
      );
      return rows.map((row) => {
        const requests = Number(row.requests ?? 0);
        const successes = Number(row.successes ?? 0);
        const latencies = db
          .all<Row>(
            `SELECT latency_ms FROM traces WHERE provider_id = ? AND started_at >= ? AND latency_ms IS NOT NULL ORDER BY latency_ms`,
            [String(row.provider_id), since],
          )
          .map((r) => Number(r.latency_ms));
        return {
          providerId: String(row.provider_id),
          requests,
          successes,
          failures: Number(row.failures ?? 0),
          successRate: requests ? successes / requests : null,
          avgLatencyMs: toNumber(row.avg_latency),
          p95LatencyMs: percentile(latencies, 0.95),
          tokensIn: Number(row.tokens_in ?? 0),
          tokensOut: Number(row.tokens_out ?? 0),
          quotaRejections: Number(row.quota_rejections ?? 0),
          failovers: Number(row.failovers ?? 0),
        };
      });
    },
    agentStats(since, projectId) {
      const projectFilter = projectId ? ' AND project_id = ?' : '';
      const projectParams = projectId ? [projectId] : [];
      const rows = db.all<Row>(
        `SELECT agent_id,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS failures,
                AVG(latency_ms) AS avg_latency,
                SUM(COALESCE(input_tokens, 0)) AS tokens_in,
                SUM(COALESCE(output_tokens, 0)) AS tokens_out,
                COUNT(*) AS requests
         FROM traces WHERE started_at >= ? AND agent_id IS NOT NULL${projectFilter} GROUP BY agent_id`,
        [since, ...projectParams],
      );
      const completedRows = db.all<Row>(
        `SELECT agent_role, COUNT(*) AS c FROM executions
         WHERE started_at >= ? AND status = 'completed'${projectFilter} GROUP BY agent_role`,
        [since, ...projectParams],
      );
      const completed = new Map(completedRows.map((r) => [String(r.agent_role), Number(r.c ?? 0)]));
      return rows.map((row) => {
        const agentId = String(row.agent_id);
        const tokensOut = Number(row.tokens_out ?? 0);
        const done = completed.get(agentId) ?? 0;
        return {
          agentId,
          tasksCompleted: done,
          tasksFailed: Number(row.failures ?? 0),
          avgDurationMs: toNumber(row.avg_latency),
          tokensIn: Number(row.tokens_in ?? 0),
          tokensOut,
          retries: 0,
          tokenEfficiency: done > 0 ? tokensOut / done : null,
        };
      });
    },
    modelStats(since) {
      const rows = db.all<Row>(
        `SELECT provider_id, model_id, COUNT(*) AS requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS failures,
                AVG(CASE WHEN status = 'success' THEN latency_ms END) AS avg_latency,
                SUM(COALESCE(input_tokens, 0)) AS tokens_in,
                SUM(COALESCE(output_tokens, 0)) AS tokens_out
         FROM traces WHERE started_at >= ? GROUP BY provider_id, model_id`,
        [since],
      );
      return rows.map((row) => {
        const requests = Number(row.requests ?? 0);
        const successes = Number(row.successes ?? 0);
        return {
          providerId: String(row.provider_id),
          modelId: String(row.model_id),
          requests,
          successes,
          failures: Number(row.failures ?? 0),
          successRate: requests ? successes / requests : null,
          avgLatencyMs: toNumber(row.avg_latency),
          p95LatencyMs: null,
          tokensIn: Number(row.tokens_in ?? 0),
          tokensOut: Number(row.tokens_out ?? 0),
          quotaRejections: 0,
          failovers: 0,
        };
      });
    },
    totals(since) {
      const row = db.get<Row>(
        `SELECT COUNT(*) AS requests,
                SUM(COALESCE(input_tokens, 0)) AS tokens_in,
                SUM(COALESCE(output_tokens, 0)) AS tokens_out,
                AVG(CASE WHEN status = 'success' THEN latency_ms END) AS avg_latency,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN failover_depth > 0 THEN 1 ELSE 0 END) AS failovers
         FROM traces WHERE started_at >= ?`,
        [since],
      );
      const requests = Number(row?.requests ?? 0);
      const successes = Number(row?.successes ?? 0);
      return {
        requests,
        tokensIn: Number(row?.tokens_in ?? 0),
        tokensOut: Number(row?.tokens_out ?? 0),
        avgLatencyMs: toNumber(row?.avg_latency),
        successRate: requests ? successes / requests : null,
        failovers: Number(row?.failovers ?? 0),
      };
    },
    latencySeries(since, granularity) {
      const grain = grainToSql(granularity, 'started_at');
      const rows = db.all<Row>(
        `SELECT ${grain} AS bucket, AVG(latency_ms) AS value FROM traces
         WHERE started_at >= ? AND latency_ms IS NOT NULL GROUP BY bucket ORDER BY bucket`,
        [since],
      );
      const points = rows.map((r) => ({ bucket: String(r.bucket), value: Number(r.value ?? 0) }));
      return {
        metric: 'llm_latency_ms',
        scope: 'system',
        scopeId: null,
        unit: 'ms',
        points,
        total: points.reduce((a, p) => a + p.value, 0),
        average: points.length ? points.reduce((a, p) => a + p.value, 0) / points.length : null,
      };
    },
    purgeBefore(cutoff) {
      return db.run('DELETE FROM traces WHERE started_at < ?', [cutoff]).changes;
    },
  };
}

function percentile(sortedValues: number[], p: number): number | null {
  if (!sortedValues.length) return null;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(p * sortedValues.length) - 1));
  return sortedValues[idx]!;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface MetricRepository {
  record(sample: Omit<MetricSample, 'id'>): void;
  recordMany(samples: Omit<MetricSample, 'id'>[]): void;
  timeseries(query: {
    metric: string;
    scope: MetricScopeInput;
    scopeId?: string | null;
    since: string;
    granularity: 'minute' | 'hour' | 'day';
    aggregation?: 'sum' | 'avg' | 'max' | 'last';
  }): MetricTimeseries;
  distinctMetrics(): { metric: string; scope: string; unit: string }[];
  purgeBefore(cutoff: string): number;
}

type MetricScopeInput = MetricSample['scope'];

export function createMetricRepository(db: Database): MetricRepository {
  const insert = (sample: Omit<MetricSample, 'id'>) => {
    db.run('INSERT INTO metrics (id, scope, scope_id, metric, value, unit, at, bucket) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      crypto.randomUUID(),
      sample.scope,
      sample.scopeId,
      sample.metric,
      sample.value,
      sample.unit,
      sample.at,
      sample.bucket,
    ]);
  };

  return {
    record: insert,
    recordMany(samples) {
      db.transaction(() => {
        for (const sample of samples) insert(sample);
      });
    },
    timeseries({ metric, scope, scopeId, since, granularity, aggregation = 'sum' }) {
      const grain = grainToSql(granularity, 'at');
      const agg = aggregation === 'avg' ? 'AVG' : aggregation === 'max' ? 'MAX' : 'SUM';
      const params: unknown[] = [metric, scope];
      let sql = `SELECT ${grain} AS bucket, ${agg}(value) AS value FROM metrics WHERE metric = ? AND scope = ? AND at >= ?`;
      params.push(since);
      if (scopeId) {
        sql += ' AND scope_id = ?';
        params.push(scopeId);
      }
      sql += ' GROUP BY bucket ORDER BY bucket';
      const rows = db.all<Row>(sql, params);
      const unitRow = db.get<Row>('SELECT unit FROM metrics WHERE metric = ? LIMIT 1', [metric]);
      const points = rows.map((r) => ({ bucket: String(r.bucket), value: Number(r.value ?? 0) }));
      return {
        metric,
        scope,
        scopeId: scopeId ?? null,
        unit: String(unitRow?.unit ?? ''),
        points,
        total: points.reduce((a, p) => a + p.value, 0),
        average: points.length ? points.reduce((a, p) => a + p.value, 0) / points.length : null,
      };
    },
    distinctMetrics() {
      return db
        .all<Row>('SELECT DISTINCT metric, scope, unit FROM metrics ORDER BY metric')
        .map((r) => ({ metric: String(r.metric), scope: String(r.scope), unit: String(r.unit) }));
    },
    purgeBefore(cutoff) {
      return db.run('DELETE FROM metrics WHERE at < ?', [cutoff]).changes;
    },
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface EventRepository {
  insert(event: OrchestratorEvent): void;
  query(query: EventQuery): OrchestratorEvent[];
  purgeBefore(cutoff: string): number;
  countsByType(since: string): { type: string; count: number }[];
}

export function createEventRepository(db: Database): EventRepository {
  const map = (row: Row): OrchestratorEvent => ({
    id: String(row.id),
    type: String(row.type) as OrchestratorEvent['type'],
    severity: String(row.severity) as OrchestratorEvent['severity'],
    projectId: row.project_id === null ? null : String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    traceId: row.trace_id === null ? null : String(row.trace_id),
    message: String(row.message),
    payload: parseJson(row.payload, {}),
    at: String(row.at),
  });

  return {
    insert(event) {
      db.run(
        `INSERT INTO events (id, type, severity, project_id, task_id, agent_id, trace_id, message, payload, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        [
          event.id,
          event.type,
          event.severity,
          event.projectId,
          event.taskId,
          event.agentId,
          event.traceId,
          event.message,
          JSON.stringify(event.payload),
          event.at,
        ],
      );
    },
    query(query) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.projectId) {
        where.push('project_id = ?');
        params.push(query.projectId);
      }
      if (query.taskId) {
        where.push('task_id = ?');
        params.push(query.taskId);
      }
      if (query.agentId) {
        where.push('agent_id = ?');
        params.push(query.agentId);
      }
      if (query.types?.length) {
        const clause = inClause(query.types, 'type');
        where.push(`type IN (${clause.sql})`);
        params.push(...clause.params);
      }
      if (query.severity?.length) {
        const clause = inClause(query.severity, 'severity');
        where.push(`severity IN (${clause.sql})`);
        params.push(...clause.params);
      }
      if (query.since) {
        where.push('at >= ?');
        params.push(query.since);
      }
      const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`;
      params.push(query.limit ?? 200);
      return db.all<Row>(sql, params).map(map);
    },
    purgeBefore(cutoff) {
      return db.run('DELETE FROM events WHERE at < ?', [cutoff]).changes;
    },
    countsByType(since) {
      return db
        .all<Row>('SELECT type, COUNT(*) AS c FROM events WHERE at >= ? GROUP BY type ORDER BY c DESC', [since])
        .map((r) => ({ type: String(r.type), count: Number(r.c ?? 0) }));
    },
  };
}

export { nowIso };
