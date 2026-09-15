import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { Logger } from '@aido/observability';
import { createContainer, type Container, type ContainerOptions } from './container.js';
import { createSseHub, type SseHub } from './sse.js';
import { registerDashboardRoutes } from './routes/dashboard.js';

/**
 * The HTTP surface. One server process serves:
 *   - `/api/*`  — the contract every shell uses (web, desktop, worker, scripts),
 *   - `/events` — the SSE stream (see `sse.ts`),
 *   - `/*`      — the built web UI in production (single static bundle, §54).
 */

/**
 * Adapts the structured logger in `@aido/observability` to the pino-shaped interface
 * Fastify expects. Keeps one logging implementation for the whole product and avoids
 * pulling in `pino-pretty` just to make request logs readable.
 */
function toFastifyLogger(logger: Logger): FastifyBaseLogger {
  const emit = (target: Logger, level: 'trace' | 'debug' | 'info' | 'warn' | 'error', first: unknown, second?: unknown, ...rest: unknown[]): void => {
    const [fields, message] = typeof first === 'string' || first === undefined ? [second && typeof second === 'object' ? (second as Record<string, unknown>) : {}, first] : [normaliseFields(first), second];
    const text = typeof message === 'string' ? message : '';
    target[level](text || JSON.stringify(fields ?? {}), rest.length ? { ...(fields ?? {}), args: rest } : (fields ?? undefined));
  };

  const make = (target: Logger): FastifyBaseLogger =>
    ({
      level: target.level,
      silent: () => {},
      child: (bindings: Record<string, unknown>) => make(target.child(bindings ?? {})),
      fatal: (first: unknown, second?: unknown, ...rest: unknown[]) => emit(target, 'error', first, second, ...rest),
      error: (first: unknown, second?: unknown, ...rest: unknown[]) => emit(target, 'error', first, second, ...rest),
      warn: (first: unknown, second?: unknown, ...rest: unknown[]) => emit(target, 'warn', first, second, ...rest),
      info: (first: unknown, second?: unknown, ...rest: unknown[]) => emit(target, 'info', first, second, ...rest),
      debug: (first: unknown, second?: unknown, ...rest: unknown[]) => emit(target, 'debug', first, second, ...rest),
      trace: (first: unknown, second?: unknown, ...rest: unknown[]) => emit(target, 'trace', first, second, ...rest),
    }) as unknown as FastifyBaseLogger;

  return make(logger);
}

/**
 * Fastify hands us `{ req, res, err }` objects that are not JSON-serialisable (they
 * contain sockets and cycles). Logging a placeholder like "[unserialisable]" would
 * destroy the value of request logs, so the useful fields are extracted explicitly.
 */
function normaliseFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return { value };
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry instanceof Error) {
      out[key] = { name: entry.name, message: entry.message, stack: entry.stack };
      continue;
    }
    if (key === 'req' || key === 'request') out[key] = summariseRequest(entry);
    else if (key === 'res' || key === 'response') out[key] = summariseResponse(entry);
    else out[key] = entry;
  }
  return out;
}

function summariseRequest(value: unknown): unknown {
  const request = value as { method?: string; url?: string; id?: string } | null;
  if (!request || typeof request !== 'object') return value;
  return { method: request.method, url: request.url, id: request.id };
}

function summariseResponse(value: unknown): unknown {
  const response = value as { statusCode?: number } | null;
  if (!response || typeof response !== 'object') return value;
  return { statusCode: response.statusCode };
}

declare module 'fastify' {
  interface FastifyInstance {
    container: Container;
  }
}

export interface ServerHandle {
  app: FastifyInstance;
  container: Container;
  sse: SseHub;
  /**
   * Binds the HTTP listener. Pass `port: 0` to let the OS pick a free port — that is
   * what the desktop shell does, so two installations never collide on 8787.
   */
  listen(options?: { host?: string; port?: number }): Promise<string>;
  /** The port actually bound (meaningful after `listen`). */
  port(): number;
  close(): Promise<void>;
}

export interface BuildServerOptions extends ContainerOptions {
  container?: Container;
  /** Serve the built web UI from `dist/web` (production) or leave routes only. */
  serveWeb?: boolean;
  /** Directory holding the built UI bundle; overrides the config default. */
  webDistDir?: string;
}

export async function buildServer(options: BuildServerOptions = {}): Promise<ServerHandle> {
  const container =
    options.container ??
    createContainer({ ...options, configOverrides: { ...options.configOverrides, ...(options.webDistDir ? { webDistDir: options.webDistDir } : {}) } });
  const app = Fastify({
    // Fastify logs through the project's own logger, so every line — HTTP, agent,
    // quota — has the same format and the same redaction rules.
    loggerInstance: toFastifyLogger(container.logger),
    // Git diffs and agent transcripts can be large; the default 1 MiB is too small.
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: true,
    // SSE needs credentials-capable headers only if the shell uses cookies; it does not,
    // but proxies still send the origin, so keep the allowlist permissive for local use.
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  const sse = createSseHub(container);
  sse.register(app);
  // The container is available to every route and plugin through the instance.
  app.decorate('container', container);
  registerDashboardRoutes(app, container);
  registerErrorHandling(app, container);

  if (options.serveWeb ?? container.config.isProduction) {
    registerStaticWeb(app, container);
  }

  return {
    app,
    container,
    sse,
    async listen(overrides: { host?: string; port?: number } = {}): Promise<string> {
      const host = overrides.host ?? container.config.host;
      const port = overrides.port ?? container.config.apiPort;
      await app.listen({ host, port });
      const bound = app.server.address();
      const actualPort = typeof bound === 'object' && bound ? bound.port : port;
      return `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;
    },
    port() {
      const bound = app.server.address();
      return typeof bound === 'object' && bound ? bound.port : container.config.apiPort;
    },
    async close(): Promise<void> {
      sse.close();
      // Stop accepting and settle in-flight runs before storage goes away.
      await container.close();
      await app.close();
    },
  };
}

function registerErrorHandling(app: FastifyInstance, container: Container): void {
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: `No API route matches ${request.method} ${request.url}` });
    }
    // SPA fallback: the client router owns every non-API path.
    const filePath = path.join(container.config.webDistDir, 'index.html');
    if (fs.existsSync(filePath)) return reply.type('text/html').send(fs.createReadStream(filePath));
    return reply.status(404).type('text/plain').send('Web UI is not built. Run `npm run build` or use the dev server.');
  });

  app.addHook('onSend', async (request, reply, payload) => {
    // The API is a local, single-operator service; never let a proxy cache state.
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
}

/**
 * Serves the single built UI bundle. Registered only in production so the dev
 * server (Vite, with HMR) is used during development.
 */
function registerStaticWeb(app: FastifyInstance, container: Container): void {
  const distDir = container.config.webDistDir;
  if (!fs.existsSync(distDir)) {
    container.logger.warn('web bundle not found; serving API only', { distDir });
    return;
  }
  app.register(fastifyStatic, { root: distDir, prefix: '/', wildcard: false });
  container.logger.info('serving built web UI', { distDir });
}

export { createContainer };
