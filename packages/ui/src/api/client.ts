import type {
  AgentId,
  AppSettings,
  ApprovalRequest,
  LLMTrace,
  MetricTimeseriesPoint,
  ModelInfo,
  OrchestratorEvent,
  Project,
  QuotaBucket,
  QuotaReservation,
  QuotaSnapshot,
  QuotaType,
  ResetStrategy,
  RoutingRationale,
  Task,
  TaskType,
} from '@aido/types';
// Type-only import: the UI must render exactly what the registry reports, without
// re-declaring the provider shape (which would drift).
import type { ProviderSummary } from '@aido/providers';

/**
 * The HTTP contract, typed once for both shells (§54).
 *
 * The web build and the desktop build call the same functions against the same
 * endpoints; the only difference is the base URL (the dev server proxies to the API,
 * the desktop app talks to its in-process server).
 *
 * Every method returns the API's shape unaltered — no client-side invention. Where the
 * API can answer "unknown", the type says so, and the UI is responsible for rendering
 * that honestly.
 */

export interface ApiErrorBody {
  error: string;
  details?: unknown;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.details = details;
  }
}

export interface ApiClientOptions {
  /** Base URL; empty string means "same origin" (dev proxy and desktop shell). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called on every 401 so the shell can show a connection problem. */
  onUnauthorized?: () => void;
}

export interface ApiClient {
  readonly baseUrl: string;
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined | null>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
  /** Raw event stream URL, for `EventSource`. */
  streamUrl(): string;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const request = async <T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined | null>): Promise<T> => {
    const url = new URL(`${baseUrl}${path}`, baseUrl ? undefined : globalThis.location?.origin ?? 'http://127.0.0.1');
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    const response = await doFetch(url.toString(), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401) options.onUnauthorized?.();

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const errorBody = (parsed ?? {}) as ApiErrorBody;
      throw new ApiRequestError(response.status, errorBody.error ?? `HTTP ${response.status} ${response.statusText}`, errorBody.details ?? parsed);
    }
    return parsed as T;
  };

  return {
    baseUrl,
    get: (path, query) => request('GET', path, undefined, query),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
    streamUrl: () => `${baseUrl}/api/events/stream`,
  };
}

/* ----------------------------------------------------------------- responses */

export interface DashboardResponse {
  projects: {
    id: string;
    name: string;
    status: string;
    runState?: string;
    taskCounts?: Partial<Record<Task['status'], number>>;
    updatedAt?: string;
    [key: string]: unknown;
  }[];
  runs: { active: number; projectIds: string[] };
  usage: { since: string; requests: number; tokensIn: number; tokensOut: number; avgLatencyMs: number; successRate: number; failovers: number };
  providers: ProviderSummary[];
  freeOnlyMode: boolean;
  approvals: ApprovalRequest[];
  reservations: { open: number; expired: number };
  recentEvents: OrchestratorEvent[];
  /**
   * Conditions the operator should know about: missing credentials, an exhausted free
   * tier, a provider that keeps failing. Objects rather than sentences so the UI can link
   * to the provider that raised them.
   */
  warnings: { providerId: string | null; level: 'warning' | 'error'; message: string }[];
}

export interface HealthResponse {
  ok: boolean;
  uptimeSeconds: number;
  database: { path: string; bytes: number; migrations: { version: number; applied: string[]; pending: string[] } };
  degraded: { component: string; detail: string }[];
  shell: { kind: string; platform: string; isDesktop: boolean };
  version: string;
}

export interface SystemMetricsResponse {
  cpuPercent: number | null;
  cpuCount: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryPercent: number;
  loadAverage: number[];
  uptimeSeconds: number;
  disk: { path: string; totalBytes: number; freeBytes: number; usedPercent: number };
  processMemoryBytes: number;
  platform: string;
  nodeVersion: string;
}

export interface QuotasResponse {
  snapshots: QuotaSnapshot[];
  capacity: {
    freeOnlyMode: boolean;
    totalRemainingTokens: number;
    totalRemainingRequests: number;
    activeProviders: number;
    totalProviders: number;
    providers: { providerId: string; remainingRequests: number | null; remainingTokens: number | null; note?: string }[];
    excluded: { providerId: string; reason: string }[];
    /** Human-readable explanation of what the estimate is based on. */
    basis: string[];
  };
  freeOnlyMode: boolean;
  reserveFraction: number;
  excludeTrialCredits: boolean;
}

export interface QuotaObservation {
  scopeModel: string | null;
  observedAt: string;
  requestsRemaining: number | null;
  tokensRemaining: number | null;
  source: string;
}

/** `/api/quotas/:providerId` — everything known about one provider's free allowance. */
export interface QuotaDetailResponse {
  provider: ProviderSummary;
  /** The limits in force, after overrides and anything learned from the provider. */
  providerLimits: {
    requestsPerMinute: number | null;
    requestsPerDay: number | null;
    tokensPerMinute: number | null;
    tokensPerDay: number | null;
    resetStrategy: ResetStrategy;
    resetTimezone: string | null;
    provenance: { source: string; confidence: number; note?: string | null };
  };
  reset: {
    strategy: ResetStrategy;
    timezone: string | null;
    windows: {
      modelId: string | null;
      requestsPerMinute: number | null;
      requestsPerDay: number | null;
      tokensPerMinute: number | null;
      tokensPerDay: number | null;
      resetStrategy: ResetStrategy;
      resetsAt: string | null;
    }[];
  };
  buckets: QuotaBucket[];
  /** Null when nothing has ever been observed for this provider. */
  observations: QuotaObservation[] | null;
  reservations: QuotaReservation[];
}

export interface RouterPolicyResponse {
  settings: {
    weights: Record<string, number>;
    freeOnlyMode: boolean;
    allowTrialCredits: boolean;
    spreadAcrossProviders: boolean;
    quotaReserveFloor: number;
    blockUnknownPricing: boolean;
    learningEnabled: boolean;
    policies: { taskType: TaskType; [key: string]: unknown }[];
  };
  policies: {
    taskType: TaskType;
    preferredCapabilities?: string[];
    priority?: string;
    qualityFloor?: number;
    maxCostPerRequest?: number | null;
    notes?: string;
    [key: string]: unknown;
  }[];
  taskTypes: TaskType[];
  defaults: RouterPolicyResponse['policies'];
}

/** `/api/router/preview` — the scoring of every candidate for a hypothetical task. */
export interface RouterPreviewResponse {
  chain: {
    model: ModelInfo;
    modelId: string;
    providerId: string;
    total: number;
    components: { name: string; raw: number; weight: number; contribution: number; note: string }[];
    positives: string[];
    negatives: string[];
  }[];
  selected: { model: ModelInfo; rationale: RoutingRationale } | null;
  rationale: RoutingRationale | null;
  policy: { taskType: TaskType; agentId: AgentId | null; requiredCapabilities: string[] } | null;
}

/** The persisted per-project state of one agent role. */
export interface AgentStateRecord {
  projectId: string;
  agentId: AgentId;
  state: string;
  paused: boolean;
  currentTaskId?: string | null;
  currentModelId?: string | null;
  currentProviderId?: string | null;
  iterations?: number;
  tasksCompleted?: number;
  tasksFailed?: number;
  lastActionAt?: string | null;
  lastError?: string | null;
  [key: string]: unknown;
}

export interface AgentSummary {
  id: AgentId;
  name: string;
  tagline?: string;
  responsibility?: string;
  accent?: string;
  tools?: string[];
  handledTaskTypes?: TaskType[];
  state: { agentId: AgentId; state: string; paused?: boolean; currentTaskId?: string | null; lastActiveAt?: string | null; [key: string]: unknown } | null;
  stats?: { tasksCompleted: number; tasksFailed: number; avgDurationMs: number; tokensIn: number; tokensOut: number; retries: number } | null;
  limits?: Record<string, number>;
  [key: string]: unknown;
}

export interface AgentDetailResponse {
  role: {
    id: AgentId;
    name: string;
    tagline: string;
    responsibility: string;
    responsibilities: string[];
    handledTaskTypes: TaskType[];
    modelPreference: {
      requiredCapabilities: string[];
      preferCapabilities: string[];
      minContextWindow: number;
      qualityRequirement: string;
      maxLatencyMs: number | null;
      allowTrialCredits: boolean;
    };
    tools: string[];
    outputSchema: string;
    limits: Record<string, number>;
    accent: string;
    /** The agent's instructions. Shown in the UI; this is not private reasoning. */
    systemPrompt: string;
  };
  state: AgentSummary['state'];
  stats: { agentId: string; tasksCompleted: number; tasksFailed: number; avgDurationMs: number; tokensIn: number; tokensOut: number; retries: number; tokenEfficiency: number | null };
  tasks: Task[];
  recentTraces: LLMTrace[];
  busyMs: number | null;
}

export interface ActivityResponse {
  events: OrchestratorEvent[];
  counts: { period: string; [key: string]: unknown }[];
}

export interface PerformanceResponse {
  since: string;
  totals: { requests: number; tokensIn: number; tokensOut: number; avgLatencyMs: number; successRate: number; failovers: number };
  providers: { providerId: string; requests: number; successRate: number; avgLatencyMs: number; tokensIn: number; tokensOut: number; failovers: number }[];
  models: { modelId: string; requests: number; successRate: number; avgLatencyMs: number; tokensIn: number; tokensOut: number }[];
  agents: { agentId: AgentId; requests: number; tasksCompleted: number; tokensIn: number; tokensOut: number; successRate: number }[];
  latency: MetricSeries;
  throughput: MetricSeries;
  tokens: MetricSeries;
  cost: MetricSeries;
  failures: { category: string; count: number }[];
  systemMetrics: MetricSeries;
}

export interface MetricSeries {
  metric: string;
  scope: string;
  scopeId: string | null;
  unit: string;
  points: MetricTimeseriesPoint[];
  total: number;
  average: number | null;
}

export interface ProjectSummary extends Project {
  counts?: Partial<Record<Task['status'], number>>;
  run?: { running: boolean; paused: boolean; cancelled: boolean; ticks: number; startedAt?: string; lastTickAt?: string; lastError?: string | null };
  /**
   * The project list is served by the same repository as the detail endpoint. Fields
   * that the API does not provide are optional here rather than invented.
   */
  agentCounts?: { agentId: AgentId; total: number }[];
}

export interface ProjectDetailResponse {
  project: Project;
  counts: { done: number } & Partial<Record<Task['status'], number>>;
  agentCounts: { agentId: AgentId; total: number }[];
  run: {
    projectId: string;
    running: boolean;
    paused: boolean;
    cancelled: boolean;
    ticks: number;
    startedAt?: string;
    lastTickAt?: string;
    lastError?: string | null;
    lastResult?: { complete: boolean; failed: boolean; notes: string[]; supervision?: { issues: { kind: string; detail: string }[] } };
  };
  memory: { kind: string; title: string; body: string; updatedAt: string; trust: string; supersededBy: string | null }[];
  quota: QuotasResponse['capacity'];
  agents: { agentId: AgentId; state: string }[];
  pendingApprovals: number;
  git: string | null;
}

export interface TaskGraphResponse {
  nodes: { id: string; title: string; agentId: AgentId; status: Task['status']; taskType: TaskType; depth: number; dependsOn: string[] }[];
  edges: { from: string; to: string }[];
  columns?: { status: string; taskIds: string[] }[];
  cycles: string[][];
}

export interface FilesResponse {
  path: string;
  entries: { name: string; path: string; type: 'file' | 'directory'; size?: number; modifiedAt?: string }[];
  truncated?: boolean;
}

/**
 * A message in a project's agent conversation log.
 *
 * This is the transcript an agent actually sent or received — the prompt it was given and
 * the answer it produced — not a summary. `trust` records whether the content came from the
 * system, from an agent, or from untrusted input such as a fetched page.
 */
export interface AgentMessageRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: AgentId | null;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  trust: string;
  tokens: number | null;
  modelId: string | null;
  providerId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

export interface GitBranchSummary {
  name: string;
  sha: string;
  current: boolean;
  lastCommitAt: string | null;
}

/** `/api/projects/:id/git/status` — the working tree plus the branch list. */
export interface GitStatusResponse {
  isRepository: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  entries: { path: string; code: string; staged: boolean; unstaged: boolean; untracked: boolean; conflicted: boolean }[];
  conflictedPaths: string[];
  operationInProgress: string | null;
  headSha: string | null;
  branches: GitBranchSummary[];
}

export interface GitCommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  refs: string;
}

export interface GitLogResponse {
  commits: GitCommitSummary[];
  /** Commits this installation recorded against the agent that made them. */
  recorded: { sha: string; agentId: string | null; message: string; createdAt?: string }[];
  byAgent: { agentId: string | null; commits: number }[];
}

export interface TestsResponse {
  runs: { id: string; status: string; startedAt: string; finishedAt?: string; command?: string; passed?: number; failed?: number; durationMs?: number; agentId?: AgentId | null }[];
  latest: TestsResponse['runs'][number] | null;
  summary: { runs: number; passed: number; failed: number; lastStatus: string | null };
  cases: { name: string; status: string; durationMs?: number; message?: string }[];
}

export interface MemoryResponse {
  stats: { kind: string; count: number; latest?: string }[];
  entries: { id: string; kind: string; key: string; title: string; body: string; trust: string; importance: number; updatedAt: string; supersededBy: string | null; sourceAgentId?: AgentId | null }[];
  specification: MemoryResponse['entries'][number] | null;
  architecture: MemoryResponse['entries'][number] | null;
  codeState: MemoryResponse['entries'][number] | null;
  testState: MemoryResponse['entries'][number] | null;
  issues: MemoryResponse['entries'][number][];
}

export interface SupervisionResponse {
  projectId: string;
  inspectedAt: string;
  issues: { kind: string; severity: string; detail: string; taskId?: string }[];
  interventions: { kind: string; detail: string; at: string }[];
  stats: { tasksInspected: number; stuck: number; retries: number; [key: string]: unknown };
  circuitBreakers?: { agentId: AgentId; open: boolean; failures: number }[];
}

/** The maintenance actions `/api/system/action` accepts, and what each one does. */
export type SystemAction =
  | 'run.maintenance'
  | 'providers.reload'
  | 'providers.health_check_all'
  | 'events.purge'
  | 'traces.purge'
  | 'quota.release_expired'
  | 'models.refresh_priorities';

export interface SystemActionResponse {
  ok: boolean;
  /** Present on some actions; the wording differs per action, which is why it is optional. */
  detail?: string;
  deleted?: number;
  released?: number;
  models?: number;
  providers?: { providerId: string; status: string }[];
}

export interface TraceExplanation {
  selected: string;
  summary: string;
  factors: { label: string; detail: string; contribution: number }[];
  rejected: { modelId: string; reason: string }[];
}

export interface PlatformResponse {
  info: { platform: string; arch: string; shell: string; hostname: string; isElectron: boolean; hasWindow: boolean; isDesktop?: boolean };
  /** Normalised shell identity, identical in shape to `/api/settings` `capabilities.shell`. */
  shell: { kind: string; platform: string; isDesktop: boolean };
  app: { name: string; version: string; channel: string };
  paths: { dataDir: string; workspaceRoot: string; logDir: string; cacheDir: string; installDir: string; databaseFile: string };
  secrets: {
    shellStore: { kind: 'os-keyring' | 'encrypted-file' | 'in-memory'; persistent: boolean; osBacked: boolean; detail: string };
    credentialVault: { source: 'env' | 'file'; keyFile: string | null };
  };
  notifications: { supported: boolean };
  updates: { feedUrl: string | null; currentVersion: string };
}

export interface UpdateInfo {
  status: 'up-to-date' | 'update-available' | 'unsupported' | 'check-failed';
  currentVersion: string;
  latest?: { version: string; notes: string; artifacts: Record<string, string>; publishedAt: string };
  instructions: string;
  error?: string;
}

export interface ProviderDetail extends ProviderSummary {
  definition?: Record<string, unknown>;
  credentials?: { key: string; fingerprint: string; createdAt?: string; lastUsedAt?: string }[];
  models?: ModelInfo[];
  /** The most recent observation per scope, if anything has ever been observed. */
  observations?: QuotaObservation[] | null;
  buckets?: QuotaDetailResponse['buckets'];
}

export interface SettingsResponse {
  settings: AppSettings;
  defaults: AppSettings;
  capabilities: {
    shell: { kind: string; platform: string; isDesktop: boolean };
    secretSource: 'env' | 'file';
    maxParallelAgents: number;
    adapterKinds: string[];
  };
  counts: { projects: number; providers: number; models: number; agents: number; openReservations: number; databaseBytes: number };
}

export interface EventsEnvelope {
  events: OrchestratorEvent[];
}

/**
 * The API surface as a flat set of functions. Keeping it one object makes it trivial to
 * mock in tests and to point at a different base URL from the desktop shell.
 */
export function createApi(client: ApiClient) {
  return {
    // ---------------------------------------------------------------- system
    dashboard: () => client.get<DashboardResponse>('/api/dashboard'),
    health: () => client.get<HealthResponse>('/api/health'),
    metrics: () => client.get<SystemMetricsResponse>('/api/system/metrics'),
    systemAction: (action: SystemAction, params?: Record<string, unknown>) => client.post<SystemActionResponse>('/api/system/action', { action, ...params }),
    explanation: (traceId: string) => client.get<TraceExplanation>(`/api/system/explanations/${traceId}`),
    platform: () => client.get<PlatformResponse>('/api/platform'),
    updateCheck: () => client.get<UpdateInfo>('/api/platform/updates'),
    notificationTest: () => client.post<{ delivered: boolean; reason?: string }>('/api/platform/notifications/test'),
    openExternal: (url: string) => client.post<{ opened: boolean }>('/api/platform/open-external', { url }),
    reveal: (projectId: string, relativePath = '.') => client.post<{ revealed: boolean; path: string }>('/api/platform/reveal', { projectId, relativePath }),
    openTerminal: (projectId: string) => client.post<{ opened: boolean; reason?: string }>('/api/platform/open-terminal', { projectId }),

    // ---------------------------------------------------------------- settings
    settings: () => client.get<SettingsResponse>('/api/settings'),
    updateSettings: (patch: Partial<AppSettings>) => client.patch<{ settings: AppSettings }>('/api/settings', patch),

    // ---------------------------------------------------------------- providers
    providers: () => client.get<{ providers: ProviderSummary[] }>('/api/providers'),
    provider: (providerId: string) => client.get<ProviderDetail>(`/api/providers/${providerId}`),
    providerCatalog: () => client.get<{ definitions: unknown[]; issues: { id: string; reason: string }[] }>('/api/providers/catalog'),
    setCredentials: (providerId: string, fields: Record<string, string>, label?: string) =>
      client.post<{ ok: boolean; detail: string }>(`/api/providers/${providerId}/credentials`, { fields, ...(label ? { label } : {}) }),
    deleteCredential: (providerId: string, field: string) => client.del<{ ok: boolean; detail: string }>(`/api/providers/${providerId}/credentials/${field}`),
    testProvider: (providerId: string) => client.post<{ ok: boolean; detail: string; latencyMs?: number | null }>(`/api/providers/${providerId}/test`),
    discoverModels: (providerId: string) => client.post<{ added: number; updated: number; error?: string; models?: ModelInfo[] }>(`/api/providers/${providerId}/discover`),
    providerHealth: (providerId: string) => client.post<{ status: string; latencyMs: number | null; message: string | null }>(`/api/providers/${providerId}/health`),
    patchProvider: (providerId: string, patch: Record<string, unknown>) => client.patch<{ ok: boolean }>(`/api/providers/${providerId}`, patch),
    reloadCatalog: () => client.post<{ count: number; issues: string[] }>('/api/providers/reload-catalog'),

    // ---------------------------------------------------------------- models
    models: (query?: { providerId?: string; taskType?: TaskType; freeOnly?: boolean; enabled?: boolean; search?: string; limit?: number }) =>
      client.get<ModelInfo[]>('/api/models', query as Record<string, string | boolean | number | undefined>),
    modelCapabilities: (modelId: string) => client.get<{ model: ModelInfo; compatibility: { taskType: TaskType; score: number; source: string }[] }>(`/api/models/${encodeURIComponent(modelId)}/capabilities`),
    patchModel: (modelId: string, patch: { enabled?: boolean; quality?: number; notes?: string; costOverride?: unknown }) =>
      client.patch<{ model: ModelInfo }>(`/api/models/${encodeURIComponent(modelId)}`, patch),
    discoverAllModels: () => client.post<{ providers: { providerId: string; added: number; updated: number; error?: string }[] }>('/api/models/discover-all'),

    // ---------------------------------------------------------------- quotas
    quotas: () => client.get<QuotasResponse>('/api/quotas'),
    quota: (providerId: string) => client.get<QuotaDetailResponse>(`/api/quotas/${providerId}`),
    setQuotaLimits: (providerId: string, limits: Record<string, unknown>) => client.post<{ ok: boolean; detail: string }>(`/api/quotas/${providerId}/limits`, limits),
    refreshQuota: (providerId: string) => client.post<{ ok: boolean; detail: string }>(`/api/quotas/${providerId}/refresh`),

    // ---------------------------------------------------------------- router
    routerPolicy: () => client.get<RouterPolicyResponse>('/api/router/policy'),
    updateRouterPolicy: (patch: Record<string, unknown>) => client.put<RouterPolicyResponse>('/api/router/policy', patch),
    routerPreview: (body: { taskType: TaskType; agentId?: AgentId; estimatedTokens?: number; requiredCapabilities?: string[] }) =>
      client.post<RouterPreviewResponse>('/api/router/preview', body),

    // ---------------------------------------------------------------- agents
    agents: (projectId?: string) => client.get<AgentSummary[]>('/api/agents', projectId ? { projectId } : undefined),
    agent: (agentId: AgentId, projectId?: string) =>
      client.get<AgentDetailResponse>(`/api/agents/${agentId}`, projectId ? { projectId } : undefined),
    /// Agent state is per project, so pausing needs the project it applies to.
    pauseAgent: (agentId: AgentId, projectId: string, reason?: string) =>
      client.post<AgentStateRecord | null>(`/api/agents/${agentId}/pause`, { projectId, ...(reason ? { reason } : {}) }),
    resumeAgent: (agentId: AgentId, projectId: string) => client.post<AgentStateRecord | null>(`/api/agents/${agentId}/resume`, { projectId }),

    // ---------------------------------------------------------------- activity
    activity: (query?: { limit?: number; type?: string; agentId?: string; projectId?: string; severity?: string }) => client.get<ActivityResponse>('/api/activity', query as Record<string, string | number | undefined>),
    performance: (query?: { days?: number }) => client.get<PerformanceResponse>('/api/performance', query as Record<string, number | undefined>),
    traces: (query?: { limit?: number; projectId?: string; taskId?: string; agentId?: string; providerId?: string; modelId?: string; status?: string }) =>
      client.get<LLMTrace[]>('/api/traces', query as Record<string, string | number | undefined>),
    trace: (traceId: string) => client.get<{ trace: LLMTrace; explanation: TraceExplanation }>(`/api/traces/${traceId}`),
    approvals: (query?: { projectId?: string }) => client.get<ApprovalRequest[]>('/api/approvals', query as Record<string, string | undefined>),
    decideApproval: (approvalId: string, body: { approved: boolean; note?: string; scope?: 'once' | 'task' }) =>
      client.post<ApprovalRequest>(`/api/approvals/${approvalId}/decide`, body),

    // ---------------------------------------------------------------- projects
    projects: () => client.get<ProjectSummary[]>('/api/projects'),
    project: (projectId: string) => client.get<ProjectDetailResponse>(`/api/projects/${projectId}`),
    createProject: (body: { name: string; description?: string; spec?: Record<string, unknown>; sourceRepo?: string; workspacePath?: string }) => client.post<Project>('/api/projects', body),
    patchProject: (projectId: string, patch: Record<string, unknown>) => client.patch<{ project: Project }>(`/api/projects/${projectId}`, patch),
    deleteProject: (projectId: string) => client.del<{ ok: boolean }>(`/api/projects/${projectId}`),
    planProject: (projectId: string) => client.post<{ tasks: Task[] }>(`/api/projects/${projectId}/plan`),
    runProject: (projectId: string, body?: { plan?: boolean; maxParallelAgents?: number }) => client.post<{ running: boolean }>(`/api/projects/${projectId}/run`, body ?? {}),
    pauseProject: (projectId: string) => client.post<{ paused: boolean }>(`/api/projects/${projectId}/pause`),
    resumeProject: (projectId: string) => client.post<{ running: boolean }>(`/api/projects/${projectId}/resume`),
    stopProject: (projectId: string) => client.post<{ cancelled: boolean }>(`/api/projects/${projectId}/stop`),
    tasks: (projectId: string) => client.get<Task[]>(`/api/projects/${projectId}/tasks`),
    task: (taskId: string) => client.get<Task>(`/api/tasks/${taskId}`),
    graph: (projectId: string) => client.get<TaskGraphResponse>(`/api/projects/${projectId}/graph`),
    supervision: (projectId: string) => client.get<SupervisionResponse>(`/api/projects/${projectId}/supervision`),
    files: (projectId: string, relativePath = '.') => client.get<FilesResponse>(`/api/projects/${projectId}/files`, { path: relativePath }),
    file: (projectId: string, relativePath: string) => client.get<{ path: string; content: string; bytes: number; truncated: boolean; binary?: boolean }>(`/api/projects/${projectId}/file`, { path: relativePath }),
    gitStatus: (projectId: string) => client.get<GitStatusResponse>(`/api/projects/${projectId}/git/status`),
    gitLog: (projectId: string, limit = 50) => client.get<GitLogResponse>(`/api/projects/${projectId}/git/log`, { limit }),
    gitDiff: (projectId: string, query?: { from?: string; to?: string; path?: string; staged?: boolean }) =>
      client.get<{ diff: string; stats?: { filesChanged: number; insertions: number; deletions: number } }>(`/api/projects/${projectId}/git/diff`, query as Record<string, string | boolean | undefined>),
    gitCreateBranch: (projectId: string, name: string, checkout = true) => client.post<{ ok: boolean; branch: string }>(`/api/projects/${projectId}/git/branch`, { name, checkout }),
    gitCommit: (projectId: string, body: { message: string; files?: string[]; agentId?: AgentId }) => client.post<{ sha: string }>(`/api/projects/${projectId}/git/commit`, body),
    gitMerge: (projectId: string, body: { from: string; into?: string }) => client.post<{ ok: boolean; conflicts?: string[]; sha?: string }>(`/api/projects/${projectId}/git/merge`, body),
    tests: (projectId: string) => client.get<TestsResponse>(`/api/projects/${projectId}/tests`),
    runTests: (projectId: string, body?: { command?: string }) => client.post<{ ok: boolean; status: string; runId?: string; detail?: string }>(`/api/projects/${projectId}/tests/run`, body ?? {}),
    memory: (projectId: string) => client.get<MemoryResponse>(`/api/projects/${projectId}/memory`),
    messages: (projectId: string, limit = 100) => client.get<AgentMessageRecord[]>(`/api/projects/${projectId}/messages`, { limit }),
    executions: (projectId: string, limit = 100) =>
      client.get<{ id: string; taskId: string; agentId: AgentId; status: string; startedAt: string; finishedAt?: string | null; iterations: number; toolCalls: number; tokensIn?: number; tokensOut?: number }[]>(
        `/api/projects/${projectId}/executions`,
        { limit },
      ),
  };
}

export type AidoApi = ReturnType<typeof createApi>;
