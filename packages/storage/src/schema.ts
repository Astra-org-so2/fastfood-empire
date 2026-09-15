/**
 * Schema migrations (§33).
 *
 * Rules followed here:
 *  - every migration is additive and idempotent (CREATE ... IF NOT EXISTS),
 *  - JSON columns hold evolving/nested payloads; anything the system queries or
 *    aggregates on gets a real column and, where it matters, an index,
 *  - foreign keys cascade so deleting a project removes its tasks, traces and
 *    messages rather than leaving orphan rows that skew metrics,
 *  - NULL is never used as a sentinel for "provider-wide" in unique keys
 *    (SQLite treats NULLs as distinct); an empty string is used instead.
 */

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core_schema',
    up: `
-- ---------------------------------------------------------------------------
-- Application settings (single row, key='app') and generic key/value state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Local user + sessions (single-user local app, but modelled properly so
-- multi-user/remote deployment does not need a schema rewrite)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT,
  revoked_at TEXT
);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  spec TEXT NOT NULL,
  status TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  source_repo TEXT,
  settings TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);

-- ---------------------------------------------------------------------------
-- Providers: definition mirror + runtime state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  api_base_url TEXT NOT NULL,
  quota_type TEXT NOT NULL DEFAULT 'unknown',
  reset_strategy TEXT NOT NULL DEFAULT 'unknown',
  reset_timezone TEXT,
  definition TEXT NOT NULL,
  quota_limits TEXT,
  health_status TEXT NOT NULL DEFAULT 'unconfigured',
  health_checked_at TEXT,
  health_latency_ms REAL,
  health_message TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at TEXT,
  cooldown_until TEXT,
  last_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  encrypted TEXT NOT NULL,
  display_hint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  last_validated_at TEXT,
  validation_state TEXT NOT NULL DEFAULT 'unverified',
  validation_detail TEXT,
  PRIMARY KEY (provider_id, field)
);

-- ---------------------------------------------------------------------------
-- Models: normalised catalogue with capabilities, pricing, quota and observed
-- performance. Everything the router needs is queryable without JSON parsing
-- for the common filters, JSON is used for nested detail.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  provider_model_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  context_window INTEGER,
  max_output_tokens INTEGER,
  capabilities TEXT NOT NULL,
  pricing TEXT NOT NULL,
  quota_limits TEXT NOT NULL,
  quota_type TEXT NOT NULL DEFAULT 'unknown',
  performance TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  quality_prior REAL NOT NULL DEFAULT 0.5,
  strengths TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  discovered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, provider_model_id)
);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id, enabled);
CREATE INDEX IF NOT EXISTS idx_models_quota_type ON models(quota_type);

-- ---------------------------------------------------------------------------
-- Quota engine: buckets, reservations, raw observations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quota_buckets (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  scope_model TEXT NOT NULL DEFAULT '',
  window TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  limit_tokens INTEGER,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_tokens INTEGER NOT NULL DEFAULT 0,
  limit_requests INTEGER,
  used_requests INTEGER NOT NULL DEFAULT 0,
  reserved_requests INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, scope_model, window, window_start)
);
CREATE INDEX IF NOT EXISTS idx_buckets_lookup ON quota_buckets(provider_id, scope_model, window);

CREATE TABLE IF NOT EXISTS quota_reservations (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  bucket_ids TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  settled_at TEXT,
  settled_tokens INTEGER,
  status TEXT NOT NULL DEFAULT 'reserved'
);
CREATE INDEX IF NOT EXISTS idx_reservations_open ON quota_reservations(status, expires_at);

CREATE TABLE IF NOT EXISTS quota_observations (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  scope_model TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL,
  limit_requests INTEGER,
  remaining_requests INTEGER,
  limit_tokens INTEGER,
  remaining_tokens INTEGER,
  reset_requests TEXT,
  reset_tokens TEXT,
  source TEXT NOT NULL,
  provenance TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_obs_time ON quota_observations(provider_id, observed_at);

-- ---------------------------------------------------------------------------
-- Task graph (DAG). Edges are normalised for traversal AND kept as JSON on the
-- task row so the UI can render the graph without a join storm.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  agent_role TEXT NOT NULL,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  depends_on TEXT NOT NULL DEFAULT '[]',
  resource_locks TEXT NOT NULL DEFAULT '[]',
  order_index INTEGER NOT NULL DEFAULT 0,
  estimated_input_tokens INTEGER,
  estimated_output_tokens INTEGER,
  result TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  last_model_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_role ON tasks(project_id, agent_role, status);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_task_deps_reverse ON task_dependencies(depends_on_id);

-- ---------------------------------------------------------------------------
-- Agent state, messages, executions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'idle',
  current_task_id TEXT,
  current_model_id TEXT,
  current_provider_id TEXT,
  iterations INTEGER NOT NULL DEFAULT 0,
  tokens_used_today INTEGER NOT NULL DEFAULT 0,
  requests_today INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_failed INTEGER NOT NULL DEFAULT 0,
  success_rate REAL,
  limits TEXT NOT NULL,
  last_action_at TEXT,
  last_error TEXT,
  error_streak INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, role)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  trust TEXT NOT NULL DEFAULT 'trusted',
  tokens INTEGER,
  model_id TEXT,
  provider_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(project_id, agent_id, created_at);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_role TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  model_id TEXT,
  provider_id TEXT,
  trace_ids TEXT NOT NULL DEFAULT '[]',
  token_input INTEGER NOT NULL DEFAULT 0,
  token_output INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  iterations INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_executions_task ON executions(task_id);
CREATE INDEX IF NOT EXISTS idx_executions_project ON executions(project_id, started_at);

-- ---------------------------------------------------------------------------
-- Observability: traces, metrics, events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  task_type TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  latency_ms REAL,
  first_token_latency_ms REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  tokens_estimated INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error_category TEXT,
  error_message TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  failover_depth INTEGER NOT NULL DEFAULT 0,
  quota_before TEXT,
  quota_after TEXT,
  telemetry TEXT,
  routing_rationale TEXT,
  streamed INTEGER NOT NULL DEFAULT 0,
  cost_estimate_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_traces_time ON traces(started_at);
CREATE INDEX IF NOT EXISTS idx_traces_model ON traces(provider_id, model_id, started_at);
CREATE INDEX IF NOT EXISTS idx_traces_task ON traces(task_id);
CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_id, started_at);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  at TEXT NOT NULL,
  bucket TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_series ON metrics(scope, scope_id, metric, bucket);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  agent_id TEXT,
  trace_id TEXT,
  message TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(at);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, at);

-- ---------------------------------------------------------------------------
-- Project memory (§14)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  superseded_by TEXT,
  related_files TEXT NOT NULL DEFAULT '[]',
  related_task_types TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  source_task_id TEXT,
  source_agent_id TEXT,
  trust TEXT NOT NULL DEFAULT 'derived',
  content_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_id, kind, importance);
CREATE INDEX IF NOT EXISTS idx_memory_key ON memory_entries(project_id, key);

-- ---------------------------------------------------------------------------
-- Git + tests + approvals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS git_commits (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  branch TEXT NOT NULL,
  message TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  agent_id TEXT,
  task_id TEXT,
  files_changed INTEGER NOT NULL DEFAULT 0,
  insertions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_commits_time ON git_commits(project_id, committed_at);

CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  suite TEXT NOT NULL,
  command TEXT NOT NULL,
  framework TEXT,
  status TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  output TEXT,
  coverage TEXT
);
CREATE INDEX IF NOT EXISTS idx_test_runs_project ON test_runs(project_id, started_at);

CREATE TABLE IF NOT EXISTS test_cases (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  message TEXT,
  file TEXT
);
CREATE INDEX IF NOT EXISTS idx_test_cases_run ON test_cases(run_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  agent_id TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  risk TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at);

-- ---------------------------------------------------------------------------
-- Learned routing knowledge (§11) — "which model is good at what"
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS model_task_stats (
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  avg_latency_ms REAL,
  avg_input_tokens REAL,
  avg_output_tokens REAL,
  quality_score REAL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id, task_type)
);
CREATE INDEX IF NOT EXISTS idx_model_task_stats ON model_task_stats(model_id, task_type);
`,
  },
  {
    version: 2,
    name: 'scheduler_queue',
    up: `
-- Priority queue used by the worker to claim ready tasks. Kept in the database
-- (rather than in memory) so an interrupted run resumes after a restart (§51.23).
CREATE TABLE IF NOT EXISTS scheduler_queue (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_ready ON scheduler_queue(claimed_at, available_at, priority);

-- Cooperative cancellation and pause signals observed by the scheduler loop.
CREATE TABLE IF NOT EXISTS run_signals (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  run_state TEXT NOT NULL DEFAULT 'idle',
  paused INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 3,
    name: 'indexes_for_dashboards',
    up: `
-- Dashboard queries aggregate the last N hours per provider/model; a covering
-- index keeps those cheap as the metrics table grows.
CREATE INDEX IF NOT EXISTS idx_metrics_at ON metrics(at);
CREATE INDEX IF NOT EXISTS idx_metrics_scope_metric_at ON metrics(metric, at);
CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status, started_at);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(type, at);
`,
  },
];
