import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { AppSettings, TaskType, OrchestratorEvent, AgentId, Project } from '@aido/types';
import { createApi, createApiClient, type AidoApi, type ProjectSummary, type TaskGraphResponse } from '@aido/ui';

/**
 * Data access for the UI.
 *
 * One client, one set of hooks, one cache. The desktop shell points the same hooks at
 * its in-process server; nothing else differs (§54).
 *
 * Cache policy: operational data is short-lived (agents and quota move constantly) but
 * never polled aggressively — the SSE stream pushes changes and invalidates exactly the
 * keys that changed, so the numbers on screen track reality without polling every view.
 */

export const api: AidoApi = createApi(createApiClient({ baseUrl: '' }));

export const queryKeys = {
  dashboard: ['dashboard'] as const,
  health: ['health'] as const,
  settings: ['settings'] as const,
  platform: ['platform'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  tasks: (id: string) => ['tasks', id] as const,
  graph: (id: string) => ['graph', id] as const,
  files: (id: string, path: string) => ['files', id, path] as const,
  git: (id: string) => ['git', id] as const,
  gitLog: (id: string) => ['git-log', id] as const,
  tests: (id: string) => ['tests', id] as const,
  memory: (id: string) => ['memory', id] as const,
  messages: (id: string) => ['messages', id] as const,
  executions: (id: string) => ['executions', id] as const,
  supervision: (id: string) => ['supervision', id] as const,
  agents: ['agents'] as const,
  agent: (id: string) => ['agent', id] as const,
  providers: ['providers'] as const,
  provider: (id: string) => ['provider', id] as const,
  models: (filter: string) => ['models', filter] as const,
  quotas: ['quotas'] as const,
  quota: (id: string) => ['quota', id] as const,
  activity: (filter: string) => ['activity', filter] as const,
  performance: (days: number) => ['performance', days] as const,
  traces: (filter: string) => ['traces', filter] as const,
  trace: (id: string) => ['trace', id] as const,
  approvals: ['approvals'] as const,
  routerPolicy: ['router-policy'] as const,
};

const LIVE_STALE_MS = 5_000;

function live<TData>(options: UseQueryOptions<TData> & { queryFn: () => Promise<TData> }): UseQueryOptions<TData> {
  return { staleTime: LIVE_STALE_MS, refetchOnWindowFocus: true, retry: 1, ...options };
}

/* ------------------------------------------------------------------ queries */

export const useDashboard = () => useQuery(live({ queryKey: queryKeys.dashboard, queryFn: api.dashboard }));
export const useHealth = () => useQuery(live({ queryKey: queryKeys.health, queryFn: api.health, refetchInterval: 15_000 }));
export const useSettings = () => useQuery(live({ queryKey: queryKeys.settings, queryFn: api.settings }));
export const usePlatform = () => useQuery(live({ queryKey: queryKeys.platform, queryFn: api.platform }));
export const useProjects = () => useQuery(live({ queryKey: queryKeys.projects, queryFn: api.projects }));

export const useProject = (projectId: string | undefined) =>
  useQuery(live({ queryKey: queryKeys.project(projectId ?? ''), queryFn: () => api.project(projectId as string), enabled: Boolean(projectId) }));

export function useProjectTasks(projectId: string | undefined) {
  return useQuery(live({ queryKey: queryKeys.tasks(projectId ?? ''), queryFn: () => api.tasks(projectId as string), enabled: Boolean(projectId) }));
}

export function useProjectGraph(projectId: string | undefined) {
  return useQuery(live({ queryKey: queryKeys.graph(projectId ?? ''), queryFn: () => api.graph(projectId as string), enabled: Boolean(projectId) }));
}

export function useProjectFiles(projectId: string | undefined, relativePath: string) {
  return useQuery(
    live({ queryKey: queryKeys.files(projectId ?? '', relativePath), queryFn: () => api.files(projectId as string, relativePath), enabled: Boolean(projectId) }),
  );
}

export function useProjectFile(projectId: string | undefined, relativePath: string | null) {
  return useQuery({
    queryKey: [...queryKeys.files(projectId ?? '', relativePath ?? ''), 'content'],
    queryFn: () => api.file(projectId as string, relativePath as string),
    enabled: Boolean(projectId && relativePath),
    staleTime: 30_000,
  });
}

export function useGitStatus(projectId: string | undefined) {
  return useQuery(live({ queryKey: queryKeys.git(projectId ?? ''), queryFn: () => api.gitStatus(projectId as string), enabled: Boolean(projectId) }));
}

export function useGitLog(projectId: string | undefined) {
  return useQuery(live({ queryKey: queryKeys.gitLog(projectId ?? ''), queryFn: () => api.gitLog(projectId as string), enabled: Boolean(projectId) }));
}

export function useTests(projectId: string | undefined) {
  return useQuery(live({ queryKey: queryKeys.tests(projectId ?? ''), queryFn: () => api.tests(projectId as string), enabled: Boolean(projectId) }));
}

export function useMemory(projectId: string | undefined) {
  return useQuery(live({ queryKey: queryKeys.memory(projectId ?? ''), queryFn: () => api.memory(projectId as string), enabled: Boolean(projectId) }));
}

export function useMessages(projectId: string | undefined) {
  return useQuery(live({ queryKey: queryKeys.messages(projectId ?? ''), queryFn: () => api.messages(projectId as string), enabled: Boolean(projectId) }));
}

export function useExecutions(projectId: string | undefined) {
  return useQuery(live({ queryKey: queryKeys.executions(projectId ?? ''), queryFn: () => api.executions(projectId as string), enabled: Boolean(projectId) }));
}

export function useSupervision(projectId: string | undefined) {
  return useQuery(live({ queryKey: queryKeys.supervision(projectId ?? ''), queryFn: () => api.supervision(projectId as string), enabled: Boolean(projectId) }));
}

/**
 * The roster. Without a project the response carries roles and metrics only; with one it
 * also carries each role's persisted state for that project, which is what pause/resume
 * acts on.
 */
export function useAgents(projectId?: string) {
  return useQuery(live({ queryKey: [...queryKeys.agents, projectId ?? 'all'], queryFn: () => api.agents(projectId) }));
}
export function useAgent(agentId: string | undefined, projectId?: string | null) {
  return useQuery(
    live({
      queryKey: [...queryKeys.agent(agentId ?? ''), projectId ?? 'all'],
      queryFn: () => api.agent(agentId as AgentId, projectId ?? undefined),
      enabled: Boolean(agentId),
    }),
  );
}

export const useProviders = () => useQuery(live({ queryKey: queryKeys.providers, queryFn: api.providers }));
export const useProvider = (providerId: string | undefined) =>
  useQuery(live({ queryKey: queryKeys.provider(providerId ?? ''), queryFn: () => api.provider(providerId as string), enabled: Boolean(providerId) }));

export function useModels(filter: { providerId?: string; taskType?: TaskType; freeOnly?: boolean; search?: string }) {
  const key = JSON.stringify(filter);
  return useQuery(live({ queryKey: queryKeys.models(key), queryFn: () => api.models({ ...filter, limit: 500 }) }));
}

export const useQuotas = () => useQuery(live({ queryKey: queryKeys.quotas, queryFn: api.quotas }));
export const useQuota = (providerId: string | undefined) =>
  useQuery(live({ queryKey: queryKeys.quota(providerId ?? ''), queryFn: () => api.quota(providerId as string), enabled: Boolean(providerId) }));

export function useActivity(filter: { limit?: number; type?: string; agentId?: string; severity?: string; projectId?: string } = {}) {
  const key = JSON.stringify(filter);
  return useQuery(live({ queryKey: queryKeys.activity(key), queryFn: () => api.activity({ limit: 200, ...filter }) }));
}

export const usePerformance = (days = 7) => useQuery(live({ queryKey: queryKeys.performance(days), queryFn: () => api.performance({ days }) }));

export function useTraces(filter: { limit?: number; projectId?: string; agentId?: string; status?: string } = {}) {
  const key = JSON.stringify(filter);
  return useQuery(live({ queryKey: queryKeys.traces(key), queryFn: () => api.traces({ limit: 100, ...filter }) }));
}

export const useTrace = (traceId: string | undefined) =>
  useQuery(live({ queryKey: queryKeys.trace(traceId ?? ''), queryFn: () => api.trace(traceId as string), enabled: Boolean(traceId) }));

export const useApprovals = () => useQuery(live({ queryKey: queryKeys.approvals, queryFn: () => api.approvals(), refetchInterval: 5_000 }));
export const useRouterPolicy = () => useQuery(live({ queryKey: queryKeys.routerPolicy, queryFn: api.routerPolicy }));

/* ------------------------------------------------------------------ mutations */

/** Invalidates the caches a mutation can affect, so every view stays consistent. */
type QueryKey = readonly unknown[];

function useInvalidate() {
  const client = useQueryClient();
  return async (keys: QueryKey[] = []) => {
    const targets: QueryKey[] = [queryKeys.dashboard, queryKeys.projects, ...keys];
    await Promise.all(targets.map((key) => client.invalidateQueries({ queryKey: key as unknown[] })));
  };
}

export function useProjectActions(projectId: string | undefined) {
  const invalidate = useInvalidate();
  const keys = [queryKeys.project(projectId ?? ''), queryKeys.tasks(projectId ?? ''), queryKeys.graph(projectId ?? ''), queryKeys.supervision(projectId ?? '')];
  return {
    plan: useMutation({ mutationFn: () => api.planProject(projectId as string), onSuccess: () => invalidate(keys) }),
    run: useMutation({ mutationFn: (body?: { plan?: boolean }) => api.runProject(projectId as string, body), onSuccess: () => invalidate(keys) }),
    pause: useMutation({ mutationFn: () => api.pauseProject(projectId as string), onSuccess: () => invalidate(keys) }),
    resume: useMutation({ mutationFn: () => api.resumeProject(projectId as string), onSuccess: () => invalidate(keys) }),
    stop: useMutation({ mutationFn: () => api.stopProject(projectId as string), onSuccess: () => invalidate(keys) }),
    runTests: useMutation({
      mutationFn: (command?: string) => api.runTests(projectId as string, command ? { command } : {}),
      onSuccess: () => invalidate([queryKeys.tests(projectId ?? '')]),
    }),
  };
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.createProject>[0]) => api.createProject(body),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

export function useApprovalActions() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ approvalId, approved, scope, note }: { approvalId: string; approved: boolean; scope?: 'once' | 'task'; note?: string }) =>
      api.decideApproval(approvalId, { approved, scope, note }),
    onSuccess: () => invalidate([queryKeys.approvals]),
  });
}

export function useSettingsMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<AppSettings>) => api.updateSettings(patch),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.settings });
      await client.invalidateQueries({ queryKey: queryKeys.dashboard });
      await client.invalidateQueries({ queryKey: queryKeys.quotas });
    },
  });
}

export function useRouterPolicyMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updateRouterPolicy(patch),
    onSuccess: async () => client.invalidateQueries({ queryKey: queryKeys.routerPolicy }),
  });
}

export function useProviderActions(providerId: string | undefined) {
  const client = useQueryClient();
  const refresh = async (): Promise<void> => {
    await Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.providers }),
      client.invalidateQueries({ queryKey: queryKeys.provider(providerId ?? '') }),
      client.invalidateQueries({ queryKey: queryKeys.models('{}') }),
    ]);
  };
  return {
    setCredentials: useMutation({ mutationFn: ({ fields, label }: { fields: Record<string, string>; label?: string }) => api.setCredentials(providerId as string, fields, label), onSuccess: refresh }),
    deleteCredential: useMutation({ mutationFn: (field: string) => api.deleteCredential(providerId as string, field), onSuccess: refresh }),
    test: useMutation({ mutationFn: () => api.testProvider(providerId as string), onSuccess: refresh }),
    discover: useMutation({ mutationFn: () => api.discoverModels(providerId as string), onSuccess: refresh }),
    health: useMutation({ mutationFn: () => api.providerHealth(providerId as string), onSuccess: refresh }),
  };
}

export function useQuotaActions() {
  const client = useQueryClient();
  const refresh = async (): Promise<void> => {
    await Promise.all([client.invalidateQueries({ queryKey: queryKeys.quotas }), client.invalidateQueries({ queryKey: ['quota'] })]);
  };
  return {
    setLimits: useMutation({ mutationFn: ({ providerId, limits }: { providerId: string; limits: Record<string, unknown> }) => api.setQuotaLimits(providerId, limits), onSuccess: refresh }),
    refresh: useMutation({ mutationFn: (providerId: string) => api.refreshQuota(providerId), onSuccess: refresh }),
  };
}

/**
 * Pause/resume act on an agent's state *inside one project*, so the project is part of
 * the mutation input rather than a hidden global.
 */
export function useAgentActions(projectId: string | null) {
  const client = useQueryClient();
  const refresh = async (): Promise<void> => {
    await Promise.all([client.invalidateQueries({ queryKey: queryKeys.agents }), client.invalidateQueries({ queryKey: ['agent'] })]);
  };
  const require = (): string => {
    if (!projectId) throw new Error('Select a project first: agent state is stored per project.');
    return projectId;
  };
  return {
    pause: useMutation({ mutationFn: ({ agentId, reason }: { agentId: AgentId; reason?: string }) => api.pauseAgent(agentId, require(), reason), onSuccess: refresh }),
    resume: useMutation({ mutationFn: ({ agentId }: { agentId: AgentId }) => api.resumeAgent(agentId, require()), onSuccess: refresh }),
  };
}

/* ------------------------------------------------------------------ live stream */

export type StreamState = 'connecting' | 'open' | 'closed';

/**
 * Subscribes to the server-sent event stream and refreshes the affected queries.
 *
 * Reconnection is delegated to `EventSource` (with a manual fallback timer) and the
 * reported state is visible in the UI: a stale dashboard that silently stopped updating
 * is worse than a visible "reconnecting" indicator.
 */
export function useLiveEvents(onEvent?: (event: OrchestratorEvent) => void): { state: StreamState; lastEventAt: string | null } {
  const client = useQueryClient();
  const [state, setState] = useState<StreamState>('connecting');
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const invalidateFor = (event: OrchestratorEvent): void => {
      const type = String(event.type);
      const projectId = (event as { projectId?: string }).projectId;
      const targets: QueryKey[] = [[queryKeys.dashboard]];
      if (type.startsWith('task.') || type.startsWith('run.') || type.startsWith('agent.')) {
        targets.push(queryKeys.projects, queryKeys.agents, queryKeys.activity('{}'));
        if (projectId) targets.push(queryKeys.project(projectId), queryKeys.tasks(projectId), queryKeys.graph(projectId), queryKeys.supervision(projectId));
      }
      if (type.startsWith('quota.') || type.startsWith('provider.')) targets.push(queryKeys.quotas, queryKeys.providers, queryKeys.dashboard);
      if (type.startsWith('approval.')) targets.push(queryKeys.approvals);
      if (type.startsWith('git.')) {
        if (projectId) targets.push(queryKeys.git(projectId), queryKeys.gitLog(projectId));
      }
      if (type.startsWith('test.')) {
        if (projectId) targets.push(queryKeys.tests(projectId));
      }
      if (type.startsWith('message.')) {
        if (projectId) targets.push(queryKeys.messages(projectId));
      }
      if (type.startsWith('execution.') || type.startsWith('trace.')) {
        if (projectId) targets.push(queryKeys.executions(projectId));
      }
      for (const key of targets) void client.invalidateQueries({ queryKey: key });
    };

    const connect = (): void => {
      if (closed) return;
      // Server-sent events are the live path, but the UI must still work without them
      // (an embedded webview, a test DOM, a proxy that strips the stream). Degrade to
      // "closed" — the header then shows a stale-data indicator and queries refetch on
      // focus — instead of throwing out of an effect and blanking the screen.
      if (typeof EventSource === 'undefined') {
        setState('closed');
        return;
      }
      source = new EventSource('/api/events/stream');
      source.onopen = () => setState('open');
      source.onerror = () => {
        setState('closed');
        source?.close();
        // Retry with a small backoff; EventSource retries itself, but not after an
        // explicit close, and a dead stream must not leave the UI stale forever.
        retry = setTimeout(connect, 3_000);
      };
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as OrchestratorEvent;
          setLastEventAt(new Date().toISOString());
          invalidateFor(event);
          handler.current?.(event);
        } catch {
          // A malformed frame must not break the stream.
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [client]);

  return { state, lastEventAt };
}

/** Convenience: the project list hook plus its most-used derived helpers. */
export function useProjectList(): { projects: ProjectSummary[]; byStatus: Record<string, ProjectSummary[]> } {
  const { data } = useProjects();
  const projects = data ?? [];
  const byStatus: Record<string, ProjectSummary[]> = {};
  for (const project of projects) (byStatus[project.status] ??= []).push(project);
  return { projects, byStatus };
}

export type { Project, TaskGraphResponse };
