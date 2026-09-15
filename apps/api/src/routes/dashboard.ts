import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerProjectRoutes } from './projects.js';
import { registerProviderRoutes } from './system.js';
import type { Container } from '../container.js';
import { ApiError, handler, isoDaysAgo, limitFrom, parse, requireParam } from '../http.js';

/**
 * Dashboard and health routes.
 *
 * The dashboard is the first thing an operator sees, so it answers the four
 * questions that actually matter: is anything running, what is it spending, what
 * needs a decision, and what does the system not know yet.
 */
export function registerDashboardRoutes(app: FastifyInstance, container: Container): void {
  const { store, registry, quota, runner, settings, events } = container;

  app.get(
    '/api/dashboard',
    handler(() => {
      const projects = store.projects.list();
      const since = isoDaysAgo(7);
      const totals = store.traces.totals(since);
      const activeRuns = runner.listActive();

      return {
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          status: project.status,
          updatedAt: project.updatedAt,
          counts: store.tasks.countsByStatus(project.id),
          run: runner.status(project.id),
        })),
        runs: { active: activeRuns.length, projectIds: activeRuns },
        usage: {
          since,
          ...totals,
        },
        providers: registry.summaries().map((summary) => ({
          id: summary.id,
          name: summary.name,
          enabled: summary.enabled,
          configured: summary.configured,
          health: summary.health,
          simulated: summary.simulated,
          credentialStatus: summary.credentialStatus.state,
          models: summary.modelCount,
          freeModels: summary.freeModelCount,
          cooldownUntil: summary.cooldownUntil,
          quotaType: summary.freeTier.quotaType,
        })),
        freeOnlyMode: settings().freeOnlyMode,
        approvals: container.approvals.pending().map((approval) => ({
          id: approval.id,
          projectId: approval.projectId,
          taskId: approval.taskId,
          agentId: approval.agentId,
          action: approval.action,
          reason: approval.reason,
          risk: approval.risk,
          payload: approval.payload,
          requestedAt: approval.requestedAt,
          decidedAt: approval.decidedAt,
          decidedBy: approval.decidedBy,
        })),
        /** Held-back reservations and expired ones, so leaks are visible. */
        reservations: {
          open: store.quota.openReservations().length,
          expired: store.quota.expireReservations(new Date().toISOString()).length,
        },
        recentEvents: store.events.query({ limit: 40 }),
        warnings: container.healthWarnings(),
      };
    }),
  );

  app.get(
    '/api/health',
    handler(() => ({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      database: { path: container.config.dbPath, bytes: store.db.sizeBytes(), migrations: store.db.migrations() },
      /** Providers that are enabled but cannot actually serve a request. */
      degraded: container.healthWarnings(),
      shell: container.shell,
      version: container.version,
    })),
  );

  /** Cheap liveness probe for the desktop shell and the dev launcher. */
  app.get('/api/ping', handler(() => ({ pong: new Date().toISOString() })));

  app.get(
    '/api/system/metrics',
    handler(() => container.systemMetrics.latest()),
  );

  app.get(
    '/api/events',
    handler((request) => {
      const query = request.query as Record<string, string | undefined>;
      return store.events.query({
        projectId: query.projectId ?? undefined,
        taskId: query.taskId ?? undefined,
        agentId: query.agentId ?? undefined,
        since: query.since ?? undefined,
        types: query.types ? (query.types.split(',') as never) : undefined,
        severity: query.severity ? (query.severity.split(',') as never) : undefined,
        limit: limitFrom(request, 200, 2_000),
      });
    }),
  );

  /**
   * Commands the desktop shell (and the web UI) can trigger through one contract,
   * so the Electron main process and the browser use identical code paths (§54).
   */
  app.post(
    '/api/system/action',
    handler(async (request) => {
      const body = parse(
        z.object({
          action: z.enum([
            'run.maintenance',
            'providers.reload',
            'providers.health_check_all',
            'events.purge',
            'traces.purge',
            'quota.release_expired',
            'models.refresh_priorities',
          ]),
          projectId: z.string().optional(),
          olderThanDays: z.number().int().min(1).max(365).optional(),
        }),
        request.body,
        'action',
      );

      switch (body.action) {
        case 'run.maintenance': {
          runner.maintenance();
          return { ok: true, detail: 'Reservation and approval maintenance completed.' };
        }
        case 'providers.reload': {
          return { ok: true, ...container.reloadProviders() };
        }
        case 'providers.health_check_all': {
          const results = await registry.healthCheckAll();
          return { ok: true, providers: results };
        }
        case 'events.purge': {
          const cutoff = isoDaysAgo(body.olderThanDays ?? settings().eventRetentionDays);
          const deleted = store.events.purgeBefore(cutoff);
          events.emit('system.notice', { deleted, cutoff }, { message: `Purged ${deleted} event(s) older than ${cutoff}`, severity: 'info' });
          return { ok: true, deleted };
        }
        case 'traces.purge': {
          const cutoff = isoDaysAgo(body.olderThanDays ?? settings().telemetryRetentionDays);
          const deleted = store.traces.purgeBefore(cutoff);
          return { ok: true, deleted };
        }
        case 'quota.release_expired': {
          const released = quota.expireStaleReservations();
          return { ok: true, released };
        }
        case 'models.refresh_priorities': {
          const models = store.models.list({ limit: 5_000 });
          for (const model of models) {
            const limits = quota.effectiveLimits(model.providerId, model);
            const usageInfo = quota.usage(model.providerId, model);
            // Priority is a derived hint, never a hidden source of truth: it is
            // recomputed from the live quota situation the operator can see.
            const remaining = usageInfo.remainingFraction;
            const priority = remaining === null ? 0 : Math.round((remaining - 0.5) * 200);
            store.models.update(model.id, { priority });
            void limits;
          }
          return { ok: true, models: models.length };
        }
        default: {
          throw ApiError.badRequest(`Unsupported action "${String(body.action)}".`);
        }
      }
    }),
  );

  app.get(
    '/api/system/explanations/:traceId',
    handler((request) => {
      const trace = store.traces.get(requireParam(request, 'traceId'));
      if (!trace) throw ApiError.notFound('Trace not found.');
      return trace.routingRationale;
    }),
  );

  // Everything project/model/provider related hangs off the same registrars.
  registerProjectRoutes(app, container);
  registerProviderRoutes(app, container);
}
