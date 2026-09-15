# Agents

Eleven specialist roles plus a Supervisor. A role is a configuration object
(`packages/agents/src/roles.ts`): instructions, tools it may call, the task types it
accepts, the model class it needs, an output contract, and hard limits. No role is a
special case in code — the run engine treats them all identically.

| Agent | Role id | Purpose | Task types |
| --- | --- | --- | --- |
| Architect | `architect` | Turns a goal into a concrete, buildable design | `architecture` |
| Project Manager | `project_manager` | Decomposes the design into a dependency-ordered plan | `planning` |
| Frontend Engineer | `frontend` | Builds the user interface | `code_generation`, `refactor` |
| Backend Engineer | `backend` | Implements the API and business logic | `code_generation`, `refactor` |
| Database Engineer | `database` | Owns the schema and data integrity | `database_design`, `code_generation` |
| QA Engineer | `qa` | Proves the software works — and proves it fails correctly | `test_generation`, `test_execution_analysis` |
| Security Engineer | `security` | Finds the ways the system can be abused | `security_audit` |
| Code Reviewer | `code_review` | Reviews changes before they are accepted | `code_review` |
| DevOps Engineer | `devops` | Packages and ships the software | `devops` |
| Performance Engineer | `performance` | Finds where the system is slow or wasteful | `performance_analysis` |
| Research Analyst | `research` | Answers open questions with evidence | `research`, `documentation`, `summarization` |
| Supervisor | `supervisor` | Keeps the team honest and unblocked | intervenes, does not work tasks |

The default team (`DEFAULT_TEAM`) is the eleven working roles; the Supervisor is always
active and cannot be paused.

## Tools

Every tool is declared per role — a role cannot use what it was not granted. The tool set
is read-only, write, or full:

```
read-only   read_file, list_files, search_files
write       + write_file, run_tests, run_lint, run_build, git_status, git_diff
full        + run_command, git_commit, git_branch, static_analysis, package_manager
```

Concretely: the Architect and the Research Analyst are read-only; the Security Engineer can
run commands and static analysis but is granted no write tools; the QA Engineer can run
tests and commands; the Code Reviewer can run lint and build but not commit; the DevOps
Engineer has the full set. `git_commit` exists only where the role is expected to commit
its own work, on its own branch.

## Model preference per role

Each role declares what it needs, not which model to use:

```ts
modelPreference: {
  requiredCapabilities: ['chat', 'structuredOutput'],
  preferCapabilities: ['reasoning', 'longContext', 'codeGeneration'],
  minContextWindow: 32_000,
  qualityRequirement: 'maximum',     // maximum | high | balanced | cheap
  maxLatencyMs: null,
  allowTrialCredits: false,
}
```

The router combines this with quota availability and measured reliability. A role's
preference can never override FREE ONLY mode, and `allowTrialCredits: false` means the role
will not consume a finite trial balance even when trial credits are enabled globally.

## Output contracts

An agent's answer is validated against a schema before it is accepted; a malformed response
is a task failure, never a silently-accepted blob:

| Schema | Used by |
| --- | --- |
| `architecture_proposal` | Architect |
| `plan` | Project Manager |
| `task_result` | Frontend, Backend, Database, DevOps, Performance, Research |
| `test_report` | QA |
| `review` | Security, Code Review |
| `plain` | Supervisor |

Each result carries a summary, the artifacts it produced, the files it changed, token
usage, and any blockers it hit. `reasoningSummary` fields are short action summaries —
never hidden chain-of-thought, which is neither requested nor stored nor shown.

## Hard limits

Enforced by the supervisor and the agent loop, not requested politely from the model:

```ts
DEFAULT_LIMITS = {
  maxTokens: 300_000,        // per task
  maxRequests: 40,           // model calls per task, including retries
  maxRuntimeMs: 15 * 60_000, // per task, including tool time
  maxRetries: 3,
  maxFilesChanged: 25,
  maxShellCommands: 40,
}
```

Plus the global supervisor limits (Settings → Hard limits): `maxRetriesPerTask`,
`maxTokensPerTask`, `maxTaskRuntimeMs`, `maxAgentIterations`, `maxParallelAgents`. Reaching
one fails the task with a category the UI shows; there is no configuration in which an
agent loops forever. Iteration limits also emit `agent.iteration_limit`.

## The run loop

```
tick → unblock ready tasks → pick eligible tasks → reserve quota → route model
     → build context → agent loop (model call ⇄ tool calls) → validate output
     → settle quota → record execution, metrics, trace → commit on the agent's branch
     → update the task, unblock dependents, supervise
```

- One agent = one task at a time; `maxParallelAgents` bounds how many run at once.
- Resource locks (`file:src/app.ts`) prevent two agents from editing the same file
  simultaneously; the planner assigns them, and conflicts are reported rather than merged
  blindly.
- QA, review and security tasks are ordinary tasks — they are planned, scheduled, retried
  and traced like any other work.
- A run stops when the graph is complete, when nothing can make progress (reported as such),
  when the operator stops it, or when a hard limit is reached.

## Agent messaging

Agents and the orchestrator communicate through the event bus and the message log
(`messages` table, `GET /api/projects/:id/messages`). Messages record the sender role, the
task they belong to, the content, the trust level and the model/provider that produced them.

Event types include `task_created`, `task_completed`, `code_changed`, `review_requested`,
`review_completed`, `security_issue_found`, `test_failed`, `performance_regression`,
`quota_exhausted`, `supervisor_intervention` and more (`packages/types/src/events.ts`).
Reviews are requested by the run engine when work reaches them, not by agents chatting
freely: the flow is visible and bounded.

## Memory and context

Project memory (`packages/project-memory`) keeps the specification, the architecture, the
code state, the test state, known issues, decisions and constraints as addressable entries
with trust levels, importance and provenance (which agent, which task).

The context builder retrieves selectively: a task gets the relevant memory entries, the
files it needs, recent messages and its acceptance criteria — then compresses (summarises
older content first, drops the least relevant) to fit the model's window. Context overflow
is classified as `context_length` and triggers compression on the next attempt rather than
blind truncation.

## Supervision and self-healing

The Supervisor watches for stuck tasks, repeated failures, agents that stop making
progress, and pending approvals. It can retry with a different model, reassign a task to
another role, pause a misbehaving agent, escalate to a human, or stop the run — and every
intervention is emitted as an event and shown in the UI.

Errors are classified into the shared taxonomy (see [PROVIDERS.md](PROVIDERS.md)), which
decides whether a retry can possibly succeed. Retrying an authentication failure or an
exhausted window is explicitly disabled: it wastes quota and time on a request that cannot
succeed.

## Adding a role

1. Add an entry to `AGENT_ROLES` in `packages/agents/src/roles.ts`: id, name, purpose,
   responsibilities, handled task types, model preference, allowed tools, output schema,
   limits and the system prompt.
2. If it needs a new output shape, add a Zod schema in `packages/agents/src/schemas.ts`.
3. If it needs a new tool, add it to the tool registry and grant it to the roles that need
   it — granting is deliberate, not a default.

Nothing in the orchestrator, the router or the UI needs to change: roles are data, and the
Agents screen reads the roster from the API. To make a new role part of the default team,
add it to `DEFAULT_TEAM`.
