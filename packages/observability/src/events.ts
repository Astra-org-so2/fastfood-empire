import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { EventQuery, EventSeverity, EventType, OrchestratorEvent } from '@aido/types';
import type { Logger } from './logger.js';
import { severityToLogLevel } from './logger.js';

export type EventListener = (event: OrchestratorEvent) => void;

export interface EventBusOptions {
  logger: Logger;
  /** Optional persistence (the DB-backed event store). Failures must not break the bus. */
  persist?: (event: OrchestratorEvent) => void;
  /** Ring-buffer size for the in-memory "recent events" view. */
  bufferSize?: number;
}

/**
 * In-process, typed event bus (§34).
 *
 * Design notes:
 *  - Listeners can never break the publisher: every call is wrapped and errors
 *    are logged, not thrown. A broken SSE client must not fail an LLM request.
 *  - Events are persisted asynchronously; the bus does not await the DB.
 *  - A bounded ring buffer backs the Activity screen's initial load, so the UI
 *    renders instantly on connect and then follows the live stream.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: OrchestratorEvent[] = [];
  private readonly bufferSize: number;
  private readonly logger: Logger;
  private readonly persistFn: ((event: OrchestratorEvent) => void) | undefined;
  private droppedPersistErrors = 0;

  constructor(options: EventBusOptions) {
    this.logger = options.logger;
    this.bufferSize = options.bufferSize ?? 500;
    this.persistFn = options.persist;
    this.emitter.setMaxListeners(200);
  }

  emit<T>(
    type: EventType,
    payload: T,
    init: Omit<Partial<OrchestratorEvent<T>>, 'type' | 'payload'> & { message: string; severity?: EventSeverity },
  ): OrchestratorEvent<T> {
    const event: OrchestratorEvent<T> = {
      id: randomUUID(),
      type,
      severity: init.severity ?? defaultSeverity(type),
      projectId: init.projectId ?? null,
      taskId: init.taskId ?? null,
      agentId: init.agentId ?? null,
      traceId: init.traceId ?? null,
      message: init.message,
      payload,
      at: init.at ?? new Date().toISOString(),
    };

    this.buffer.push(event as OrchestratorEvent);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();

    const level = severityToLogLevel(event.severity);
    if (this.logger.isEnabled(level)) {
      this.logger[level](event.message, {
        event: event.type,
        projectId: event.projectId ?? undefined,
        taskId: event.taskId ?? undefined,
        agentId: event.agentId ?? undefined,
        traceId: event.traceId ?? undefined,
      });
    }

    // A failing listener or store must never propagate into domain code.
    try {
      this.emitter.emit('event', event);
    } catch (err) {
      this.logger.error('event listener threw', { error: err instanceof Error ? err.message : String(err), event: type });
    }

    if (this.persistFn) {
      try {
        this.persistFn(event as OrchestratorEvent);
      } catch (err) {
        this.droppedPersistErrors += 1;
        if (this.droppedPersistErrors <= 5 || this.droppedPersistErrors % 100 === 0) {
          this.logger.error('event persistence failed', {
            error: err instanceof Error ? err.message : String(err),
            dropped: this.droppedPersistErrors,
          });
        }
      }
    }

    return event;
  }

  /** Subscribe to every event. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    const wrapped: EventListener = (event) => {
      try {
        listener(event);
      } catch (err) {
        this.logger.error('event subscriber threw', { error: err instanceof Error ? err.message : String(err) });
      }
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  /** Recent in-memory events, newest last. */
  recent(query: EventQuery = {}): OrchestratorEvent[] {
    let items = this.buffer;
    if (query.projectId) items = items.filter((e) => e.projectId === query.projectId);
    if (query.taskId) items = items.filter((e) => e.taskId === query.taskId);
    if (query.agentId) items = items.filter((e) => e.agentId === query.agentId);
    if (query.types?.length) {
      const set = new Set(query.types);
      items = items.filter((e) => set.has(e.type));
    }
    if (query.severity?.length) {
      const set = new Set(query.severity);
      items = items.filter((e) => set.has(e.severity));
    }
    if (query.since) items = items.filter((e) => e.at >= query.since!);
    const limit = query.limit ?? 200;
    return items.slice(-limit);
  }

  listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}

function defaultSeverity(type: EventType): EventSeverity {
  if (type.endsWith('failed') || type === 'system.error' || type === 'git.conflict' || type === 'security.issue_found') {
    return 'error';
  }
  if (
    type === 'quota.exhausted' ||
    type === 'quota.reservation_denied' ||
    type === 'supervisor.intervention' ||
    type === 'supervisor.limit_reached' ||
    type === 'approval.requested' ||
    type === 'performance.regression' ||
    type === 'task.blocked' ||
    type === 'llm.failover'
  ) {
    return 'warning';
  }
  if (type.startsWith('llm.') || type.startsWith('quota.') || type.startsWith('router.')) return 'debug';
  return 'info';
}
