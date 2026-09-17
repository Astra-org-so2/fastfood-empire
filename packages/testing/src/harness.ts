import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppSettings,
  ModelInfo,
  Project,
  ProjectSpec,
  ProviderDefinition,
  Task,
  TaskRequest,
  TaskType,
} from '@aido/types';
import { createLogger, EventBus, type Logger } from '@aido/observability';
import { createStore, type Store } from '@aido/storage';
import { loadMasterKey } from '@aido/security';
import { CredentialVault } from '@aido/security';
import { defaultAppSettings, loadProviderCatalog } from '@aido/config';
import { ProviderRegistry, SimulatedProvider } from '@aido/providers';
import { QuotaManager } from '@aido/quota-engine';
import { LLMExecutor, ModelRouter } from '@aido/model-router';
import { ContextBuilder, ProjectMemory } from '@aido/project-memory';
import { BaseAgent, DEFAULT_TEAM } from '@aido/agents';
import { ApprovalService, PlannerService, ProjectRunner, RunEngine } from '@aido/orchestrator';
import { GitRepository } from '@aido/git';
import { Workspace } from '@aido/sandbox';

/**
 * Shared integration harness.
 *
 * Every subsystem is wired the same way the real application wires it, against a
 * temporary database and workspace, using only the local simulator provider. That
 * means integration tests exercise the genuine code path — router, quota
 * reservations, agent loop, scheduler, git — with no API keys and no network, and
 * a bug in the wiring is caught by the same tests that catch bugs in the logic.
 */

export interface HarnessOptions {
  /** Extra provider definitions (defaults to the simulated provider only). */
  definitions?: ProviderDefinition[];
  windowRoot?: string;
  settingsPatch?: (settings: AppSettings) => void;
  logLevel?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  /** Simulator tuning, e.g. `failureRate` to test failure paths. */
  simulated?: { failureRate?: number; baseLatencyMs?: number; latencyJitterMs?: number; tokensPerDay?: number };
}

export interface Harness {
  root: string;
  dataDir: string;
  workspaceRoot: string;
  store: Store;
  settings: AppSettings;
  events: EventBus;
  /** Credential vault, so tests can store a provider key the way the API does. */
  vault: CredentialVault;
  logger: Logger;
  registry: ProviderRegistry;
  quota: QuotaManager;
  router: ModelRouter;
  executor: LLMExecutor;
  memory: ProjectMemory;
  contextBuilder: ContextBuilder;
  approvals: ApprovalService;
  createAgent: (agentId: string) => BaseAgent;
  workspaceFor: () => Workspace;
  gitFor: (branch?: string) => GitRepository;
  createEngine: (overrides?: Partial<AppSettings>) => RunEngine;
  createPlanner: () => PlannerService;
  /**
   * Runner wired exactly like the API container: the approval service reports decisions
   * back into the runner, so a test can prove that a decision is not just a row update.
   */
  createRunner: (options?: { intervalMs?: number; maxTicks?: number; engineFactory?: (project: Project) => RunEngine }) => ProjectRunner;
  close: () => void;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = options.windowRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aido-test-'));
  const dataDir = path.join(root, 'data');
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const logger = createLogger({ level: options.logLevel ?? 'error' });
  const store = createStore({ path: path.join(dataDir, 'aido.db') });
  const events = new EventBus({ logger, persist: (event) => store.events.insert(event) });

  const settings = defaultAppSettings();
  // Tests default to AUTO so no approval prompt can stall a run; approval behaviour
  // is asserted explicitly by the tests that care about it.
  settings.executionMode = 'auto';
  settings.freeOnlyMode = true;
  settings.supervisor.maxParallelAgents = 2;
  options.settingsPatch?.(settings);

  const { key } = loadMasterKey({ keyFile: path.join(dataDir, 'master.key'), envValue: 'test-master-key-do-not-use-outside-tests' });
  const vault = new CredentialVault({ store: store.credentials, key });

  // The shipped catalogue is loaded from disk so tests run against the same
  // provider definitions the application uses — a drifted fixture would hide bugs.
  const definitions = options.definitions ?? loadProviderCatalog({ dir: providerCatalogDir() }).definitions;
  // Providers a test names explicitly are enabled; the shipped catalogue is not,
  // because none of those have credentials in a test environment.
  const explicitlyProvided = options.definitions !== undefined;
  for (const definition of definitions) {
    store.providers.upsertFromDefinition(definition, { enabled: explicitlyProvided ? true : definition.id === 'simulated' });
  }

  const registry = new ProviderRegistry({
    store,
    vault,
    definitions,
    logger,
    adapters: new Map([['simulated', SimulatedProvider as never]]),
  });
  for (const definition of definitions) void definition;

  const quota = new QuotaManager({ store, settings: () => settings, logger });
  const router = new ModelRouter({
    store,
    quota,
    settings: () => settings,
    logger,
    providerSummary: (providerId) => {
      const provider = store.providers.get(providerId);
      if (!provider) return null;
      return { enabled: provider.enabled, configured: true, health: provider.health.status };
    },
  });
  const executor = new LLMExecutor({ store, registry, quota, router, events, settings: () => settings, logger });
  const memory = new ProjectMemory(store);
  const contextBuilder = new ContextBuilder({ store, memory, logger });
  let runnerRef: ProjectRunner | null = null;
  const approvals = new ApprovalService({
    store,
    events,
    logger,
    onDecided: (request, decision) => runnerRef?.settleApproval(request, decision),
  });

  const workspaceFor = () => new Workspace({ rootPath: workspaceRoot, settings: () => settings, executionMode: () => settings.executionMode, logger });
  const gitFor = () => new GitRepository({ path: workspaceRoot, logger, authorName: 'AI Dev Orchestrator', authorEmail: 'agents@aido.local' });

  const createAgent = (agentId: string) =>
    new BaseAgent({
      agentId: agentId as never,
      executor,
      contextBuilder,
      memory,
      store,
      events,
      logger,
      executionMode: () => settings.executionMode,
      maxIterations: () => settings.supervisor.maxAgentIterations,
    });

  const createEngine = (overrides: Partial<AppSettings> = {}) =>
    new RunEngine({
      store,
      events,
      logger,
      settings: () => ({ ...settings, ...overrides, supervisor: { ...settings.supervisor, ...(overrides.supervisor ?? {}) } }),
      memory,
      createAgent,
      workspaceFor,
      gitFor,
      approvals: { request: (input) => approvals.request(input) },
    });

  const createPlanner = () => new PlannerService({ store, memory, events, logger, createAgent, workspaceFor, gitFor });

  const defaultEngineFactory = (project: Project) =>
    new RunEngine({
      store,
      events,
      logger,
      settings: () => {
        const supervisor = project.settings.maxParallelAgents
          ? { ...settings.supervisor, maxParallelAgents: project.settings.maxParallelAgents }
          : settings.supervisor;
        return { ...settings, supervisor, freeOnlyMode: project.settings.freeOnlyMode ?? settings.freeOnlyMode };
      },
      memory,
      createAgent,
      workspaceFor,
      gitFor,
      approvals: { request: (input) => approvals.request(input) },
    });

  const createRunner = (options: { intervalMs?: number; maxTicks?: number; engineFactory?: (project: Project) => RunEngine } = {}): ProjectRunner => {
    const runner = new ProjectRunner({
      store,
      events,
      logger,
      settings: () => settings,
      engineFactory: options.engineFactory ?? defaultEngineFactory,
      planProject: async (project) => {
        const result = await createPlanner().planProject(project);
        return { createdTasks: result.createdTasks as unknown[] };
      },
      intervalMs: options.intervalMs ?? 25,
      maxTicks: options.maxTicks ?? 400,
    });
    runnerRef = runner;
    return runner;
  };

  return {
    root,
    dataDir,
    workspaceRoot,
    store,
    settings,
    events,
    vault,
    logger,
    registry,
    quota,
    router,
    executor,
    memory,
    contextBuilder,
    approvals,
    createAgent,
    workspaceFor,
    gitFor,
    createEngine,
    createPlanner,
    createRunner,
    close: () => {
      runnerRef = null;
      approvals.dispose();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Repository root, resolved from this file so tests work from any cwd. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** Directory holding the shipped provider definitions. */
export function providerCatalogDir(): string {
  return path.join(REPO_ROOT, 'config', 'providers');
}

const simulatedCache = new Map<string, ProviderDefinition>();

/**
 * The real `config/providers/simulated.json`, with optional overrides. Tests use it
 * as the base for synthetic providers so they never drift from the shipped shape.
 */
export function simulatedDefinition(overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  const key = JSON.stringify(overrides);
  const cached = simulatedCache.get(key);
  if (cached) return cached;
  const file = path.join(providerCatalogDir(), 'simulated.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ProviderDefinition;
  const merged = { ...raw, ...overrides } as ProviderDefinition;
  simulatedCache.set(key, merged);
  return merged;
}

/** Definition suitable for registering an extra provider in a test. */
export function testProviderDefinition(id: string, overrides: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return simulatedDefinition({ id, name: `Test provider ${id}`, ...overrides });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function sampleSpec(overrides: Partial<ProjectSpec> = {}): ProjectSpec {
  return {
    goal: 'Build a URL shortener service with click analytics',
    description: 'Operators create short links; the service records clicks and reports totals.',
    techStack: ['TypeScript', 'Node.js'],
    constraints: ['No external SaaS dependencies'],
    nonFunctional: ['Startup under one second'],
    acceptanceCriteria: ['Creating a link returns a code', 'Following a code increments its counter'],
    targetUsers: 'Small internal teams',
    deliverable: 'A runnable service with tests',
    ...overrides,
  };
}

export function sampleProject(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString();
  return {
    id: 'proj-test',
    name: 'URL Shortener',
    slug: 'url-shortener',
    description: 'Test project',
    spec: sampleSpec(),
    status: 'planning',
    workspacePath: '/tmp/aido-test-workspace',
    branch: 'main',
    sourceRepo: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settings: {
      executionMode: 'auto',
      maxParallelAgents: 2,
      autoStart: true,
      enabledAgents: [...DEFAULT_TEAM],
      freeOnlyMode: true,
      maxTotalTokens: null,
      gitAuthorName: 'AI Dev Orchestrator',
      gitAuthorEmail: 'agents@aido.local',
    },
    ...overrides,
  } as Project;
}

export function sampleTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: 'task-test',
    projectId: 'proj-test',
    title: 'Implement the shortener endpoint',
    description: 'Create POST /links which returns a short code.',
    agentRole: 'backend',
    taskType: 'code_generation',
    status: 'ready',
    priority: 'normal',
    dependsOn: [],
    resourceLocks: ['file:src/links.ts'],
    parentId: null,
    orderIndex: 0,
    estimatedInputTokens: null,
    estimatedOutputTokens: null,
    result: null,
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    lastModelId: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    ...overrides,
  } as Task;
}

export function sampleTaskRequest(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    taskType: 'code_generation' as TaskType,
    prompt: 'Implement the requested endpoint.',
    estimatedInputTokens: 1_500,
    estimatedOutputTokens: 800,
    requiredCapabilities: [],
    preferredCapabilities: [],
    priority: 'normal',
    ...overrides,
  };
}

export function sampleModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    modelId: 'simulated:sim-medium',
    providerId: 'simulated',
    providerModelId: 'sim-medium',
    displayName: 'Simulator (medium)',
    contextWindow: 65_536,
    maxOutputTokens: 8_192,
    capabilities: { streaming: true, jsonMode: true, structuredOutput: true },
    strengths: [],
    qualityPrior: 0.5,
    quotaType: 'user_hosted',
    pricing: null,
    status: 'online',
    metadataVerified: true,
    ...overrides,
  } as unknown as ModelInfo;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Polls until `check` returns true, or throws after `timeoutMs`. */
export async function waitFor(check: () => boolean, options: { timeoutMs?: number; intervalMs?: number; description?: string } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${options.description ? `: ${options.description}` : ''}`);
}

export function withTempDir(prefix = 'aido-test-'): { path: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export { DEFAULT_TEAM };
