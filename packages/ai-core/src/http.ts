import { ProviderError, type ErrorCategory, type RateLimitTelemetry, type TelemetryField } from '@aido/types';

/**
 * HTTP layer shared by every adapter.
 *
 * Responsibilities that must NOT be duplicated per provider:
 *  - one place that turns transport/HTTP failures into the error taxonomy (§20),
 *  - one place that parses rate-limit telemetry using a *configurable* header map,
 *  - one place that enforces timeouts and cancellation,
 *  - one place that guarantees no credential ever appears in a log line.
 */

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  bodyText: string;
  json: T | null;
  durationMs: number;
  telemetry: RateLimitTelemetry;
  url: string;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Header name -> telemetry field mapping from the provider definition. */
  telemetryMap?: Partial<Record<TelemetryField, string[]>>;
  providerId: string;
  modelId?: string | null;
  /** When true, a 429 becomes `quota_exhausted` if the body suggests a daily cap. */
  detectDailyQuota?: boolean;
  /** Max bytes of response body to read (protects against a runaway stream). */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class HttpClient {
  constructor(
    private readonly options: {
      fetchImpl?: typeof fetch;
      baseUrl: string;
      defaultHeaders?: Record<string, string>;
      /** Test hook for deterministic clock-free tests. */
      now?: () => number;
    },
  ) {}

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  buildUrl(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    const base = this.options.baseUrl.replace(/\/$/, '');
    const suffix = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    return `${base}${suffix}`;
  }

  async request<T = unknown>(pathOrUrl: string, options: RequestOptions): Promise<HttpResponse<T>> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new ProviderError({
        category: 'network_error',
        message: 'No fetch implementation available in this runtime.',
        providerId: options.providerId,
        modelId: options.modelId ?? null,
      });
    }

    const url = this.buildUrl(pathOrUrl);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    // Propagate an external cancellation (task pause / run stop) into the fetch.
    const onExternalAbort = () => controller.abort(new Error('cancelled'));
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const started = this.options.now?.() ?? Date.now();
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.options.defaultHeaders,
      ...options.headers,
    };
    if (options.body !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/json';
    }

    try {
      const response = await fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      const bodyText = await readLimited(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
      const durationMs = (this.options.now?.() ?? Date.now()) - started;
      const telemetry = parseTelemetry(response.headers, options.telemetryMap);

      let json: T | null = null;
      if (bodyText) {
        try {
          json = JSON.parse(bodyText) as T;
        } catch {
          json = null; // Non-JSON error pages (HTML 502s) are common; keep the text.
        }
      }

      if (!response.ok) {
        throw classifyHttpError({
          status: response.status,
          bodyText,
          json,
          headers: response.headers,
          telemetry,
          providerId: options.providerId,
          modelId: options.modelId ?? null,
          detectDailyQuota: options.detectDailyQuota ?? true,
        });
      }

      return { status: response.status, ok: true, headers: response.headers, bodyText, json, durationMs, telemetry, url };
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw classifyTransportError(err, {
        providerId: options.providerId,
        modelId: options.modelId ?? null,
        timeoutMs,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * Opens a streaming response and yields decoded text chunks. SSE framing is
   * handled by the caller because providers differ (`data:` JSON vs plain text).
   */
  async *streamBody(
    pathOrUrl: string,
    options: RequestOptions,
  ): AsyncGenerator<{ text: string; telemetry: RateLimitTelemetry }> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const url = this.buildUrl(pathOrUrl);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    // Streaming keeps the connection open while tokens arrive, so the abort timer
    // is driven by inactivity rather than total duration.
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(new Error('stream idle timeout')), Math.max(30_000, timeoutMs));
    };
    const onExternalAbort = () => controller.abort(new Error('cancelled'));
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      ...this.options.defaultHeaders,
      ...options.headers,
    };
    if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';

    try {
      armIdleTimer();
      const response = await fetchImpl(url, {
        method: options.method ?? 'POST',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const bodyText = await readLimited(response, 64 * 1024);
        let json: unknown = null;
        try {
          json = JSON.parse(bodyText);
        } catch {
          /* keep null */
        }
        throw classifyHttpError({
          status: response.status,
          bodyText,
          json,
          headers: response.headers,
          telemetry: parseTelemetry(response.headers, options.telemetryMap),
          providerId: options.providerId,
          modelId: options.modelId ?? null,
          detectDailyQuota: true,
        });
      }

      const telemetry = parseTelemetry(response.headers, options.telemetryMap);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let emittedTelemetry = false;
      while (true) {
        armIdleTimer();
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const text = decoder.decode(value, { stream: true });
          if (text) {
            yield { text, telemetry: emittedTelemetry ? {} : telemetry };
            emittedTelemetry = true;
          }
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw classifyTransportError(err, { providerId: options.providerId, modelId: options.modelId ?? null, timeoutMs });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.byteLength ?? 0;
      if (received > maxBytes) {
        out += decoder.decode(value, { stream: true });
        await reader.cancel().catch(() => undefined);
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock?.();
  }
  return out;
}

export function parseTelemetry(
  headers: Headers,
  map: Partial<Record<TelemetryField, string[]>> | undefined,
): RateLimitTelemetry {
  const telemetry: RateLimitTelemetry = {};
  if (!map) return telemetry;
  const readFirst = (names: string[] | undefined): string | null => {
    for (const name of names ?? []) {
      const value = headers.get(name);
      if (value !== null && value !== '') return value;
    }
    return null;
  };
  const numericFields: TelemetryField[] = ['requestsRemaining', 'requestsLimit', 'tokensRemaining', 'tokensLimit'];
  for (const field of Object.keys(map) as TelemetryField[]) {
    const raw = readFirst(map[field]);
    if (raw === null) continue;
    if (numericFields.includes(field)) {
      const parsed = Number.parseInt(raw.replace(/[^0-9-]/g, ''), 10);
      if (Number.isFinite(parsed)) (telemetry as Record<string, unknown>)[field] = parsed;
    } else {
      (telemetry as Record<string, unknown>)[field] = raw;
    }
  }
  if (telemetry.retryAfter === undefined) {
    const retryAfter = headers.get('retry-after');
    if (retryAfter) telemetry.retryAfter = retryAfter;
  }
  return telemetry;
}

/** Parses `retry-after` in both numeric-seconds and HTTP-date form. */
export function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  // Some providers use Go-style durations: "2m59.56s", "7.66s", "1h2m3s".
  const durationMatch = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?$/);
  if (durationMatch && (durationMatch[1] || durationMatch[2] || durationMatch[3])) {
    const hours = Number(durationMatch[1] ?? 0);
    const minutes = Number(durationMatch[2] ?? 0);
    const secs = Number(durationMatch[3] ?? 0);
    return Math.round(((hours * 60 + minutes) * 60 + secs) * 1000);
  }
  return null;
}

const CONTEXT_LENGTH_PATTERNS = [
  /context length/i,
  /context window/i,
  /maximum context/i,
  /too many tokens/i,
  /reduce the length/i,
  /input is too long/i,
  /exceeds the maximum number of tokens/i,
];

const QUOTA_PATTERNS = [/quota/i, /daily limit/i, /per day/i, /insufficient (credit|balance)/i, /billing/i, /out of credits/i];
const MODEL_PATTERNS = [/model not found/i, /no such model/i, /does not exist/i, /unknown model/i, /model.*(deprecated|decommissioned|retired)/i];
const CONTENT_FILTER_PATTERNS = [/content filter/i, /safety/i, /blocked by/i, /flagged/i];

export function classifyHttpError(input: {
  status: number;
  bodyText: string;
  json: unknown;
  headers: Headers;
  telemetry: RateLimitTelemetry;
  providerId: string;
  modelId: string | null;
  detectDailyQuota: boolean;
}): ProviderError {
  const { status, bodyText, json, headers, telemetry, providerId, modelId, detectDailyQuota } = input;
  const message = extractErrorMessage(json, bodyText);
  const retryAfterMs = parseRetryAfter(headers.get('retry-after') ?? telemetry.retryAfter ?? null);

  let category: ErrorCategory;
  if (status === 401 || status === 403) category = 'authentication';
  else if (status === 404) category = MODEL_PATTERNS.some((re) => re.test(message)) ? 'model_unavailable' : 'invalid_request';
  else if (status === 408 || status === 504) category = 'timeout';
  else if (status === 429) {
    // Distinguish a transient per-minute rate limit from an exhausted daily budget:
    // retrying the former helps, retrying the latter burns time and quota headroom.
    const looksLikeHardQuota =
      detectDailyQuota &&
      (QUOTA_PATTERNS.some((re) => re.test(message)) ||
        (telemetry.tokensRemaining === 0 && telemetry.tokensLimit !== undefined) ||
        (telemetry.requestsRemaining === 0 && telemetry.requestsLimit !== undefined));
    category = looksLikeHardQuota ? 'quota_exhausted' : 'rate_limit';
  } else if (status === 400 || status === 422) {
    if (CONTEXT_LENGTH_PATTERNS.some((re) => re.test(message))) category = 'context_length';
    else if (MODEL_PATTERNS.some((re) => re.test(message))) category = 'model_unavailable';
    else if (CONTENT_FILTER_PATTERNS.some((re) => re.test(message))) category = 'content_filter';
    else category = 'invalid_request';
  } else if (status >= 500) category = 'server_error';
  else category = 'unknown';

  return new ProviderError({
    category,
    message: `HTTP ${status}: ${message}`,
    providerId,
    modelId,
    retryAfterMs,
    telemetry,
  });
}

export function classifyTransportError(err: unknown, context: { providerId: string; modelId: string | null; timeoutMs: number }): ProviderError {
  const error = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = error?.code ?? error?.cause?.code;
  const message = error?.message ?? String(err);

  if (error?.name === 'AbortError' || /abort/i.test(message)) {
    const isTimeout = /timeout/i.test(message);
    return new ProviderError({
      category: isTimeout || !/cancel/i.test(message) ? 'timeout' : 'cancelled',
      message: isTimeout ? `Request timed out after ${context.timeoutMs}ms.` : 'Request was cancelled.',
      providerId: context.providerId,
      modelId: context.modelId,
      cause: err,
    });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || /fetch failed/i.test(message)) {
    return new ProviderError({
      category: 'network_error',
      message: `Network error${code ? ` (${code})` : ''}: ${message}`,
      providerId: context.providerId,
      modelId: context.modelId,
      cause: err,
    });
  }
  return new ProviderError({
    category: 'unknown',
    message: message.slice(0, 500),
    providerId: context.providerId,
    modelId: context.modelId,
    cause: err,
  });
}

export function extractErrorMessage(json: unknown, bodyText: string): string {
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>;
    // OpenAI-compatible shapes
    const error = record.error;
    if (typeof error === 'string') return truncate(error);
    if (error && typeof error === 'object') {
      const nested = error as Record<string, unknown>;
      const candidate = nested.message ?? nested.detail ?? nested.reason ?? nested.type;
      if (typeof candidate === 'string') {
        const code = typeof nested.code === 'string' ? ` [${nested.code}]` : '';
        return truncate(`${candidate}${code}`);
      }
    }
    // Google shape
    if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).status === 'string') {
      const nested = error as Record<string, unknown>;
      return truncate(`${String(nested.status)}: ${String(nested.message ?? '')}`);
    }
    if (typeof record.message === 'string') return truncate(record.message);
    if (typeof record.detail === 'string') return truncate(record.detail);
    // Google's list-of-errors shape
    if (Array.isArray(record.errors) && record.errors.length) {
      const first = record.errors[0] as Record<string, unknown>;
      if (typeof first?.message === 'string') return truncate(first.message);
    }
  }
  const stripped = bodyText.replace(/\s+/g, ' ').trim();
  return truncate(stripped || 'no response body');
}

function truncate(value: string, max = 600): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
