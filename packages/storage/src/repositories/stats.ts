import type { TaskType } from '@aido/types';
import type { Database, Row } from '../db.js';
import { nowIso, toNumber } from './helpers.js';

/**
 * Learned model/task statistics (§11, §40). The router blends this evidence with
 * configured priors, so a 3-failure streak on one model removes it from rotation
 * for that task type without any human intervention.
 */
export interface ModelTaskStat {
  providerId: string;
  modelId: string;
  taskType: TaskType;
  attempts: number;
  successes: number;
  failures: number;
  consecutiveFailures: number;
  avgLatencyMs: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  qualityScore: number | null;
  updatedAt: string;
}

export interface ModelTaskStatsRepository {
  record(params: {
    providerId: string;
    modelId: string;
    taskType: TaskType;
    outcome: 'success' | 'failure';
    latencyMs?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    quality?: number | null;
  }): void;
  get(providerId: string, modelId: string, taskType: TaskType): ModelTaskStat | null;
  listForModel(modelId: string): ModelTaskStat[];
  list(taskType?: TaskType): ModelTaskStat[];
  /** Success-rate-weighted strengths per model, for the model catalogue UI. */
  strengthsByModel(minAttempts: number): Map<string, { taskType: TaskType; successRate: number; attempts: number }[]>;
}

export function createModelTaskStatsRepository(db: Database): ModelTaskStatsRepository {
  const map = (row: Row): ModelTaskStat => ({
    providerId: String(row.provider_id),
    modelId: String(row.model_id),
    taskType: String(row.task_type) as TaskType,
    attempts: Number(row.attempts ?? 0),
    successes: Number(row.successes ?? 0),
    failures: Number(row.failures ?? 0),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    avgLatencyMs: toNumber(row.avg_latency_ms),
    avgInputTokens: toNumber(row.avg_input_tokens),
    avgOutputTokens: toNumber(row.avg_output_tokens),
    qualityScore: toNumber(row.quality_score),
    updatedAt: String(row.updated_at),
  });

  const alpha = 0.25; // EWMA weight for latency/token averages

  return {
    record({ providerId, modelId, taskType, outcome, latencyMs, inputTokens, outputTokens, quality }) {
      const existing = this.get(providerId, modelId, taskType);
      const attempts = (existing?.attempts ?? 0) + 1;
      const successes = (existing?.successes ?? 0) + (outcome === 'success' ? 1 : 0);
      const failures = (existing?.failures ?? 0) + (outcome === 'failure' ? 1 : 0);
      const consecutiveFailures = outcome === 'success' ? 0 : (existing?.consecutiveFailures ?? 0) + 1;
      const ewm = (prev: number | null | undefined, sample: number | null | undefined) => {
        if (sample === null || sample === undefined || !Number.isFinite(sample)) return prev ?? null;
        if (prev === null || prev === undefined) return sample;
        return prev * (1 - alpha) + sample * alpha;
      };
      const qualityScore = quality === null || quality === undefined ? (existing?.qualityScore ?? null) : ewm(existing?.qualityScore, quality);

      db.run(
        `INSERT INTO model_task_stats (provider_id, model_id, task_type, attempts, successes, failures, consecutive_failures, avg_latency_ms, avg_input_tokens, avg_output_tokens, quality_score, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider_id, model_id, task_type) DO UPDATE SET
           attempts = excluded.attempts, successes = excluded.successes, failures = excluded.failures,
           consecutive_failures = excluded.consecutive_failures, avg_latency_ms = excluded.avg_latency_ms,
           avg_input_tokens = excluded.avg_input_tokens, avg_output_tokens = excluded.avg_output_tokens,
           quality_score = excluded.quality_score, updated_at = excluded.updated_at`,
        [
          providerId,
          modelId,
          taskType,
          attempts,
          successes,
          failures,
          consecutiveFailures,
          ewm(existing?.avgLatencyMs, latencyMs),
          ewm(existing?.avgInputTokens, inputTokens),
          ewm(existing?.avgOutputTokens, outputTokens),
          qualityScore,
          nowIso(),
        ],
      );
    },
    get(providerId, modelId, taskType) {
      const row = db.get<Row>('SELECT * FROM model_task_stats WHERE provider_id = ? AND model_id = ? AND task_type = ?', [
        providerId,
        modelId,
        taskType,
      ]);
      return row ? map(row) : null;
    },
    listForModel(modelId) {
      return db.all<Row>('SELECT * FROM model_task_stats WHERE model_id = ? ORDER BY attempts DESC', [modelId]).map(map);
    },
    list(taskType) {
      const rows = taskType
        ? db.all<Row>('SELECT * FROM model_task_stats WHERE task_type = ?', [taskType])
        : db.all<Row>('SELECT * FROM model_task_stats');
      return rows.map(map);
    },
    strengthsByModel(minAttempts) {
      const rows = db.all<Row>('SELECT * FROM model_task_stats WHERE attempts >= ? ORDER BY model_id, successes DESC', [minAttempts]).map(map);
      const result = new Map<string, { taskType: TaskType; successRate: number; attempts: number }[]>();
      for (const stat of rows) {
        const list = result.get(stat.modelId) ?? [];
        list.push({ taskType: stat.taskType, successRate: stat.attempts ? stat.successes / stat.attempts : 0, attempts: stat.attempts });
        result.set(stat.modelId, list);
      }
      return result;
    },
  };
}
