import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '@aido/types';
import { createHarness, sampleTaskRequest, testProviderDefinition, type Harness } from '@aido/testing';

/**
 * The two real wire protocols (§52), driven against a local HTTP server.
 *
 * Everything else in the suite runs through the simulator or a scripted provider, which
 * means the code that actually talks to a provider over the network — request shape,
 * authentication, model discovery, error classification, rate-limit headers — had no
 * coverage: a typo in a path or a mis-read header would only show up in production.
 *
 * The fake provider here speaks the real protocols and records every request it receives,
 * so the assertions are about what left the process, not about a mock's intentions.
 */

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

interface FakeServer {
  /** Root of the fake provider, without any API version suffix. */
  rootUrl: string;
  baseUrl: string;
  received: Received[];
  /** One entry per response: [status, body, headers]. Consumed in order, last one repeats. */
  respond: (status: number, body: unknown, headers?: Record<string, string>) => void;
  close: () => Promise<void>;
}

async function startServer(): Promise<FakeServer> {
  const received: Received[] = [];
  const queue: { status: number; body: unknown; headers: Record<string, string> }[] = [];
  let fallback: { status: number; body: unknown; headers: Record<string, string> } | null = null;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method ?? 'GET',
        url: req.url ?? '',
        headers: req.headers,
        body: text ? (JSON.parse(text) as unknown) : null,
      });
      const next = queue.shift() ?? fallback ?? { status: 200, body: {}, headers: {} };
      res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers });
      res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    rootUrl: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    received,
    respond(status, body, headers = {}) {
      const entry = { status, body, headers };
      fallback = entry;
      queue.push(entry);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Groq's documented header contract, verbatim. */
const GROQ_HEADERS: Record<string, string> = {
  'x-ratelimit-limit-requests': '1000',
  'x-ratelimit-remaining-requests': '995',
  'x-ratelimit-limit-tokens': '6000',
  'x-ratelimit-remaining-tokens': '5500',
  'x-ratelimit-reset-requests': '2m59.56s',
  'x-ratelimit-reset-tokens': '7.66s',
};

const GROQ_TELEMETRY = {
  requestsRemaining: ['x-ratelimit-remaining-requests'],
  requestsLimit: ['x-ratelimit-limit-requests'],
  tokensRemaining: ['x-ratelimit-remaining-tokens'],
  tokensLimit: ['x-ratelimit-limit-tokens'],
  resetRequests: ['x-ratelimit-reset-requests'],
  resetTokens: ['x-ratelimit-reset-tokens'],
  retryAfter: ['retry-after'],
} as const;

describe('real provider adapters', () => {
  let harness: Harness | null = null;
  let server: FakeServer | null = null;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    harness?.close();
    harness = null;
    await server?.close();
    server = null;
  });

  /** An OpenAI-compatible provider whose base URL is the fake server. */
  function openAiDefinition(extra: Record<string, unknown> = {}) {
    return testProviderDefinition('local-openai', {
      name: 'Local OpenAI-compatible',
      kind: 'openai_compatible',
      simulated: false,
      authenticationType: 'bearer',
      apiBaseUrl: server!.baseUrl,
      // Declaring the endpoint is what makes discovery possible at all; the adapter
      // reports `modelDiscovery: false` when a definition has none.
      modelsEndpoint: '/models',
      credentialFields: [{ key: 'apiKey', label: 'API key', required: true, secret: true }],
      telemetry: GROQ_TELEMETRY as never,
      telemetrySemantics: { requests: 'per_day', tokens: 'per_minute' },
      // Groq publishes no per-model pricing in its API; a free-tier key is not billed.
      // Declared as data so FREE ONLY ($0 ceiling) can route it at all.
      defaultPricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0, source: 'provider_docs', note: 'Free tier: no charge.' },
      seedModels: [],
      ...extra,
    } as never);
  }

  async function openAiHarness(extra: Record<string, unknown> = {}) {
    const created = await createHarness({ definitions: [openAiDefinition(extra)] });
    created.vault.set('local-openai', 'apiKey', 'test-key-openai-secret');
    created.registry.invalidate('local-openai');
    harness = created;
    return created;
  }

  it('discovers the catalogue and sends an authenticated, well-formed chat request', async () => {
    const created = await openAiHarness();
    server!.respond(200, {
      data: [
        { id: 'llama-3.1-8b-instant', context_length: 131_072, max_output_tokens: 8_192 },
        { id: 'whisper-large-v3', context_length: 4_096 },
      ],
    });

    const discovery = await created.registry.discoverModels('local-openai');
    expect(discovery.error).toBeNull();
    expect(discovery.added).toBe(2);

    const models = created.store.models.list({ providerId: 'local-openai' });
    const llama = models.find((model) => model.providerModelId === 'llama-3.1-8b-instant');
    // Capability flags are inferred from the id, and the context window comes from the
    // provider's own metadata — not from anything remembered about this provider.
    expect(llama).toMatchObject({ contextWindow: 131_072, maxOutputTokens: 8_192 });
    expect(llama?.capabilities).toMatchObject({ chat: true, codeGeneration: true, longContext: true });

    server!.received.length = 0;
    server!.respond(200, { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }, GROQ_HEADERS);
    server!.received.length = 0;

    const result = await created.executor.execute({
      taskRequest: sampleTaskRequest({ taskType: 'code_generation', requiredCapabilities: [], maxLatencyMs: 60_000 }),
      messages: [{ role: 'user', content: 'Say ok.' }],
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    } as never);

    expect(result.response.content).toBe('ok');
    expect(result.chosen.providerId).toBe('local-openai');
    const chat = server!.received.find((entry) => entry.url.includes('chat/completions'));
    expect(chat).toBeDefined();
    expect(chat!.method).toBe('POST');
    expect(chat!.headers.authorization).toBe('Bearer test-key-openai-secret');
    // The wire carries the provider's own model id; the internal `provider:model` id must
    // never leak out of the application.
    expect((chat!.body as { model: string }).model).toBe('llama-3.1-8b-instant');
    expect(result.chosen.modelId).toBe('local-openai:llama-3.1-8b-instant');
    expect((chat!.body as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it('turns Groq-style rate-limit headers into learned limits and a real quota stop', async () => {
    const created = await openAiHarness();
    server!.respond(200, { data: [{ id: 'llama-3.1-8b-instant', context_length: 131_072 }] });
    await created.registry.discoverModels('local-openai');

    const call = () =>
      created.executor.execute({
        taskRequest: sampleTaskRequest({ taskType: 'code_generation', requiredCapabilities: [], maxLatencyMs: 60_000 }),
        messages: [{ role: 'user', content: 'Say ok.' }],
        retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
      } as never);

    server!.respond(200, { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }, GROQ_HEADERS);

    const result = await created.executor.execute({
      taskRequest: sampleTaskRequest({ taskType: 'code_generation', requiredCapabilities: [], maxLatencyMs: 60_000 }),
      messages: [{ role: 'user', content: 'Say ok.' }],
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    } as never);

    // 1. the headers are parsed on the response, including Go-style durations
    expect(result.response.telemetry).toMatchObject({
      requestsLimit: 1_000,
      requestsRemaining: 995,
      tokensLimit: 6_000,
      tokensRemaining: 5_500,
      resetRequests: '2m59.56s',
      resetTokens: '7.66s',
    });

    // 2. they are recorded as observations, so the engine stops trusting seeded numbers
    const observed = created.store.quota.observedLimits('local-openai', 'llama-3.1-8b-instant');
    expect(observed).toMatchObject({ limitRequests: 1_000, limitTokens: 6_000 });

    // 3. and the daily/per-minute windows are interpreted from the declared semantics:
    //    Groq's request counter is per day, its token counter per minute.
    const model = created.store.models.get('local-openai:llama-3.1-8b-instant');
    expect(model?.quota.requestsPerDay).toBe(1_000);
    expect(model?.quota.tokensPerMinute).toBe(6_000);
    expect(model?.quota.provenance.source).toBe('observed_header');

    // 4. "0 remaining" is a hard stop, not a hint: the next run must not send a request.
    server!.respond(200, { choices: [{ message: { role: 'assistant', content: 'should not be sent' } }] }, {
      ...GROQ_HEADERS,
      'x-ratelimit-remaining-requests': '0',
    });
    await call();

    const before = server!.received.length;
    const refused = await call().catch((err: unknown) => err);
    // The request never leaves the process: an exhausted provider is skipped by the
    // router before anything is sent, which is the whole point of tracking the headers.
    expect(server!.received.length).toBe(before);
    expect(refused).toBeInstanceOf(ProviderError);
    expect(JSON.stringify(created.router.decide({
      settings: created.settings,
      taskRequest: sampleTaskRequest({ taskType: 'code_generation', requiredCapabilities: [] }),
    }).rationale)).toContain('cooldown');
  });

  it('classifies HTTP failures without inventing a retryable error', async () => {
    // Asserted at the adapter, one request per status: the executor adds cooldowns and
    // failover on top, so it is the wrong place to read a status-to-category mapping.
    const created = await openAiHarness();
    server!.respond(200, { data: [{ id: 'llama-3.1-8b-instant', context_length: 131_072 }] });
    await created.registry.discoverModels('local-openai');
    const provider = created.registry.provider('local-openai');
    expect(provider).not.toBeNull();

    const chat = () =>
      provider!.chat({
        traceId: 'trace-adapter-test',
        modelId: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 5_000,
      });

    // 401 — the key is rejected, and the error must not carry the key back
    server!.respond(401, { error: { message: 'Invalid API Key' } });
    const unauthorized = await chat().catch((err: unknown) => err);
    expect(unauthorized).toBeInstanceOf(ProviderError);
    expect((unauthorized as ProviderError).category).toBe('authentication');
    expect((unauthorized as ProviderError).message).not.toContain('test-key-openai-secret');
    expect(JSON.stringify(unauthorized)).not.toContain('test-key-openai-secret');

    // 429 with a Go-style retry-after — transient, so retrying is worth it and the delay
    // the provider asked for is preserved.
    server!.respond(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '7.66s' });
    const limited = await chat().catch((err: unknown) => err);
    expect((limited as ProviderError).category).toBe('rate_limit');
    expect((limited as ProviderError).retryAfterMs).toBe(7_660);

    // 500 — the provider is broken, not the request
    server!.respond(500, { error: { message: 'internal error' } });
    const broken = await chat().catch((err: unknown) => err);
    expect((broken as ProviderError).category).toBe('server_error');

    // 200 with no choices — a malformed success must not be accepted as content
    server!.respond(200, { choices: [] });
    const empty = await chat().catch((err: unknown) => err);
    expect((empty as ProviderError).category).toBe('invalid_request');

    // 400 blaming the model — routing must treat the model, not the request, as the problem
    server!.respond(400, { error: { message: 'The model `llama-3.1-8b-instant` does not exist' } });
    const gone = await chat().catch((err: unknown) => err);
    expect((gone as ProviderError).category).toBe('model_unavailable');

    // 400 about the prompt — a real request problem, and not something to retry blindly
    server!.respond(400, { error: { message: 'messages must not be empty' } });
    const badRequest = await chat().catch((err: unknown) => err);
    expect((badRequest as ProviderError).category).toBe('invalid_request');

    // A truncated body is a provider bug, not a valid empty answer.
    server!.respond(200, '{"choices": [');
    const truncated = await chat().catch((err: unknown) => err);
    expect(truncated).toBeInstanceOf(ProviderError);
  });

  it('speaks the Google Generative protocol: discovery, generateContent and its own key', async () => {
    const definition = testProviderDefinition('local-gemini', {
      name: 'Local Gemini',
      kind: 'google_generative',
      simulated: false,
      // Google's surface is versioned in the base URL, as it is in config/providers/gemini.json.
      apiBaseUrl: `${server!.rootUrl}/v1beta`,
      modelsEndpoint: '/v1beta/models',
      credentialFields: [{ key: 'apiKey', label: 'API key', required: true, secret: true }],
      telemetry: {},
      // The Generative Language API reports no pricing at all — the adapter passes
      // null by design, so the free tier must be declared.
      defaultPricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0, source: 'provider_docs', note: 'Free tier: no charge.' },
      seedModels: [],
    } as never);

    const created = await createHarness({ definitions: [definition] });
    created.vault.set('local-gemini', 'apiKey', 'test-key-gemini-secret');
    created.registry.invalidate('local-gemini');
    harness = created;

    server!.respond(200, {
      models: [
        {
          name: 'models/gemini-2.0-flash',
          displayName: 'Gemini 2.0 Flash',
          inputTokenLimit: 1_048_576,
          outputTokenLimit: 8_192,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        // Not a chat model: it must not enter the routing catalogue.
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
      ],
    });

    const discovery = await created.registry.discoverModels('local-gemini');
    expect(discovery.error).toBeNull();
    const models = created.store.models.list({ providerId: 'local-gemini' });
    expect(models.map((model) => model.providerModelId)).toEqual(['gemini-2.0-flash']);
    expect(models[0]).toMatchObject({ contextWindow: 1_048_576, maxOutputTokens: 8_192 });

    const discoveryCall = server!.received.find((entry) => entry.url.includes('/models?'));
    expect(discoveryCall?.headers['x-goog-api-key']).toBe('test-key-gemini-secret');
    // Google's own key must never be sent to the OpenAI-compatible provider and vice versa.
    expect(discoveryCall?.headers.authorization).toBeUndefined();

    server!.respond(
      200,
      {
        candidates: [{ content: { parts: [{ text: 'Gemini says ok' }], role: 'model' }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
      },
      {},
    );

    const result = await created.executor.execute({
      taskRequest: sampleTaskRequest({
        taskType: 'code_generation',
        requiredCapabilities: [],
        providerId: 'local-gemini',
        maxLatencyMs: 60_000,
      }),
      messages: [{ role: 'user', content: 'Say ok.' }],
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
    } as never);

    expect(result.response.content).toBe('Gemini says ok');
    expect(result.response.usage.inputTokens).toBe(12);
    expect(result.response.usage.outputTokens).toBe(4);
    expect(result.response.finishReason).toBe('stop');

    const generate = server!.received.find((entry) => entry.url.includes(':generateContent'));
    expect(generate?.url).toContain('/v1beta/models/gemini-2.0-flash:generateContent');
    expect(generate?.headers['x-goog-api-key']).toBe('test-key-gemini-secret');
    expect(generate?.headers.authorization).toBeUndefined();
    expect(generate?.headers['content-type']).toContain('application/json');
  });

  it('streams a completion, keeps partial output and collects usage from the final frame', async () => {
    const created = await openAiHarness();
    server!.respond(200, { data: [{ id: 'llama-3.1-8b-instant', context_length: 131_072 }] });
    await created.registry.discoverModels('local-openai');

    // A real SSE exchange: three content frames, provider keep-alive noise between them,
    // a usage-only final frame, then the terminator.
    const frames = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}',
      ': keep-alive',
      'data: {"choices":[{"delta":{"content":", "}}]}',
      'data: {"choices":[{"delta":{"content":"world"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":3,"total_tokens":14}}',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    server!.respond(200, frames, { 'content-type': 'text/event-stream' });

    const provider = created.registry.provider('local-openai')!;
    let text = '';
    let finishReason: string | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const chunk of provider.stream({
      traceId: 'trace-stream',
      modelId: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'Say hello.' }],
      timeoutMs: 5_000,
    })) {
      text += chunk.delta;
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens };
    }

    expect(text).toBe('Hello, world');
    expect(finishReason).toBe('stop');
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 3 });

    const call = server!.received.at(-1);
    expect(call?.headers.authorization).toBe('Bearer test-key-openai-secret');
    expect(call?.headers.accept).toBe('text/event-stream');
    expect((call?.body as { stream?: boolean })?.stream).toBe(true);
  });

  it('refuses a model of unknown cost in FREE ONLY rather than assuming it is free', async () => {
    // No declared pricing: the provider reports none, so the cost is genuinely unknown
    // and the $0 ceiling must reject it. Assuming "free" here is how a free-only mode
    // ends up spending money.
    const created = await openAiHarness({ defaultPricing: null });
    server!.respond(200, { data: [{ id: 'llama-3.1-8b-instant', context_length: 131_072 }] });
    await created.registry.discoverModels('local-openai');
    expect(created.store.models.get('local-openai:llama-3.1-8b-instant')?.pricing.provenance.source).toBe('unknown');

    const decision = created.router.decide({
      settings: created.settings,
      taskRequest: sampleTaskRequest({ taskType: 'code_generation', requiredCapabilities: [] }),
    });
    expect(decision.selected).toBeNull();
    expect(JSON.stringify(decision.rationale)).toContain('cost is unknown');

    const before = server!.received.length;
    await expect(
      created.executor.execute({
        taskRequest: sampleTaskRequest({ taskType: 'code_generation', requiredCapabilities: [], maxLatencyMs: 5_000 }),
        messages: [{ role: 'user', content: 'hello' }],
        retryPolicy: { maxAttempts: 1, baseDelayMs: 1 },
      } as never),
    ).rejects.toThrow();
    expect(server!.received.length).toBe(before);
  });

  it('keeps the better price when a later discovery reports none', async () => {
    const created = await openAiHarness({
      defaultPricing: { inputPerMillionTokens: 0.5, outputPerMillionTokens: 1.5, source: 'user_configured', note: 'declared by hand' },
    });
    server!.respond(200, {
      data: [{ id: 'llama-3.1-8b-instant', context_length: 131_072, pricing: { prompt: '0.0000002', completion: '0.0000004' } }],
    });
    await created.registry.discoverModels('local-openai');
    const discovered = created.store.models.get('local-openai:llama-3.1-8b-instant');
    // The provider's own number wins over the declaration...
    expect(discovered?.pricing.provenance.source).toBe('api_reported');
    expect(discovered?.pricing.inputPerMillionTokens).toBeCloseTo(0.2, 6);

    // ...and a discovery pass that reports nothing must not downgrade it.
    server!.respond(200, { data: [{ id: 'llama-3.1-8b-instant', context_length: 131_072 }] });
    await created.registry.discoverModels('local-openai');
    const after = created.store.models.get('local-openai:llama-3.1-8b-instant');
    expect(after?.pricing.provenance.source).toBe('api_reported');
    expect(after?.pricing.inputPerMillionTokens).toBeCloseTo(0.2, 6);
  });
});
