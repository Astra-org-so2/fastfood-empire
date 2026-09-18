import type { EventBus, Logger } from '@aido/observability';
import type { OrchestratorEvent } from '@aido/types';
import type { NotificationSink } from './index.js';

/**
 * Turns a small, curated set of orchestrator events into system notifications (§54).
 *
 * Not every event deserves a desktop notification — relaying them all would make the
 * feature useless. The selection below is the "a human would want to know now" set:
 * a finished run, a failed run, an approval that blocks progress, and a provider that
 * failed a health check. Repeated messages about the same topic are collapsed with a
 * per-tag cooldown, because a retry storm must not produce a notification storm.
 *
 * Notifications are best-effort: delivery failures are logged at debug level and never
 * affect the run, which is why the subscriber returns immediately.
 */
export interface NotificationBridgeOptions {
  events: EventBus;
  sink: NotificationSink;
  logger: Logger;
  /** Minimum milliseconds between two notifications sharing a tag. */
  cooldownMs?: number;
  /** Injected for tests. */
  now?: () => number;
}

export interface NotificationBridge {
  /** Events that were forwarded, and events suppressed by the cooldown. */
  stats(): { delivered: number; suppressed: number; failed: number };
  dispose(): void;
}

interface NotificationRule {
  tag: string;
  urgency: 'low' | 'normal' | 'critical';
  title: (event: OrchestratorEvent) => string;
  body: (event: OrchestratorEvent) => string;
}

function projectName(event: OrchestratorEvent): string {
  const payload = event.payload as { projectName?: string; projectId?: string } | undefined;
  return payload?.projectName ?? payload?.projectId ?? 'project';
}

const RULES: Record<string, NotificationRule> = {
  'run.finished': {
    tag: 'run',
    urgency: 'normal',
    title: (event) => (event.severity === 'error' ? 'Agent run failed' : 'Agent run finished'),
    body: (event) => `${event.message} (${projectName(event)})`,
  },
  'approval.requested': {
    tag: 'approval',
    urgency: 'critical',
    title: () => 'Approval required',
    body: (event) => `${event.message} — an agent is waiting for your decision.`,
  },
  'provider.health_changed': {
    tag: 'provider',
    urgency: 'normal',
    title: () => 'Provider health changed',
    body: (event) => event.message,
  },
  'quota.exhausted': {
    tag: 'quota',
    urgency: 'normal',
    title: () => 'Free quota exhausted',
    body: (event) => `${event.message} — the router will use another provider.`,
  },
  'system.notice': {
    tag: 'system',
    urgency: 'low',
    title: () => 'AI Dev Orchestrator',
    body: (event) => event.message,
  },
};

export function attachNotificationBridge(options: NotificationBridgeOptions): NotificationBridge {
  const cooldownMs = options.cooldownMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const lastSent = new Map<string, number>();
  const counters = { delivered: 0, suppressed: 0, failed: 0 };

  if (!options.sink.supported()) {
    // Say it once, in the log, instead of failing quietly on every event.
    options.logger.info('system notifications are unavailable in this environment; the in-app activity feed remains the notification channel');
    return { stats: () => ({ ...counters }), dispose: () => undefined };
  }

  const unsubscribe = options.events.subscribe((event) => {
    const rule = RULES[event.type];
    if (!rule) return;
    // An informational system notice is not worth a desktop notification unless it is
    // a warning or worse: those are the ones that need attention.
    if (event.type === 'system.notice' && event.severity === 'info') return;

    const previous = lastSent.get(rule.tag) ?? 0;
    if (now() - previous < cooldownMs) {
      counters.suppressed += 1;
      return;
    }
    lastSent.set(rule.tag, now());

    void options.sink
      .notify({ title: rule.title(event), body: rule.body(event), urgency: rule.urgency, tag: rule.tag })
      .then((result) => {
        if (result.delivered) counters.delivered += 1;
        else {
          counters.failed += 1;
          options.logger.debug('notification not delivered', { reason: result.reason, event: event.type });
        }
      })
      .catch((err: unknown) => {
        counters.failed += 1;
        options.logger.debug('notification failed', { error: err instanceof Error ? err.message : String(err) });
      });
  });

  return { stats: () => ({ ...counters }), dispose: unsubscribe };
}
