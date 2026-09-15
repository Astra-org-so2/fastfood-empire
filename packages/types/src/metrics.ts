/** Observability: traces, metrics samples, system metrics (§21, §32). */
import type { ErrorCategory, RateLimitTelemetry, TokenUsage } from './chat.js';

export type TraceStatus = 'success' | 'error' | 'timeout' | 'cancelled' | 'rejected_by_quota';

export interface LLMTrace {
  traceId: string;
  projectId: string | null;
  taskId: string | null;
  agentId: string | null;
  providerId: string;
  modelId: string;
  taskType: string | null;
  startedAt: string;
  finishedAt: string | null;
  latencyMs: number | null;
  firstTokenLatencyMs: number | null;
  usage: TokenUsage | null;
  status: TraceStatus;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  attempt: number;
  /** How many providers were tried before this one succeeded. */
  failoverDepth: number;
  quotaBefore: { requestsRemaining: number | null; tokensRemaining: number | null } | null;
  quotaAfter: { requestsRemaining: number | null; tokensRemaining: number | null } | null;
  telemetry: RateLimitTelemetry | null;
  /** Why the router picked this model (structured reasons). */
  routingRationale: RoutingRationale | null;
  streamed: boolean;
  costEstimateUsd: number | null;
}

export interface RoutingRationale {
  selectedModelId: string;
  policyId: string | null;
  totalScore: number;
  components: { name: string; weight: number; raw: number; contribution: number; note?: string }[];
  positives: string[];
  negatives: string[];
  rejected: { modelId: string; reasons: string[] }[];
  considered: number;
  freeOnlyApplied: boolean;
}

export type MetricScope =
  | 'provider'
  | 'model'
  | 'agent'
  | 'project'
  | 'task'
  | 'system'
  | 'router';

export interface MetricSample {
  id: string;
  scope: MetricScope;
  scopeId: string;
  metric: string;
  value: number;
  unit: string;
  at: string;
  /** Bucket start for aggregation, ISO. */
  bucket: string;
}

export interface SystemMetrics {
  cpuPercent: number | null;
  cpuCount: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryPercent: number;
  loadAverage: number[];
  uptimeSeconds: number;
  disk: { path: string; totalBytes: number | null; freeBytes: number | null; usedPercent: number | null } | null;
  processMemoryBytes: number;
  platform: string;
  nodeVersion: string;
}

export interface MetricTimeseriesPoint {
  bucket: string;
  value: number;
}

export interface MetricTimeseries {
  metric: string;
  scope: MetricScope;
  scopeId: string | null;
  unit: string;
  points: MetricTimeseriesPoint[];
  total: number;
  average: number | null;
}

export interface ProviderStats {
  providerId: string;
  requests: number;
  successes: number;
  failures: number;
  successRate: number | null;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  tokensIn: number;
  tokensOut: number;
  quotaRejections: number;
  failovers: number;
}

export interface AgentStats {
  agentId: string;
  tasksCompleted: number;
  tasksFailed: number;
  avgDurationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  retries: number;
  /** Tokens spent per completed task — context efficiency proxy. */
  tokenEfficiency: number | null;
}
