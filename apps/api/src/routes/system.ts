import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TASK_TYPES, type AgentId, type LLMTrace, type ResetStrategy } from '@aido/types';
import { AGENT_ROLES, DEFAULT_TEAM, getAgentRole } from '@aido/agents';
import { estimateCapacity } from '@aido/quota-engine';
import type { Container } from '../container.js';
import { ApiError, handler, isoDaysAgo, limitFrom, parse, requireParam } from '../http.js';

/**
 * Provider, model, quota, agent, observability and settings routes.
 *
 * Anything that cannot be determined is returned as `null`/`unknown` with a reason,
 * never as a plausible-looking default: the UI must be able to show "not known yet"
 * rather than inventing a quota or a capability (§5, §21).
 */

const CredentialSchema = z.object({
  /** Extra fields for providers that need more than one secret (e.g. account id). */
  fields: z.record(z.string().min(1).max(4_000)).refine((value) => Object.keys(value).length > 0, 'at least one credential field is required'),
  label: z.string().max(200).optional(),
});

const OverrideSchema = z.object({
  enabled: z.boolean().optional(),
  quotaType: z.enum(['free_renewable', 'free_trial', 'paid', 'unknown', 'user_hosted']).optional(),
  resetStrategy: z.enum(['utc_midnight', 'provider_timezone', 'rolling_24h', 'explicit_timestamp', 'api_reported', 'unknown']).optional(),
  resetTimezone: z.string().max(80).nullable().optional(),
  quotaLimits: z
    .object({
      requestsPerMinute: z.number().int().min(0).nullable().optional(),
      requestsPerHour: z.number().int().min(0).nullable().optional(),
      requestsPerDay: z.number().int().min(0).nullable().optional(),
      requestsPerMonth: z.number().int().min(0).nullable().optional(),
      tokensPerMinute: z.number().int().min(0).nullable().optional(),
      tokensPerDay: z.number().int().min(0).nullable().optional(),
      tokensPerMonth: z.number().int().min(0).nullable().optional(),
      concurrentRequests: z.number().int().min(0).nullable().optional(),
      resetStrategy: z.enum(['utc_midnight', 'provider_timezone', 'rolling_24h', 'explicit_timestamp', 'api_reported', 'unknown']).nullable().optional(),
      resetTimezone: z.string().max(80).nullable().optional(),
    })
    .nullable()
    .optional(),
  notes: z.string().max(2_000).nullable().optional(),
});

const SettingsPatchSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).optional(),
  denseMode: z.boolean().optional(),
  executionMode: z.enum(['auto', 'supervised', 'manual']).optional(),
  freeOnlyMode: z.boolean().optional(),
  allowUnknownQuotaProviders: z.boolean().optional(),
  router: z
    .object({
      defaultStrategy: z.enum(['balanced', 'cheapest', 'fastest', 'highest_quality', 'most_reliable']).optional(),
      spreadAcrossProviders: z.boolean().optional(),
      reserveFraction: z.number().min(0).max(0.95).optional(),
    })
    .optional(),
  supervisor: z
    .object({
      maxRetriesPerTask: z.number().int().min(0).max(20).optional(),
      maxTokensPerTask: z.number().int().min(1_000).optional(),
      maxTaskRuntimeMs: z.number().int().min(10_000).optional(),
      maxAgentIterations: z.number().int().min(1).max(100).optional(),
      maxParallelAgents: z.number().int().min(1).max(8).optional(),
      maxTotalRunTokens: z.number().int().min(0).nullable().optional(),
      enabled: z.boolean().optional(),
    })
    .optional(),
  quota: z
    .object({
      reserveFraction: z.number().min(0).max(0.95).optional(),
      assumeUnknownIsUnlimited: z.boolean().optional(),
      refreshIntervalMs: z.number().int().min(5_000).optional(),
      telemetryTrustWeight: z.number().min(0).max(1).optional(),
    })
    .optional(),
  notifications: z
    .object({ approvals: z.boolean().optional(), failures: z.boolean().optional(), quota: z.boolean().optional(), desktop: z.boolean().optional() })
    .optional(),
});

export function registerProviderRoutes(app: FastifyInstance, container: Container): void {
  const { store, registry, quota, router, events, vault, settings } = container;

  // ---------------------------------------------------------------- providers

  app.get(
    '/api/providers',
    handler(() => ({
      providers: registry.summaries(),
    })),
  );

  app.get(
    '/api/providers/catalog',
    handler(() => ({
      /** Definitions shipped with the app, whether or not they are configured. */
      definitions: registry.definitionsList().map((definition) => ({
        id: definition.id,
        name: definition.name,
        kind: definition.kind,
        documentationUrl: definition.documentationUrl,
        apiBaseUrl: definition.apiBaseUrl,
        authenticationType: definition.authenticationType,
        credentialFields: definition.credentialFields ?? [],
        envKeys: definition.envKeys,
        usageEndpoint: definition.usageEndpoint,
        modelsEndpoint: definition.modelsEndpoint,
        healthEndpoint: definition.healthEndpoint,
        telemetrySemantics: definition.telemetrySemantics ?? null,
        freeTier: definition.freeTier,
        quotaLimits: definition.quotaLimits,
        seedModels: definition.seedModels ?? [],
        capabilities: definition.capabilities,
        metadataVerified: definition.metadataVerified,
        lastVerifiedAt: definition.lastVerifiedAt,
        notes: definition.notes,
        registered: registry.registeredProviderIds().includes(definition.id),
      })),
      settings: {
        freeOnlyMode: settings().freeOnlyMode,
        assumeUnknownIsUnlimited: settings().quota.assumeUnknownIsUnlimited,
      },
    })),
  );

  app.get(
    '/api/providers/:providerId',
    handler((request) => {
      const providerId = requireParam(request, 'providerId');
      const summary = registry.summary(providerId);
      if (!summary) throw ApiError.notFound(`Provider ${providerId} not found.`);
      return {
        ...summary,
        definition: registry.definition(providerId),
        credentials: vault.listForProvider(providerId),
        models: store.models.list({ providerId }),
        observations: store.quota.latestObservation(providerId, ''),
        buckets: store.quota.listBuckets(providerId),
      };
    }),
  );

  app.post(
    '/api/providers/:providerId/credentials',
    handler(async (request) => {
      const providerId = requireParam(request, 'providerId');
      const definition = registry.definition(providerId);
      if (!definition) throw ApiError.notFound(`Provider ${providerId} not found.`);
      const body = parse(CredentialSchema, request.body, 'credentials');
      const allowed = new Set((definition.credentialFields ?? []).map((field) => field.key));
      for (const [field] of Object.entries(body.fields)) {
        if (allowed.size && !allowed.has(field)) {
          throw ApiError.badRequest(`Provider ${providerId} does not declare a credential field named "${field}".`);
        }
      }
      for (const [field, value] of Object.entries(body.fields)) {
        vault.set(providerId, field, value);
        // The value is written once and never read back through the API.
        events.emit('provider.credentials_updated', { providerId, field }, { message: `Credential saved for ${definition.name} (${field})`, severity: 'info' });
      }
      registry.invalidate(providerId);
      store.providers.upsertFromDefinition(definition, { enabled: true });
      const status = await registry.testConnection(providerId);
      const discovery = status.state === 'valid' ? await registry.discoverModels(providerId) : { models: [], added: 0, updated: 0, error: null };
      return { credential: vault.describe(providerId, Object.keys(body.fields)[0] ?? 'apiKey'), status, discovery: { added: discovery.added, updated: discovery.updated, error: discovery.error } };
    }),
  );

  app.delete(
    '/api/providers/:providerId/credentials/:field',
    handler((request, reply) => {
      const providerId = requireParam(request, 'providerId');
      const field = requireParam(request, 'field');
      const removed = vault.delete(providerId, field);
      if (!removed) throw ApiError.notFound(`No ${field} credential stored for ${providerId}.`);
      registry.invalidate(providerId);
      reply.status(204);
      return null;
    }),
  );

  app.post(
    '/api/providers/:providerId/test',
    handler(async (request) => {
      const providerId = requireParam(request, 'providerId');
      const status = await registry.testConnection(providerId);
      events.emit(
        'provider.health_changed',
        { providerId, state: status.state },
        { message: `Credential check for ${providerId}: ${status.state}${status.detail ? ` — ${status.detail}` : ''}`, severity: status.state === 'valid' ? 'info' : 'warning' },
      );
      return status;
    }),
  );

  app.post(
    '/api/providers/:providerId/discover',
    handler(async (request) => {
      const providerId = requireParam(request, 'providerId');
      const result = await registry.discoverModels(providerId);
      if (result.error) throw ApiError.badRequest(result.error);
      events.emit(
        'model.discovered',
        { providerId, added: result.added, updated: result.updated },
        { message: `Discovered ${result.models.length} model(s) for ${providerId}: ${result.added} new, ${result.updated} updated`, severity: 'info' },
      );
      return { models: result.models, added: result.added, updated: result.updated };
    }),
  );

  app.post(
    '/api/providers/:providerId/health',
    handler(async (request) => {
      const providerId = requireParam(request, 'providerId');
      return registry.healthCheck(providerId);
    }),
  );

  app.patch(
    '/api/providers/:providerId',
    handler((request) => {
      const providerId = requireParam(request, 'providerId');
      const definition = registry.definition(providerId);
      if (!definition) throw ApiError.notFound(`Provider ${providerId} not found.`);
      const body = parse(OverrideSchema, request.body, 'provider override');

      if (body.quotaLimits !== undefined && body.quotaLimits !== null) {
        // Limits are recorded with provenance so the UI can always say where a number
        // came from. A user-entered limit is `user_configured`, never "verified".
        store.providers.saveOverride(providerId, {
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.quotaType ? { quotaType: body.quotaType } : {}),
          ...(body.resetStrategy ? { resetStrategy: body.resetStrategy } : {}),
          ...(body.resetTimezone !== undefined ? { resetTimezone: body.resetTimezone } : {}),
          ...(body.notes ? { notes: body.notes } : {}),
          quotaLimits: completeLimits(body.quotaLimits, body.resetStrategy ?? null, body.resetTimezone ?? null),
        });
      } else if (Object.keys(body).length) {
        store.providers.saveOverride(providerId, {
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.quotaType ? { quotaType: body.quotaType } : {}),
          ...(body.resetStrategy ? { resetStrategy: body.resetStrategy } : {}),
          ...(body.resetTimezone !== undefined ? { resetTimezone: body.resetTimezone } : {}),
          ...(body.notes ? { notes: body.notes } : {}),
        });
      }
      if (body.enabled !== undefined) registry.setEnabled(providerId, body.enabled);
      events.emit('provider.health_changed', { providerId, patch: Object.keys(body) }, { message: `Provider ${providerId} configuration updated`, severity: 'info' });
      return registry.summary(providerId);
    }),
  );

  // ---------------------------------------------------------------- models

  app.get(
    '/api/models',
    handler((request) => {
      const query = request.query as Record<string, string | undefined>;
      return store.models
        .list({
          providerId: query.providerId,
          enabled: query.enabled === undefined ? undefined : query.enabled === 'true',
          status: query.status as never,
          limit: limitFrom(request, 500, 5_000),
        })
        .filter((model) => (query.taskType ? router.compatibilityFor(model, query.taskType as never).score > 0 : true));
    }),
  );

  app.get(
    '/api/models/:modelId/capabilities',
    handler((request) => {
      const modelId = requireParam(request, 'modelId');
      const model = store.models.get(modelId);
      if (!model) throw ApiError.notFound(`Model ${modelId} not found.`);
      return {
        model,
        capabilities: model.capabilities,
        /** Fields that could not be discovered are listed rather than assumed. */
        unknown: Object.entries(model.capabilities)
          .filter(([, value]) => value === null || value === undefined)
          .map(([key]) => key),
        taskTypeSupport: router.compatibilityMatrix(model),
        pricing: model.pricing,
        quota: model.quota,
        taskStats: store.modelTaskStats.listForModel(modelId),
        performance: model.performance,
      };
    }),
  );

  app.patch(
    '/api/models/:modelId',
    handler((request) => {
      const modelId = requireParam(request, 'modelId');
      const body = parse(
        z.object({
          enabled: z.boolean().optional(),
          priority: z.number().int().min(-1_000).max(1_000).optional(),
          qualityPrior: z.number().min(0).max(1).optional(),
          status: z.enum(['online', 'degraded', 'offline', 'unknown']).optional(),
        }),
        request.body,
        'model patch',
      );
      const updated = store.models.update(modelId, body);
      if (!updated) throw ApiError.notFound(`Model ${modelId} not found.`);
      return updated;
    }),
  );

  /** One-click discovery across every enabled provider. */
  app.post(
    '/api/models/discover-all',
    handler(async () => {
      const results = [];
      for (const summary of registry.summaries().filter((entry) => entry.enabled && entry.configured)) {
        const result = await registry.discoverModels(summary.id);
        results.push({ providerId: summary.id, added: result.added, updated: result.updated, total: result.models.length, error: result.error });
      }
      return {
        providers: results,
        added: results.reduce((sum, entry) => sum + entry.added, 0),
        updated: results.reduce((sum, entry) => sum + entry.updated, 0),
        errors: results.filter((entry) => entry.error).map((entry) => `${entry.providerId}: ${entry.error}`),
      };
    }),
  );

  // ---------------------------------------------------------------- quotas

  app.get(
    '/api/quotas',
    handler(() => {
      const models = store.models.list({ limit: 5_000 });
      return {
        snapshots: quota.snapshots(models),
        capacity: estimateCapacity({
          store,
          effectiveLimits: (providerId, model) => quota.effectiveLimits(providerId, model),
          usage: (providerId, model) => quota.usage(providerId, model),
          reserveFraction: settings().quota.reserveFraction,
          freeOnlyMode: settings().freeOnlyMode,
          providerSummaries: () =>
            registry.summaries().map((summary) => ({
              id: summary.id,
              name: summary.name,
              enabled: summary.enabled,
              configured: summary.configured,
              simulated: summary.simulated ?? false,
            })),
        }),
        freeOnlyMode: settings().freeOnlyMode,
        reserveFraction: settings().quota.reserveFraction,
        excludeTrialCredits: true,
      };
    }),
  );

  app.get(
    '/api/quotas/:providerId',
    handler((request) => {
      const providerId = requireParam(request, 'providerId');
      const summary = registry.summary(providerId);
      if (!summary) throw ApiError.notFound(`Provider ${providerId} not found.`);
      const models = store.models.list({ providerId });
      const record = store.providers.get(providerId);
      const observations = store.quota.observedLimits(providerId, '');
      return {
        provider: summary,
        providerLimits: quota.effectiveLimits(providerId, null),
        reset: {
          strategy: record?.resetStrategy ?? 'unknown',
          timezone: record?.resetTimezone ?? null,
          /** Every window's concrete reset time, so the UI never has to guess. */
          windows: models.map((model) => ({
            modelId: model.id,
            ...quota.effectiveLimits(providerId, model),
            usage: quota.usage(providerId, model),
          })),
        },
        buckets: store.quota.listBuckets(providerId),
        observations,
        reservations: store.quota.openReservations(providerId),
      };
    }),
  );

  /** Applies live telemetry from the provider's own headers/endpoints (never guessed). */
  app.post(
    '/api/quotas/:providerId/refresh',
    handler(async (request) => {
      const providerId = requireParam(request, 'providerId');
      const usage = await registry.usage(providerId);
      const snapshots = await registry.quotaSnapshots(providerId);
      return { usage, snapshots };
    }),
  );

  app.post(
    '/api/quotas/:providerId/limits',
    handler((request) => {
      const providerId = requireParam(request, 'providerId');
      const body = parse(
        z.object({
          requestsPerMinute: z.number().int().min(0).nullable(),
          requestsPerHour: z.number().int().min(0).nullable(),
          requestsPerDay: z.number().int().min(0).nullable(),
          requestsPerMonth: z.number().int().min(0).nullable(),
          tokensPerMinute: z.number().int().min(0).nullable(),
          tokensPerDay: z.number().int().min(0).nullable(),
          tokensPerMonth: z.number().int().min(0).nullable(),
          concurrentRequests: z.number().int().min(0).nullable(),
          resetStrategy: z.enum(['utc_midnight', 'provider_timezone', 'rolling_24h', 'explicit_timestamp', 'api_reported', 'unknown']).nullable(),
          resetTimezone: z.string().max(80).nullable(),
        }),
        request.body,
        'quota limits',
      );
      store.providers.saveOverride(providerId, { quotaLimits: completeLimits(body, body.resetStrategy, body.resetTimezone) });
      return { providerLimits: quota.effectiveLimits(providerId, null), models: store.models.list({ providerId }).map((model) => quota.effectiveLimits(providerId, model)) };
    }),
  );

  // ---------------------------------------------------------------- routing policy

  app.get(
    '/api/router/policy',
    handler(() => ({
      settings: settings().router,
      policies: settings().router.policies,
      taskTypes: TASK_TYPES,
      /** Defaults shipped with the app, so the UI can show "modified from default". */
      defaults: container.config.defaults.router.policies,
    })),
  );

  app.put(
    '/api/router/policy',
    handler((request) => {
      const body = parse(
        z.object({
          defaultStrategy: z.enum(['balanced', 'cheapest', 'fastest', 'highest_quality', 'most_reliable']).optional(),
          spreadAcrossProviders: z.boolean().optional(),
          policies: z
            .array(
              z.object({
                id: z.string().min(1).max(80),
                taskType: z.string().min(1).max(80),
                preferredAgents: z.array(z.string()).optional(),
                preferredProviders: z.array(z.string()).optional(),
                excludedProviders: z.array(z.string()).optional(),
                requiredCapabilities: z.array(z.string()).optional(),
                preferredCapabilities: z.array(z.string()).optional(),
                minContextWindow: z.number().int().min(0).optional(),
                maxCostUsd: z.number().min(0).optional(),
                weights: z.record(z.number()).optional(),
                failoverDepth: z.number().int().min(1).max(10).optional(),
                freeOnly: z.boolean().optional(),
              }),
            )
            .max(60)
            .optional(),
        }),
        request.body,
        'routing policy',
      );
      const current = settings();
      const updated = container.updateSettings({
        router: {
          ...current.router,
          ...(body.defaultStrategy ? { defaultStrategy: body.defaultStrategy } : {}),
          ...(body.spreadAcrossProviders !== undefined ? { spreadAcrossProviders: body.spreadAcrossProviders } : {}),
          ...(body.policies ? { policies: body.policies as never } : {}),
        },
      });
      return { settings: updated.router };
    }),
  );

  /** Explains which model would be chosen right now, and why (§26). */
  app.post(
    '/api/router/preview',
    handler((request) => {
      const body = parse(
        z.object({
          taskType: z.string().min(1).max(80),
          agentRole: z.string().min(1).max(80).optional(),
          projectId: z.string().optional(),
          estimatedInputTokens: z.number().int().min(0).max(5_000_000).default(4_000),
          estimatedOutputTokens: z.number().int().min(0).max(5_000_000).default(2_000),
          requiredCapabilities: z.array(z.string()).optional(),
          maxCostUsd: z.number().min(0).nullable().optional(),
        }),
        request.body,
        'preview request',
      );
      const decision = router.decide({
        settings: settings(),
        taskRequest: {
          taskType: body.taskType as never,
          agentId: body.agentRole ?? null,
          projectId: body.projectId ?? null,
          prompt: '',
          requiredCapabilities: (body.requiredCapabilities ?? []) as never,
          preferredCapabilities: [],
          estimatedInputTokens: body.estimatedInputTokens,
          estimatedOutputTokens: body.estimatedOutputTokens,
          maxCostUsd: body.maxCostUsd ?? null,
          priority: 'normal',
        },
      });
      return decision;
    }),
  );

  // ---------------------------------------------------------------- agents

  app.get(
    '/api/agents',
    handler((request) => {
      const query = request.query as Record<string, string | undefined>;
      // `state` and `stats` are the names the shared UI contract (@aido/ui) uses; the
      // `projectState`/`metrics` aliases are kept so nothing that already reads this route
      // breaks. `state` is echoed with its agentId when a project is given because an agent
      // only has state in the context of one project.
      // Scoped to the project being viewed when one is selected: cross-project totals next
      // to a project's roster read as if they were that project's numbers.
      const stats = store.traces.agentStats(isoDaysAgo(7), query.projectId);
      return AGENT_ROLES.map((role) => {
        const record = query.projectId ? store.agents.get(query.projectId, role.id) : null;
        const state = record ? { ...record, agentId: role.id, lastActiveAt: record.lastActionAt } : null;
        const metrics = stats.find((stat) => stat.agentId === role.id) ?? null;
        return {
          ...role,
          state,
          stats: metrics,
          projectState: record,
          metrics,
        };
      });
    }),
  );

  app.get(
    '/api/agents/:agentId',
    handler((request) => {
      const agentId = requireParam(request, 'agentId') as AgentId;
      const query = request.query as Record<string, string | undefined>;
      let role: (typeof AGENT_ROLES)[number];
      try {
        role = getAgentRole(agentId);
      } catch {
        throw ApiError.notFound(`Agent ${agentId} is not a known role.`);
      }
      if (!role) throw ApiError.notFound(`Agent ${agentId} is not a known role.`);
      return {
        role,
        state: query.projectId ? store.agents.get(query.projectId, agentId) : null,
        stats: store.traces.agentStats(isoDaysAgo(30), query.projectId).find((stat) => stat.agentId === agentId) ?? null,
        tasks: query.projectId ? store.tasks.listByProject(query.projectId).filter((task) => task.agentRole === agentId) : [],
        recentTraces: store.traces.list({ agentId, limit: limitFrom(request, 25, 200) }),
        busyMs: query.projectId ? store.executions.durationStats(query.projectId, agentId) : null,
      };
    }),
  );

  app.post(
    '/api/agents/:agentId/pause',
    handler((request) => {
      const agentId = requireParam(request, 'agentId') as AgentId;
      const body = parse(z.object({ projectId: z.string().min(1), reason: z.string().max(300).optional() }), request.body, 'request');
      store.agents.patch(body.projectId, agentId, { paused: true, state: 'paused' });
      events.emit('agent.state_changed', { agentId, state: 'paused', reason: body.reason }, { message: `Agent ${agentId} paused: ${body.reason ?? 'no reason given'}`, projectId: body.projectId, agentId, severity: 'warning' });
      return store.agents.get(body.projectId, agentId);
    }),
  );

  app.post(
    '/api/agents/:agentId/resume',
    handler((request) => {
      const agentId = requireParam(request, 'agentId') as AgentId;
      const body = parse(z.object({ projectId: z.string().min(1) }), request.body, 'request');
      store.agents.patch(body.projectId, agentId, { paused: false, state: 'idle' });
      events.emit('agent.state_changed', { agentId, state: 'idle' }, { message: `Agent ${agentId} resumed`, projectId: body.projectId, agentId });
      return store.agents.get(body.projectId, agentId);
    }),
  );

  app.get(
    '/api/agents/team',
    handler(() => ({
      team: DEFAULT_TEAM,
      roles: AGENT_ROLES.map((role) => ({
        id: role.id,
        name: role.name,
        tagline: role.tagline,
        responsibility: role.responsibility,
        handledTaskTypes: role.handledTaskTypes,
        tools: role.tools,
        limits: role.limits,
        accent: role.accent,
      })),
    })),
  );

  // ---------------------------------------------------------------- observability

  app.get(
    '/api/activity',
    handler((request) => {
      const query = request.query as Record<string, string | undefined>;
      const since = query.since ?? isoDaysAgo(Number(query.days ?? 7));
      return {
        events: store.events.query({
          projectId: query.projectId ?? undefined,
          taskId: query.taskId ?? undefined,
          agentId: query.agentId ?? undefined,
          types: query.types ? (query.types.split(',') as never) : undefined,
          severity: query.severity ? (query.severity.split(',') as never) : undefined,
          since,
          limit: limitFrom(request, 200, 2_000),
        }),
        counts: store.events.countsByType(since),
      };
    }),
  );

  app.get(
    '/api/performance',
    handler((request) => {
      const query = request.query as Record<string, string | undefined>;
      const since = query.since ?? isoDaysAgo(Number(query.days ?? 7));
      return {
        since,
        totals: store.traces.totals(since),
        providers: store.traces.providerStats(since),
        models: store.traces.modelStats(since),
        agents: store.traces.agentStats(since),
        latency: store.traces.latencySeries(since, 'hour'),
        throughput: store.metrics.timeseries({ metric: 'llm.requests', scope: 'system', since, granularity: 'hour', aggregation: 'sum' }),
        tokens: store.metrics.timeseries({ metric: 'llm.tokens_total', scope: 'system', since, granularity: 'hour', aggregation: 'sum' }),
        cost: store.metrics.timeseries({ metric: 'llm.cost_usd', scope: 'system', since, granularity: 'hour', aggregation: 'sum' }),
        failures: store.events.query({ types: ['llm.request_failed'] as never, since, limit: 200 }),
        systemMetrics: store.metrics.timeseries({ metric: 'system.memory_rss_mb', scope: 'system', since, granularity: 'hour', aggregation: 'avg' }),
      };
    }),
  );

  app.get(
    '/api/traces',
    handler((request) => {
      const query = request.query as Record<string, string | undefined>;
      return store.traces.list({
        projectId: query.projectId,
        taskId: query.taskId,
        agentId: query.agentId,
        providerId: query.providerId,
        modelId: query.modelId,
        status: query.status as never,
        limit: limitFrom(request, 100, 1_000),
      });
    }),
  );

  app.get(
    '/api/traces/:traceId',
    handler((request) => {
      const trace = store.traces.get(requireParam(request, 'traceId'));
      if (!trace) throw ApiError.notFound('Trace not found.');
      return { trace, explanation: explainTrace(trace) };
    }),
  );

  // ---------------------------------------------------------------- approvals

  app.get(
    '/api/approvals',
    handler((request) => {
      const query = request.query as Record<string, string | undefined>;
      return container.approvals.pending(query.projectId);
    }),
  );

  app.post(
    '/api/approvals/:approvalId/decide',
    handler((request) => {
      const approvalId = requireParam(request, 'approvalId');
      const body = parse(
        z.object({
          approved: z.boolean(),
          note: z.string().max(1_000).optional(),
          /** 'once' applies to this request; 'task' approves this action for the task. */
          scope: z.enum(['once', 'task']).default('once'),
        }),
        request.body,
        'decision',
      );
      const approval = container.approvals.decide(approvalId, body.approved ? 'approved' : 'denied', body.scope === 'task' ? 'operator (scope: task)' : 'operator', body.note);
      if (!approval) throw ApiError.notFound(`Approval ${approvalId} not found or already decided.`);
      return approval;
    }),
  );

  // ------------------------------------------------------- platform (§54)

  /**
   * What this install is: which shell is hosting it, what the OS provides, where the
   * data lives, which secret store backs credentials, and whether system notifications
   * and updates are available. The desktop shell and the web UI read the same endpoint,
   * so both can explain the environment truthfully instead of guessing.
   */
  app.get(
    '/api/platform',
    handler(() => {
      const adapter = container.platform;
      const secretStore = adapter.secrets.info();
      return {
        info: adapter.info,
        app: adapter.appInfo,
        /**
         * The same shell vocabulary `/api/settings` uses, so a client has one way to ask
         * "am I the web app or the desktop app?" instead of reading `info.shell` in one
         * place and `capabilities.shell` in another.
         */
        shell: {
          kind: adapter.info.shell,
          platform: adapter.info.platform,
          isDesktop: adapter.info.shell === 'desktop',
        },
        paths: {
          dataDir: adapter.paths.dataDir(),
          workspaceRoot: adapter.paths.workspaceRoot(),
          logDir: adapter.paths.logDir(),
          cacheDir: adapter.paths.cacheDir(),
          installDir: adapter.paths.installDir(),
          /** Where the running process actually read its database from. */
          databaseFile: container.config.dbPath,
        },
        secrets: {
          shellStore: secretStore,
          /** The API vault encrypts provider keys at rest; this says with which key. */
          credentialVault: { source: container.secretSource, keyFile: container.secretSource === 'file' ? container.config.masterKeyFile : null },
        },
        notifications: { supported: adapter.notifications.supported() },
        updates: { feedUrl: adapter.updater.feedUrl(), currentVersion: container.version },
      };
    }),
  );

  /** Sends a test notification so the operator can verify the desktop integration. */
  app.post(
    '/api/platform/notifications/test',
    handler(async () => {
      const result = await container.platform.notifications.notify({
        title: 'AI Dev Orchestrator',
        body: 'System notifications are working.',
        urgency: 'low',
        tag: 'aido-test',
      });
      return result;
    }),
  );

  /** Checks the update feed; never installs anything by itself. */
  app.get(
    '/api/platform/updates',
    handler(async () => container.platform.updater.check(container.version)),
  );

  app.post(
    '/api/platform/open-external',
    handler(async (request) => {
      const body = parse(z.object({ url: z.string().url().max(2_000) }), request.body, 'url');
      return { opened: await container.platform.shell.openExternal(body.url) };
    }),
  );

  /** Reveals a path from the project workspace in the OS file manager. */
  app.post(
    '/api/platform/reveal',
    handler(async (request) => {
      const body = parse(z.object({ projectId: z.string().min(1), relativePath: z.string().max(500).default('.') }), request.body, 'path');
      const project = store.projects.get(body.projectId);
      if (!project) throw ApiError.notFound(`Project ${body.projectId} not found.`);
      const resolved = container.workspaceFor(project).resolve(body.relativePath);
      if (!resolved.allowed) throw ApiError.badRequest(`Path is outside the project workspace: ${resolved.reason}`);
      return { revealed: await container.platform.shell.showInFileManager(resolved.absolutePath), path: resolved.absolutePath };
    }),
  );

  /** Opens a terminal at the project root, for the desktop shell's "open terminal" action. */
  app.post(
    '/api/platform/open-terminal',
    handler(async (request) => {
      const body = parse(z.object({ projectId: z.string().min(1) }), request.body, 'project');
      const project = store.projects.get(body.projectId);
      if (!project) throw ApiError.notFound(`Project ${body.projectId} not found.`);
      return container.platform.shell.openTerminal(project.workspacePath);
    }),
  );

  // ---------------------------------------------------------------- settings

  app.get(
    '/api/settings',
    handler(() => ({
      settings: settings(),
      defaults: container.config.defaults,
      /** What this process can actually do, so the UI can disable the rest. */
      capabilities: {
        shell: container.shell,
        secretSource: container.secretSource,
        maxParallelAgents: settings().supervisor.maxParallelAgents,
        adapterKinds: registry.definitionsList().map((definition) => definition.kind),
      },
      counts: {
        projects: store.projects.count(),
        providers: store.providers.list().length,
        models: store.models.countByProvider().reduce((sum, entry) => sum + entry.total, 0),
        agents: AGENT_ROLES.length,
        openReservations: store.quota.openReservations().length,
        databaseBytes: store.db.sizeBytes(),
      },
    })),
  );

  app.patch(
    '/api/settings',
    handler((request) => {
      const body = parse(SettingsPatchSchema, request.body, 'settings patch');
      const current = settings();
      const updated = container.updateSettings({
        ...(body.theme ? { theme: body.theme } : {}),
        ...(body.denseMode !== undefined ? { denseMode: body.denseMode } : {}),
        ...(body.executionMode ? { executionMode: body.executionMode } : {}),
        ...(body.freeOnlyMode !== undefined ? { freeOnlyMode: body.freeOnlyMode } : {}),
        ...(body.allowUnknownQuotaProviders !== undefined ? { allowUnknownQuotaProviders: body.allowUnknownQuotaProviders } : {}),
        router: { ...current.router, ...(body.router ?? {}) },
        supervisor: { ...current.supervisor, ...(body.supervisor ?? {}) },
        quota: { ...current.quota, ...(body.quota ?? {}) },
        notifications: { ...current.notifications, ...(body.notifications ?? {}) },
      });
      if (body.freeOnlyMode !== undefined) {
        events.emit(
          'quota.updated',
          { freeOnlyMode: updated.freeOnlyMode },
          { message: updated.freeOnlyMode ? 'FREE ONLY mode enabled — paid and trial models are excluded' : 'FREE ONLY mode disabled', severity: updated.freeOnlyMode ? 'info' : 'warning' },
        );
      }
      return updated;
    }),
  );

  app.post(
    '/api/providers/reload-catalog',
    handler(() => {
      const result = container.reloadProviders();
      return result;
    }),
  );
}

/**
 * `ModelQuotaLimits` is a complete record: every dimension is either a number or an
 * explicit `null` ("not asserted"). Partial patches are therefore filled here rather
 * than leaving `undefined`, which would read as "unknown" in a place that expects a
 * deliberate statement.
 */
function completeLimits(
  partial: {
    requestsPerMinute?: number | null;
    requestsPerHour?: number | null;
    requestsPerDay?: number | null;
    requestsPerMonth?: number | null;
    tokensPerMinute?: number | null;
    tokensPerDay?: number | null;
    tokensPerMonth?: number | null;
    concurrentRequests?: number | null;
    resetStrategy?: ResetStrategy | null;
    resetTimezone?: string | null;
  },
  resetStrategy: ResetStrategy | null,
  resetTimezone: string | null,
): {
  requestsPerMinute: number | null;
  requestsPerHour: number | null;
  requestsPerDay: number | null;
  requestsPerMonth: number | null;
  tokensPerMinute: number | null;
  tokensPerDay: number | null;
  tokensPerMonth: number | null;
  concurrentRequests: number | null;
  resetStrategy: ResetStrategy;
  resetTimezone: string | null;
} {
  return {
    requestsPerMinute: partial.requestsPerMinute ?? null,
    requestsPerHour: partial.requestsPerHour ?? null,
    requestsPerDay: partial.requestsPerDay ?? null,
    requestsPerMonth: partial.requestsPerMonth ?? null,
    tokensPerMinute: partial.tokensPerMinute ?? null,
    tokensPerDay: partial.tokensPerDay ?? null,
    tokensPerMonth: partial.tokensPerMonth ?? null,
    concurrentRequests: partial.concurrentRequests ?? null,
    resetStrategy: partial.resetStrategy ?? resetStrategy ?? 'unknown',
    resetTimezone: partial.resetTimezone ?? resetTimezone ?? null,
  };
}

/** Turns a stored trace into a short, human-readable "why this model" explanation. */
export function explainTrace(trace: LLMTrace): {
  selected: string;
  summary: string;
  factors: { label: string; detail: string }[];
  rejected: { modelId: string; reason: string }[];
} {
  const rationale = trace.routingRationale;
  const components = rationale?.components ?? [];
  const factors = components
    .slice()
    .sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0))
    .map((component) => ({
      label: component.name,
      detail: `${component.note ?? ''} (raw ${formatNumber(component.raw)}, weight ${formatNumber(component.weight)}, contribution ${formatNumber(component.contribution)})`.trim(),
    }));
  const positives = (rationale?.positives ?? []).slice(0, 6);
  const negatives = (rationale?.negatives ?? []).slice(0, 6);
  const summary = [
    `${trace.modelId} was selected for ${trace.taskType ?? 'this task'}.`,
    positives.length ? `Advantages: ${positives.join('; ')}.` : '',
    negatives.length ? `Trade-offs: ${negatives.join('; ')}.` : '',
    rationale?.freeOnlyApplied ? 'FREE ONLY mode was applied to this decision.' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    selected: trace.modelId,
    summary,
    factors,
    rejected: (rationale?.rejected ?? []).map((entry) => ({ modelId: entry.modelId, reason: entry.reasons.join('; ') })),
  };
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'n/a';
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(3);
}
