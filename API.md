# HTTP API

Fastify + Zod. Every handler validates its input, returns JSON, and throws a structured
error (`{ error, details? }`) with a meaningful status code. Bind address and port come from
`AIDO_HOST` / `AIDO_API_PORT` (defaults `127.0.0.1` and `8787`).

The web UI, the desktop shell and the worker all speak this API; it is the only way into the
system, which is why quarantine, approvals and quota decisions are all observable here
rather than hidden in the client.

Base conventions:

- Paths are under `/api`.
- Timestamps are ISO-8601 strings in UTC.
- Unknown values are `null`, never `0` or `""`. A provider whose limits are unknown returns
  `null` limits and a provenance of `unknown`; the UI renders that as "unknown".
- Enums are lowercase snake_case (`free_renewable`, `utc_midnight`, `code_review`).

---

## System

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/ping` | Liveness. Used by the UI test suite and probes. |
| `GET` | `/api/health` | Readiness: `{ ok, uptimeSeconds, database: { path, bytes, migrations }, degraded: [{ component, detail }], shell, version }`. `degraded` is where a missing notification daemon or an unreachable store is reported instead of being swallowed. |
| `GET` | `/api/dashboard` | The dashboard aggregate: projects, active runs, usage, provider health, FREE ONLY state, pending approvals, open reservations, recent events, warnings. |
| `GET` | `/api/settings` | `{ settings, defaults, capabilities, counts }`. `capabilities.shell` is `{ kind, platform, isDesktop }`; `counts` reports `agents` (every declared role) and `agentsInDefaultTeam` separately, because the roster is larger than the team a project starts with. |
| `PATCH` | `/api/settings` | Partial settings update (execution mode, FREE ONLY, supervisor limits, security flags, retention, notifications, quota behaviour). |
| `GET` | `/api/activity` | Events with `counts` grouped by severity/type; filters `type`, `severity`, `agentId`, `projectId`, `limit`. |
| `GET` | `/api/performance` | Tokens, latency, throughput, cost, success rates per provider/model/agent, failures by category, system metrics. |
| `GET` | `/api/traces` / `/api/traces/:traceId` | Model-call traces, including the routing rationale. |
| `GET` | `/api/system/explanations/:traceId` | The trace's routing rationale as an explanation object. |
| `GET` | `/api/system/metrics` | Raw metric series by scope and window. |
| `POST` | `/api/system/action` | Maintenance: `run.maintenance`, `providers.reload`, `providers.health_check_all`, `events.purge`, `traces.purge`, `quota.release_expired`, `models.refresh_priorities`. |
| `GET` | `/api/events` | The persisted event log (filters: `type`, `projectId`, `taskId`, `agentId`, `severity`, `since`, `limit`). |
| `GET` | `/api/events/stream` | **Server-sent events.** One JSON event per frame, used by the UI for live updates. Reconnect is the client's job; the stream sends a heartbeat so proxies do not close it. |
| `GET` | `/api/approvals` | Pending approvals (optionally by project). |
| `POST` | `/api/approvals/:approvalId/decide` | `{ approved: boolean, note?, scope?: 'once' \| 'task' }` (default `once`). Approving puts the blocked task back to `ready` and wakes the run so it re-runs with this action granted — `once` only for that resumed attempt, `task` for every later attempt of the task; denying fails the task with the note as its reason and blocks its dependents. Returns the decided request with its `decisionScope`; 404 when the id is unknown or already decided. |
| `GET` | `/api/tasks/:taskId` | One task with its dependency statuses and execution history. |
| `PATCH` | `/api/tasks/:taskId` | Edit a task (title, description, priority, agent, type, dependencies, max attempts, status). |
| `DELETE` | `/api/tasks/:taskId` | Delete a task and its dependency edges. |

## Providers

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/providers` | Summaries: enablement, credential status, health, model counts, free-tier class, cooldown. |
| `GET` | `/api/providers/catalog` | Shipped definitions plus `settings.freeOnlyMode` and `assumeUnknownIsUnlimited`, so the UI can explain exclusions. |
| `POST` | `/api/providers/reload-catalog` | Re-read `config/providers/` without restarting. Returns `{ count, issues }`. |
| `GET` | `/api/providers/:providerId` | Detail: summary + `definition`, `credentials` (fingerprint only), `models`, `observations`, `buckets`. |
| `PATCH` | `/api/providers/:providerId` | Enable/disable, set priority, edit non-secret definition fields. |
| `POST` | `/api/providers/:providerId/credentials` | Store credential fields (encrypted). Returns `{ ok, detail }`; never echoes the value. |
| `DELETE` | `/api/providers/:providerId/credentials/:field` | Remove one stored field. |
| `POST` | `/api/providers/:providerId/test` | Validate credentials against the provider and record the result. |
| `POST` | `/api/providers/:providerId/discover` | Run discovery (`/models` or the provider's equivalent) and upsert the catalogue. |
| `POST` | `/api/providers/:providerId/health` | Health check; feeds `provider.health_changed`. |

## Models

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/models` | Normalised `ModelInfo[]`. Filters: `providerId`, `taskType`, `freeOnly`, `search`, `enabled`, `limit`. |
| `GET` | `/api/models/:modelId` | One model. Model ids are `providerId:providerModelId`. |
| `GET` | `/api/models/:modelId/capabilities` | Capability matrix for the model (what it can and cannot do, with provenance). |
| `PATCH` | `/api/models/:modelId` | Enable/disable, set quality prior, notes, cost override. |
| `POST` | `/api/models/discover-all` | Discovery across every enabled provider; returns per-provider results including partial failures. |

## Quotas

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/quotas` | `{ snapshots, capacity, freeOnlyMode, reserveFraction, excludeTrialCredits }`. Capacity reports the basis of its estimate and which providers were excluded and why. |
| `GET` | `/api/quotas/:providerId` | `{ provider, providerLimits, reset, buckets, observations, reservations }`. |
| `POST` | `/api/quotas/:providerId/limits` | Override limits (operator-declared values are recorded with `user_configured` provenance). |
| `POST` | `/api/quotas/:providerId/refresh` | Ask the provider for live usage/limits where it exposes them. |

## Router

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/router/policy` | Weights, per-task-type policies, learning flags, defaults. |
| `PUT` | `/api/router/policy` | Replace policy fields (weights, strategies, per-task-type policies). |
| `POST` | `/api/router/preview` | Score candidates for a hypothetical task without running anything: `{ chain, selected, rationale, policy }`. This is the "why would you pick that model?" endpoint. |

## Agents

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/agents` | The roster. With `?projectId=` each entry also carries `state` (that project's persisted state) and `stats`. |
| `GET` | `/api/agents/team` | The default team plus role summaries. |
| `GET` | `/api/agents/:agentId` | One role: definition, limits, tools, instructions, state for a project, stats, tasks, recent traces, busy time. |
| `POST` | `/api/agents/:agentId/pause` | `{ projectId, reason? }` — removes the role from dispatch. |
| `POST` | `/api/agents/:agentId/resume` | `{ projectId }` — returns the role to the pool. |

## Projects

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects` | Projects with task counts, run state and last activity. |
| `POST` | `/api/projects` | Create from a spec: `{ name, description, spec, workspacePath?, sourceRepo?, executionMode?, maxParallelAgents?, freeOnlyMode? }`. `spec` is an object, not a paragraph — see below. |
| `GET` | `/api/projects/:projectId` | Detail: project, counts per status, per-agent counts, run state, memory stats, quota estimate, agent states, pending approvals, git path. |
| `PATCH` | `/api/projects/:projectId` | Update name/description/status/spec/settings (execution mode, parallelism, enabled agents, token cap, FREE ONLY override). |
| `DELETE` | `/api/projects/:projectId` | Remove the project and its records (workspace files are left on disk). |
| `POST` | `/api/projects/:projectId/plan` | Run the Architect → Project Manager pipeline and write the task plan. |
| `POST` | `/api/projects/:projectId/run` | Start (or resume) a run; `{ plan: false }` skips planning if a plan exists. |
| `GET` | `/api/projects/:projectId/run` | Current run state: running, paused, cancelled, ticks, timings, last result and error. |
| `POST` | `/api/projects/:projectId/pause` \| `/resume` \| `/stop` | Run controls. `stop` is idempotent. |
| `GET` | `/api/projects/:projectId/tasks` | The task list. |
| `POST` | `/api/projects/:projectId/tasks` | Add a task by hand. |
| `GET` | `/api/projects/:projectId/graph` | `{ nodes, edges, cycles }` for the DAG view. Cycles are computed and reported, not assumed away. |
| `GET` | `/api/projects/:projectId/files` \| `/file` | Workspace listing and single-file contents, through the workspace path guard. |
| `GET` | `/api/projects/:projectId/memory` | Memory: stats, entries, specification, architecture, code state, test state, issues. |
| `GET` | `/api/projects/:projectId/messages` | The agent conversation log (`taskId`/`agentId` filters). |
| `GET` | `/api/projects/:projectId/executions` | Agent executions with iterations, tool calls, tokens and outcome. |
| `GET` | `/api/projects/:projectId/supervision` | Supervisor state: interventions, stuck/stalled tasks, limits reached. |
| `GET` | `/api/projects/:projectId/tests` | `{ runs, latest, summary, cases }`. |
| `POST` | `/api/projects/:projectId/tests/run` | Run the project's own test command in the sandbox; records a run. |
| `GET` | `/api/projects/:projectId/git/status` | Repository state: branch, upstream, ahead/behind, working-tree `entries`, `conflictedPaths`, `operationInProgress`, `headSha`, `branches`. `isRepository: false` when the workspace is not a repo yet. |
| `GET` | `/api/projects/:projectId/git/log` | `{ commits, recorded, byAgent }` — history plus this installation's commits attributed to agents. |
| `GET` | `/api/projects/:projectId/git/diff` | Diff by `path`, by `from`/`to`, or against HEAD; with stats. |
| `POST` | `/api/projects/:projectId/git/branch` | Create/checkout a branch. |
| `POST` | `/api/projects/:projectId/git/commit` | Commit selected files with a message (agent attribution optional). |
| `POST` | `/api/projects/:projectId/git/merge` | `{ from, into? }`. Conflicts are **reported**, never auto-resolved. |

## Platform (desktop/shell integration)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/platform` | `{ info, app, shell, paths, secrets, notifications, updates }`. `shell` is `{ kind: 'web' \| 'desktop' \| 'headless', platform, isDesktop }`; `paths` includes the database actually in use; `secrets` reports which store is protecting shell-level secrets and whether it is OS-backed. |
| `GET` | `/api/platform/updates` | Update check: `up-to-date`, `update-available`, `unsupported` (no feed configured) or `check-failed`, always with the exact install instructions. |
| `POST` | `/api/platform/notifications/test` | Send a test notification; reports `{ delivered, reason }` honestly when no daemon is present. |
| `POST` | `/api/platform/open-external` | Open a URL in the OS browser (validated). |
| `POST` | `/api/platform/reveal` | Reveal a workspace path in the file manager (path-guarded). |
| `POST` | `/api/platform/open-terminal` | Open a terminal at the project root. Convenience only: commands agents run still go through the sandbox. |

---

## Error handling

```json
{ "error": "Provider groq is not configured: missing apiKey", "details": { "field": "apiKey" } }
```

| Status | Meaning |
| --- | --- |
| `400` | Validation failed, or the request cannot be satisfied as stated (e.g. clone into a non-empty workspace). |
| `401` / `403` | Credential rejected by a provider; path outside the workspace; command forbidden by policy. |
| `404` | Unknown project, task, model, provider, trace or approval. |
| `409` | Conflict (duplicate slug, a run already in progress, a merge conflict). |
| `429` | Provider rate limit surfaced to the caller. |
| `500` | Unexpected failure — always logged with the request id. |

The client (`packages/ui/src/api/client.ts`) turns non-2xx responses into
`ApiRequestError { status, message, details }`, which is what the UI's error states render.

## Typical flows

**Bring up a provider**

```
POST /api/providers/groq/credentials   { fields: { apiKey: "…" }, label: "personal" }
POST /api/providers/groq/test          → { ok, detail, status: 'valid' }
POST /api/providers/groq/discover      → models upserted with provenance
GET  /api/quotas/groq                  → limits, reset strategy, provenance, observations
```

**Build something**

```jsonc
// POST /api/projects — `spec` is structured, because the Architect, the Project Manager
// and every downstream agent read these fields as separate inputs.
{
  "name": "Slugkit",
  "description": "Small TypeScript slug utilities",
  "spec": {
    "goal": "Provide two pure slug helpers",
    "description": "toSlug and uniqueSlug, dependency free",
    "techStack": ["TypeScript", "Node 22"],
    "constraints": ["No runtime dependencies"],
    "nonFunctional": ["Deterministic", "ASCII-only output"],
    "acceptanceCriteria": ["Empty input returns an empty slug", "Collisions get -2, -3 …"],
    "targetUsers": "Library authors",
    "deliverable": "Publishable package with tests and a README"
  }
}
```

```
POST /api/projects/:id/plan            → architecture + task plan (real model calls)
POST /api/projects/:id/run             { plan: false }
GET  /api/projects/:id/graph           → watch the DAG drain
GET  /api/events/stream                → live updates while it runs
GET  /api/projects/:id/tests           → verification results
GET  /api/projects/:id/git/log         → what each agent committed
GET  /api/traces?projectId=:id         → every call, with its routing rationale
```

**Explain a decision**

```
GET /api/traces/:traceId                    → routingRationale: components, weights, rejected
GET /api/system/explanations/:traceId       → the same, phrased for a human
POST /api/router/preview { taskType }       → what the router would pick right now, and why
```
