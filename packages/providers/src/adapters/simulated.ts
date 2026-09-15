import {
  ProviderError,
  type ChatChunk,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type TokenUsage,
} from '@aido/types';
import { BaseProvider, type ProviderConstructorOptions } from '@aido/ai-core';
import { buildModelInfo } from '../model-factory.js';

/**
 * Local simulator provider.
 *
 * Purpose: let every subsystem (router, quota engine, agents, sandbox, git, tests,
 * observability, the whole UI) be exercised end-to-end — and covered by automated
 * tests — with no API keys and no network. It is also what makes the
 * "create project → run agents → review code" flow demonstrable offline.
 *
 * Honesty requirements (§46) are enforced in three ways:
 *  1. every model id is prefixed `sim-` and the provider is flagged `simulated`,
 *  2. every response carries `metadata.simulated = true` and the UI shows a
 *     "SIMULATED" badge on anything produced this way,
 *  3. it never claims to represent a real model's capability or quota.
 *
 * Behaviour is deterministic given the same request, so tests can assert on it.
 */
export interface SimulatedOptions extends ProviderConstructorOptions {
  /** Deterministic latency model, in ms. */
  baseLatencyMs?: number;
  latencyJitterMs?: number;
  /** 0..1 probability of a synthetic failure (used for failure-path testing). */
  failureRate?: number;
  /** Simulated daily token budget (user_hosted => effectively local capacity). */
  tokensPerDay?: number;
  /** Frozen clock for tests. */
  now?: () => number;
}

export class SimulatedProvider extends BaseProvider {
  private readonly sim: Required<Pick<SimulatedOptions, 'baseLatencyMs' | 'latencyJitterMs' | 'failureRate' | 'tokensPerDay'>> & { now: () => number };
  private tokensUsedToday = 0;
  private requestsToday = 0;
  private windowStart = new Date().toISOString().slice(0, 10);

  constructor(options: SimulatedOptions) {
    super(options, {
      streaming: true,
      modelDiscovery: true,
      usageReporting: true,
      rateLimitTelemetry: false,
      tools: false,
      jsonMode: true,
    });
    this.sim = {
      baseLatencyMs: options.baseLatencyMs ?? 120,
      latencyJitterMs: options.latencyJitterMs ?? 80,
      failureRate: options.failureRate ?? 0,
      tokensPerDay: options.tokensPerDay ?? 5_000_000,
      now: options.now ?? (() => Date.now()),
    };
  }

  override async listModels(): Promise<ModelInfo[]> {
    const models = (this.definition.seedModels ?? []).map((seed) =>
      buildModelInfo({
        definition: this.definition,
        providerModelId: seed.id,
        displayName: seed.displayName,
        context: {
          definition: this.definition,
          contextWindow: seed.contextWindow ?? null,
          maxOutputTokens: seed.maxOutputTokens ?? null,
          capabilities: seed.capabilities ?? {},
          pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0, source: 'user_configured' },
          metadata: { simulated: true },
        },
        status: 'online',
      }),
    );
    this.cacheModels(models);
    return models;
  }

  override async healthCheck() {
    return { ok: true, status: 'online' as const, latencyMs: 1, message: 'Local simulator is always available.', checkedAt: new Date().toISOString() };
  }

  override async getUsage() {
    this.rollWindow();
    return {
      requestsToday: this.requestsToday,
      tokensToday: this.tokensUsedToday,
      reportedRemaining: { requestsRemaining: null, tokensRemaining: Math.max(0, this.sim.tokensPerDay - this.tokensUsedToday) },
      provenance: {
        source: 'user_configured' as const,
        confidence: 1,
        observedAt: new Date().toISOString(),
        note: 'Counted by the simulator itself.',
      },
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = this.sim.now();
    await this.delay(request.modelId, false);
    this.rollWindow();
    this.maybeFail(request);

    const content = this.composeResponse(request);
    const usage = this.usageFor(request, content);
    this.requestsToday += 1;
    this.tokensUsedToday += usage.totalTokens;

    return {
      traceId: request.traceId,
      providerId: this.id,
      modelId: request.modelId,
      content,
      finishReason: 'stop',
      usage,
      latencyMs: this.sim.now() - started,
      raw: { simulated: true },
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    await this.delay(request.modelId, false);
    this.rollWindow();
    this.maybeFail(request);
    const content = this.composeResponse(request);
    const words = content.split(/(\s+)/);
    for (const word of words) {
      yield { traceId: request.traceId, delta: word };
      await this.delay(request.modelId, true);
    }
    const usage = this.usageFor(request, content);
    this.requestsToday += 1;
    this.tokensUsedToday += usage.totalTokens;
    yield { traceId: request.traceId, delta: '', finishReason: 'stop', usage };
  }

  override async getQuota() {
    this.rollWindow();
    return [
      {
        providerId: this.id,
        modelId: null,
        quotaType: 'user_hosted' as const,
        window: 'per_day' as const,
        limit: this.sim.tokensPerDay,
        used: this.tokensUsedToday,
        remaining: Math.max(0, this.sim.tokensPerDay - this.tokensUsedToday),
        remainingFraction: Math.max(0, 1 - this.tokensUsedToday / this.sim.tokensPerDay),
        resetsAt: `${this.windowStart}T00:00:00.000Z`,
        resetStrategy: 'rolling_24h' as const,
        resetIsEstimated: true,
        provenance: {
          source: 'user_configured' as const,
          confidence: 1,
          note: 'Locally counted; the simulator is not a real provider and consumes no external quota.',
        },
        cooldownUntil: null,
      },
    ];
  }

  // -------------------------------------------------------------------------

  private rollWindow(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.windowStart) {
      this.windowStart = today;
      this.tokensUsedToday = 0;
      this.requestsToday = 0;
    }
  }

  private maybeFail(request: ChatRequest): void {
    if (this.sim.failureRate <= 0) return;
    // The flaky model exists specifically so failure-path tests are deterministic-ish.
    const penalty = request.modelId.includes('error-prone') ? 0.5 : 0;
    const probability = Math.min(0.95, this.sim.failureRate + penalty);
    const roll = deterministicUnit(`${request.traceId}:${request.modelId}`);
    if (roll < probability) {
      throw new ProviderError({
        category: 'server_error',
        message: `Simulated transient failure (probability ${probability.toFixed(2)}). Providers fail; this one fails on purpose so failure handling can be tested.`,
        providerId: this.id,
        modelId: request.modelId,
      });
    }
  }

  /**
   * Files to create when writing code, taken from the plan's declared resource
   * locks. Doing this makes the offline run produce a real, reviewable repository
   * instead of an empty one. It is a simulator behaviour, plainly marked as such.
   */
  private plannedFiles(brief: string): string[] {
    const declared = new Set<string>();
    // Explicit statement from the task brief, when present.
    const stated = /Files this task may create or change: ([^\n]+)/.exec(brief);
    for (const entry of stated?.[1]?.split(',') ?? []) {
      const path = entry.trim();
      if (path) declared.add(path);
    }
    for (const match of brief.matchAll(/"resourceLocks"\s*:\s*\[([^\]]*)\]/g)) {
      for (const inner of (match[1] ?? '').matchAll(/"file:([^"]+)"/g)) declared.add(inner[1] ?? '');
    }
    // Only files the task itself declares are touched: a read-only role is never
    // handed a write the sandbox would refuse, and nothing is invented.
    return [...declared].filter((entry) => entry && !entry.includes('..') && /^[A-Za-z0-9_./-]+$/.test(entry)).slice(0, 3);
  }

  /** The plan/task text this request is working from, used to shape the content. */
  private requestContext(request: ChatRequest): string {
    return request.messages.filter((message) => message.role === 'user').map((message) => message.content).join('\n');
  }

  /**
   * Simulated tool plan for one turn.
   *
   * Turn detection uses the agent loop's own markers for tool feedback, so the
   * simulator performs the task's declared file writes on its first turn and then
   * finishes on the next one — the same shape a real model would produce. Files come
   * from the task brief's declared targets, and this provider never pretends the
   * content is real work.
   */
  private simulatedActions(request: ChatRequest): { tool: string; args: Record<string, unknown>; purpose: string }[] {
    const brief = this.requestContext(request);
    // If this task already received tool feedback on an earlier turn, finish now.
    // The markers are produced by the agent loop itself, and they also cover refused
    // or failed calls: retrying those would loop until the iteration cap.
    // Sections in the bundle look like: `--- write_file → ok (untrusted data) ---`
    if (/^(?:--- )?(?:Tool not permitted:|[a-z_]+ \u2192 (?:ok|failed)\b)/m.test(brief)) return [];

    return this.plannedFiles(brief).map((path) => this.simulatedWrite(path));
  }

  /** Placeholder content appropriate to the file extension. */
  private simulatedWrite(path: string): { tool: string; args: Record<string, unknown>; purpose: string } {
    if (/^package\.json$/.test(path)) {
      const manifest = {
        name: 'simulated-project',
        private: true,
        version: '0.0.0',
        type: 'module',
        description: 'Placeholder manifest created by the local simulator because no real provider is configured.',
        scripts: { test: 'node --test' },
      };
      return { tool: 'write_file', args: { path, content: `${JSON.stringify(manifest, null, 2)}\n` }, purpose: 'create a placeholder package manifest (simulated)' };
    }
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|cs)$/.test(path)) {
      const source = [
        `// ${path} — placeholder generated by the local simulator.`,
        '// Configure a real provider to replace this with an implementation.',
        '',
        'export function describe(): string {',
        `  return 'simulated declaration for ${path}';`,
        '}',
        '',
      ].join('\n');
      return { tool: 'write_file', args: { path, content: source }, purpose: `create ${path} (simulated)` };
    }
    if (/\.md$/.test(path)) {
      const title = path.replace(/\.md$/, '');
      return {
        tool: 'write_file',
        args: {
          path,
          content: `# ${title}\n\nPlaceholder created by the local simulator: this installation has no real provider configured, so no meaningful content could be produced.\n`,
        },
        purpose: `document ${path} (simulated)`,
      };
    }
    return { tool: 'write_file', args: { path, content: `Placeholder generated by the local simulator for ${path}.\n` }, purpose: `create ${path} (simulated)` };
  }

  private async delay(modelId: string, streamChunk: boolean): Promise<void> {
    const sizeFactor = modelId.includes('large') ? 3 : modelId.includes('small') ? 1 : 1.5;
    const jitter = deterministicUnit(`${modelId}:${streamChunk ? 'c' : 'r'}`) * this.sim.latencyJitterMs;
    const ms = streamChunk ? (this.sim.baseLatencyMs * sizeFactor) / 8 + jitter : this.sim.baseLatencyMs * sizeFactor + jitter;
    await new Promise((resolve) => setTimeout(resolve, Math.round(ms)));
  }

  /**
   * Deterministic, *useful-shaped* output. It echoes the request so tests can
   * assert the prompt actually reached the provider, and it emits valid JSON when
   * a JSON response format was requested so structured-output parsing is exercised.
   */
  private composeResponse(request: ChatRequest): string {
    const taskText = request.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const simulatedMarker = `[SIMULATED RESPONSE — ${request.modelId}]`;

    if (request.responseFormat?.type === 'json_schema' || request.responseFormat?.type === 'json_object') {
      const schema = request.responseFormat.type === 'json_schema' ? request.responseFormat.schema : null;
      const name = request.responseFormat.type === 'json_schema' ? request.responseFormat.name : null;
      const actions = name === 'task_result' ? this.simulatedActions(request) : [];
      return `${simulatedMarker}\n${JSON.stringify(simulatedStructuredPayload(schema, name, taskText, actions), null, 2)}`;
    }
    const summary = taskText.replace(/\s+/g, ' ').slice(0, 220);
    return [
      simulatedMarker,
      `Requested output tokens: ${request.maxOutputTokens ?? 'unspecified'}.`,
      `Prompt length: ${taskText.length} characters.`,
      '',
      'Summary of the input I received (no real reasoning was performed — this is the local simulator):',
      summary || '(empty prompt)',
    ].join('\n');
  }

  private usageFor(request: ChatRequest, content: string): TokenUsage {
    const inputTokens = this.estimator.estimateMessages(request.messages, request.modelId).tokens;
    const outputTokens = this.estimator.estimate(content, 'prose').tokens;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
  }
}

function deterministicUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

/**
 * Builds a payload that satisfies the requested schema, so structured-output
 * parsing, validation and the whole agent loop are exercised offline.
 *
 * Two layers:
 *  1. scenario payloads for the schemas this platform actually uses (plan,
 *     architecture, review, test report, agent envelope), which make an offline
 *     run produce a real-looking plan and real-looking task results;
 *  2. a generic recursive synthesiser for everything else, which fills every
 *     property (arrays get `minItems` or one element, enums pick a valid member)
 *     and respects string/number/boolean types.
 *
 * Everything it returns is marked `simulated`, and this provider never claims to
 * represent a real model (§46).
 */
function simulatedStructuredPayload(
  schema: Record<string, unknown> | null,
  schemaName: string | null,
  taskText: string,
  simulatedActions: unknown[] = [],
): Record<string, unknown> {
  const scenario = scenarioPayload(schemaName, taskText, simulatedActions);
  if (scenario) return scenario;

  const properties = (schema?.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema?.required) ? (schema!.required as string[]) : Object.keys(properties);
  const out: Record<string, unknown> = {};
  for (const key of required) {
    out[key] = synthesize(properties[key] as Record<string, unknown> | undefined, key, taskText, 0);
  }
  if (!Object.keys(out).length) {
    out.summary = `Simulated result for: ${taskText.replace(/\s+/g, ' ').slice(0, 120)}`;
    out.simulated = true;
  }
  out.simulated = true;
  return out;
}

/** Schema-name-specific payloads so an offline run behaves like a real one. */
function scenarioPayload(
  schemaName: string | null,
  taskText: string,
  simulatedActions: unknown[] = [],
): Record<string, unknown> | null {
  const goal = extractGoal(taskText);
  switch (schemaName) {
    case 'architecture_proposal':
      return {
        summary: `Simulated architecture for "${goal}": a TypeScript service with a React client, SQLite storage and a documented HTTP API. Produced by the local simulator, not by a real model.`,
        assumptions: ['The target runtime is Node.js 22+ (simulated)', 'No third-party services are available (simulated)'],
        stack: [
          { layer: 'language', choice: 'TypeScript', rationale: 'Type safety across the whole codebase (simulated).' },
          { layer: 'backend', choice: 'Node.js HTTP server', rationale: 'Single runtime for API and workers (simulated).' },
          { layer: 'frontend', choice: 'React', rationale: 'Component reuse with the desktop shell (simulated).' },
          { layer: 'storage', choice: 'SQLite', rationale: 'Zero operational overhead locally (simulated).' },
        ],
        components: [
          { name: 'api', responsibility: 'Exposes the HTTP surface and validates input (simulated).', technologies: ['TypeScript'], dependsOn: ['storage'] },
          { name: 'storage', responsibility: 'Persists entities and enforces invariants (simulated).', technologies: ['SQLite'], dependsOn: [] },
          { name: 'web', responsibility: 'Renders the operator interface (simulated).', technologies: ['React'], dependsOn: ['api'] },
        ],
        dataModel: [{ entity: 'item', fields: ['id', 'title', 'createdAt'], relations: [] }],
        apiSurface: [
          { method: 'GET', path: '/health', purpose: 'Liveness probe (simulated).' },
          { method: 'GET', path: '/api/items', purpose: 'List items (simulated).' },
        ],
        projectStructure: [
          { path: 'src/server', purpose: 'API implementation (simulated).' },
          { path: 'src/web', purpose: 'Client implementation (simulated).' },
        ],
        risks: [{ risk: 'Simulated output is not a substitute for design review.', mitigation: 'Treat every simulated artefact as a placeholder.', severity: 'high' }],
        openQuestions: [`What non-functional targets apply to "${goal}"?`],
        delivery: ['Implement storage', 'Implement API', 'Implement client'],
      };
    case 'plan':
      return {
        summary: `Simulated plan for "${goal}": scaffolding, feature implementation and tests. Produced by the local simulator.`,
        tasks: [
          {
            id: 'scaffold',
            title: 'Scaffold the project structure',
            description: 'Create the directory layout, package manifest and entry point required by the goal (simulated plan item).',
            // A writing task must go to a role that may write files; the planner
            // enforces this for every plan, including the simulator's.
            agent: 'devops',
            taskType: 'code_generation',
            priority: 'high',
            dependsOn: [],
            resourceLocks: ['file:package.json'],
            acceptanceCriteria: ['The project builds', 'An entry point exists'],
          },
          {
            id: 'feature',
            title: `Implement the core feature for "${goal}"`,
            description: 'Implement the primary behaviour described by the spec, keeping the public surface minimal (simulated plan item).',
            agent: 'backend',
            taskType: 'code_generation',
            priority: 'high',
            dependsOn: ['scaffold'],
            resourceLocks: ['file:src/core.ts'],
            acceptanceCriteria: ['The feature is reachable through the public surface'],
          },
          {
            id: 'tests',
            title: 'Add automated tests for the core behaviour',
            description: 'Cover the implemented behaviour with tests that fail if the behaviour regresses (simulated plan item).',
            agent: 'qa',
            taskType: 'test_generation',
            priority: 'normal',
            dependsOn: ['feature'],
            resourceLocks: ['file:test/core.test.ts'],
            acceptanceCriteria: ['Tests run and pass'],
          },
          {
            id: 'review',
            title: 'Review the implementation',
            description: 'Review the diff produced by the implementation tasks and report blocking issues (simulated plan item).',
            agent: 'code_review',
            taskType: 'code_review',
            priority: 'normal',
            dependsOn: ['tests'],
            resourceLocks: [],
            acceptanceCriteria: ['A verdict is recorded'],
          },
        ],
        notes: ['Generated by the local simulator; replace with a real model for meaningful design work.'],
      };
    case 'review':
      return {
        summary: 'Simulated review: the diff is structurally coherent and no blocking issue is detectable by the local simulator.',
        verdict: 'approve_with_suggestions',
        blocking: [],
        suggestions: [{ message: 'Add a real assertion once implemented (simulated review).', location: 'src/core.ts' }],
        positives: ['No obvious structural problem in the simulated diff.'],
        confidence: 0.3,
        inspected: { diff: true, files: [] },
      };
    case 'test_report':
      return {
        summary: 'Simulated test run: the command was executed and reported the following results (simulated).',
        command: 'npm test',
        passed: 3,
        failed: 0,
        skipped: 0,
        durationMs: 1450,
        executed: true,
        failures: [],
        coverageNotes: 'Simulated coverage note.',
      };
    case 'task_result': {
      // The envelope is what drives the agent loop. The simulator issues one real
      // tool call when the request carries a plan-declared file, so an offline run
      // produces reviewable repository contents instead of an empty workspace; the
      // second turn then completes because an action was already executed.
      return {
        reasoning_summary: 'Simulated turn: the local simulator performs no real reasoning and only emits placeholder work.',
        actions: simulatedActions,
        result: {
          summary: `Simulated completion of the requested work for: ${goal.slice(0, 200)}`,
          artifacts: [],
          findings: [],
          decisions: [],
        },
        status: 'completed',
        blocker: null,
      };
    }
    default:
      return null;
  }
}

/** Recursive schema walker: produces a value the schema will accept. */
function synthesize(definition: Record<string, unknown> | undefined, key: string, taskText: string, depth: number): unknown {
  if (!definition || depth > 4) return `simulated ${key}`;
  const type = definition.type;

  if (Array.isArray(definition.enum)) return (definition.enum as unknown[])[0] ?? `simulated ${key}`;
  if (Array.isArray(type)) {
    const first = (type as string[]).find((candidate) => candidate !== 'null');
    return synthesize({ ...definition, type: first }, key, taskText, depth);
  }
  if (type === 'array') {
    const minItems = typeof definition.minItems === 'number' ? definition.minItems : 1;
    const items = definition.items as Record<string, unknown> | undefined;
    return Array.from({ length: Math.max(1, Math.min(minItems, 3)) }, (_, index) => synthesize(items, `${key}${index + 1}`, taskText, depth + 1));
  }
  if (type === 'object' || definition.properties) {
    const properties = (definition.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(definition.required) ? (definition.required as string[]) : Object.keys(properties);
    const out: Record<string, unknown> = {};
    for (const property of required) {
      out[property] = synthesize(properties[property] as Record<string, unknown> | undefined, property, taskText, depth + 1);
    }
    return out;
  }
  if (type === 'number' || type === 'integer') {
    const minimum = typeof definition.minimum === 'number' ? definition.minimum : 0;
    const maximum = typeof definition.maximum === 'number' ? definition.maximum : Math.max(minimum, 1);
    return Math.min(Math.max(minimum, 1), maximum);
  }
  if (type === 'boolean') return false;
  const minLength = typeof definition.minLength === 'number' ? definition.minLength : 0;
  const text = `Simulated ${key} for: ${taskText.replace(/\s+/g, ' ').slice(0, 120)}`;
  return text.length >= minLength ? text : text.padEnd(minLength, '.');
}

/** Best-effort extraction of the goal line from a prompt, for readable output. */
function extractGoal(taskText: string): string {
  const match = taskText.match(/Goal:\s*(.+)/i);
  const goal = (match?.[1] ?? taskText).replace(/\s+/g, ' ').trim();
  return goal.slice(0, 140) || 'the requested project';
}
