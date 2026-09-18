import path from 'node:path';
import fs from 'node:fs';
import {
  defaultAppSettings,
  loadConfig,
  loadProviderCatalog,
  normalizeSettings,
  type AppConfig,
  type ProviderOverride,
} from '@aido/config';
import { attachNotificationBridge, createPlatform, type NotificationBridge, type PlatformAdapter, type ShellKind } from '@aido/platform';
import { createLogger, EventBus, SystemMetricsCollector, type Logger } from '@aido/observability';
import { createStore, type Store } from '@aido/storage';
import { CredentialVault, loadMasterKey } from '@aido/security';
import { ProviderRegistry, SimulatedProvider } from '@aido/providers';
import { QuotaManager } from '@aido/quota-engine';
import { LLMExecutor, ModelRouter } from '@aido/model-router';
import { ContextBuilder, ProjectMemory } from '@aido/project-memory';
import { BaseAgent, Supervisor } from '@aido/agents';
import { ApprovalService, PlannerService, ProjectRunner, RunEngine } from '@aido/orchestrator';
import { GitRepository } from '@aido/git';
import { Workspace } from '@aido/sandbox';
import type { AgentId, AppSettings, Project } from '@aido/types';

/**
 * Composition root (§37).
 *
 * Everything the HTTP layer, the worker and the desktop shell need is built here in
 * one place, from `AppConfig`. Nothing below this file knows about Fastify, React or
 * Electron, which is what keeps the two shells (§54) sharing one implementation.
 */

export interface Container {
  config: AppConfig;
  store: Store;
  events: EventBus;
  logger: Logger;
  vault: CredentialVault;
  registry: ProviderRegistry;
  quota: QuotaManager;
  router: ModelRouter;
  executor: LLMExecutor;
  memory: ProjectMemory;
  contextBuilder: ContextBuilder;
  approvals: ApprovalService;
  runner: ProjectRunner;
  supervisor: Supervisor;
  systemMetrics: SystemMetricsCollector;
  /** Version reported by `/api/health` (from package.json). */
  version: string;
  /** Enabled providers that cannot currently serve a request, with the reason. */
  healthWarnings(): { providerId: string; level: 'warning' | 'error'; message: string }[];
  /** Which shell is hosting this process (web UI vs. desktop app vs. worker). */
  shell: { kind: ShellKind; platform: NodeJS.Platform; isDesktop: boolean };
  /**
   * The platform adapter (§54): paths, secret storage, notifications, updates and
   * shell integration. Nothing else in the codebase branches on the OS.
   */
  platform: PlatformAdapter;
  /** Desktop notifications for the few events a human must know about (§54). */
  notifications: NotificationBridge;
  /** Where the credential master key came from, for the security screen. */
  secretSource: 'env' | 'file';
  settings(): AppSettings;
  updateSettings(patch: Partial<AppSettings>): AppSettings;
  createAgent(agentId: AgentId): BaseAgent;
  workspaceFor(project: Project): Workspace;
  gitFor(project: Project): GitRepository;
  /**
   * Creates the project's directory and repository (or clones `sourceRepo` into it).
   * One implementation for the API, the worker, the desktop shell and tests, so a
   * project can never exist in the database without a usable workspace.
   */
  provisionWorkspace(project: Project): Promise<{ created: boolean; cloned: boolean; initialised: boolean }>;
  /** Architect → project-manager planning. Shared by the API and the worker. */
  planProject(project: Project): ReturnType<PlannerService['planProject']>;
  /** Reloads `config/providers/*.json` plus database overrides. */
  reloadProviders(): { count: number; issues: string[] };
  /**
   * Stops active runs, then closes storage. Async on purpose: closing the database
   * while an agent is mid-turn would crash the process and strand its task.
   */
  close(): Promise<void>;
}

export interface ContainerOptions {
  /** Overrides for tests and the desktop shell. */
  configOverrides?: Partial<AppConfig>;
  authRequired?: boolean;
}

export function createContainer(options: ContainerOptions = {}): Container {
  const platform = createPlatform({ version: readVersion(loadConfig(options.configOverrides).repoRoot), feedUrl: process.env.AIDO_UPDATE_FEED ?? null });
  const config = loadConfig(options.configOverrides);
  const version = readVersion(config.repoRoot);
  const logger = createLogger({ level: config.logLevel });

  const store = createStore({ path: config.dbPath });
  const events = new EventBus({ logger, persist: (event) => store.events.insert(event) });

  // Settings: defaults → persisted → environment overrides.
  const persisted = store.settings.load();
  const normalized = normalizeSettings({
    ...defaultAppSettings(),
    ...(persisted.settings ?? {}),
    executionMode: config.executionMode,
  });
  const settings: AppSettings = normalized.settings;
  for (const repair of normalized.repairs) logger.warn('settings repaired', { repair });
  const settingsAccessor = () => settings;
  const updateSettings = (patch: Partial<AppSettings>): AppSettings => {
    const merged = normalizeSettings({ ...settings, ...patch }).settings;
    Object.assign(settings, merged);
    store.settings.save(merged);
    events.emit('system.notice', { phase: 'settings' }, { message: 'Settings updated', severity: 'info' });
    return merged;
  };

  // Credentials: encrypted at rest with a per-install master key.
  const { key, source } = loadMasterKey({ keyFile: config.masterKeyFile, envValue: process.env.AIDO_MASTER_KEY });
  const isDesktop = config.shell === 'desktop' || platform.info.shell === 'desktop';
  logger.info('credential vault ready', { source, keyFile: source === 'file' ? config.masterKeyFile : null });
  const vault = new CredentialVault({ store: store.credentials, key, keyFile: config.masterKeyFile });

  const catalog = loadProviderCatalog({
    dir: config.providerDir,
    overrides: providerOverrides(store),
    logger: { warn: (message, meta) => logger.warn(message, meta) },
  });
  for (const definition of catalog.definitions) {
    const configured = store.providers.get(definition.id);
    // A provider is only enabled by default when it needs no credentials (the local
    // simulator) — anything else must be configured deliberately by the operator.
    if (!configured) store.providers.upsertFromDefinition(definition, { enabled: (definition.credentialFields ?? []).length === 0 });
  }

  const registry = new ProviderRegistry({
    store,
    vault,
    definitions: catalog.definitions,
    logger,
    // The simulator is a first-class built-in adapter, registered explicitly so the
    // registry never needs a special case for it.
    adapters: new Map([['simulated', SimulatedProvider as never]]),
  });

  // Seed model rows from the definitions so a fresh install is immediately usable
  // (the simulated provider works with no credentials); real providers still need
  // credentials and a discovery call before they can route.
  const seeded = registry.syncDefinitions();
  logger.debug('provider catalogue synced', seeded);

  const quota = new QuotaManager({ store, settings: settingsAccessor, logger });
  const router = new ModelRouter({
    store,
    quota,
    settings: settingsAccessor,
    logger,
    providerSummary: (providerId) => {
      const provider = store.providers.get(providerId);
      if (!provider) return null;
      return { enabled: provider.enabled, configured: registry.isConfigured(providerId), health: provider.health.status };
    },
  });
  const executor = new LLMExecutor({ store, registry, quota, router, events, settings: settingsAccessor, logger });

  const memory = new ProjectMemory(store);
  const contextBuilder = new ContextBuilder({ store, memory, logger });
  // The decision handler is wired after the runner exists (they reference each other):
  // approving an action queues the blocked task again, denying it fails the task.
  let runnerRef: ProjectRunner | null = null;
  const approvals = new ApprovalService({
    store,
    events,
    logger,
    onDecided: (request, decision) => runnerRef?.settleApproval(request, decision),
  });

  const createAgent = (agentId: AgentId) =>
    new BaseAgent({
      agentId,
      executor,
      contextBuilder,
      memory,
      store,
      events,
      logger,
      executionMode: () => settings.executionMode,
      maxIterations: () => settings.supervisor.maxAgentIterations,
    });

  const workspaceFor = (project: Project) =>
    new Workspace({
      rootPath: project.workspacePath,
      settings: settingsAccessor,
      executionMode: () => project.settings.executionMode ?? settings.executionMode,
      logger,
    });

  const gitFor = (project: Project) =>
    new GitRepository({
      path: project.workspacePath,
      logger,
      authorName: project.settings.gitAuthorName,
      authorEmail: project.settings.gitAuthorEmail,
      // Every commit this process makes is recorded against the agent and task that
      // produced it, which is what the Git screen's attribution panels read.
      onCommit: (commit) => {
        try {
          store.commits.record({
            projectId: project.id,
            sha: commit.sha,
            branch: commit.branch ?? project.branch,
            message: commit.message,
            authorName: commit.authorName,
            authorEmail: commit.authorEmail,
            agentId: commit.agentId,
            taskId: commit.taskId,
            filesChanged: commit.filesChanged,
            insertions: commit.insertions,
            deletions: commit.deletions,
            committedAt: commit.committedAt,
          });
        } catch (err) {
          logger.warn('could not record a commit', { sha: commit.sha, error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

  const provisionWorkspace = async (project: Project): Promise<{ created: boolean; cloned: boolean; initialised: boolean }> => {
    const existed = fs.existsSync(project.workspacePath);
    fs.mkdirSync(project.workspacePath, { recursive: true });
    const git = gitFor(project);

    let cloned = false;
    if (project.sourceRepo && !existed) {
      try {
        await git.clone(project.sourceRepo, { depth: 50 });
        cloned = true;
      } catch (err) {
        logger.warn('clone failed; the project keeps an empty local repository', {
          projectId: project.id,
          sourceRepo: project.sourceRepo,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let initialised = false;
    if (!cloned && !(await git.isRepository())) {
      await git.init(project.branch || 'main');
      initialised = true;
    }
    return { created: !existed, cloned, initialised };
  };

  const engineFactory = (project: Project) =>
    new RunEngine({
      store,
      events,
      logger,
      settings: () => {
        // Per-project overrides: parallel agents and FREE ONLY can be tightened (or
        // relaxed) for a single project without changing the global policy.
        const supervisor = project.settings.maxParallelAgents
          ? { ...settings.supervisor, maxParallelAgents: project.settings.maxParallelAgents }
          : settings.supervisor;
        return normalizeSettings({
          ...settings,
          supervisor,
          freeOnlyMode: project.settings.freeOnlyMode ?? settings.freeOnlyMode,
        }).settings;
      },
      memory,
      createAgent,
      workspaceFor,
      gitFor,
      approvals: { request: (input) => approvals.request(input) },

    });

  const planner = new PlannerService({
    store,
    memory,
    events,
    logger,
    createAgent,
    workspaceFor,
    gitFor,
    maxPlanTasks: 60,
  });

  const runner = new ProjectRunner({
    store,
    events,
    logger,
    settings: settingsAccessor,
    engineFactory,
    planProject: async (project) => {
      const result = await planner.planProject(project);
      return { createdTasks: result.createdTasks };
    },
    intervalMs: 400,
  });

  const supervisor = new Supervisor({
    store,
    events,
    logger,
    settings: settingsAccessor,
    alternativeAgentsFor: () => ['backend', 'frontend', 'database', 'devops', 'qa'],
  });

  const systemMetrics = new SystemMetricsCollector({ diskPath: config.dataDir, intervalMs: 0 });

  runnerRef = runner;
  const maintenance = setInterval(() => runner.maintenance(), 60_000);
  maintenance.unref?.();

  const notifications = attachNotificationBridge({ events, sink: platform.notifications, logger });

  const container: Container = {
    config,
    store,
    events,
    logger,
    vault,
    registry,
    quota,
    router,
    executor,
    memory,
    contextBuilder,
    approvals,
    runner,
    supervisor,
    planProject: (project) => planner.planProject(project),
    systemMetrics,
    version,
    healthWarnings: () => collectWarnings(container),
    shell: { kind: config.shell ?? platform.info.shell, platform: process.platform, isDesktop },
    platform,
    notifications,
    secretSource: source,
    settings: settingsAccessor,
    updateSettings,
    createAgent,
    workspaceFor,
    gitFor,
    provisionWorkspace,
    reloadProviders() {
      const reloadedCatalog = loadProviderCatalog({
        dir: config.providerDir,
        overrides: providerOverrides(store),
        logger: { warn: (message, meta) => logger.warn(message, meta) },
      });
      const summaries = registry.reloadDefinitions(reloadedCatalog.definitions);
      return { count: summaries.length, issues: reloadedCatalog.issues.map((issue) => `${issue.file}: ${issue.error}`) };
    },
    async close() {
      clearInterval(maintenance);
      notifications.dispose();
      const drained = await runner.shutdown();
      if (drained.abandoned) {
        logger.warn('a run did not stop within the shutdown timeout', { abandoned: drained.abandoned });
      }
      approvals.dispose();
      store.close();
    },
  };

  ensureDataDirs(container);
  return container;
}

/**
 * Warnings are the honest half of "no fake functionality": anything the operator
 * would otherwise mistake for working is listed here with the actual reason.
 */
function collectWarnings(container: Container): { providerId: string; level: 'warning' | 'error'; message: string }[] {
  const warnings: { providerId: string; level: 'warning' | 'error'; message: string }[] = [];
  for (const summary of container.registry.summaries()) {
    if (!summary.enabled) continue;
    if (!summary.adapter.registered) {
      warnings.push({ providerId: summary.id, level: 'error', message: 'No adapter is registered for this provider kind, so it cannot be used.' });
      continue;
    }
    if (!summary.configured) {
      warnings.push({ providerId: summary.id, level: 'error', message: `Missing credentials: ${summary.missingCredentialFields.join(', ') || 'unknown fields'}.` });
      continue;
    }
    if (summary.modelCount === 0) {
      warnings.push({ providerId: summary.id, level: 'warning', message: 'No models discovered yet. Run model discovery on the Providers screen.' });
      continue;
    }
    if (!summary.metadataVerified && summary.freeTier.quotaType === 'free_renewable') {
      warnings.push({ providerId: summary.id, level: 'warning', message: 'Free-tier limits are unverified (metadataVerified = false). Values are learned from provider responses at runtime.' });
    }
    if (summary.modelCount > 0 && container.store.models.list({ providerId: summary.id, enabled: true, limit: 1 }).length === 0) {
      warnings.push({ providerId: summary.id, level: 'warning', message: 'All models of this provider are disabled, so it will never be selected.' });
    }
  }
  if (container.settings().freeOnlyMode) {
    const freeModels = container.store.models.list({ enabled: true, limit: 5_000 }).filter((model) => model.quotaType === 'free_renewable');
    if (freeModels.length === 0) {
      warnings.push({ providerId: 'router', level: 'error', message: 'FREE ONLY mode is on and no renewable-free model is available, so no request can be routed.' });
    }
  }
  return warnings;
}

/** The application version, read from the root package.json (never invented). */
function readVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Operator edits made in the UI win over the shipped JSON files. */
function providerOverrides(store: Store): ProviderOverride[] {
  return store.providers.list().map((record) => ({
    providerId: record.id,
    enabled: record.enabled,
    quotaType: record.quotaType,
    resetStrategy: record.resetStrategy,
    resetTimezone: record.resetTimezone,
    quotaLimits: record.quotaLimits,
  }));
}

/** Creates the data/workspace roots so the first run never fails on a missing dir. */
function ensureDataDirs(container: Container): void {
  for (const dir of [container.config.dataDir, container.config.workspaceRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  container.logger.debug('data directories ready', {
    dataDir: container.config.dataDir,
    workspaceRoot: path.relative(container.config.repoRoot, container.config.workspaceRoot),
  });
}
