import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  type AppSettings,
  type ChatChunk,
  type ChatRequest,
  type ChatResponse,
  type ErrorCategory,
  type LLMTrace,
  type ModelInfo,
  type RoutingRationale,
  type TaskRequest,
} from '@aido/types';
import type { EventBus, Logger } from '@aido/observability';
import type { Store } from '@aido/storage';
import type { QuotaManager } from '@aido/quota-engine';
import type { ProviderRegistry } from '@aido/providers';
import type { LLMProvider } from '@aido/ai-core';
import { withRetry, type RetryPolicy } from '@aido/ai-core';
import { estimateCostUsd } from './scoring.js';
import type { ModelRouter, RoutingDecision, ScoredCandidate } from './router.js';

/**
 * LLM Executor: model selection + quota reservation + failover + tracing (§19, §20, §32).
 *
 * Failover contract:
 *  - a failure that occurs *before any token is emitted* triggers the next model in
 *    the routing chain,
 *  - a failure *after* tokens have been streamed cannot be retried transparently
 *    (the consumer already saw partial output), so it is reported as an error and
 *    recorded against the model's reliability — retrying would duplicate output,
 *  - retryable categories are retried on the same model first (with backoff and
 *    provider-supplied retry-after), because switching model for a transient 503
 *    is more expensive than waiting,
 *  - non-retryable categories (auth, invalid request, context length) fail over
 *    immediately without wasting a second request.
 */

/**
 * Error categories that apply to every model of a provider rather than to the one
 * model that happened to receive the request.
 */
const PROVIDER_WIDE_FAILURES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'authentication',
  'network_error',
  'quota_exhausted',
]);

export interface ExecuteOptions {
  taskRequest: TaskRequest;
  messages: ChatRequest['messages'];
  modelId?: string | null;
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: ChatRequest['responseFormat'];
  tools?: ChatRequest['tools'];
  stop?: string[];
  /** Correlates the request with a task/agent for tracing. */
  projectId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  /** Cancels the request (run stop / pause). */
  signal?: AbortSignal;
  /** Streaming only: receive each delta. */
  onChunk?: (delta: string, cumulative: string) => void;
  /** Override the failover chain length (defaults to the policy's). */
  maxFailovers?: number;
  /** Extra seconds to add to the timeout. */
  timeoutMs?: number;
}

export interface ExecuteResult {
  response: ChatResponse;
  decision: RoutingDecision;
  chosen: ScoredCandidate;
  attempts: {
    modelId: string;
    providerId: string;
    /** null = the candidate was not tried at all (see `skipped`). */
    category: ErrorCategory | null;
    message: string | null;
    durationMs: number;
    /** True when the candidate was deliberately not attempted. */
    skipped?: boolean;
  }[];
  reservationId: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimated: boolean };
}

export interface ExecutorOptions {
  store: Store;
  registry: ProviderRegistry;
  quota: QuotaManager;
  router: ModelRouter;
  events: EventBus;
  settings: () => AppSettings;
  logger: Logger;
  retryPolicy?: Partial<RetryPolicy>;
  now?: () => Date;
}

export class LLMExecutor {
  constructor(private readonly options: ExecutorOptions) {}

  // -------------------------------------------------------------------------
  // Non-streaming
  // -------------------------------------------------------------------------

  async execute(input: ExecuteOptions): Promise<ExecuteResult> {
    const decision = this.decideFor(input);
    if (!decision.selected) {
      this.options.events.emit(
        'router.rejected',
        { rationale: decision.rationale },
        {
          message: `No eligible model for ${input.taskRequest.taskType}: ${describeNoModel(decision)}`,
          projectId: input.projectId ?? null,
          taskId: input.taskId ?? null,
          agentId: input.agentId ?? null,
          severity: 'error',
        },
      );
      throw new ProviderError({
        category: 'model_unavailable',
        message: `No eligible model could be selected for task type "${input.taskRequest.taskType}". ${describeNoModel(decision)}`,
        providerId: 'router',
      });
    }

    const chain = this.limitChain(decision, input.maxFailovers);
    // Providers that just failed in a provider-wide way (bad key, network outage,
    // shared account quota). Retrying a sibling model cannot help and wastes quota.
    const skipProviders = new Set<string>();
    const attempts: ExecuteResult['attempts'] = [];
    let lastError: ProviderError | null = null;

    for (let index = 0; index < chain.length; index += 1) {
      const candidate = chain[index]!;
      if (skipProviders.has(candidate.providerId)) {
        attempts.push({
          modelId: candidate.modelId,
          providerId: candidate.providerId,
          category: null,
          skipped: true,
          message: 'not attempted: another model on this provider already failed in a provider-wide way',
          durationMs: 0,
        });
        continue;
      }

      const provider = this.options.registry.provider(candidate.providerId);
      if (!provider) {
        attempts.push({ modelId: candidate.modelId, providerId: candidate.providerId, category: 'model_unavailable', message: 'No adapter registered', durationMs: 0 });
        continue;
      }

      const decisionForCandidate = { ...decision, selected: candidate, rationale: { ...decision.rationale, selectedModelId: candidate.modelId, components: candidate.components, positives: candidate.positives, negatives: candidate.negatives } };

      const reservation = this.reserveQuota(candidate, input, decisionForCandidate.rationale);
      if (!reservation.allowed) {
        attempts.push({ modelId: candidate.modelId, providerId: candidate.providerId, category: 'quota_exhausted', message: reservation.reason, durationMs: 0 });
        this.options.events.emit(
          'quota.reservation_denied',
          { providerId: candidate.providerId, modelId: candidate.modelId, reason: reservation.reason },
          {
            message: `Skipped ${candidate.model.displayName}: ${reservation.reason}`,
            severity: 'warning',
            projectId: input.projectId ?? null,
            taskId: input.taskId ?? null,
            agentId: input.agentId ?? null,
          },
        );
        continue;
      }

      const traceId = randomUUID();
      const startedAt = this.now().toISOString();
      const started = Date.now();
      this.options.store.traces.insert(
        baseTrace({
          traceId,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          input,
          startedAt,
          attempt: index + 1,
          failoverDepth: index,
          rationale: decisionForCandidate.rationale,
          quotaBefore: quotaSnapshotFor(candidate),
        }),
      );
      this.options.events.emit(
        'llm.request_started',
        { traceId, providerId: candidate.providerId, modelId: candidate.modelId, taskType: input.taskRequest.taskType, attempt: index + 1 },
        {
          message: `Calling ${candidate.model.displayName} via ${candidate.providerId} (attempt ${index + 1}/${chain.length})`,
          severity: 'debug',
          projectId: input.projectId ?? null,
          taskId: input.taskId ?? null,
          agentId: input.agentId ?? null,
          traceId,
        },
      );

      try {
        const response = await this.callWithRetry(provider, candidate, input, traceId);
        const durationMs = Date.now() - started;

        this.options.quota.commit(reservation.reservationId, {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        });
        this.afterSuccess(candidate, response, input, traceId, decisionForCandidate.rationale);
        this.options.store.traces.finish(traceId, {
          finishedAt: this.now().toISOString(),
          latencyMs: durationMs,
          usage: response.usage,
          status: 'success',
          telemetry: response.telemetry,
          errorCategory: null,
          errorMessage: null,
          failoverDepth: index,
          costEstimateUsd: estimateCostUsd(candidate.model, response.usage.inputTokens, response.usage.outputTokens),
        });
        this.options.events.emit(
          'llm.request_completed',
          { traceId, providerId: candidate.providerId, modelId: candidate.modelId, usage: response.usage, latencyMs: durationMs },
          {
            message: `${candidate.model.displayName} responded in ${(durationMs / 1000).toFixed(2)}s (${response.usage.inputTokens} in / ${response.usage.outputTokens} out)${response.usage.estimated ? ' [estimated]' : ''}`,
            severity: 'debug',
            projectId: input.projectId ?? null,
            taskId: input.taskId ?? null,
            agentId: input.agentId ?? null,
            traceId,
          },
        );

        attempts.push({ modelId: candidate.modelId, providerId: candidate.providerId, category: null, message: null, durationMs });
        return {
          response,
          decision,
          chosen: candidate,
          attempts,
          reservationId: reservation.reservationId,
          usage: {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            totalTokens: response.usage.totalTokens,
            estimated: response.usage.estimated,
          },
        };
      } catch (err) {
        const error = err instanceof ProviderError ? err : new ProviderError({ category: 'unknown', message: err instanceof Error ? err.message : String(err), providerId: candidate.providerId, modelId: candidate.modelId, cause: err });
        const durationMs = Date.now() - started;
        lastError = error;
        attempts.push({ modelId: candidate.modelId, providerId: candidate.providerId, category: error.category, message: error.message, durationMs });

        // No output was produced, so the reservation must be returned untouched.
        this.options.quota.release(reservation.reservationId);
        this.options.quota.recordFailure(candidate.providerId, error);
        this.options.router.recordOutcome({
          providerId: candidate.providerId,
          modelId: candidate.model.providerModelId,
          taskType: input.taskRequest.taskType,
          outcome: 'failure',
          latencyMs: durationMs,
        });
        this.recordFailureMetrics(candidate, error);
        this.options.store.traces.finish(traceId, {
          finishedAt: this.now().toISOString(),
          latencyMs: durationMs,
          status: error.category === 'timeout' ? 'timeout' : error.category === 'quota_exhausted' ? 'rejected_by_quota' : 'error',
          errorCategory: error.category,
          errorMessage: error.message,
          failoverDepth: index,
        });
        this.options.events.emit(
          'llm.request_failed',
          { traceId, providerId: candidate.providerId, modelId: candidate.modelId, category: error.category, message: error.message, attempts: attempts.length },
          {
            message: `${candidate.model.displayName} failed (${error.category}): ${error.message}`,
            severity: error.category === 'cancelled' ? 'info' : 'warning',
            projectId: input.projectId ?? null,
            taskId: input.taskId ?? null,
            agentId: input.agentId ?? null,
            traceId,
          },
        );

        if (error.category === 'cancelled' || input.signal?.aborted) throw error;

        // Provider-wide failures: another model of the same provider would hit the
        // same wall (invalid key, network outage, shared account quota).
        if (PROVIDER_WIDE_FAILURES.has(error.category)) {
          skipProviders.add(candidate.providerId);
          this.options.logger.warn('skipping the remaining models of a provider after a provider-wide failure', {
            providerId: candidate.providerId,
            category: error.category,
          });
        }

        const next = chain[index + 1];
        if (!next) throw error;
        this.options.events.emit(
          'llm.failover',
          { from: candidate.modelId, to: next.modelId, category: error.category },
          {
            message: `Failing over from ${candidate.model.displayName} to ${next.model.displayName} after ${error.category}`,
            severity: 'warning',
            projectId: input.projectId ?? null,
            taskId: input.taskId ?? null,
            agentId: input.agentId ?? null,
          },
        );
      }
    }

    // If every attempt failed the same way, surface that category: the caller
    // (agent loop, supervisor, UI) needs to distinguish "no model available" from
    // "the key is invalid" to decide whether retrying is even meaningful.
    const failures = attempts.filter((attempt) => !attempt.skipped && attempt.category !== null);
    const distinct = new Set(failures.map((attempt) => attempt.category));
    const category: ErrorCategory = distinct.size === 1 ? [...distinct][0]! : 'model_unavailable';
    throw new ProviderError({
      category,
      message: `Every candidate model failed. Attempts: ${attempts.map((a) => `${a.modelId} (${a.category ?? 'ok'})`).join(', ')}`,
      providerId: attempts[0]?.providerId ?? 'router',
      cause: lastError ?? undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Streaming
  // -------------------------------------------------------------------------

  /**
   * Streams a completion. Failover is possible until the first delta is emitted;
   * after that the call is committed to one model (documented behaviour rather
   * than a silent gap).
   */
  async *stream(input: ExecuteOptions): AsyncIterable<{ delta: string; done: boolean; usage?: ChatResponse['usage']; traceId?: string }> {
    const decision = this.decideFor(input);
    if (!decision.selected) {
      throw new ProviderError({
        category: 'model_unavailable',
        message: `No eligible model could be selected for task type "${input.taskRequest.taskType}". ${describeNoModel(decision)}`,
        providerId: 'router',
      });
    }

    const chain = this.limitChain(decision, input.maxFailovers);
    let lastError: ProviderError | null = null;

    for (let index = 0; index < chain.length; index += 1) {
      const candidate = chain[index]!;
      const provider = this.options.registry.provider(candidate.providerId);
      if (!provider) {
        lastError = new ProviderError({ category: 'model_unavailable', message: 'No adapter registered', providerId: candidate.providerId, modelId: candidate.modelId });
        continue;
      }
      const rationale: RoutingRationale = {
        ...decision.rationale,
        selectedModelId: candidate.modelId,
        components: candidate.components,
        positives: candidate.positives,
        negatives: candidate.negatives,
      };
      const reservation = this.reserveQuota(candidate, input, rationale);
      if (!reservation.allowed) {
        lastError = new ProviderError({ category: 'quota_exhausted', message: reservation.reason, providerId: candidate.providerId, modelId: candidate.modelId });
        continue;
      }

      const traceId = randomUUID();
      const startedAt = this.now().toISOString();
      const started = Date.now();
      this.options.store.traces.insert(
        baseTrace({ traceId, providerId: candidate.providerId, modelId: candidate.modelId, input, startedAt, attempt: index + 1, failoverDepth: index, rationale, quotaBefore: quotaSnapshotFor(candidate) }),
      );

      let emitted = false;
      let cumulative = '';
      let finalUsage: ChatResponse['usage'] | null = null;
      let telemetry: ChatResponse['telemetry'] | undefined;
      // Per-stream, not per-instance: concurrent streams on one executor used to
      // clobber each other's first-token measurement.
      let firstTokenAt: number | null = null;

      try {
        for await (const chunk of provider.stream(this.buildRequest(input, candidate, traceId))) {
          if (chunk.telemetry && Object.keys(chunk.telemetry).length) telemetry = chunk.telemetry;
          if (chunk.usage) finalUsage = chunk.usage;
          if (chunk.delta) {
            if (!emitted) {
              emitted = true;
              firstTokenAt = Date.now();
            }
            cumulative += chunk.delta;
            input.onChunk?.(chunk.delta, cumulative);
            yield { delta: chunk.delta, done: false, traceId };
          }
        }

        const durationMs = Date.now() - started;
        const usage = finalUsage ?? {
          inputTokens: estimateTokensSafe(provider, input),
          outputTokens: 0,
          totalTokens: estimateTokensSafe(provider, input),
          estimated: true,
        };
        this.options.quota.commit(reservation.reservationId, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });

        const synthetic: ChatResponse = {
          traceId,
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          content: cumulative,
          finishReason: 'stop',
          usage,
          latencyMs: durationMs,
          telemetry,
        };
        this.afterSuccess(candidate, synthetic, input, traceId, rationale);
        this.options.store.traces.finish(traceId, {
          finishedAt: this.now().toISOString(),
          latencyMs: durationMs,
          firstTokenLatencyMs: firstTokenAt !== null ? firstTokenAt - started : null,
          usage,
          status: 'success',
          telemetry,
          streamed: true,
          failoverDepth: index,
          costEstimateUsd: estimateCostUsd(candidate.model, usage.inputTokens, usage.outputTokens),
        });
        yield { delta: '', done: true, usage, traceId };
        return;
      } catch (err) {
        const error = err instanceof ProviderError ? err : new ProviderError({ category: 'unknown', message: err instanceof Error ? err.message : String(err), providerId: candidate.providerId, modelId: candidate.modelId, cause: err });
        lastError = error;
        this.options.quota.release(reservation.reservationId);
        this.options.quota.recordFailure(candidate.providerId, error);
        this.options.router.recordOutcome({
          providerId: candidate.providerId,
          modelId: candidate.model.providerModelId,
          taskType: input.taskRequest.taskType,
          outcome: 'failure',
          latencyMs: Date.now() - started,
        });
        this.options.store.traces.finish(traceId, {
          finishedAt: this.now().toISOString(),
          latencyMs: Date.now() - started,
          status: error.category === 'timeout' ? 'timeout' : 'error',
          errorCategory: error.category,
          errorMessage: error.message,
          streamed: true,
          failoverDepth: index,
        });

        if (emitted) {
          // Partial output already delivered: switching models now would duplicate
          // or contradict what the consumer has seen. Surface the failure instead.
          this.options.events.emit(
            'llm.request_failed',
            { traceId, providerId: candidate.providerId, modelId: candidate.modelId, category: error.category, message: error.message, partial: true },
            {
              message: `Stream failed after ${cumulative.length} characters from ${candidate.model.displayName}: ${error.message}`,
              severity: 'error',
              projectId: input.projectId ?? null,
              taskId: input.taskId ?? null,
              agentId: input.agentId ?? null,
              traceId,
            },
          );
          throw error;
        }
        if (error.category === 'cancelled' || input.signal?.aborted) throw error;
      }
    }

    throw lastError ?? new ProviderError({ category: 'model_unavailable', message: 'No candidate model could serve the streaming request.', providerId: 'router' });
  }


  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private decideFor(input: ExecuteOptions): RoutingDecision {
    if (input.modelId) {
      // Pinned model (used by the "try this model" action and by tests).
      const model = this.options.store.models.get(input.modelId) ?? null;
      if (model) {
        const decision = this.options.router.decide({ taskRequest: input.taskRequest, settings: this.options.settings() });
        const pinned = decision.chain.find((c) => c.modelId === model.id) ?? null;
        if (pinned) return { ...decision, chain: [pinned, ...decision.chain.filter((c) => c.modelId !== model.id)], selected: pinned };
      }
    }
    return this.options.router.decide({ taskRequest: input.taskRequest, settings: this.options.settings() });
  }

  private limitChain(decision: RoutingDecision, maxFailovers?: number): ScoredCandidate[] {
    if (!decision.selected) return [];
    const limit = maxFailovers !== undefined ? maxFailovers + 1 : decision.chain.length;
    return decision.chain.slice(0, Math.max(1, limit));
  }

  private reserveQuota(
    candidate: ScoredCandidate,
    input: ExecuteOptions,
    rationale: RoutingRationale,
  ): { allowed: true; reservationId: string } | { allowed: false; reason: string } {
    const decision = this.options.quota.check({
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      estimatedInputTokens: input.taskRequest.estimatedInputTokens,
      estimatedOutputTokens: input.taskRequest.estimatedOutputTokens,
      model: candidate.model,
    });
    if (decision.allowed) {
      this.options.events.emit(
        'quota.updated',
        { providerId: candidate.providerId, reservationId: decision.reservation.id, estimatedTokens: decision.reservation.estimatedTokens },
        {
          message: `Reserved ~${decision.reservation.estimatedTokens.toLocaleString()} tokens on ${candidate.providerId} for ${candidate.model.displayName}`,
          severity: 'debug',
          traceId: decision.reservation.traceId,
          projectId: input.projectId ?? null,
          taskId: input.taskId ?? null,
          agentId: input.agentId ?? null,
        },
      );
      void rationale;
      return { allowed: true, reservationId: decision.reservation.id };
    }
    return { allowed: false, reason: decision.reason };
  }

  private async callWithRetry(provider: LLMProvider, candidate: ScoredCandidate, input: ExecuteOptions, traceId: string): Promise<ChatResponse> {
    const request = this.buildRequest(input, candidate, traceId);
    return withRetry(
      async (attempt) => {
        if (attempt > 1) {
          this.options.events.emit(
            'llm.request_started',
            { traceId, providerId: candidate.providerId, modelId: candidate.modelId, retryAttempt: attempt },
            {
              message: `Retrying ${candidate.model.displayName} (attempt ${attempt})`,
              severity: 'debug',
              projectId: input.projectId ?? null,
              taskId: input.taskId ?? null,
              agentId: input.agentId ?? null,
              traceId,
            },
          );
        }
        return provider.chat(request);
      },
      {
        policy: this.options.retryPolicy,
        signal: input.signal,
      },
    );
  }

  /**
   * Downgrades a requested response format to what the chosen model actually
   * supports. Asking a model for `json_schema` when it cannot do it wastes a
   * request (or fails outright) on a free quota, and the prompt already carries
   * the output contract, so this is a pure win.
   */
  private adaptResponseFormat(
    requested: ChatRequest['responseFormat'],
    model: ModelInfo,
  ): ChatRequest['responseFormat'] {
    if (!requested || requested.type === 'text') return requested;
    const capabilities = model.capabilities ?? {};
    if (requested.type === 'json_schema') {
      if (capabilities.structuredOutput === true) return requested;
      if (capabilities.jsonMode === true) return { type: 'json_object' };
      return undefined;
    }
    if (requested.type === 'json_object') {
      return capabilities.jsonMode === true || capabilities.structuredOutput === true ? requested : undefined;
    }
    return requested;
  }

  private buildRequest(input: ExecuteOptions, candidate: ScoredCandidate, traceId: string): ChatRequest {
    return {
      modelId: candidate.model.providerModelId,
      messages: input.messages,
      temperature: input.temperature,
      maxOutputTokens: input.maxOutputTokens,
      responseFormat: this.adaptResponseFormat(input.responseFormat, candidate.model),
      tools: input.tools,
      stop: input.stop,
      traceId,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      timeoutMs: input.timeoutMs,
      collectTelemetry: true,
    };
  }

  private afterSuccess(
    candidate: ScoredCandidate,
    response: ChatResponse,
    input: ExecuteOptions,
    traceId: string,
    rationale: RoutingRationale,
  ): void {
    const settings = this.options.settings();
    let providerReportsExhaustion = false;
    if (settings.quota.learnFromHeaders && response.telemetry && Object.keys(response.telemetry).length) {
      try {
        const ingested = this.options.quota.ingestTelemetry({
          providerId: candidate.providerId,
          modelId: candidate.model.providerModelId,
          telemetry: response.telemetry,
        });
        providerReportsExhaustion = ingested.exhausted;
      } catch (err) {
        this.options.logger.warn('failed to ingest rate-limit telemetry', {
          providerId: candidate.providerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // A successful call proves the provider is usable again — unless it also reported
    // that nothing is left, in which case clearing the cooldown would undo the stop the
    // header just asked for.
    if (!providerReportsExhaustion) this.options.quota.clearCooldown(candidate.providerId);
    this.options.router.recordOutcome({
      providerId: candidate.providerId,
      modelId: candidate.model.providerModelId,
      taskType: input.taskRequest.taskType,
      outcome: 'success',
      latencyMs: response.latencyMs,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    });

    // Update the model's rolling performance so the router keeps learning.
    const previous = candidate.model.performance;
    const alpha = 0.25;
    this.options.store.models.updatePerformance(candidate.modelId, {
      averageLatency: previous.averageLatency === null ? response.latencyMs : previous.averageLatency * (1 - alpha) + response.latencyMs * alpha,
      averageFirstTokenLatency:
        response.firstTokenLatencyMs === undefined
          ? previous.averageFirstTokenLatency
          : previous.averageFirstTokenLatency === null
            ? response.firstTokenLatencyMs
            : previous.averageFirstTokenLatency * (1 - alpha) + response.firstTokenLatencyMs * alpha,
      throughput:
        response.latencyMs > 0
          ? (response.usage.outputTokens / response.latencyMs) * 1000
          : previous.throughput,
      successRate: previous.successRate === null ? 1 : previous.successRate * (1 - alpha) + alpha,
      samples: previous.samples + 1,
    });
    this.options.store.models.setStatus(candidate.modelId, 'online');

    const bucketKey = bucketFor(this.now());
    this.options.store.metrics.recordMany([
      { scope: 'model', scopeId: candidate.modelId, metric: 'llm_input_tokens', value: response.usage.inputTokens, unit: 'tokens', at: startedIso(this.now()), bucket: bucketKey },
      { scope: 'model', scopeId: candidate.modelId, metric: 'llm_output_tokens', value: response.usage.outputTokens, unit: 'tokens', at: startedIso(this.now()), bucket: bucketKey },
      { scope: 'model', scopeId: candidate.modelId, metric: 'llm_latency_ms', value: response.latencyMs, unit: 'ms', at: startedIso(this.now()), bucket: bucketKey },
      { scope: 'provider', scopeId: candidate.providerId, metric: 'llm_requests', value: 1, unit: 'requests', at: startedIso(this.now()), bucket: bucketKey },
      { scope: 'provider', scopeId: candidate.providerId, metric: 'llm_tokens', value: response.usage.totalTokens, unit: 'tokens', at: startedIso(this.now()), bucket: bucketKey },
      ...(input.agentId
        ? ([{ scope: 'agent', scopeId: input.agentId, metric: 'llm_tokens', value: response.usage.totalTokens, unit: 'tokens', at: startedIso(this.now()), bucket: bucketKey }] as const)
        : []),
    ]);
    void rationale;
    void traceId;
  }

  private recordFailureMetrics(candidate: ScoredCandidate, error: ProviderError): void {
    const bucketKey = bucketFor(this.now());
    this.options.store.metrics.record({
      scope: 'provider',
      scopeId: candidate.providerId,
      metric: 'llm_errors',
      value: 1,
      unit: 'errors',
      at: startedIso(this.now()),
      bucket: bucketKey,
    });
    this.options.store.metrics.record({
      scope: 'model',
      scopeId: candidate.modelId,
      metric: `llm_error_${error.category}`,
      value: 1,
      unit: 'errors',
      at: startedIso(this.now()),
      bucket: bucketKey,
    });
    const previous = candidate.model.performance;
    this.options.store.models.updatePerformance(candidate.modelId, {
      ...previous,
      successRate: previous.successRate === null ? 0 : previous.successRate * 0.75,
      samples: previous.samples + 1,
    });
    if (error.category === 'model_unavailable') this.options.store.models.setStatus(candidate.modelId, 'offline');
    else if (error.category === 'server_error' || error.category === 'timeout') this.options.store.models.setStatus(candidate.modelId, 'degraded');
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function baseTrace(input: {
  traceId: string;
  providerId: string;
  modelId: string;
  input: ExecuteOptions;
  startedAt: string;
  attempt: number;
  failoverDepth: number;
  rationale: RoutingRationale;
  quotaBefore: LLMTrace['quotaBefore'];
}): LLMTrace {
  return {
    traceId: input.traceId,
    projectId: input.input.projectId ?? null,
    taskId: input.input.taskId ?? null,
    agentId: input.input.agentId ?? null,
    providerId: input.providerId,
    modelId: input.modelId,
    taskType: input.input.taskRequest.taskType,
    startedAt: input.startedAt,
    finishedAt: null,
    latencyMs: null,
    firstTokenLatencyMs: null,
    usage: null,
    status: 'success',
    errorCategory: null,
    errorMessage: null,
    attempt: input.attempt,
    failoverDepth: input.failoverDepth,
    quotaBefore: input.quotaBefore,
    quotaAfter: null,
    telemetry: null,
    routingRationale: input.rationale,
    streamed: false,
    costEstimateUsd: null,
  };
}

function quotaSnapshotFor(candidate: ScoredCandidate): LLMTrace['quotaBefore'] {
  return {
    requestsRemaining: candidate.model.quota.requestsPerDay,
    tokensRemaining: candidate.model.quota.tokensPerDay,
  };
}

function describeNoModel(decision: RoutingDecision): string {
  if (!decision.rationale.rejected.length) return 'No models are enabled in the catalogue.';
  const counts = new Map<string, number>();
  for (const rejection of decision.rationale.rejected) {
    for (const reason of rejection.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => `${count}× ${reason}`)
    .join('; ');
}

function estimateTokensSafe(provider: LLMProvider, input: ExecuteOptions): number {
  void provider;
  // Rough character-based fallback when a provider returns no usage for a stream.
  const characters = input.messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.ceil(characters / 4) + 32;
}

function bucketFor(now: Date): string {
  return `${now.toISOString().slice(0, 13)}:00:00Z`;
}

function startedIso(now: Date): string {
  return now.toISOString();
}
