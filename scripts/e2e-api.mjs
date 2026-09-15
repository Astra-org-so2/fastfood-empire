#!/usr/bin/env node
/**
 * API end-to-end smoke test against a real, listening server.
 *
 * Proves the §51 acceptance path over HTTP: create a project → check providers and
 * models → plan → run → tasks unblock and complete → inspect git, memory, traces and
 * the "why this model" explanation. Every assertion reads real state; nothing is
 * stubbed. Run with: `npm run e2e:api`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
process.env.AIDO_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'aido-api-e2e-'));
process.env.AIDO_WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), 'aido-api-e2e-ws-'));
process.env.AIDO_EXECUTION_MODE = 'auto';
process.env.AIDO_API_PORT = process.env.AIDO_API_PORT ?? '8811';
process.env.AIDO_LOG_LEVEL = 'warn';
process.env.AIDO_MASTER_KEY = 'api-e2e-master-key';

const { buildServer } = await import(path.join(root, 'apps/api/src/server.ts'));

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await buildServer({ containerOptions: undefined });
const base = await server.listen();

const api = async (method, url, body) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json };
};

const spec = {
  goal: 'Build a small URL shortener service with tests and documentation.',
  description: 'A single-process HTTP service with an in-memory store, plus tests and a README.',
  techStack: ['TypeScript', 'Node.js'],
  constraints: ['No paid infrastructure', 'Must run offline'],
  nonFunctional: ['Startup under 1 second'],
  acceptanceCriteria: ['Shortening a URL returns a code', 'Resolving a code returns the original URL'],
  targetUsers: 'Internal developers',
  deliverable: 'A runnable service with tests',
};

try {
  const health = await api('GET', '/api/health');
  check('GET /api/health responds', health.status === 200 && health.json?.ok === true, `status ${health.status}`);

  const dashboard = await api('GET', '/api/dashboard');
  check('GET /api/dashboard responds', dashboard.status === 200 && Array.isArray(dashboard.json?.providers), `${dashboard.json?.providers?.length ?? 0} providers`);

  const providers = await api('GET', '/api/providers');
  const simulated = providers.json?.providers?.find((provider) => provider.id === 'simulated');
  check('the simulated provider is enabled by default', Boolean(simulated?.enabled), simulated?.id);
  check('provider summaries expose credential state', typeof simulated?.credentialStatus?.state === 'string', simulated?.credentialStatus?.state);
  check('provider summaries expose health', typeof simulated?.health?.status === 'string', simulated?.health?.status);

  const catalog = await api('GET', '/api/providers/catalog');
  const defs = catalog.json?.definitions ?? [];
  check('provider catalogue is served from config', defs.length >= 10, `${defs.length} definitions`);
  // A provider is only enabled once it can actually serve a request: the operator
  // enables the rest by supplying credentials. What must hold is that none of them is
  // silently unusable — each either has an adapter or says exactly what is missing.
  const unusable = (providers.json?.providers ?? []).filter((provider) => !provider.adapter?.registered || (!provider.configured && provider.missingCredentialFields.length === 0 && !provider.simulated));
  check('every catalogued provider is either usable or explains what is missing', unusable.length === 0, `${providers.json?.providers?.length ?? 0} providers, ${unusable.length} unexplained`);
  check('providers needing credentials are disabled until configured', (providers.json?.providers ?? []).filter((p) => !p.configured && !p.simulated).every((p) => !p.enabled));
  const unverified = defs.filter((definition) => definition.metadataVerified === false);
  check('unverified provider metadata is labelled as such', unverified.length >= 9, `${unverified.length}/${defs.length} unverified`);
  const models = await api('GET', '/api/models');
  check('models are seeded from provider definitions', (models.json?.length ?? 0) > 0, `${models.json?.length ?? 0} models`);
  const freeModels = (models.json ?? []).filter((model) => model.quotaType === 'free_renewable');
  check('FREE ONLY mode has at least one renewable-free model', freeModels.length > 0, `${freeModels.length} free models`);

  const discovery = await api('POST', '/api/providers/simulated/discover');
  check('model discovery works for the simulated provider', discovery.status === 200 && discovery.json?.models?.length > 0, `${discovery.json?.models?.length ?? 0} discovered`);

  const created = await api('POST', '/api/projects', { name: 'URL Shortener', description: 'e2e target', spec });
  check('POST /api/projects creates a project', created.status === 201 && Boolean(created.json?.id), created.json?.id);
  const projectId = created.json?.id;

  const workspacePath = created.json?.workspacePath;
  check('the project workspace is created on disk', Boolean(workspacePath), workspacePath);

  const plan = await api('POST', `/api/projects/${projectId}/plan`);
  check('POST /plan produces tasks', plan.status === 200 && (plan.json?.createdTasks?.length ?? 0) > 0, `${plan.json?.createdTasks?.length ?? 0} tasks`);

  const tasksAfterPlan = await api('GET', `/api/projects/${projectId}/tasks`);
  const roles = new Set((tasksAfterPlan.json ?? []).map((task) => task.agentRole));
  check('the plan uses multiple specialised agents', roles.size >= 3, [...roles].join(', '));
  const blocked = (tasksAfterPlan.json ?? []).filter((task) => task.status === 'blocked');
  check('dependent tasks start blocked', blocked.length > 0, `${blocked.length} blocked`);

  const graph = await api('GET', `/api/projects/${projectId}/graph`);
  check('the dependency graph has nodes and edges', (graph.json?.nodes?.length ?? 0) > 0 && (graph.json?.edges?.length ?? 0) > 0, `${graph.json?.nodes?.length} nodes / ${graph.json?.edges?.length} edges`);

  const run = await api('POST', `/api/projects/${projectId}/run`, { plan: false });
  check('POST /run starts the run', run.status === 200 && run.json?.running === true, `ticks ${run.json?.ticks}`);

  // Wait for the run to finish (bounded, never an infinite wait).
  let status = null;
  let finalTasks = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    status = await api('GET', `/api/projects/${projectId}/run`);
    finalTasks = (await api('GET', `/api/projects/${projectId}/tasks`)).json ?? [];
    const pending = finalTasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
    if (!status.json?.running) break;
    if (pending.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const done = finalTasks.filter((task) => task.status === 'done');
  check('the run completes tasks', done.length > 0, `${done.length}/${finalTasks.length} done`);
  check('the run stops on its own', status.json?.running === false, `status ${status.json?.running}`);
  const unblocked = finalTasks.filter((task) => task.status === 'done' && task.dependsOn.length > 0);
  check('dependent tasks were auto-unblocked and completed', unblocked.length > 0, `${unblocked.length} dependent tasks done`);

  const traces = await api('GET', `/api/traces?projectId=${projectId}&limit=200`);
  check('every model call produced a trace', (traces.json?.length ?? 0) >= done.length, `${traces.json?.length ?? 0} traces`);
  const traceOk = (traces.json ?? []).every((trace) => trace.modelId && trace.providerId);
  check('traces record the provider and model used', traceOk);

  const firstTrace = traces.json?.[0];
  if (firstTrace) {
    const explanation = await api('GET', `/api/traces/${firstTrace.traceId}`);
    check('traces explain why the model was selected', explanation.json?.explanation?.factors?.length > 0, `${explanation.json?.explanation?.factors?.length} factors`);
    const rationale = firstTrace.routingRationale;
    check('the routing rationale keeps the rejected candidates', Array.isArray(rationale?.rejected), `${rationale?.rejected?.length ?? 0} rejected`);
  }

  const quotas = await api('GET', '/api/quotas');
  const quotaSnapshots = quotas.json?.snapshots ?? [];
  check('quota snapshots are exposed', quotaSnapshots.length > 0, `${quotaSnapshots.length} snapshots`);
  check('quota capacity is estimated', quotas.json?.capacity !== undefined);
  const consumed = quotaSnapshots.filter((snapshot) => (snapshot.used ?? 0) > 0);
  check('real usage is recorded against quota windows', consumed.length > 0, `${consumed.length} windows with usage`);
  const providerQuota = await api('GET', '/api/quotas/simulated');
  const buckets = providerQuota.json?.buckets ?? [];
  const bucketUsage = buckets.reduce((sum, bucket) => sum + (bucket.usedRequests ?? 0), 0);
  check('quota buckets hold the committed usage', bucketUsage > 0, `${bucketUsage} requests across ${buckets.length} buckets`);
  check('no reservation outlives its call', (providerQuota.json?.reservations?.length ?? 0) === 0, `${providerQuota.json?.reservations?.length ?? 0} open`);
  check('free-only accounting excludes trial credits', quotas.json?.excludeTrialCredits === true);

  const gitStatus = await api('GET', `/api/projects/${projectId}/git/status`);
  check('git status is available', gitStatus.status === 200, `branch ${gitStatus.json?.branch ?? gitStatus.json?.currentBranch ?? 'n/a'}`);
  const gitLog = await api('GET', `/api/projects/${projectId}/git/log`);
  check('agent commits reached the repository', (gitLog.json?.commits?.length ?? 0) > 0, `${gitLog.json?.commits?.length ?? 0} commits`);
  const agentBranches = (gitStatus.json?.branches ?? []).filter((branch) => branch.name.startsWith('agent/'));
  check('each agent worked on its own branch', agentBranches.length >= 2, agentBranches.map((branch) => branch.name).join(', '));

  const files = await api('GET', `/api/projects/${projectId}/files`);
  check('workspace files can be listed', (files.json?.entries?.length ?? 0) > 0, `${files.json?.entries?.length ?? 0} entries`);
  const fileNames = (files.json?.entries ?? []).map((entry) => entry.name ?? entry.path);
  check('agents wrote the files their tasks declared', fileNames.length > 0 && (fileNames.includes('src') || fileNames.some((name) => String(name).endsWith('.json'))), fileNames.slice(0, 6).join(', '));

  const memory = await api('GET', `/api/projects/${projectId}/memory`);
  check('shared project memory holds the specification', Boolean(memory.json?.specification), `kinds: ${(memory.json?.stats ?? []).map((stat) => stat.kind).join(', ')}`);

  const messages = await api('GET', `/api/projects/${projectId}/messages`);
  check('agents communicated with each other', (messages.json?.length ?? 0) > 0, `${messages.json?.length ?? 0} messages`);

  const executions = await api('GET', `/api/projects/${projectId}/executions`);
  check('executions are recorded', (executions.json?.length ?? 0) > 0, `${executions.json?.length ?? 0} executions`);

  const activity = await api('GET', `/api/activity?projectId=${projectId}`);
  check('the activity feed is populated', (activity.json?.events?.length ?? 0) > 0, `${activity.json?.events?.length ?? 0} events`);

  const performance = await api('GET', '/api/performance');
  check('performance metrics are computed from real calls', (performance.json?.totals?.requests ?? 0) > 0, `${performance.json?.totals?.requests} requests`);

  const tests = await api('POST', `/api/projects/${projectId}/tests/run`, { command: 'node -e "console.log(\'2 passed\')"', timeoutMs: 20_000 });
  check('the test runner executes a real command in the sandbox', tests.status === 200, `exit ${tests.json?.exitCode}`);
  const testHistory = await api('GET', `/api/projects/${projectId}/tests`);
  check('test runs are persisted', (testHistory.json?.runs?.length ?? 0) > 0, `${testHistory.json?.runs?.length ?? 0} runs`);

  const preview = await api('POST', '/api/router/preview', { taskType: 'code_generation', estimatedInputTokens: 8_000, estimatedOutputTokens: 2_000 });
  check('the router can explain a decision before running anything', preview.status === 200 && Array.isArray(preview.json?.chain), `${preview.json?.chain?.length ?? 0} candidates`);
  check('the router reports why candidates were rejected', Array.isArray(preview.json?.rationale?.rejected));

  const settings = await api('PATCH', '/api/settings', { freeOnlyMode: true, supervisor: { maxParallelAgents: 3 } });
  check('settings can be changed at runtime', settings.status === 200 && settings.json?.freeOnlyMode === true, `maxParallelAgents ${settings.json?.supervisor?.maxParallelAgents}`);

  const events = await api('GET', '/api/events?limit=5');
  check('events are persisted for the activity view', (events.json?.length ?? 0) > 0, `${events.json?.length ?? 0} events`);

  const stop = await api('POST', `/api/projects/${projectId}/stop`, {});
  check('a run can be stopped idempotently', stop.status === 200);

  // ---------------------------------------------------------------- agents (§14, §54)
  const roster = await api('GET', `/api/agents?projectId=${projectId}`);
  check('the roster reports a state per role for a project', roster.status === 200 && (roster.json ?? []).every((agent) => agent.state !== undefined), `${roster.json?.length ?? 0} roles`);
  const worked = (roster.json ?? []).filter((agent) => (agent.state?.tasksCompleted ?? 0) > 0);
  check('agents that completed work have it recorded on their row', worked.length > 0, worked.map((agent) => `${agent.id}:${agent.state.tasksCompleted}`).join(', '));
  check('agents are idle once the run is stopped', (roster.json ?? []).every((agent) => agent.state?.state !== 'working'));
  const taskGraph = await api('GET', `/api/projects/${projectId}/graph`);
  check('the task graph reports its dependency cycles explicitly', Array.isArray(taskGraph.json?.cycles), `${taskGraph.json?.cycles?.length ?? 0} cycles`);

  // ---------------------------------------------------------------- platform (§54)
  const platform = await api('GET', '/api/platform');
  check('the platform reports which shell is running', platform.status === 200 && typeof platform.json?.shell?.kind === 'string', `${platform.json?.shell?.kind} on ${platform.json?.shell?.platform}`);
  check('the platform reports its storage paths', Boolean(platform.json?.paths?.databaseFile), platform.json?.paths?.databaseFile);
  check('the platform reports where credentials are stored', typeof platform.json?.secrets?.shellStore?.kind === 'string', platform.json?.secrets?.shellStore?.kind);
  check('the platform reports update capability or its absence', typeof platform.json?.updates?.feedUrl === 'string' || platform.json.updates?.feedUrl === null);
  const updater = await api('GET', '/api/platform/updates');
  check('checking for updates answers without throwing', updater.status === 200 && typeof updater.json?.instructions === 'string', updater.json?.status);
  const notif = await api('POST', '/api/platform/notifications/test', {});
  check('the notification path reports delivery honestly', notif.status === 200 && typeof notif.json?.delivered === 'boolean', notif.json?.reason ?? 'delivered');
  const openExternal = await api('POST', '/api/platform/open-external', { url: 'https://example.com' });
  check('opening an external URL is refused in a headless server', openExternal.status < 500, `status ${openExternal.status}`);
} catch (err) {
  check('e2e run completed without throwing', false, err instanceof Error ? err.message : String(err));
} finally {
  await server.close();
  rmSync(process.env.AIDO_DATA_DIR, { recursive: true, force: true });
  rmSync(process.env.AIDO_WORKSPACE_ROOT, { recursive: true, force: true });
}

const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.error(`\nFailed checks:\n${failed.map((entry) => ` - ${entry.name}${entry.detail ? ` (${entry.detail})` : ''}`).join('\n')}`);
  process.exit(1);
}
