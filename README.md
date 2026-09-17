# AI Dev Orchestrator

A multi-provider LLM orchestration platform that manages **free** provider quotas and
coordinates a team of specialised AI agents to build software projects.

It is not a chat UI with several API keys bolted on. It is a scheduler, a quota ledger, a
model router, an agent runtime and a workspace: you describe a project, it plans the work,
assigns it to specialised agents, runs each agent against a real Git repository, tests and
reviews the result, and moves on — while spending only free quota and explaining every
model choice it makes.

**One product, two shells.** The browser app and the Linux desktop app are the same
codebase, the same API contract, the same orchestration engine and the same UI components.
See [docs/DESKTOP.md](docs/DESKTOP.md).

---

## What it actually does

Given a project goal, the platform:

1. **Plans.** The Architect produces a structured architecture proposal (components, stack,
   data model, API surface, decisions) which is stored in project memory. The Project
   Manager converts it into a dependency-ordered task plan with resource locks. Plan-local
   ids are remapped, self/unknown dependencies are dropped, and dependency cycles are broken
   before the plan is written.
2. **Routes every task to a model.** Each task type has a policy (required capabilities,
   quality floor, latency ceiling, whether trial credits are allowed). The router scores
   every candidate with
   `capabilityMatch × quality × quotaAvailability × reliability × latency × taskCompatibility`,
   honours FREE ONLY mode, and records the full rationale on the trace.
3. **Reserves quota atomically.** Before a request is sent, the quota engine reserves the
   worst-case token cost against the provider's window. Two agents can never reserve the
   same allowance; exhausted windows are never called; unknown limits are *not* treated as
   unlimited.
4. **Runs the task.** The assigned agent works in a sandboxed workspace with a tool set
   scoped to its role, on its own feature branch, with hard limits on retries, tokens,
   runtime, iterations and parallel agents.
5. **Handles failure.** Errors are classified into 12 categories; the retryable ones are
   retried (on a different model when the failure was model-specific), the rest fail fast,
   and the provider is failed over or cooled down. Nothing that cannot succeed is retried.
6. **Verifies.** QA runs real commands in the sandbox; the Code Review agent reviews the
   diff; Security and Performance agents audit when their task types are planned. Test runs,
   reviews and findings are recorded as data.
7. **Unblocks the graph.** Completing a task marks its dependents ready. Blocked cascades
   are computed, so dead work is reported instead of waiting forever.
8. **Shows its work.** Every model call produces a trace with tokens, latency, cost, the
   routing score and its components, the error category and the retry decision. The UI is
   built to answer "why did it do that?" without exposing hidden chain-of-thought — only
   action summaries and conclusions.

## Acceptance path

The end-to-end script (`npm run e2e:api`, 60 checks) drives this exactly:

```
create a project → add a provider → discover models → see free quotas and reset times
→ enable FREE ONLY → plan → run → tasks unblock and complete → agents record their work
→ tests run in the sandbox → git branches/commits/diffs are inspected → memory is populated
→ traces explain the model choice → quotas account for every request
```

## Quick start

Requirements: **Node.js 22+** (uses the built-in `node:sqlite`), **Git**.

```bash
npm install                # no Electron, no database server, no cloud account
npm run dev                # API on :8787, web UI on :5173 (proxying /api)
```

Open <http://localhost:5173>. The first screen is the Dashboard; there is nothing to
configure to get started because the shipped **Local Simulator** provider needs no API key
and consumes no external quota — it exists so the whole pipeline can be exercised offline.
Its output is always labelled as simulated; it is never presented as a real model answer.

To use a real free tier, open **Providers**, pick a provider, paste a key and press
**Test** then **Discover models**. Keys are encrypted at rest and are never shown again
after saving.

Production-style single process:

```bash
npm run build              # dist/api, dist/worker, dist/web
npm start                  # serves the API and the built UI on one port
```

On Ubuntu/Debian you can install it system-wide instead:

```bash
npm run build && npm run package:deb      # -> dist/installers/ai-dev-orchestrator_*_amd64.deb
sudo apt install ./dist/installers/ai-dev-orchestrator_*.deb

aido                 # start the API and the UI (foreground)
aido open            # start it in the background and open the UI
aido worker          # run background agents with no window, for systemd
aido paths           # print the directories this installation uses

systemctl --user enable --now ai-dev-orchestrator-worker.service   # unattended agent work
```

The package needs Node 22+ and Git on the machine (`Depends: nodejs (>= 22.5), git`) and
keeps all state in `~/.local/share/aido` and `~/aido`. It is built with `dpkg-deb` from the
same bundles the desktop shell loads; when the Electron toolchain is present the same
package also carries the native window (`aido desktop`). See
[docs/DESKTOP.md](docs/DESKTOP.md).

## Screens

| Screen | What it answers |
| --- | --- |
| **Dashboard** | Is anything running, what did it cost, what needs me, is FREE ONLY on? |
| **Projects** / **Project detail** | What is this project, what is its plan status, run controls, tasks, files, memory, messages, executions, tests, git, supervision. |
| **Tasks** | The kanban across projects, with status, agent, attempts and locks. |
| **Graph** | The task DAG: dependencies, depth, what is unblocked, what is blocked by what, cycles (if any). |
| **Agents** / **Agent detail** | The 11 roles + Supervisor: purpose, tools, model preferences, hard limits, state, counters, tasks, recent model calls, and the exact instructions each role runs with. |
| **Providers** / **Provider detail** | Credentials, health, models, quota class, effective limits, observed live values, and the raw definition. |
| **Models** | Every discovered model: capabilities, context, price with provenance, quota class, and a provider-wide rediscovery action. |
| **Quotas** | Per-provider capacity, basis, exclusions, reset times and per-window snapshots. |
| **Activity** | The event stream with severity/agent/type filters and the raw payload. |
| **Git** | Branch, working tree, branches, merge, commit history, diffs, and commits recorded against agents. |
| **Tests** | Recorded runs and cases, plus a button that runs the project's own test command in the sandbox. |
| **Performance** | Tokens, latency, throughput, success rate, cost, per-provider/model/agent breakdown, failures by category, system memory. |
| **Settings** | Execution mode, FREE ONLY, hard limits, security posture, router weights and per-task-type policies, a routing preview, the team roster, notifications, updates, quota accounting. |

## The free-quota discipline

This is the part that gets products like this wrong, so it is explicit:

- **Quota classes are distinguished**: `FREE_RENEWABLE`, `FREE_TRIAL`, `PAID`, `UNKNOWN`,
  `USER_HOSTED`. Trial credits and expiring promo balances are **not** renewable free quota.
- **FREE ONLY mode never** calls a paid model, a provider with unknown pricing, or spends
  trial credits.
- **Reset times are never assumed to be UTC midnight.** Strategies: `utc_midnight`,
  `provider_timezone` (DST-aware — Google's daily reset is midnight *Pacific*, which moves
  between 07:00Z and 08:00Z), `rolling_24h`, `explicit_timestamp`, `api_reported`.
- **Unknown is not unlimited.** A provider whose limits are unknown refuses reservation
  unless the operator explicitly opts into assuming unlimited.
- **Live data beats shipped data.** Remaining-quota headers (Groq's `x-ratelimit-*`,
  OpenRouter's `/key` usage) are recorded as observations and override the shipped numbers.
- **Nothing is fabricated.** Every shipped numeric limit carries a provenance record
  (`provider_docs`, `observed_header`, `api_reported`, `user_configured`, `inferred`,
  `unknown`) with a confidence value, and the catalogue ships marked
  `metadataVerified: false` until a human verifies it. The UI shows the provenance
  everywhere a number appears.

## Repository layout

```
apps/
  api/        Fastify server: 65 routes, SSE stream, static UI, SPA fallback
  web/        React 19 + Tailwind v4 + TanStack Query UI (the shared frontend)
  worker/     headless scheduler process (no UI, same database)
  desktop/    Electron shell: main/preload/IPC + opt-in packaging toolchain
packages/
  types/      every shared type: provider, model, quota, task, agent, trace, event, desktop
  config/     settings defaults, the provider catalogue loader, task-type policies
  observability/  logger, event bus, metrics collector, trace store
  security/   credential vault (AES-256-GCM), redaction, master key handling
  storage/    node:sqlite layer, migrations, 27 tables, 21 repositories
  ai-core/    the provider-agnostic LLM call contract and retry policy
  providers/  adapter interface, registry, adapters (openai-compatible, gemini, cloudflare…)
  quota-engine/  windows, atomic reservations, reset engine, limit learning, capacity
  model-router/  scoring, candidate chain, task-type preference learning, explanations
  agents/     11 role definitions, the agent loop, tool set, schemas, supervisor
  orchestrator/  planner (Architect→PM), run engine, DAG unblocking, approvals, background
  project-memory/  specification/architecture/code/test/issue memory + context builder
  sandbox/    workspace confinement, command policy, process-group timeouts
  git/        branch-per-agent, commits, diffs, merge with conflict reporting
  platform/   shell detection, XDG paths, secret stores, notifications, updater
  ui/         the shared component set and the typed API client (§54: used by both shells)
  testing/    integration harness + scripted providers
```

## Documentation

| Document | Contents |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, data flow, the orchestration loop, schema, and the decisions behind them |
| [PROVIDERS.md](PROVIDERS.md) | The adapter contract, the provider config format, quota semantics, adding a provider |
| [AGENTS.md](AGENTS.md) | The 11 roles, task types, messaging, memory, limits, review flow |
| [SECURITY.md](SECURITY.md) | Credential handling, sandboxing, prompt-injection defence, threat model, limits |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Setup, scripts, tests, conventions, extending the system |
| [API.md](API.md) | Every HTTP route, with request and response shapes |
| [docs/DESKTOP.md](docs/DESKTOP.md) | The Linux target: packaging, paths, notifications, updates, portability |

## Testing

```bash
npm run typecheck                        # tsc across all packages and the app
npm run test                             # 81 unit + integration tests (65 + 16 screens)
npm run test:ui                          # the 16 screen render tests on their own
npm run e2e:api                          # 60 checks against a real listening server
npm run package:deb                      # build the Debian package from the built bundles
```

`npm run test:ui` mounts every route in a DOM against a live API and fails if a screen
crashes, renders nothing, or shows an error state — it is the check that catches a UI
reading a field the API does not send. It **skips with a warning** when no API is
reachable, so a green `npm test` without a running server says nothing about the screens;
run `npm run dev:api` (or `aido serve`) first. The same applies to `npm run e2e:api`.

Every failure mode the spec calls out has a test that reproduces it against the real
subsystems: timeouts, 429s, exhausted quotas, invalid keys, an empty model catalogue,
network failures, malformed model output, context overflow, a mid-stream failure, an agent
that never converges, two agents on the same file, a merge conflict, a failing test run and
a database that has gone away. Two of those tests found defects rather than confirming
behaviour: the scheduler used to let two same-lock tasks start in one tick, and Mocha
output was reported as "no tests ran", and a SUPERVISED overwrite used to proceed while its
approval was still pending. The approval path is now covered end to end: the tool refuses
while the request is undecided, approving it re-queues the blocked task and the same call
succeeds, denying it fails the task with the operator's reason and releases its dependents,
and the scope the operator picked is honoured — "once" covers the resumed attempt, "task"
covers the rest of the work.

## Status and known limits

This is an early but genuinely working system. Honest list of what is *not* done or not
verified here:

- The shipped provider catalogue's numeric free-tier limits are **unverified** against
  current provider documentation (`metadataVerified: false`), because published free-tier
  numbers are volatile and mutually inconsistent. Live header/API observations override
  them at runtime; the UI shows the provenance of every number.
- No provider credential is configured in this environment, so real-provider paths
  (discovery, headers, quota learning) are exercised by tests and by the adapter code, not
  by a live account here.
- The `.deb` is built and verified here (`npm run package:deb`, then extracted with
  `dpkg-deb -x` and started from the extracted tree). What is *not* verified here is the
  Electron window itself: this environment cannot reach the Electron download host, so the
  desktop shell was bundled but never launched, and `aido desktop` reports that the runtime
  is missing instead of failing obscurely. AppImage output needs the same toolchain.
- `notify-send` is not present in every environment; notification delivery reports the
  failure instead of pretending to have sent something.
- SQLite is the default store (zero operational complexity). The storage layer is behind
  repository interfaces, so a Postgres implementation is possible without touching the
  orchestration layer, but it does not exist yet.

## License

Unlicensed / private work in progress.
