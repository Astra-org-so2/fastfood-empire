import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodTypeAny } from 'zod';

/**
 * HTTP plumbing: validation, error mapping and pagination.
 *
 * Every input crosses a Zod boundary, so a malformed request produces a 400 with a
 * field-level explanation instead of a stack trace, and every thrown error is
 * mapped to a status code in exactly one place.
 */

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, message, details);
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, message);
  }

  static conflict(message: string): ApiError {
    return new ApiError(409, message);
  }

  static unavailable(message: string): ApiError {
    return new ApiError(503, message);
  }
}

/** Validates and returns the parsed value, or throws a 400 with the issues. */
export function parse<T extends ZodTypeAny>(schema: T, value: unknown, what = 'request'): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw ApiError.badRequest(
      `Invalid ${what}.`,
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export function requireParam(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, string | undefined>;
  const value = params[name];
  if (!value) throw ApiError.badRequest(`Missing path parameter "${name}".`);
  return value;
}

export function limitFrom(request: FastifyRequest, fallback = 100, max = 1_000): number {
  const query = request.query as Record<string, string | undefined>;
  const raw = Number(query.limit ?? fallback);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), max);
}

/** Wraps a handler so thrown errors become structured JSON responses. */
export function handler<Params = unknown>(
  fn: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    try {
      const result = await fn(request as FastifyRequest, reply);
      if (reply.sent) return reply;
      return result === undefined ? null : result;
    } catch (err) {
      if (err instanceof ApiError) {
        return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? null });
      }
      const message = err instanceof Error ? err.message : String(err);
      request.log.error({ err }, 'request failed');
      // Message is surfaced because this is a local, single-operator tool; it is what
      // makes a failure actionable instead of a generic 500.
      return reply.status(500).send({ error: message });
    }
  };
}

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
