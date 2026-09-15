import {
  ProviderError,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ModelCapabilities,
  type ModelInfo,
  type ResponseFormat,
  type TokenUsage,
} from '@aido/types';
import type { LLMProviderCapabilities } from '@aido/types';
import { BaseProvider, type ProviderConstructorOptions } from '@aido/ai-core';
import { buildModelInfo } from '../model-factory.js';

/**
 * Adapter for the OpenAI-compatible `/chat/completions` surface.
 *
 * Used by Groq, OpenRouter, Cerebras, Mistral, Cloudflare Workers AI, NVIDIA NIM,
 * Hugging Face router and Cohere's compatibility endpoint — i.e. the majority of
 * current free-tier providers. Provider-specific differences are expressed as
 * constructor flags rather than subclasses, so adding one of these providers is a
 * registry entry plus a config file, not new code (§52).
 */

export interface OpenAiCompatibleOptions extends ProviderConstructorOptions {
  /** Some gateways require attribution headers (OpenRouter HTTP-Referer/X-Title). */
  extraHeaders?: Record<string, string>;
  /** Path prefix for the models endpoint (default '/models'). */
  modelsPath?: string;
  /** Path for chat completions (default '/chat/completions'). */
  chatPath?: string;
  /** Rewrite a request body before sending (provider-specific extensions). */
  transformBody?: (body: Record<string, unknown>, request: ChatRequest) => Record<string, unknown>;
  /**
   * Extract a model list from a non-standard envelope. Return null to fall back
   * to OpenAI's `{ data: [...] }` shape.
   */
  parseModelList?: (json: unknown) => RawModel[] | null;
  /** Map a raw model entry to the fields we normalise. */
  mapRawModel?: (raw: RawModel) => MappedModel;
  /** Some providers return usage only in the final SSE frame. */
  streamIncludesUsage?: boolean;
  /** Override the usage endpoint declared in the provider definition. */
  usageEndpointOverride?: string;
}

export interface RawModel {
  id?: string;
  name?: string;
  display_name?: string;
  description?: string;
  context_length?: number;
  context_window?: number;
  max_output_tokens?: number;
  pricing?: { prompt?: string | number; completion?: string | number } | null;
  capabilities?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MappedModel {
  providerModelId: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  pricing: { inputPerMillionTokens: number | null; outputPerMillionTokens: number | null; source: 'api_reported'; reference?: string } | null;
  capabilities: Partial<ModelCapabilities>;
  metadata: Record<string, unknown>;
}

export class OpenAiCompatibleProvider extends BaseProvider {
  private readonly options: OpenAiCompatibleOptions;

  constructor(options: OpenAiCompatibleOptions) {
    super(options, openAiCapabilities(options));
    this.options = options;
  }

  override listModels(): Promise<ModelInfo[]> {
    return this.fetchModels();
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    const path = this.options.modelsPath ?? this.definition.modelsEndpoint ?? '/models';
    const response = await this.http.request<unknown>(path, this.requestOptions({ method: 'GET', timeoutMs: 30_000, detectDailyQuota: false }));
    const raw = this.extractRawModels(response.json);
    const models: ModelInfo[] = [];
    for (const entry of raw) {
      const mapped = this.mapModel(entry);
      if (!mapped) continue;
      models.push(
        buildModelInfo({
          definition: this.definition,
          providerModelId: mapped.providerModelId,
          displayName: mapped.displayName,
          context: {
            definition: this.definition,
            contextWindow: mapped.contextWindow,
            maxOutputTokens: mapped.maxOutputTokens,
            capabilities: mapped.capabilities,
            pricing: mapped.pricing,
            metadata: mapped.metadata,
          },
          status: 'online',
        }),
      );
    }
    this.cacheModels(models);
    this.logger.info('model discovery complete', { count: models.length, path });
    return models;
  }

  private extractRawModels(json: unknown): RawModel[] {
    const custom = this.options.parseModelList?.(json);
    if (custom) return custom;
    if (Array.isArray(json)) return json as RawModel[];
    if (json && typeof json === 'object') {
      const record = json as Record<string, unknown>;
      if (Array.isArray(record.data)) return record.data as RawModel[];
      // Cloudflare-style envelope: { result: [...] }
      if (Array.isArray(record.result)) return record.result as RawModel[];
      if (Array.isArray(record.models)) return record.models as RawModel[];
    }
    throw new ProviderError({
      category: 'invalid_request',
      message: `${this.name} returned a model list in an unexpected shape; cannot enumerate models without guessing.`,
      providerId: this.id,
    });
  }

  private mapModel(raw: RawModel): MappedModel | null {
    if (this.options.mapRawModel) {
      const mapped = this.options.mapRawModel(raw);
      return mapped.providerModelId ? mapped : null;
    }
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    if (!id) return null;
    const pricing = parseOpenAiPricing(raw.pricing);
    return {
      providerModelId: id,
      displayName: typeof raw.name === 'string' && raw.name ? raw.name : (typeof raw.display_name === 'string' && raw.display_name ? raw.display_name : id),
      contextWindow: numericOrNull(raw.context_length) ?? numericOrNull(raw.context_window),
      maxOutputTokens: numericOrNull(raw.max_output_tokens),
      pricing,
      capabilities: {},
      metadata: {},
    };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const body = this.buildBody(request, false);
    const response = await this.http.request<Record<string, unknown>>(this.options.chatPath ?? '/chat/completions', this.requestOptions({
      method: 'POST',
      body,
      timeoutMs: request.timeoutMs ?? this.timeoutMs,
      modelId: request.modelId,
    }));

    const latencyMs = Date.now() - started;
    const choice = firstChoice(response.json);
    if (!choice) {
      throw new ProviderError({
        category: 'invalid_request',
        message: `${this.name} returned a response with no choices. Raw body: ${response.bodyText.slice(0, 300)}`,
        providerId: this.id,
        modelId: request.modelId,
      });
    }

    const content = extractContent(choice);
    const usage = parseUsage(response.json, this.estimator, request, content);
    this.calibrate(request.modelId, this.estimator.estimateMessages(request.messages, request.modelId).tokens, usage.inputTokens);

    return {
      traceId: request.traceId,
      providerId: this.id,
      modelId: request.modelId,
      content,
      finishReason: mapFinishReason(choice?.finish_reason),
      toolCalls: extractToolCalls(choice),
      usage,
      latencyMs,
      telemetry: response.telemetry,
      raw: response.json,
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const body = this.buildBody(request, true);
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    let finalUsage: TokenUsage | undefined;
    let buffer = '';

    for await (const chunk of this.http.streamBody(this.options.chatPath ?? '/chat/completions', this.requestOptions({
      method: 'POST',
      body,
      timeoutMs: request.timeoutMs ?? this.timeoutMs,
      modelId: request.modelId,
    }))) {
      buffer += chunk.text;
      const frames = buffer.split('\n');
      // Keep the last (possibly partial) line for the next iteration.
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // A malformed frame must not kill the stream; providers occasionally emit
          // keep-alive noise between JSON frames.
          continue;
        }
        const choice = firstChoice(parsed);
        const delta = typeof choice?.delta === 'object' && choice.delta !== null ? extractContent(choice.delta) : '';
        if (parsed.usage) finalUsage = parseUsage(parsed, this.estimator, request, '');
        if (delta) {
          if (firstTokenAt === null) firstTokenAt = Date.now();
          yield { traceId: request.traceId, delta };
        }
        const finishReason = mapFinishReason(choice?.finish_reason);
        if (finishReason && finishReason !== 'unknown') {
          yield {
            traceId: request.traceId,
            delta: '',
            finishReason,
            usage: finalUsage,
          };
        }
      }
    }

    if (this.options.streamIncludesUsage && !finalUsage) {
      // Provider promised usage in-stream but did not send it: leave it undefined so
      // the caller estimates, rather than fabricating a number.
      this.logger.debug('stream finished without usage payload', { model: request.modelId });
    }
    if (firstTokenAt !== null) {
      this.logger.debug('stream completed', { model: request.modelId, ms: Date.now() - startedAt });
    }
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const base: Record<string, unknown> = {
      model: request.modelId,
      messages: request.messages.map(toWireMessage),
      stream,
    };
    if (request.temperature !== undefined) base.temperature = request.temperature;
    if (request.topP !== undefined) base.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) base.max_tokens = request.maxOutputTokens;
    if (request.stop?.length) base.stop = request.stop;
    if (request.seed !== undefined) base.seed = request.seed;
    if (request.responseFormat) base.response_format = toWireResponseFormat(request.responseFormat);
    if (request.tools?.length) {
      base.tools = request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
      base.tool_choice = 'auto';
    }
    if (stream && this.options.streamIncludesUsage) base.stream_options = { include_usage: true };
    if (request.extra) Object.assign(base, request.extra);
    return this.options.transformBody ? this.options.transformBody(base, request) : base;
  }

  protected override authHeaders(): Record<string, string> {
    const headers = super.authHeaders();
    return { ...headers, ...(this.options.extraHeaders ?? {}) };
  }

  override async healthCheck() {
    const endpoint = this.definition.healthEndpoint ?? this.options.modelsPath ?? '/models';
    const checkedAt = new Date().toISOString();
    try {
      const started = Date.now();
      await this.http.request(endpoint, this.requestOptions({ method: 'GET', timeoutMs: 15_000, detectDailyQuota: false }));
      const latencyMs = Date.now() - started;
      return {
        ok: true,
        status: (latencyMs > 5_000 ? 'degraded' : 'online') as 'degraded' | 'online',
        latencyMs,
        message: latencyMs > 5_000 ? `Responded slowly (${latencyMs}ms)` : null,
        checkedAt,
      };
    } catch (err) {
      const error = err instanceof ProviderError ? err : null;
      return {
        ok: false,
        status: 'offline' as const,
        latencyMs: null,
        message: error ? `${error.category}: ${error.message}` : String(err),
        checkedAt,
      };
    }
  }
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role === 'tool' ? 'tool' : message.role, content: message.content };
  if (message.role === 'tool' && message.name) wire.name = message.name;
  return wire;
}

function toWireResponseFormat(format: ResponseFormat): Record<string, unknown> | undefined {
  switch (format.type) {
    case 'text':
      return undefined;
    case 'json_object':
      return { type: 'json_object' };
    case 'json_schema':
      return { type: 'json_schema', json_schema: { name: format.name, schema: format.schema, strict: false } };
    default:
      return undefined;
  }
}

function firstChoice(json: unknown): { message?: Record<string, unknown>; delta?: Record<string, unknown>; finish_reason?: string; text?: string } | null {
  if (!json || typeof json !== 'object') return null;
  const choices = (json as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  return choices[0] as { message?: Record<string, unknown>; delta?: Record<string, unknown>; finish_reason?: string; text?: string };
}

function extractContent(container: Record<string, unknown> | null | undefined): string {
  if (!container) return '';
  const candidate = container.content ?? container.text ?? container.reasoning_content ?? container.reasoning;
  if (typeof candidate === 'string') return candidate;
  // Multimodal content arrays: concatenate text parts, ignore image parts.
  if (Array.isArray(candidate)) {
    return candidate
      .map((part) => (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? String((part as Record<string, unknown>).text) : ''))
      .join('');
  }
  return '';
}

function extractToolCalls(choice: { message?: Record<string, unknown> } | null): ChatResponse['toolCalls'] {
  const calls = choice?.message?.tool_calls;
  if (!Array.isArray(calls)) return undefined;
  return calls
    .map((call, index) => {
      const record = call as Record<string, unknown>;
      const fn = (record.function ?? {}) as Record<string, unknown>;
      if (typeof fn.name !== 'string') return null;
      return {
        id: typeof record.id === 'string' ? record.id : `call_${index}`,
        name: fn.name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      };
    })
    .filter((call): call is { id: string; name: string; arguments: string } => call !== null);
}

function mapFinishReason(reason: string | undefined): ChatResponse['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'eos':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_call';
    case 'content_filter':
      return 'content_filter';
    case undefined:
    case null as unknown as undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

export function parseUsage(
  json: unknown,
  estimator: import('@aido/ai-core').TokenEstimator,
  request: ChatRequest,
  content: string,
): TokenUsage {
  if (json && typeof json === 'object') {
    const usage = (json as Record<string, unknown>).usage;
    if (usage && typeof usage === 'object') {
      const record = usage as Record<string, unknown>;
      const input = numericOrNull(record.prompt_tokens ?? record.input_tokens);
      const output = numericOrNull(record.completion_tokens ?? record.output_tokens);
      if (input !== null || output !== null) {
        const inputTokens = input ?? 0;
        const outputTokens = output ?? 0;
        return {
          inputTokens,
          outputTokens,
          totalTokens: numericOrNull(record.total_tokens) ?? inputTokens + outputTokens,
          estimated: false,
        };
      }
    }
  }
  // No provider-reported usage: estimate, and mark it as estimated so the UI can
  // show "≈" instead of pretending it is authoritative (§46).
  const inputTokens = estimator.estimateMessages(request.messages, request.modelId).tokens;
  const outputTokens = estimator.estimate(content, 'code').tokens;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
}

function parseOpenAiPricing(pricing: RawModel['pricing']): MappedModel['pricing'] {
  if (!pricing || typeof pricing !== 'object') return null;
  const prompt = typeof pricing.prompt === 'string' ? Number.parseFloat(pricing.prompt) : typeof pricing.prompt === 'number' ? pricing.prompt : null;
  const completion =
    typeof pricing.completion === 'string' ? Number.parseFloat(pricing.completion) : typeof pricing.completion === 'number' ? pricing.completion : null;
  if (prompt === null && completion === null) return null;
  if (!Number.isFinite(prompt ?? 0) || !Number.isFinite(completion ?? 0)) return null;
  // OpenRouter quotes USD per single token; normalise to per-million.
  const perMillion = (value: number | null) => (value === null ? null : value * 1_000_000);
  return { inputPerMillionTokens: perMillion(prompt), outputPerMillionTokens: perMillion(completion), source: 'api_reported', reference: 'provider /models pricing field' };
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function openAiCapabilities(options: OpenAiCompatibleOptions): LLMProviderCapabilities {
  const capabilities = options.definition.capabilities;
  return {
    streaming: capabilities.includes('streaming'),
    modelDiscovery: Boolean(options.definition.modelsEndpoint) || Boolean(options.modelsPath),
    usageReporting: Boolean(options.definition.usageEndpoint) || Boolean(options.usageEndpointOverride),
    rateLimitTelemetry: Boolean(options.definition.telemetry && Object.keys(options.definition.telemetry).length),
    tools: capabilities.includes('tools'),
    jsonMode: capabilities.includes('jsonMode'),
  };
}
