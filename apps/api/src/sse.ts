import type { FastifyInstance, FastifyReply } from 'fastify';
import type { OrchestratorEvent } from '@aido/types';
import type { Container } from './container.js';

/**
 * Server-Sent Events hub (§30).
 *
 * The UI subscribes once and receives every agent message, task transition, quota
 * decision, provider health change and approval request as it happens. SSE is used
 * rather than WebSockets because the stream is one-directional (server → UI),
 * survives proxies, reconnects automatically in the browser, and lets the desktop
 * shell use the identical transport as the web shell (§54).
 */

export interface SseFilter {
  projectId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  types?: string[];
}

export function createSseHub(container: Container) {
  const clients = new Set<{ reply: FastifyReply; filter: SseFilter }>();

  const send = (client: { reply: FastifyReply; filter: SseFilter }, event: OrchestratorEvent) => {
    const { filter } = client;
    if (filter.projectId && event.projectId !== filter.projectId) return;
    if (filter.taskId && event.taskId !== filter.taskId) return;
    if (filter.agentId && event.agentId !== filter.agentId) return;
    if (filter.types?.length && !filter.types.includes(event.type)) return;
    try {
      client.reply.raw.write(`event: ${event.type}\n`);
      client.reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      clients.delete(client);
    }
  };

  // One bus subscription fans out to every connected client.
  const unsubscribe = container.events.subscribe((event) => {
    for (const client of clients) send(client, event);
  });

  return {
    register(app: FastifyInstance): void {
      app.get('/api/events/stream', (request, reply) => {
        const query = request.query as Record<string, string | undefined>;
        const filter: SseFilter = {
          projectId: query.projectId ?? null,
          taskId: query.taskId ?? null,
          agentId: query.agentId ?? null,
          types: query.types ? query.types.split(',').filter(Boolean) : undefined,
        };

        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          // Proxies (including the sandbox preview) must not buffer the stream.
          'X-Accel-Buffering': 'no',
        });
        reply.raw.write(': connected\n\n');

        const client = { reply, filter };
        clients.add(client);

        // Heartbeat keeps intermediaries from closing an idle connection and gives
        // the UI a cheap liveness signal.
        const heartbeat = setInterval(() => {
          try {
            reply.raw.write(`: ping ${Date.now()}\n\n`);
          } catch {
            clearInterval(heartbeat);
            clients.delete(client);
          }
        }, 15_000);
        heartbeat.unref?.();

        // Recent history so a freshly opened screen is not empty.
        const history = container.store.events.query({
          projectId: filter.projectId ?? undefined,
          limit: 50,
        });
        for (const event of history.reverse()) send(client, event);

        request.raw.on('close', () => {
          clearInterval(heartbeat);
          clients.delete(client);
          reply.raw.end();
        });
      });
    },

    clientCount(): number {
      return clients.size;
    },

    close(): void {
      unsubscribe?.();
      for (const client of clients) {
        try {
          client.reply.raw.end();
        } catch {
          // already closed
        }
      }
      clients.clear();
    },
  };
}

export type SseHub = ReturnType<typeof createSseHub>;
