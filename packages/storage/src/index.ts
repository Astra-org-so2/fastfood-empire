import { openDatabase, type Database, type DatabaseOptions } from './db.js';
import { createSettingsRepository } from './repositories/settings.js';
import { createProjectRepository } from './repositories/projects.js';
import { createProviderRepository, createCredentialStore, createModelRepository } from './repositories/providers.js';
import { createQuotaRepository } from './repositories/quota.js';
import { createTaskRepository, createSchedulerQueueRepository, createRunSignalRepository } from './repositories/tasks.js';
import { createTraceRepository, createMetricRepository, createEventRepository } from './repositories/observability.js';
import { createMemoryRepository } from './repositories/memory.js';
import { createMessageRepository, createExecutionRepository, createAgentStateRepository } from './repositories/messages.js';
import { createCommitRepository, createTestRepository } from './repositories/git.js';
import { createApprovalRepository } from './repositories/approvals.js';
import { createModelTaskStatsRepository } from './repositories/stats.js';
import { createUserRepository } from './repositories/users.js';

export * from './db.js';
export * from './schema.js';
export * from './repositories/settings.js';
export * from './repositories/projects.js';
export * from './repositories/providers.js';
export * from './repositories/quota.js';
export * from './repositories/tasks.js';
export * from './repositories/observability.js';
export * from './repositories/memory.js';
export * from './repositories/messages.js';
export * from './repositories/git.js';
export * from './repositories/approvals.js';
export * from './repositories/stats.js';
export * from './repositories/users.js';

/**
 * Aggregated store: every repository behind one object so consumers (API, worker,
 * orchestrator) receive a single dependency instead of a dozen.
 */
export interface Store {
  db: Database;
  settings: ReturnType<typeof createSettingsRepository>;
  projects: ReturnType<typeof createProjectRepository>;
  providers: ReturnType<typeof createProviderRepository>;
  credentials: ReturnType<typeof createCredentialStore>;
  models: ReturnType<typeof createModelRepository>;
  quota: ReturnType<typeof createQuotaRepository>;
  tasks: ReturnType<typeof createTaskRepository>;
  queue: ReturnType<typeof createSchedulerQueueRepository>;
  runSignals: ReturnType<typeof createRunSignalRepository>;
  traces: ReturnType<typeof createTraceRepository>;
  metrics: ReturnType<typeof createMetricRepository>;
  events: ReturnType<typeof createEventRepository>;
  memory: ReturnType<typeof createMemoryRepository>;
  messages: ReturnType<typeof createMessageRepository>;
  executions: ReturnType<typeof createExecutionRepository>;
  agents: ReturnType<typeof createAgentStateRepository>;
  commits: ReturnType<typeof createCommitRepository>;
  tests: ReturnType<typeof createTestRepository>;
  approvals: ReturnType<typeof createApprovalRepository>;
  modelTaskStats: ReturnType<typeof createModelTaskStatsRepository>;
  users: ReturnType<typeof createUserRepository>;
  close(): void;
}

export function createStore(options: DatabaseOptions): Store {
  const db = openDatabase(options);
  return {
    db,
    settings: createSettingsRepository(db),
    projects: createProjectRepository(db),
    providers: createProviderRepository(db),
    credentials: createCredentialStore(db),
    models: createModelRepository(db),
    quota: createQuotaRepository(db),
    tasks: createTaskRepository(db),
    queue: createSchedulerQueueRepository(db),
    runSignals: createRunSignalRepository(db),
    traces: createTraceRepository(db),
    metrics: createMetricRepository(db),
    events: createEventRepository(db),
    memory: createMemoryRepository(db),
    messages: createMessageRepository(db),
    executions: createExecutionRepository(db),
    agents: createAgentStateRepository(db),
    commits: createCommitRepository(db),
    tests: createTestRepository(db),
    approvals: createApprovalRepository(db),
    modelTaskStats: createModelTaskStatsRepository(db),
    users: createUserRepository(db),
    close() {
      db.close();
    },
  };
}
