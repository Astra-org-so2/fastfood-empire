import { ProviderError } from '@aido/types';

/**
 * Retry/backoff primitives (§20, §39).
 *
 * The one rule that matters: only retry what can succeed. A 401 retried six times
 * is six wasted requests against a free quota; a context-length error retried is
 * never going to fit. `ProviderError.retryable` already encodes this, and
 * `classifyHttpError` is the single place that decides it.
 */

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Full jitter: delay = random(0, computed). Prevents thundering herds across agents. */
  jitter: 'full' | 'equal' | 'none';
  /** Honour the provider's retry-after, clamped to maxDelayMs. */
  honourRetryAfter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: 'full',
  honourRetryAfter: true,
};

export interface RetryContext {
  attempt: number;
  error: ProviderError;
  delayMs: number;
}

export interface RetryOptions {
  policy?: Partial<RetryPolicy>;
  signal?: AbortSignal;
  onRetry?: (context: RetryContext) => void;
  /** Injected for tests so retries do not actually sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function computeDelayMs(attempt: number, policy: RetryPolicy, error: ProviderError): number {
  if (policy.honourRetryAfter && error.retryAfterMs !== null && error.retryAfterMs > 0) {
    return Math.min(error.retryAfterMs, policy.maxDelayMs);
  }
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  switch (policy.jitter) {
    case 'full':
      return Math.round(Math.random() * exponential);
    case 'equal':
      return Math.round(exponential / 2 + Math.random() * (exponential / 2));
    default:
      return exponential;
  }
}

/**
 * Runs `operation` with retries. Non-retryable failures throw immediately so the
 * caller can fail over to another provider instead of stalling.
 */
export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await operation(attempt);
    } catch (err) {
      const error =
        err instanceof ProviderError
          ? err
          : new ProviderError({ category: 'unknown', message: err instanceof Error ? err.message : String(err), providerId: 'unknown', cause: err });

      // Cancellation is never retried.
      if (options.signal?.aborted || error.category === 'cancelled') throw error;
      if (!error.retryable || attempt >= policy.maxAttempts) throw error;

      const delayMs = computeDelayMs(attempt, policy, error);
      options.onRetry?.({ attempt, error, delayMs });
      await (options.sleep ?? sleep)(delayMs, options.signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError({ category: 'cancelled', message: 'Sleep aborted', providerId: 'internal' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError({ category: 'cancelled', message: 'Sleep aborted', providerId: 'internal' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Circuit breaker per provider/model. Prevents an outage from consuming the
 * remaining budget of every other provider through endless failover (§20).
 */
export interface CircuitState {
  consecutiveFailures: number;
  openedAt: number | null;
  halfOpenAttempts: number;
}

export class CircuitBreaker {
  private readonly states = new Map<string, CircuitState>();

  constructor(
    private readonly options: {
      failureThreshold: number;
      openMs: number;
      halfOpenMaxAttempts?: number;
      now?: () => number;
    },
  ) {}

  private key(providerId: string, modelId?: string | null): string {
    return modelId ? `${providerId}:${modelId}` : providerId;
  }

  isOpen(providerId: string, modelId?: string | null): boolean {
    const state = this.states.get(this.key(providerId, modelId));
    if (!state || state.openedAt === null) return false;
    const now = this.options.now?.() ?? Date.now();
    if (now - state.openedAt >= this.options.openMs) {
      // Half-open: allow a probe through so recovery is detected automatically.
      state.halfOpenAttempts += 1;
      if (state.halfOpenAttempts > (this.options.halfOpenMaxAttempts ?? 1)) return true;
      return false;
    }
    return true;
  }

  recordSuccess(providerId: string, modelId?: string | null): void {
    this.states.delete(this.key(providerId, modelId));
  }

  recordFailure(providerId: string, modelId?: string | null, errorCategory?: string): void {
    const key = this.key(providerId, modelId);
    const state = this.states.get(key) ?? { consecutiveFailures: 0, openedAt: null, halfOpenAttempts: 0 };
    state.consecutiveFailures += 1;
    state.halfOpenAttempts = 0;
    // Auth and invalid-request failures are not "the service is down"; they are
    // configuration problems. Open the breaker anyway so we stop hammering, but
    // the provider health panel shows the concrete error.
    if (state.consecutiveFailures >= this.options.failureThreshold && (errorCategory === undefined || errorCategory !== 'cancelled')) {
      state.openedAt = this.options.now?.() ?? Date.now();
    }
    this.states.set(key, state);
  }

  snapshot(): { key: string; state: CircuitState; openUntil: number | null }[] {
    const now = this.options.now?.() ?? Date.now();
    return [...this.states.entries()].map(([key, state]) => ({
      key,
      state,
      openUntil: state.openedAt === null ? null : state.openedAt + this.options.openMs - now,
    }));
  }

  reset(): void {
    this.states.clear();
  }
}
