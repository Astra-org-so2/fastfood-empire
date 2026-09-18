# Architecture

How the platform is put together, why, and where the seams are.

## 1. One product, two shells

The web app and the Linux desktop app are **one application with two entry points**:

```
                    ┌──────────────────────────────┐
   browser ────────▶│ apps/web  (Vite build → dist/web)
                    └──────────────┬───────────────┘
                                   │  same UI, same API contract
   Electron window ─▶ apps/desktop ├─ main.ts  (window, IPC, single instance)
                       └────────────┴─ host.ts  (starts the API in-process)
                                   │
                        ┌──────────▼───────────┐
                        │  apps/api (Fastify)  │  ← the only backend
                        └──────────┬───────────┘
                                   │
        packages/{providers, quota-engine, model-router, agents, orchestrator,
                  project-memory, git, sandbox, storage, observability, security, platform}
```

The desktop shell does not reimplement anything: it starts the same server, on loopback with
an OS-assigned port, and loads the same `dist/web` bundle. Platform-specific behaviour
(paths, secret stores, notifications, updater, file manager, terminal, window controls) is
isolated behind the interfaces in `packages/platform`; the renderer detects the shell via
`window.aido` and enables the desktop-only affordances. Adding Windows or macOS means
implementing those interfaces, not rewriting the core.

## 2. Layering rules

| Layer | Packages | May depend on | Must never |
| --- | --- | --- | --- |
| Types | `types` | nothing | contain logic |
| Infrastructure | `observability`, `storage`, `security`, `config` | types | know about LLMs or agents |
| Provider edge | `ai-core`, `providers` | types, infra | contain orchestration logic; hard-code a provider outside its definition/adapter |
| Policy | `quota-engine`, `model-router` | types, infra, providers | send requests |
| Work | `agents`, `orchestrator`, `project-memory`, `sandbox`, `git` | all of the above | reach into HTTP or the filesystem without passing the guards |
| Delivery | `apps/api`, `apps/web`, `apps/worker`, `apps/desktop`, `ui` | everything | contain business rules that belong in a package |

The rule that matters most: **no provider-specific logic in the core.** Providers are data
(JSON definitions) plus an adapter. If adding a provider required touching the router or the
quota engine, the abstraction would be broken.

## 3. The orchestration loop

`RunEngine.tick()` is the whole system in one function:

```
 1. unblock    tasks whose dependencies are all `done` → `ready`
 2. select     ready tasks, filtered by enabled/paused agents, resource locks, parallelism
 3. reserve    quota-engine reserves worst-case tokens per candidate provider (atomic)
 4. route      model-router scores candidates → a chain, not a single pick
 5. context    project-memory selects relevant entries, files, messages; compress to fit
 6. run        agent loop: model call → tool calls → validate output → repeat (bounded)
 7. settle     quota settled with actual usage; execution, metrics, trace recorded
 8. commit     git: agent's feature branch, commit with the agent as author
 9. update     task status/result; emit events; unblock dependents
10. supervise  stuck detection, retries on another model, reassignment, escalation
```

Everything is bounded: `maxTicks` per `runToCompletion`, `maxRetriesPerTask`,
`maxTokensPerTask`, `maxTaskRuntimeMs`, `maxAgentIterations`, `maxParallelAgents`. A tick
that cannot make progress stops and reports why, instead of spinning.

Step 8 is also where attribution comes from. `GitRepository` reports every commit it creates
through an `onCommit` callback, which the container and the test harness record in `git_commits`
with the agent and task that produced it — the Git screen's per-agent panels read that table, and
`git log` alone could never answer "which agent wrote this". When a task completes in AUTO mode
the engine commits whatever is left on the agent's branch (`<agent>: <task title>`), so a model
that forgets to call `git_commit` still leaves inspectable work; in SUPERVISED and MANUAL mode it
does not, because writing history is the operator's decision there and the Git screen has the
button for it.

Long-running work runs in a background scheduler (`packages/orchestrator/src/background.ts`)
with a project claim file, crash recovery (tasks left `running` are re-queued) and a drain
on shutdown. The desktop app, the headless worker and the API all start the same scheduler —
that is why background agents work identically in both shells.

### Dangerous actions and approvals

Step 6 is where a tool can stop and ask. The order matters:

1. the tool raises a request through `RunEngine`, which persists an `approvals` row and sets
   the task to `paused` / the agent to `waiting`;
2. the callback returns **`null`** — a *request* is not a *permission*. The tool refuses the
   action and the agent reports that it is blocked, so nothing destructive happens while the
   operator is still reading the prompt;
3. the decision arrives later: `POST /api/approvals/:id/decide` calls `ApprovalService.decide`,
   which fires `onDecided` — wired in `container.ts` to `ProjectRunner.settleApproval`.
   Approving puts the task back to `ready`, emits `task.unblocked` and wakes the run, which
   re-runs the task with the approved action keys in `grantedApprovals`, so the same call now
   succeeds. Denying fails the task with the operator's reason and cascades `blocked` to its
   dependents instead of leaving them waiting on work that can never finish;
4. an *expired* request is not a decision and never reaches `onDecided` — expiry is reported
   as its own status, and `waitForDecision` resolves it as "no".

How far a grant reaches is part of the decision, not a UI label: `approvals.decision_scope`
records `once` or `task`, and `grantedApprovalKeys` honours a `once` grant only for the
attempt the request was raised in (the dispatcher stamps `grantedForAttempt` on the payload
when it asks) while a `task` grant applies to every later attempt of that task.

A decision is persisted before the handler runs, and a throwing handler is logged rather than
propagated, so an approved/denied row can never be half-applied from the operator's point of view.

## 4. The quota engine

The most safety-critical component. Design:

- **Buckets** (`quota_buckets`) are per provider, optionally per model, per window
  (minute/hour/day/month) with separate token and request counters, each with a limit, used,
  reserved and window bounds.
- **Reservations** (`quota_reservations`) record the worst case *before* a request is
  sent — `estimatedInputTokens + maxOutputTokens` — inside a transaction, so two agents
  cannot reserve the same allowance. Reservations are settled with actual usage, or expire
  (`reservationTtlMs`) if a process dies holding one, which is what makes a crash safe
  instead of leaky.
- **Reset engine** implements `utc_midnight`, `provider_timezone` (timezone- and
  DST-aware), `rolling_24h`, `explicit_timestamp` and `api_reported`. Nothing assumes UTC
  midnight: Google's free tier resets at midnight *Pacific*, which is 07:00Z or 08:00Z
  depending on the season.
- **Limit learning.** Provider telemetry (headers such as `x-ratelimit-remaining-*`, usage
  endpoints such as OpenRouter's `/key`) is parsed after each call and stored as an
  observation; observed values override configured ones for subsequent decisions.
- **Unknown is not unlimited.** Providers with unknown limits refuse reservation unless
  `assumeUnknownIsUnlimited` is explicitly enabled.
- **Capacity reporting** distinguishes what is known, what is estimated and what is unknown,
  and lists which providers were excluded and why.

## 5. The model router

Score per candidate:

```
score = capabilityMatch^w1 × quality^w2 × quotaAvailability^w3
      × reliability^w4 × latency^w5 × taskCompatibility^w6
```

- Weights are configurable (Settings → Router policy) and every component's raw value,
  weight, contribution and a human-readable note are recorded on the trace, so "why this
  model?" is answerable after the fact.
- `taskCompatibility` comes from a per-task-type preference table that **learns from real
  attempts** (`model_task_stats`): successes and failures per model per task type shift the
  preference. A model that keeps failing at `test_generation` stops being chosen for it.
- FREE ONLY mode filters candidates before scoring: paid models, unknown-priced models and
  trial credits are excluded, and the exclusion is recorded as `freeOnlyApplied` in the
  rationale.
- The router returns a **chain**, not a pick: the executor walks it on retryable failures.
- A quota reserve floor (default fraction of each window) keeps headroom so a parallel batch
  cannot overrun a limit mid-flight.

## 6. Failure handling

Errors are classified (see [PROVIDERS.md](PROVIDERS.md) for the table) and each category
decides the response: retry with backoff, retry on a different model, fail over, cool the
provider down, open the circuit breaker, or fail the task immediately. Non-retryable
failures are never retried. Failures cascade through the DAG: dependents of a dead task are
marked blocked with a reason instead of waiting forever.

## 7. Data model

SQLite via `node:sqlite` (zero operational complexity), 27 tables, all access behind 21
repositories in `packages/storage/src/repositories/`:

```
settings  kv_state  users  sessions                      — configuration and identity
projects  agents  tasks  task_dependencies               — the work
providers  credentials  models                           — the provider edge
quota_buckets  quota_reservations  quota_observations    — the ledger
messages  executions  traces  metrics  events            — what happened
memory_entries                                          — what was learned
git_commits  test_runs  test_cases                       — code and verification
approvals  model_task_stats  scheduler_queue  run_signals — control
```

Migrations are versioned and applied on connect (`migrations` status is reported by
`/api/health`). The storage layer is behind repository interfaces, so a Postgres
implementation would not touch the orchestration layer — but only SQLite exists today, and
that is stated rather than implied.

## 8. Observability

- **Events** (`events`, SSE at `/api/events/stream`) — 50+ typed events from
  `task.started` to `supervisor.intervention`, with severity, project, task, agent and
  payload. The UI's Activity screen is a view over this, and the live stream invalidates
  client queries by prefix.
- **Traces** (`traces`) — one row per model call: provider, model, tokens, latency, cost
  estimate, status, error category, routing rationale with components and rejected
  candidates. `GET /api/system/explanations/:traceId` turns a trace into a plain-language
  explanation.
- **Metrics** (`metrics`) — tokens, latency, duration, success/failure per agent,
  provider, model and bucket, plus system memory/CPU samples, aggregated by
  `GET /api/performance`.
- **Executions** — one row per agent-task attempt with iterations, tool calls, tokens and
  outcome.

These three are deliberately separate: an execution answers "what did the agent do", a
trace answers "which model call was that and why", a metric answers "is this getting worse".

## 9. Frontend

React 19 + TypeScript + React Router + TanStack Query + Tailwind v4, one shared component
set in `packages/ui` used by both shells.

- **One typed API client** (`packages/ui/src/api/client.ts`) declares the contract once;
  the screens and the desktop shell consume the same `AidoApi`.
- **Live data** arrives over SSE; the client invalidates only the affected query prefixes,
  so a task completion does not refetch the whole app.
- **States are explicit everywhere**: loading, empty, error and degraded each have a
  designed presentation. An unknown value renders as unknown rather than as a plausible
  default — that rule applies to prices, quotas, health and status alike.
- **Dense, dark-first, keyboard-accessible.** Information hierarchy over decoration: no
  gradients, no oversized cards, tables for tabular data.

## 10. Decisions worth knowing

- **`node:sqlite` over a database server.** Single-file, no daemon, no ports; the product
  should be runnable on a laptop with no infrastructure. Correctness (atomic reservations,
  transactions, savepoints for nested units of work) is provided by SQLite semantics rather
  than by an external service.
- **Events as the coordination primitive.** Agents, the scheduler, the UI and the audit
  trail all read the same stream; nothing polls the database for "what's new" except the
  background scheduler's claim check.
- **Roles as data.** Adding an agent is a config change; the run engine has no `switch
  (agentId)`.
- **Providers as data + adapter.** Same reasoning, and the reason the shipped catalogue can
  be marked unverified without weakening the code.
- **Reserve before sending, settle after.** The alternative — counting after the fact —
  cannot prevent a 429, only report it.
- **Fail loudly on malformed model output.** A response that does not match its schema is a
  task failure with a recorded reason, never a partially-parsed success.
- **Provenance on every number.** A quota or price without a source is a guess, and guesses
  get spent as if they were facts.

## 11. Where to look first

| Question | File |
| --- | --- |
| What happens in one tick? | `packages/orchestrator/src/run-engine.ts` |
| How are tasks planned? | `packages/orchestrator/src/planner.ts` |
| How is a model chosen? | `packages/model-router/src/router.ts` |
| How is quota protected? | `packages/quota-engine/src/manager.ts`, `resets.ts` |
| What can an agent do? | `packages/agents/src/roles.ts`, `agent.ts`, `tools.ts` |
| What is sent to the model? | `packages/project-memory/src/context-builder.ts` |
| How are commands constrained? | `packages/security/src/command-policy.ts`, `packages/sandbox/src/workspace.ts` |
| How does the UI get data? | `packages/ui/src/api/client.ts`, `apps/web/src/lib/api.ts` |
