# Providers

A provider is **data plus an adapter**. Adding one must never require a change to the
orchestrator, the router, the quota engine or the UI.

- The **data** is a JSON file in `config/providers/` describing how to reach the provider,
  which credentials it needs, what it can do, how its rate limits are expressed and which
  free tier it offers.
- The **adapter** is a small class implementing `LLMProvider` (`packages/ai-core`) that
  speaks the provider's wire format.

Today ten definitions ship: `groq`, `gemini`, `openrouter`, `cerebras`, `mistral`,
`cloudflare`, `nvidia`, `huggingface`, `cohere`, and `simulated` (the local simulator).
Three adapter kinds cover them all: `openai_compatible`, `google_generative`, `simulated`.

---

## The adapter contract

`packages/ai-core/src/provider.ts` defines the only thing the core knows about a provider:

```ts
interface LLMProvider {
  readonly definition: ProviderDefinition;

  listModels(): Promise<ProviderModel[]>;                 // discovery
  complete(request: CompletionRequest): Promise<CompletionResult>;
  stream?(request: CompletionRequest): AsyncIterable<CompletionChunk>;
  healthCheck?(): Promise<ProviderHealth>;
  usage?(): Promise<UsageInfo | null>;                    // API-reported usage, when offered
}
```

Capabilities are declared as flags on the definition and on each discovered model
(`chat`, `streaming`, `tools`, `jsonMode`, `structuredOutput`, `codeGeneration`,
`longContext`, `reasoning`, `vision`, `embeddings`, `imageGeneration`). The router matches
task requirements against these flags; it never special-cases a provider by name.

Everything provider-specific lives behind that interface: HTTP shape, auth header,
streaming format, error mapping, token accounting, rate-limit headers.

## Error mapping

An adapter must translate transport and API failures into the shared taxonomy
(`packages/types`), because retry and failover decisions depend on it:

| Category | Retried? | What happens |
| --- | --- | --- |
| `timeout` | yes | Retry, then fail over |
| `rate_limit` | yes, after cooldown | Cooldown from `retry-after` (or the learned reset), then fail over |
| `quota_exhausted` | **no** | Window marked exhausted; router switches provider |
| `authentication` | **no** | Credential marked rejected; provider skipped until replaced |
| `invalid_request` | **no** | Task fails with the reason |
| `context_length` | **no** | Context builder compresses on the next attempt |
| `server_error` | yes | Backoff, then fail over |
| `model_unavailable` | yes | Immediate failover |
| `network_error` | yes | Backoff; repeated failures open the circuit breaker |
| `content_filter` | **no** | Task fails; the same content would be refused again |
| `cancelled` | **no** | Stopped by the operator or a hard limit |
| `unknown` | supervisor decides | Recorded with the raw message |

"Not retried" is enforced, not advisory: retrying an authentication error or an exhausted
quota burns time and quota for a request that cannot succeed.

## The definition format

```jsonc
{
  "id": "groq",
  "name": "Groq",
  "kind": "openai_compatible",          // adapter kind
  "apiBaseUrl": "https://api.groq.com/openai/v1",
  "authenticationType": "bearer",

  "credentialFields": [                  // what the UI asks for, and what is required
    { "key": "apiKey", "label": "API key", "required": true, "secret": true }
  ],
  "envKeys": ["GROQ_API_KEY"],           // fallback when no credential is stored

  "modelsEndpoint": "/models",
  "usageEndpoint": null,
  "healthEndpoint": "/models",
  "documentationUrl": "https://console.groq.com/docs/rate-limits",

  "capabilities": ["chat", "streaming", "tools", "jsonMode", "codeGeneration", "vision"],

  "telemetrySemantics": { "requests": "per_day", "tokens": "per_minute" },

  "quotaLimits": {
    "requestsPerMinute": 30,
    "requestsPerDay": 1440,
    "tokensPerMinute": 6000,
    "resetStrategy": "utc_midnight",
    "resetTimezone": null,
    "provenance": {
      "source": "provider_docs",
      "confidence": 0.35,
      "reference": "https://console.groq.com/docs/rate-limits",
      "note": "Placeholder until the first real response header is observed…"
    }
  },

  "freeTier": { "available": true, "quotaType": "free_renewable", "resetStrategy": "utc_midnight" },
  "seedModels": [{ "providerModelId": "…", "contextWindow": 131072, "capabilities": ["chat"] }],
  "metadataVerified": false,
  "lastVerifiedAt": null,
  "notes": "…"
}
```

`seedModels` are a starting point only: **discovery replaces them** the moment a real
`/models` call succeeds. A seed that is wrong is corrected, not defended.

### Honesty rules encoded in this format

- `metadataVerified: false` means "a human has not confirmed these numbers against the
  provider's current documentation". The UI shows a warning wherever those numbers appear.
- Every numeric limit carries a `provenance` record with a `source` and `confidence`.
  The sources are `provider_docs`, `observed_header`, `api_reported`, `user_configured`,
  `inferred`, `unknown`.
- `freeTier.quotaType` distinguishes `free_renewable` (resets on its own) from
  `free_trial` (a finite credit that will not come back). Trial credit is never treated as
  renewable quota and is never spent in FREE ONLY mode.
- Nothing is inferred from a model's name. A model is only marked free because a
  definition, an API response, or an operator says so — with provenance.

## Quota semantics

- **Windows** are per provider (optionally per model) and per dimension: requests/tokens ×
  minute/hour/day/month, plus concurrency.
- **Reservation is atomic.** A request reserves the worst-case token cost
  (`estimatedInputTokens + maxOutputTokens`) before it is sent. Reservations are stored in
  `quota_reservations`, settled with actual usage afterwards, and expired if a call never
  reports back, so a crashed process cannot leak allowance.
- **Resets** follow the provider's own rule: `utc_midnight`, `provider_timezone`
  (timezone-aware, DST-correct), `rolling_24h`, `explicit_timestamp`, or `api_reported`
  (the provider told us when its window ends).
- **Learning.** Rate-limit headers and usage endpoints are parsed after each request and
  recorded as observations. The observed value wins over the configured one. Groq's
  `x-ratelimit-*` headers and OpenRouter's `GET /key` are implemented; others are added by
  declaring `telemetrySemantics` and mapping headers in the adapter.
- **Safety margin.** A configurable fraction of each window is reserved and never spent, so
  a batch of parallel tasks cannot overrun a limit mid-run.
- **Capacity reporting** (`/api/quotas`) reports what remains, on what basis, which
  providers were excluded and why — it never invents a number when limits are unknown.

## Adding a provider

1. If it speaks the OpenAI wire format (`/chat/completions` + `/models`), no code is
   needed: copy the closest JSON file in `config/providers/`, set `kind` to
   `openai_compatible`, and fill in the base URL, credential fields and documentation URL.
2. Otherwise add an adapter in `packages/providers/src/adapters/` implementing
   `LLMProvider`, and register its `kind` in the registry's adapter map.
3. Reload: `POST /api/providers/reload-catalog` (or restart). The provider appears in the
   **Providers** screen, ready for credentials and discovery.

No orchestrator, router, quota or UI change is required — that is the test of whether the
abstraction is doing its job.

## Credentials

- Keys are entered in the UI, validated against the provider (`POST /providers/:id/test`),
  encrypted with AES-256-GCM under a per-install master key, and stored in the local
  database. They are never logged, never returned by the API (only a fingerprint and
  timestamps) and never sent to any provider other than the one they belong to.
- `envKeys` are a fallback/seed for headless deployments. A credential entered in the UI
  takes precedence.
- If a key is rejected, the provider is marked `invalid` with the reason, excluded from
  routing, and surfaced on the Providers screen and the Dashboard warnings.

## The Local Simulator

`simulated` is a first-class provider implemented in `packages/providers/src/adapters/simulated.ts`.
It consumes no network and no external quota, is priced 0, and produces deterministic
placeholder output that is always prefixed `[SIMULATED RESPONSE …]`. It exists so the full
pipeline can be exercised offline, in tests, and by a new user with no keys. It is labelled
everywhere it appears; the UI never presents its output as a real model answer.
