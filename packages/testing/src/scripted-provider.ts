import {
  ProviderError,
  type ChatChunk,
  type ChatRequest,
  type ChatResponse,
  type ErrorCategory,
  type CredentialStatus,
  type ModelInfo,
  type QuotaType,
  type ProviderDefinition,
  type UsageInfo,
} from '@aido/types';
import { BaseProvider, type ProviderConstructorOptions } from '@aido/ai-core';
import { buildModelInfo } from '@aido/providers';

/**
 * Scripted provider for failure testing (§48).
 *
 * Every failure mode the master prompt requires us to test — timeouts, 429s, quota
 * exhaustion, invalid keys, unavailable models, network failures, malformed
 * responses, context overflow — is scripted here so it is reproducible and fast.
 * The provider never claims to be real: it is only ever constructed in tests.
 */

export type ScriptedOutcome =
  | { kind: 'success'; content?: string; inputTokens?: number; outputTokens?: number; latencyMs?: number }
  | { kind: 'stream'; deltas: string[]; usage?: { inputTokens: number; outputTokens: number }; failAfterDeltas?: number }
  | { kind: 'error'; category: ErrorCategory; message?: string; retryAfterMs?: number; status?: number }
  | { kind: 'timeout'; afterMs?: number }
  | { kind: 'malformed'; content: string }
  | { kind: 'context_length'; limit: number }
  | { kind: 'models'; models: { id: string; displayName?: string; contextWindow?: number; maxOutputTokens?: number }[] }
  | { kind: 'no_models' }
  | { kind: 'invalid_key' }
  | { kind: 'delay'; ms: number; then?: ScriptedOutcome };

export interface ScriptedProviderOptions extends Omit<ProviderConstructorOptions, 'resolveCredential'> {
  /** Never needed: the scripted provider performs no network calls. */
  resolveCredential?: ProviderConstructorOptions['resolveCredential'];
  outcomes: ScriptedOutcome[];
  /** Loop the script instead of exhausting it. */
  repeat?: boolean;
  /** How the provider reports its quota; drives FREE ONLY routing decisions. */
  quotaType?: QuotaType;
}

export class ScriptedProvider extends BaseProvider {
  private readonly queue: ScriptedOutcome[];
  private readonly repeat: boolean;
  /** Every request that actually reached the provider, for assertions. */
  readonly received: ChatRequest[] = [];
  private cursor = 0;

  constructor(options: ScriptedProviderOptions) {
    super({ ...options, resolveCredential: options.resolveCredential ?? (() => null) }, {
      streaming: true,
      modelDiscovery: true,
      usageReporting: true,
      rateLimitTelemetry: true,
      tools: false,
      jsonMode: true,
    });
    this.queue = [...options.outcomes];
    this.repeat = options.repeat ?? false;
  }

  private next(request: ChatRequest): ScriptedOutcome {
    this.received.push(request);
    if (!this.queue.length) return { kind: 'success' };
    const index = this.repeat ? this.cursor % this.queue.length : Math.min(this.cursor, this.queue.length - 1);
    this.cursor += 1;
    return this.queue[index]!;
  }

  override async listModels(): Promise<ModelInfo[]> {
    const outcome = this.queue.find((entry) => entry.kind === 'models' || entry.kind === 'no_models');
    if (outcome?.kind === 'no_models') return [];
    // Falls back to the definition's seed models, which is what a provider whose
    // catalogue is declared in config should do.
    const declared =
      outcome?.kind === 'models'
        ? outcome.models
        : (this.definition.seedModels ?? []).map((seed) => ({
            id: seed.id,
            displayName: seed.displayName,
            contextWindow: seed.contextWindow ?? 32_768,
            maxOutputTokens: seed.maxOutputTokens ?? 4_096,
          }));
    return declared.map((model) =>
      buildModelInfo({
        definition: this.definition,
        providerModelId: model.id,
        displayName: model.displayName ?? model.id,
        context: {
          definition: this.definition,
          contextWindow: model.contextWindow ?? 32_768,
          maxOutputTokens: model.maxOutputTokens ?? 4_096,
          capabilities: { streaming: true, jsonMode: true, structuredOutput: true },
          pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0, source: 'user_configured' },
          metadata: {},
        },
        status: 'online',
      }),
    );
  }

  override async validateCredentials(): Promise<CredentialStatus> {
    if (this.queue.some((entry) => entry.kind === 'invalid_key')) {
      return { state: 'invalid', checkedAt: new Date().toISOString(), detail: '401 Unauthorized (scripted)' };
    }
    return { state: 'valid', checkedAt: new Date().toISOString(), detail: 'Scripted credentials accepted.' };
  }

  override async getUsage(): Promise<UsageInfo> {
    return {
      requestsToday: this.received.length,
      tokensToday: this.received.length * 150,
      provenance: { source: 'api_reported', confidence: 1, note: 'Counted locally by the scripted test provider.', observedAt: new Date().toISOString() },
    };
  }

  override async chat(request: ChatRequest): Promise<ChatResponse> {
    const outcome = this.next(request);
    return this.respond(outcome, request);
  }

  override async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const outcome = this.next(request);
    if (outcome.kind === 'stream') {
      let emitted = 0;
      for (const delta of outcome.deltas) {
        if (outcome.failAfterDeltas !== undefined && emitted >= outcome.failAfterDeltas) {
          throw new ProviderError({
            category: 'server_error',
            message: 'Scripted mid-stream failure.',
            providerId: this.id,
            modelId: request.modelId,
          });
        }
        emitted += 1;
        yield { traceId: request.traceId, delta };
      }
      yield { traceId: request.traceId, delta: '', finishReason: 'stop', usage: { inputTokens: outcome.usage?.inputTokens ?? 10, outputTokens: outcome.usage?.outputTokens ?? 20, totalTokens: (outcome.usage?.inputTokens ?? 10) + (outcome.usage?.outputTokens ?? 20), estimated: false } };
      return;
    }
    const response = await this.respond(outcome, request);
    yield { traceId: request.traceId, delta: response.content };
    yield { traceId: request.traceId, delta: '', finishReason: 'stop', usage: response.usage };
  }

  private async respond(outcome: ScriptedOutcome, request: ChatRequest): Promise<ChatResponse> {
    switch (outcome.kind) {
      case 'delay':
        await new Promise((resolve) => setTimeout(resolve, outcome.ms));
        return this.respond(outcome.then ?? { kind: 'success' }, request);

      case 'timeout': {
        await new Promise((resolve) => setTimeout(resolve, outcome.afterMs ?? 5_000));
        throw new ProviderError({ category: 'timeout', message: 'Scripted timeout.', providerId: this.id, modelId: request.modelId });
      }

      case 'error':
        throw new ProviderError({
          category: outcome.category,
          message: outcome.message ?? `Scripted ${outcome.category}.`,
          providerId: this.id,
          modelId: request.modelId,
          retryAfterMs: outcome.retryAfterMs ?? null,
        });

      case 'malformed':
        return this.ok(request, outcome.content);

      case 'context_length':
        throw new ProviderError({
          category: 'context_length',
          message: `Scripted context overflow: input exceeds ${outcome.limit} tokens.`,
          providerId: this.id,
          modelId: request.modelId,
        });

      case 'models':
      case 'no_models':
      case 'invalid_key':
        return this.ok(request, 'Scripted response.');

      case 'stream':
        return this.ok(request, outcome.deltas.join(''), {
          inputTokens: outcome.usage?.inputTokens ?? 10,
          outputTokens: outcome.usage?.outputTokens ?? 20,
        });

      case 'success':
      default:
        return this.ok(request, outcome.content ?? 'Scripted success.', {
          inputTokens: outcome.inputTokens ?? 120,
          outputTokens: outcome.outputTokens ?? 60,
        });
    }
  }

  private ok(request: ChatRequest, content: string, usage?: { inputTokens: number; outputTokens: number }): ChatResponse {
    const input = usage?.inputTokens ?? 120;
    const output = usage?.outputTokens ?? 60;
    return {
      traceId: request.traceId,
      providerId: this.id,
      modelId: request.modelId,
      content,
      finishReason: 'stop',
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, estimated: usage === undefined },
      latencyMs: 12,
      telemetry: { requestsRemaining: 99, tokensRemaining: 9_999, resetRequests: '60s', resetTokens: '60s' },
    };
  }
}
