import {
  ProviderError,
  type ChatChunk,
  type ChatRequest,
  type ChatResponse,
  type ModelInfo,
  type TokenUsage,
} from '@aido/types';
import { BaseProvider, type ProviderConstructorOptions } from '@aido/ai-core';
import { buildModelInfo, inferStrengths } from '../model-factory.js';

/**
 * Google Gemini adapter (`generativelanguage.googleapis.com/v1beta`).
 *
 * Notable differences from the OpenAI shape that this adapter absorbs:
 *  - the API key travels as a query parameter or `x-goog-api-key` header,
 *  - messages are `contents` with `parts`, and the system prompt is a separate
 *    `systemInstruction` field,
 *  - streaming is a different method (`streamGenerateContent?alt=sse`),
 *  - the model list is `{ models: [{ name: 'models/gemini-...', ... }] }`,
 *  - token counts are `usageMetadata.promptTokenCount` / `candidatesTokenCount`,
 *    and are present even on non-streaming calls.
 *
 * Gemini does not emit rate-limit headers, so this adapter reports no telemetry;
 * the quota engine therefore treats Gemini limits as unknown and learns them from
 * 429 responses (documented in PROVIDERS.md).
 */
export class GoogleGenerativeProvider extends BaseProvider {
  constructor(options: ProviderConstructorOptions) {
    super(options, {
      streaming: true,
      modelDiscovery: true,
      usageReporting: false, // Gemini exposes per-request usage, not account-wide usage
      rateLimitTelemetry: false,
      tools: true,
      jsonMode: true,
    });
  }

  override async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let pageToken: string | undefined;
    // Paginate: the catalogue is larger than one page and silently truncating it
    // would make models invisible with no explanation.
    for (let page = 0; page < 10; page += 1) {
      const path = `/models?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      const response = await this.http.request<{ models?: GoogleModel[]; nextPageToken?: string }>(path, this.requestOptions({
        method: 'GET',
        headers: this.authHeaders(),
        timeoutMs: 30_000,
        detectDailyQuota: false,
      }));
      for (const raw of response.json?.models ?? []) {
        const id = (raw.name ?? '').replace(/^models\//, '');
        if (!id) continue;
        // Only chat-capable models belong in the routing catalogue.
        const methods = raw.supportedGenerationMethods ?? [];
        if (methods.length && !methods.includes('generateContent')) continue;
        models.push(
          buildModelInfo({
            definition: this.definition,
            providerModelId: id,
            displayName: raw.displayName ?? id,
            context: {
              definition: this.definition,
              contextWindow: raw.inputTokenLimit ?? null,
              maxOutputTokens: raw.outputTokenLimit ?? null,
              capabilities: {
                vision: true, // the current generation is multimodal
                tools: true,
                structuredOutput: /2\.(5|0)|3\./i.test(id) || methods.includes('generateContent'),
                reasoning: /thinking|2\.5/i.test(id),
                codeGeneration: true,
              },
              pricing: null, // Gemini's API does not publish pricing
              metadata: { supportedGenerationMethods: methods, description: raw.description ?? null },
            },
            status: 'online',
          }),
        );
      }
      pageToken = response.json?.nextPageToken;
      if (!pageToken) break;
    }
    this.cacheModels(models);
    this.logger.info('model discovery complete', { count: models.length });
    return models;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const body = this.buildBody(request);
    const response = await this.http.request<GoogleResponse>(`/models/${encodeURIComponent(request.modelId)}:generateContent`, this.requestOptions({
      method: 'POST',
      body,
      headers: this.authHeaders(),
      timeoutMs: request.timeoutMs ?? this.timeoutMs,
      modelId: request.modelId,
      detectDailyQuota: true,
    }));

    const candidate = response.json?.candidates?.[0];
    const content = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    if (!content && !candidate?.finishReason) {
      const blocked = response.json?.promptFeedback?.blockReason;
      throw new ProviderError({
        category: blocked ? 'content_filter' : 'invalid_request',
        message: blocked ? `Request blocked by safety filters: ${blocked}` : 'Gemini returned an empty candidate.',
        providerId: this.id,
        modelId: request.modelId,
      });
    }

    const usage = this.parseUsage(response.json, request, content);
    this.calibrate(request.modelId, this.estimator.estimateMessages(request.messages, request.modelId).tokens, usage.inputTokens);

    return {
      traceId: request.traceId,
      providerId: this.id,
      modelId: request.modelId,
      content,
      finishReason: mapGoogleFinish(candidate?.finishReason),
      usage,
      latencyMs: Date.now() - started,
      telemetry: response.telemetry,
      raw: response.json,
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const body = this.buildBody(request);
    let buffer = '';
    let usage: TokenUsage | undefined;
    for await (const chunk of this.http.streamBody(
      `/models/${encodeURIComponent(request.modelId)}:streamGenerateContent?alt=sse`,
      this.requestOptions({
        method: 'POST',
        body,
        headers: this.authHeaders(),
        timeoutMs: request.timeoutMs ?? this.timeoutMs,
        modelId: request.modelId,
      }),
    )) {
      buffer += chunk.text;
      const frames = buffer.split('\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let parsed: GoogleResponse;
        try {
          parsed = JSON.parse(payload) as GoogleResponse;
        } catch {
          continue;
        }
        const candidate = parsed.candidates?.[0];
        const delta = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
        if (parsed.usageMetadata) usage = this.usageFromMetadata(parsed.usageMetadata, parsed, request, '');
        if (delta) yield { traceId: request.traceId, delta };
        if (candidate?.finishReason) {
          yield { traceId: request.traceId, delta: '', finishReason: mapGoogleFinish(candidate.finishReason), usage };
        }
      }
    }
  }

  private buildBody(request: ChatRequest): Record<string, unknown> {
    const systemParts = request.messages.filter((m) => m.role === 'system').map((m) => ({ text: m.content }));
    const contents = request.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.topP !== undefined) generationConfig.topP = request.topP;
    if (request.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = request.maxOutputTokens;
    if (request.stop?.length) generationConfig.stopSequences = request.stop;
    if (request.responseFormat) {
      if (request.responseFormat.type === 'json_object') generationConfig.responseMimeType = 'application/json';
      if (request.responseFormat.type === 'json_schema') {
        generationConfig.responseMimeType = 'application/json';
        generationConfig.responseSchema = sanitiseSchemaForGoogle(request.responseFormat.schema);
      }
    }

    const body: Record<string, unknown> = { contents };
    if (systemParts.length) body.systemInstruction = { parts: systemParts };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: sanitiseSchemaForGoogle(tool.parameters),
          })),
        },
      ];
    }
    if (request.extra) Object.assign(body, request.extra);
    return body;
  }

  protected override authHeaders(): Record<string, string> {
    // Header auth keeps the key out of URLs and therefore out of any request log.
    return { 'x-goog-api-key': this.requireCredential() };
  }

  private parseUsage(json: GoogleResponse | null, request: ChatRequest, content: string): TokenUsage {
    if (json?.usageMetadata) return this.usageFromMetadata(json.usageMetadata, json, request, content);
    const inputTokens = this.estimator.estimateMessages(request.messages, request.modelId).tokens;
    const outputTokens = this.estimator.estimate(content, 'code').tokens;
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
  }

  private usageFromMetadata(
    metadata: NonNullable<GoogleResponse['usageMetadata']>,
    _json: GoogleResponse,
    _request: ChatRequest,
    _content: string,
  ): TokenUsage {
    const inputTokens = metadata.promptTokenCount ?? 0;
    const outputTokens = metadata.candidatesTokenCount ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: metadata.totalTokenCount ?? inputTokens + outputTokens,
      estimated: metadata.promptTokenCount === undefined,
    };
  }

  override async healthCheck() {
    const checkedAt = new Date().toISOString();
    try {
      const started = Date.now();
      await this.http.request('/models?pageSize=1', this.requestOptions({ method: 'GET', headers: this.authHeaders(), timeoutMs: 15_000, detectDailyQuota: false }));
      const latencyMs = Date.now() - started;
      return {
        ok: true,
        status: (latencyMs > 5_000 ? 'degraded' : 'online') as 'degraded' | 'online',
        latencyMs,
        message: null,
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

  /** Not used directly, but keeps the strength hinting available for the registry. */
  static strengths(modelId: string): ReturnType<typeof inferStrengths> {
    return inferStrengths(modelId);
  }
}

interface GoogleModel {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

interface GoogleResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

function mapGoogleFinish(reason: string | undefined): ChatResponse['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    case undefined:
      return 'unknown';
    default:
      return 'unknown';
  }
}

/**
 * Gemini rejects a handful of JSON-Schema keywords it does not implement
 * (`$schema`, `additionalProperties`, `$ref`). Stripping them keeps structured
 * output working instead of failing with an opaque 400.
 */
export function sanitiseSchemaForGoogle(schema: unknown, depth = 0): unknown {
  if (depth > 12 || schema === null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map((item) => sanitiseSchemaForGoogle(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (['$schema', 'additionalProperties', '$ref', '$defs', 'definitions', 'examples', 'default'].includes(key)) continue;
    out[key] = sanitiseSchemaForGoogle(value, depth + 1);
  }
  return out;
}
