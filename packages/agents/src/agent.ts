import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  type AgentId,
  type AgentLimits,
  type AgentStepOutcome,
  type AgentTool,
  type ApprovalRequest,
  type ArchitectureProposal,
  type ModelInfo,
  type Task,
  type TaskResult,
} from '@aido/types';
import type { EventBus, Logger } from '@aido/observability';
import type { Store } from '@aido/storage';
import type { ContextBuilder, ProjectMemory } from '@aido/project-memory';
import type { GitRepository } from '@aido/git';
import type { Workspace } from '@aido/sandbox';
import { buildSystemMessage, extractJson, type PromptSection } from '@aido/ai-core';
import type { LLMExecutor } from '@aido/model-router';
import { UNTRUSTED_CONTENT_RULE } from '@aido/security';
import { AGENT_ROLE_MAP } from './roles.js';
import { AgentResponseSchema, outputInstructions, schemaFor, type AgentResponsePayload, type SchemaName } from './schemas.js';
import { ToolExecutor, toolCatalogue } from './tools.js';

/**
 * The agent execution loop (§12, §13, §43).
 *
 * One "step" = one agent working on one task until it either completes, blocks,
 * needs approval, or hits a hard limit. The loop is bounded on every axis: model
 * iterations, tokens, files changed, shell commands and wall-clock time. That is
 * what makes autonomous execution safe to leave running.
 *
 * Deliberate design choices:
 *  - no hidden chain-of-thought is requested or stored; the model returns a short
 *    `reasoning_summary`, and the UI shows actions and conclusions only (§25),
 *  - tool results are fed back as *untrusted* sections, so a file containing
 *    instructions cannot hijack the next iteration,
 *  - every write is recorded from the tool result, not from the model's claim, so
 *    the task result reflects what actually happened on disk (§46),
 *  - every role works through the same protocol: gather evidence with tools, then
 *    hand in the role's structured artefact (a plan, an architecture, a test report,
 *    a review). Analysis-only roles simply choose no tool calls, which means the
 *    reviewer really can read the diff and the QA agent really can write tests.
 */

export interface AgentRunContext {
  projectId: string;
  task: Task;
  workspace: Workspace;
  git: GitRepository;
  /** Cancellation for stop/pause. */
  signal?: AbortSignal;
  /** Live terminal stream. */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /** Approvals already granted for this task (action keys). */
  grantedApprovals?: Set<string>;
  requestApproval: (request: { action: string; reason: string; risk: 'low' | 'medium' | 'high'; payload: Record<string, unknown> }) => Promise<ApprovalRequest | null>;
  /** Overrides the role's default limits (project settings). */
  limitsOverride?: Partial<AgentLimits>;
}

export interface AgentRunResult extends AgentStepOutcome {
  /** Structured payload for architect/PM/reviewer/test roles. */
  structured?: unknown;
  /** Whether the model's structured output passed validation. */
  validated: boolean;
}

export interface BaseAgentOptions {
  agentId: AgentId;
  executor: LLMExecutor;
  contextBuilder: ContextBuilder;
  memory: ProjectMemory;
  store: Store;
  events: EventBus;
  logger: Logger;
  executionMode: () => 'auto' | 'supervised' | 'manual';
  /** Hard iteration ceiling from supervisor settings (§19). */
  maxIterations: () => number;
  now?: () => Date;
}

export class BaseAgent {
  readonly agentId: AgentId;
  protected readonly options: BaseAgentOptions;
  private readonly startedAt: number;

  constructor(options: BaseAgentOptions) {
    this.agentId = options.agentId;
    this.options = options;
    this.startedAt = Date.now();
  }

  get role() {
    return AGENT_ROLE_MAP[this.agentId];
  }

  /** Runs the agent on a task until it finishes, blocks, or hits a limit. */
  async run(context: AgentRunContext): Promise<AgentRunResult> {
    const role = this.role;
    const limits: AgentLimits = { ...role.limits, ...(context.limitsOverride ?? {}) };
    const startedMs = Date.now();
    const task = context.task;
    const schemaName: SchemaName = role.outputSchema;


    this.options.events.emit(
      'agent.state_changed',
      { agentId: this.agentId, state: 'working', taskId: task.id },
      { message: `${role.name} started "${task.title}"`, projectId: context.projectId, taskId: task.id, agentId: this.agentId },
    );

    const toolResults: PromptSection[] = [];
    const changedFiles: { path: string; action: 'created' | 'modified' | 'deleted' }[] = [];
    let shellCommands = 0;
    let tokensUsed = 0;
    let requests = 0;
    let iterations = 0;
    let lastModel: { modelId: string; providerId: string } | null = null;
    let lastError: string | null = null;
    let emptyResponses = 0;

    const maxIterations = Math.max(1, Math.min(this.options.maxIterations(), 40));
    // Every role speaks the envelope protocol so it can inspect the repository and
    // run commands; the role-specific artefact is collected once the work is done.
    const envelopeSchemaName: SchemaName = 'task_result';

    for (iterations = 1; iterations <= maxIterations; iterations += 1) {
      // ---- limit enforcement before spending more quota ----------------------
      const elapsed = Date.now() - startedMs;
      if (elapsed > limits.maxRuntimeMs) {
        return this.blocked(context, `Runtime limit reached (${Math.round(limits.maxRuntimeMs / 1000)}s).`, { iterations, tokensUsed, requests, changedFiles, startedMs, lastModel });
      }
      if (tokensUsed > limits.maxTokens) {
        return this.blocked(context, `Token limit reached (${limits.maxTokens.toLocaleString()} tokens).`, { iterations, tokensUsed, requests, changedFiles, startedMs, lastModel });
      }
      if (requests >= limits.maxRequests) {
        return this.blocked(context, `Request limit reached (${limits.maxRequests}).`, { iterations, tokensUsed, requests, changedFiles, startedMs, lastModel });
      }
      if (shellCommands > limits.maxShellCommands) {
        return this.blocked(context, `Shell command limit reached (${limits.maxShellCommands}).`, { iterations, tokensUsed, requests, changedFiles, startedMs, lastModel });
      }
      if (changedFiles.length > limits.maxFilesChanged) {
        return this.blocked(context, `File change limit reached (${limits.maxFilesChanged}).`, { iterations, tokensUsed, requests, changedFiles, startedMs, lastModel });
      }
      if (context.signal?.aborted) {
        return this.blocked(context, 'Run was stopped.', { iterations, tokensUsed, requests, changedFiles, startedMs, lastModel });
      }

      // ---- context ----------------------------------------------------------
      const model = this.selectModelHint();
      const bundle = this.options.contextBuilder.build({
        projectId: context.projectId,
        task,
        agentId: this.agentId,
        requiredFiles: [],
        model,
        workspace: context.workspace,
        extraSections: toolResults,
      });

      const systemMessage = buildSystemMessage({
        role: role.name,
        instructions: role.systemPrompt,
        includeUntrustedRule: true,
        outputContract: `${outputInstructions(schemaName)}\n\nAvailable tools:\n${toolCatalogue(role.tools)}\n\n${UNTRUSTED_CONTENT_RULE}`,
      });

      // ---- model call -------------------------------------------------------
      let raw: string;
      try {
        // The role's contract is requested as JSON at the wire level; the executor
        // downgrades it to json_object or plain text for models that cannot do
        // structured output, so this never becomes an unsupported request.
        const jsonSchema = schemaFor(envelopeSchemaName).jsonSchema;
        const result = await this.options.executor.execute({
          taskRequest: {
            taskType: task.taskType,
            prompt: bundle.text,
            estimatedInputTokens: bundle.estimatedTokens,
            estimatedOutputTokens: Math.min(8_000, Math.max(1_500, Math.floor((model?.maxOutputTokens ?? 4_096) * 0.6))),
            requiredCapabilities: role.modelPreference.requiredCapabilities,
            preferredCapabilities: role.modelPreference.preferCapabilities,
            minContextWindow: role.modelPreference.minContextWindow,
            priority: task.priority,
            maxLatencyMs: role.modelPreference.maxLatencyMs,
            qualityRequirement: role.modelPreference.qualityRequirement,
            allowTrialCredits: role.modelPreference.allowTrialCredits,
            agentId: this.agentId,
            projectId: context.projectId,
          },
          messages: [
            { role: 'system', content: systemMessage },
            { role: 'user', content: bundle.text },
          ],
          responseFormat: jsonSchema ? { type: 'json_schema', schema: jsonSchema, name: envelopeSchemaName } : { type: 'json_object' },
          projectId: context.projectId,
          taskId: task.id,
          agentId: this.agentId,
          signal: context.signal,
          maxOutputTokens: Math.min(8_000, model?.maxOutputTokens ?? 8_192),
        });
        raw = result.response.content;
        requests += 1;
        tokensUsed += result.usage.totalTokens;
        lastModel = { modelId: result.chosen.modelId, providerId: result.chosen.providerId };

        this.options.store.messages.append({
          projectId: context.projectId,
          taskId: task.id,
          agentId: this.agentId,
          role: 'assistant',
          content: raw.slice(0, 20_000),
          trust: 'trusted',
          tokens: result.usage.outputTokens,
          modelId: result.chosen.modelId,
          providerId: result.chosen.providerId,
          meta: { iteration: iterations, contextTokens: bundle.estimatedTokens, compression: bundle.compression.savedFraction },
        });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const category = err instanceof ProviderError ? err.category : 'unknown';
        this.options.events.emit(
          'agent.state_changed',
          { agentId: this.agentId, state: 'error', error: lastError, category },
          { message: `${role.name} could not complete "${task.title}": ${lastError}`, severity: 'error', projectId: context.projectId, taskId: task.id, agentId: this.agentId },
        );
        return {
          taskId: task.id,
          agentId: this.agentId,
          status: 'failed',
          error: lastError,
          durationMs: Date.now() - startedMs,
          iterations,
          tokenUsage: { input: 0, output: tokensUsed },
          modelId: lastModel?.modelId,
          providerId: lastModel?.providerId,
          validated: false,
        };
      }

      // ---- parse ------------------------------------------------------------
      const parsed = this.parseResponse(raw, envelopeSchemaName, true);

      // ---- agent envelope (task_result) -------------------------------------
      if (!parsed.ok) {
        lastError = parsed.error;
        if (iterations >= 2) {
          return this.failed(context, `Response could not be parsed as the required JSON envelope: ${parsed.error}`, { iterations, tokensUsed, requests, changedFiles, startedMs, lastModel });
        }
        toolResults.push({
          title: 'Previous response was invalid',
          trust: 'trusted',
          priority: 100,
          body: `Your previous response was not valid JSON: ${parsed.error}\nRespond with ONLY the JSON object described in the output contract.`,
        });
        continue;
      }

      const envelope = parsed.value as AgentResponsePayload;
      const actions = envelope.actions ?? [];

      // ---- tool execution ---------------------------------------------------
      if (actions.length) {
        const executor = new ToolExecutor({
          workspace: context.workspace,
          git: context.git,
          logger: this.options.logger,
          agentId: this.agentId,
          task,
          executionMode: this.options.executionMode(),
          grantedApprovals: context.grantedApprovals ?? new Set(),
          requestApproval: context.requestApproval,
          onOutput: context.onOutput,
          signal: context.signal,
        });

        for (const action of actions.slice(0, 6)) {
          if (!role.tools.includes(action.tool as AgentTool)) {
            toolResults.push({
              title: `Tool not permitted: ${action.tool}`,
              trust: 'trusted',
              priority: 90,
              body: `The ${role.name} role is not permitted to use "${action.tool}". Available tools: ${role.tools.join(', ')}.`,
            });
            continue;
          }
          if (context.signal?.aborted) break;

          this.options.events.emit(
            'agent.message',
            { agentId: this.agentId, taskId: task.id, tool: action.tool, args: action.args, purpose: action.purpose },
            {
              message: `${role.name}: ${action.tool}${action.purpose ? ` — ${action.purpose}` : ''}`,
              severity: 'debug',
              projectId: context.projectId,
              taskId: task.id,
              agentId: this.agentId,
            },
          );

          const result = await executor.execute(action.tool as AgentTool, action.args ?? {});
          if (result.executedCommand) shellCommands += 1;
          if (result.changedFiles) changedFiles.push(...result.changedFiles);

          if (result.approval && !result.ok) {
            return {
              taskId: task.id,
              agentId: this.agentId,
              status: 'awaiting_approval',
              result: {
                summary: `Waiting for approval: ${result.approval.action}`,
                artifacts: changedFiles.map((file) => ({ path: file.path, action: file.action })),
                approvalRequest: { action: result.approval.action, reason: result.approval.reason, risk: result.approval.risk },
                tokenUsage: { input: 0, output: tokensUsed },
              },
              modelId: lastModel?.modelId,
              providerId: lastModel?.providerId,
              tokenUsage: { input: 0, output: tokensUsed },
              durationMs: Date.now() - startedMs,
              iterations,
              validated: true,
            };
          }

          toolResults.push({
            title: `${action.tool} → ${result.ok ? 'ok' : 'failed'}`,
            trust: 'untrusted',
            source: `${action.tool} output`,
            kind: 'command_output',
            priority: 75,
            body: result.output,
          });
        }
        continue;
      }

      // ---- completion / blocking -------------------------------------------
      if (envelope.status === 'needs_approval' && envelope.result?.approvalRequest) {
        const request = await context.requestApproval({
          action: envelope.result.approvalRequest.action,
          reason: envelope.result.approvalRequest.reason,
          risk: envelope.result.approvalRequest.risk,
          payload: { taskId: task.id, agentId: this.agentId },
        });
        return {
          taskId: task.id,
          agentId: this.agentId,
          status: 'awaiting_approval',
          result: {
            summary: `Waiting for approval: ${envelope.result.approvalRequest.action}`,
            artifacts: changedFiles.map((file) => ({ path: file.path, action: file.action })),
            approvalRequest: envelope.result.approvalRequest,
            tokenUsage: { input: 0, output: tokensUsed },
          },
          modelId: lastModel?.modelId,
          providerId: lastModel?.providerId,
          tokenUsage: { input: 0, output: tokensUsed },
          durationMs: Date.now() - startedMs,
          iterations,
          validated: true,
          structured: request ? { approvalId: request.id } : undefined,
        };
      }

      if (envelope.status === 'blocked') {
        return this.blocked(context, envelope.blocker || 'The agent reported it was blocked without explaining why.', {
          iterations,
          tokensUsed,
          requests,
          changedFiles,
          startedMs,
          lastModel,
        });
      }

      if (!envelope.result) {
        // "working" with no tool calls and no result is a malformed answer, not a
        // real blocker: re-prompt with a correction once before giving up.
        emptyResponses += 1;
        if (emptyResponses >= 2) {
          return this.blocked(
            context,
            'The model returned neither tool calls nor a result twice in a row; it cannot continue with the available context window.',
            { iterations, tokensUsed, requests, changedFiles, startedMs, lastModel },
          );
        }
        toolResults.push({
          title: 'Empty response',
          trust: 'trusted',
          priority: 100,
          body:
            'Your last response had no "actions" and no "result". Either request the tool calls you need, or return a populated "result" with "status": "completed". Messages that do neither cannot be acted on.',
        });
        continue;
      }

      // The work is finished. Roles whose deliverable is a structured artefact (a
      // plan, an architecture, a test report, a review) hand it in now, validated
      // against their own schema. A failed validation is reported, never faked.
      let structured: unknown = envelope.result.data;
      let artefactWarning: string | null = null;
      if (schemaName !== 'task_result') {
        const artefact = await this.collectArtefact({
          context,
          task,
          roleName: role.name,
          schemaName,
          summary: envelope.result.summary,
          brief: bundle.text,
          changedFiles,
          signal: context.signal,
        });
        requests += artefact.requests;
        tokensUsed += artefact.tokensUsed;
        if (artefact.modelId) lastModel = { modelId: artefact.modelId, providerId: artefact.providerId ?? lastModel?.providerId ?? 'unknown' };
        if (artefact.ok) {
          structured = artefact.value;
        } else {
          artefactWarning = artefact.error;
          this.options.events.emit(
            'system.notice',
            { agentId: this.agentId, taskId: task.id, schema: schemaName, error: artefact.error },
            {
              message: `${role.name} finished "${task.title}" but its ${schemaName} report did not validate: ${artefact.error}`,
              severity: 'warning',
              projectId: context.projectId,
              taskId: task.id,
              agentId: this.agentId,
            },
          );
        }
      }

      // Success: persist findings and decisions into project memory so the rest of
      // the team benefits from them (§14).
      const result: TaskResult = {
        summary: envelope.result.summary,
        artifacts: envelope.result.artifacts?.length ? envelope.result.artifacts : changedFiles.map((file) => ({ path: file.path, action: file.action })),
        testsRun: envelope.result.testsRun,
        findings: envelope.result.findings,
        decisions: envelope.result.decisions,
        data: (structured as Record<string, unknown> | undefined) ?? envelope.result.data,
        tokenUsage: { input: 0, output: tokensUsed },
      };

      for (const decision of result.decisions ?? []) {
        this.options.memory.addDecision(context.projectId, decision, { agentId: this.agentId, taskId: task.id });
      }
      for (const finding of result.findings ?? []) {
        if (finding.severity === 'info' || finding.severity === 'low') continue;
        this.options.memory.addFinding(
          context.projectId,
          {
            title: `${task.title}: ${finding.message.slice(0, 80)}`,
            body: finding.message,
            severity: finding.severity,
            relatedFiles: finding.location ? [finding.location] : changedFiles.map((file) => file.path),
            taskTypes: [task.taskType],
          },
          { agentId: this.agentId, taskId: task.id },
        );
      }

      this.options.events.emit(
        'agent.state_changed',
        { agentId: this.agentId, state: 'idle', taskId: task.id },
        { message: `${role.name} completed "${task.title}"`, projectId: context.projectId, taskId: task.id, agentId: this.agentId },
      );

      return {
        taskId: task.id,
        agentId: this.agentId,
        status: 'completed',
        result,
        modelId: lastModel?.modelId,
        providerId: lastModel?.providerId,
        tokenUsage: { input: 0, output: tokensUsed },
        durationMs: Date.now() - startedMs,
        iterations,
        structured,
        validated: artefactWarning === null,
      };
    }

    // Loop exhausted without a terminal state: this is the runaway guard (§19).
    this.options.events.emit(
      'supervisor.limit_reached',
      { agentId: this.agentId, taskId: task.id, limit: 'maxAgentIterations', iterations },
      {
        message: `${this.role.name} reached the iteration limit (${iterations - 1}) on "${task.title}" and was stopped.`,
        severity: 'warning',
        projectId: context.projectId,
        taskId: task.id,
        agentId: this.agentId,
      },
    );
    return this.blocked(context, `Iteration limit reached (${iterations - 1} model turns without completing the task).`, {
      iterations: iterations - 1,
      tokensUsed,
      requests,
      changedFiles,
      startedMs,
      lastModel,
    });
  }

  // ---------------------------------------------------------------------------

  /**
   * Asks the agent for its role-specific artefact once the work is done.
   *
   * The request carries the same brief plus a summary of what was actually done, and
   * is validated against the role's schema. This is the step that turns "the agent
   * says it finished" into a checked plan / architecture / test report / review.
   */
  private async collectArtefact(input: {
    context: AgentRunContext;
    task: Task;
    roleName: string;
    schemaName: SchemaName;
    summary: string;
    brief: string;
    changedFiles: { path: string; action: string }[];
    signal?: AbortSignal;
  }): Promise<
    | { ok: true; value: unknown; requests: number; tokensUsed: number; modelId: string | null; providerId: string | null }
    | { ok: false; error: string; requests: number; tokensUsed: number; modelId: string | null; providerId: string | null }
  > {
    const role = this.role;
    const schema = schemaFor(input.schemaName);
    const systemMessage = buildSystemMessage({
      role: input.roleName,
      instructions: role.systemPrompt,
      includeUntrustedRule: true,
      outputContract: outputInstructions(input.schemaName),
    });
    const files = input.changedFiles.length ? input.changedFiles.map((file) => `${file.action} ${file.path}`).join(', ') : 'none';
    const user = [
      input.brief,
      '',
      '--- Work already performed ---',
      input.summary,
      `Files changed: ${files}`,
      '',
      `Return ONLY the ${input.schemaName} JSON object now, based strictly on what you actually observed. Do not claim work you did not do.`,
    ].join('\n');

    try {
      const response = await this.options.executor.execute({
        taskRequest: {
          taskType: input.task.taskType,
          prompt: user,
          estimatedInputTokens: Math.max(500, Math.round(input.brief.length / 4)),
          estimatedOutputTokens: 2_000,
          requiredCapabilities: role.modelPreference.requiredCapabilities,
          preferredCapabilities: role.modelPreference.preferCapabilities,
          minContextWindow: role.modelPreference.minContextWindow,
          priority: input.task.priority,
          qualityRequirement: role.modelPreference.qualityRequirement,
          allowTrialCredits: role.modelPreference.allowTrialCredits,
          agentId: this.agentId,
          projectId: input.context.projectId,
        },
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: user },
        ],
        responseFormat: schema.jsonSchema ? { type: 'json_schema', schema: schema.jsonSchema, name: input.schemaName } : { type: 'json_object' },
        projectId: input.context.projectId,
        taskId: input.task.id,
        agentId: this.agentId,
        signal: input.signal,
        maxOutputTokens: 4_000,
      });
      const base = {
        requests: 1,
        tokensUsed: response.usage.totalTokens,
        modelId: response.chosen.modelId,
        providerId: response.chosen.providerId,
      };
      const parsed = this.parseResponse(response.response.content, input.schemaName, false);
      if (!parsed.ok) return { ok: false, error: parsed.error, ...base };
      return { ok: true, value: parsed.value, ...base };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        requests: 1,
        tokensUsed: 0,
        modelId: null,
        providerId: null,
      };
    }
  }

  private parseResponse(
    raw: string,
    schemaName: SchemaName,
    envelope: boolean,
  ): { ok: true; value: unknown } | { ok: false; error: string } {
    const schema = schemaFor(schemaName);
    if (envelope) {
      const extracted = extractJson<unknown>(raw);
      if (extracted.error || extracted.value === null) return { ok: false, error: extracted.error ?? 'empty response' };
      const validated = AgentResponseSchema.safeParse(extracted.value);
      if (!validated.success) {
        return { ok: false, error: `schema validation failed: ${validated.error.issues.slice(0, 4).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
      }
      return { ok: true, value: validated.data };
    }
    const extracted = extractJson<unknown>(raw);
    if (extracted.error || extracted.value === null) return { ok: false, error: extracted.error ?? 'empty response' };
    if (schema.zod) {
      const validated = schema.zod.safeParse(extracted.value);
      if (!validated.success) {
        return { ok: false, error: `schema validation failed: ${validated.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
      }
      return { ok: true, value: validated.data };
    }
    return { ok: true, value: extracted.value };
  }

  /** Best-effort hint so the context builder can size the prompt before routing. */
  private selectModelHint(): ModelInfo | null {
    void this.options;
    return null;
  }

  private blocked(
    context: AgentRunContext,
    reason: string,
    stats: {
      iterations: number;
      tokensUsed: number;
      requests: number;
      changedFiles: { path: string; action: string }[];
      startedMs: number;
      lastModel: { modelId: string; providerId: string } | null;
    },
  ): AgentRunResult {
    this.options.events.emit(
      'task.blocked',
      { agentId: this.agentId, taskId: context.task.id, reason },
      { message: `${this.role.name} blocked on "${context.task.title}": ${reason}`, severity: 'warning', projectId: context.projectId, taskId: context.task.id, agentId: this.agentId },
    );
    return {
      taskId: context.task.id,
      agentId: this.agentId,
      status: 'blocked',
      error: reason,
      result: {
        summary: `Blocked: ${reason}`,
        artifacts: stats.changedFiles.map((file) => ({ path: file.path, action: file.action as 'created' | 'modified' | 'deleted' })),
        tokenUsage: { input: 0, output: stats.tokensUsed },
      },
      modelId: stats.lastModel?.modelId,
      providerId: stats.lastModel?.providerId,
      tokenUsage: { input: 0, output: stats.tokensUsed },
      durationMs: Date.now() - stats.startedMs,
      iterations: stats.iterations,
      validated: false,
    };
  }

  private failed(
    context: AgentRunContext,
    error: string,
    stats: {
      iterations: number;
      tokensUsed: number;
      requests: number;
      changedFiles: { path: string; action: string }[];
      startedMs: number;
      lastModel: { modelId: string; providerId: string } | null;
    },
  ): AgentRunResult {
    return {
      taskId: context.task.id,
      agentId: this.agentId,
      status: 'failed',
      error,
      modelId: stats.lastModel?.modelId,
      providerId: stats.lastModel?.providerId,
      tokenUsage: { input: 0, output: stats.tokensUsed },
      durationMs: Date.now() - stats.startedMs,
      iterations: stats.iterations,
      validated: false,
    };
  }

  protected newTraceId(): string {
    return randomUUID();
  }

  /** Architecture helpers used by the planner. */
  static asArchitecture(value: unknown): ArchitectureProposal | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as ArchitectureProposal;
    if (!candidate.summary || !Array.isArray(candidate.stack)) return null;
    return candidate;
  }
}
