# Development

## Requirements

- **Node.js 22+** — the storage layer uses the built-in `node:sqlite` (experimental, no
  native build step, no `better-sqlite3`).
- **Git** — the workspace integration is real Git, not a simulation.
- That is the whole list. No database server, no Docker, no cloud account, no Electron for
  the default install.

## Setup

```bash
npm install                 # ~340 packages, all from npm; Electron is opt-in (see below)
cp .env.example .env        # optional: defaults work as-is
npm run dev                 # API :8787 + web :5173 (Vite proxies /api)
```

`npm run dev` runs both processes; open <http://localhost:5173>. The API alone is
`npm run dev:api`, the headless worker is `npm run dev:worker`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | API + web dev server together |
| `npm run build` | esbuild bundles for `apps/api`, `apps/worker`, and `vite build` for `dist/web` |
| `npm run build:web` | The UI bundle on its own (`dist/web`) |
| `npm start` | Runs the built API, which also serves `dist/web` on one port |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` across every package and app |
| `npm run lint` / `lint:fix` | ESLint |
| `npm test` | Vitest: unit + integration (42 tests) |
| `npm run test:unit` / `test:integration` | Subsets |
| `npm run test:ui` | DOM render tests for every screen against a live API (16 tests) |
| `npm run e2e:api` | 60-check end-to-end run against a real listening server |
| `npm run verify` | typecheck + lint + test |
| `npm run build:desktop` | Bundles the Electron main/preload (no Electron install needed) |
| `npm run start:desktop` | Launches the desktop shell (needs the opt-in toolchain) |
| `npm run package:deb` | Builds the `.deb` with `dpkg-deb` from the built bundles (no Electron needed) |
| `npm run package:desktop[:all]` | Builds `.deb` (and AppImage) with electron-builder |
| `npm run db:migrate` | Applies migrations to the configured database |

## Testing

Four layers, each catching a different class of bug:

**1. Unit tests** (`test/unit/`) — quota accounting and platform behaviour. Quota tests are
the most detailed: reservations, expiry, window rollover, DST-aware resets, learning from
headers, and that a reservation cannot be double-spent.

**2. Integration tests** (`test/integration/`) — the real wiring, no mocks: the shared
harness (`packages/testing`) builds the actual router, quota manager, agent loop, planner and
run engine against a temporary database and workspace, using the local simulator plus
scripted providers that can be told to return 429s, timeouts, malformed JSON, or failures.

- `failure-paths.test.ts` — failover on 429, quota exhaustion never sent, non-retryable
  errors not retried, malformed responses rejected.
- `worker-lifecycle.test.ts` — background runs, crash recovery, stop semantics, drain on
  shutdown.
- `desktop-host.test.ts` — the desktop host: single-instance lock, UI availability, the
  API-only degraded path, clean shutdown.
- `agent-state.test.ts` — agent rows are created on first write, counters accumulate
  atomically, and a real run records completed work per agent.

**3. Screen render tests** (`test/ui/`) — every screen and project tab is mounted in jsdom
against a **live API** and must reach a rendered state without crashing or showing an error
state:

```bash
npm run dev:api                      # in one terminal
npm run test:ui                      # in another
AIDO_E2E_BASE_URL=http://127.0.0.1:9000 npm run test:ui   # non-default port
```

This suite is what catches a screen reading a field the API does not send — the failure mode
that type-checks cleanly but breaks in front of a user. It skips with a warning (not a
failure) when no API is reachable.

**4. End-to-end** (`scripts/e2e-api.mjs`) — starts a real server on a temporary database and
drives the full acceptance path over HTTP, asserting on real state, not fixtures.

### Adding a provider: the checklist

1. Copy the nearest `config/providers/*.json`; set the base URL, credentials, capabilities,
   `telemetrySemantics`, and a `provenance` block with an honest `confidence`.
2. If it is not OpenAI-compatible, add `packages/providers/src/adapters/<name>.ts`
   implementing `LLMProvider` and register the adapter kind.
3. Add a test for its error mapping if the provider has distinctive failure modes.
4. Do **not** add provider-specific branches to the router, quota engine or UI. If you feel
   you need to, the interface is wrong — fix the interface instead.

### Adding a route

Routes live in `apps/api/src/routes/*.ts` and are registered by `buildServer()`. Every
handler validates its input with Zod, returns a plain object, and throws `ApiError` for
failures. Add the type to the shared client (`packages/ui/src/api/client.ts`) in the same
commit — the contract is declared once and consumed by both shells.

## Conventions

- **TypeScript strict**, ESM, `.js` extension on relative imports.
- **No `any`**, no non-null assertions where a check is possible; a genuinely unknown value
  is typed as unknown and rendered as unknown.
- **Comments explain why, not what.** The codebase is commented where a decision is
  surprising: why an upsert is needed, why a retry is refused, why a comparison excludes a
  category. Trivial comments are noise.
- **Errors are data.** Capture the category, the reason and what was attempted; never
  swallow an error without recording it (a comment explaining why it is safe to ignore is
  acceptable, as in "a malformed SSE frame must not break the stream").
- **Never fabricate a value.** If a limit, price, health status or test result is unknown,
  the API returns null/unknown and the UI says so. Placeholder numbers must carry
  provenance and a confidence.
- **No hidden chain-of-thought.** Store and display action summaries and conclusions;
  never request or persist private reasoning.
- **Bounded loops only.** Any loop over tasks, retries or ticks needs a documented cap.

## Working on the UI

- Components come from `packages/ui`; screens in `apps/web/src/screens/` compose them.
  If two screens need the same widget, it belongs in `packages/ui`.
- Data access goes through the hooks in `apps/web/src/lib/api.ts` (TanStack Query). Live
  updates come from the SSE stream: add the affected query key to `invalidateFor()` rather
  than adding a polling interval.
- Because both shells share the bundle, do not import Electron or Node APIs in the UI.
  Platform differences are read from the API (`/api/platform`, `/api/settings`) or from
  `window.aido`.
- The design vocabulary is dense and dark-first: `Panel`, `Section`, `data-table`,
  `Badge`, `Stat`, `Empty`, `ErrorState`, `LoadingRows`. Every list has an empty state and
  every fetch has a loading and error state.

## Working on the backend

- New persistence goes through a repository in `packages/storage/src/repositories/` and a
  migration in `packages/storage/src/schema.ts`. Never query the database from a route.
- Anything that spends quota must go through `QuotaManager.reserve()` and be settled.
- Anything that calls a model must go through the router and produce a trace; a direct
  provider call from a feature is a bug.
- Anything that touches the filesystem or runs a command must go through the workspace guard
  and the command policy.

## Desktop development

The Electron toolchain is deliberately not installed by `npm install` (Electron is a ~100 MB
binary that CI images and offline machines often cannot fetch):

```bash
npm run build:web                # the shared UI bundle the shell serves
npm run build:desktop            # bundles main + preload with esbuild (no Electron needed)
npm run package:deb              # a working .deb without Electron (server + worker + UI)
cd apps/desktop/packaging && npm install && cd ../../..
npm run start:desktop            # run the window
npm run package:desktop          # dist/installers/*.deb, built by electron-builder
```

`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install` in `apps/desktop/packaging` installs the
toolchain without the binary: bundling still works, but running and packaging need it.

`scripts/build-deb.mjs` is the route that works without any of that: it stages the same
product tree, writes the control file, launcher, desktop entry, icon and systemd user unit,
and builds with `dpkg-deb`. It adds the native window when the Electron runtime is present
and says so when it is not. Test it from an extracted package with `AIDO_APP_DIR`:

```bash
npm run build && npm run package:deb
dpkg-deb -x dist/installers/ai-dev-orchestrator_0.1.0_amd64.deb /tmp/aido
AIDO_APP_DIR=/tmp/aido/opt/ai-dev-orchestrator sh /tmp/aido/usr/bin/aido paths
```

See [docs/DESKTOP.md](DESKTOP.md) for paths, notifications, updates and portability.

## Database

Default location is `.data/aido.db` (development) or `$XDG_DATA_HOME/aido/aido.db` (desktop
builds). Set `AIDO_DB_PATH` to move it. Migrations run automatically on connect; the applied
version is visible at `GET /api/health` and in Settings → Diagnostics.

To start over: stop the app and delete `.data` (development) or the XDG data directory.
That removes projects, credentials and history with it — the app never does this by itself.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot find module 'node:sqlite'` | Node < 22. Upgrade. |
| The UI shows "reconnecting…" forever | The SSE stream is blocked (proxy). Data still loads; check `/api/events/stream` through your proxy. |
| A provider shows `invalid` | The stored key was rejected. Re-enter it in Providers → Credentials. |
| A task is `blocked` with a reason | It failed terminally or a dependency did. Read the reason on the task; the Activity screen has the full event history. |
| No models appear | The provider has no credentials or discovery has not run. Providers → Discover. |
| `npm run test:ui` skipped | No API on `AIDO_E2E_BASE_URL` (default `http://127.0.0.1:8787`). Start `npm run dev:api`. |
| Desktop shell starts API-only | `dist/web/index.html` is missing: run `npm run build:web`. The log says so. |

## Design constraints worth preserving

1. **No provider-specific logic outside adapters.** Providers are data plus an adapter.
2. **Atomic quota, always.** Reserve before sending; never send to an exhausted window.
3. **Never retry what cannot succeed.**
4. **Unknown is not zero and not unlimited** — it is unknown, and it is reported as such.
5. **Untrusted content is data, never instructions.**
6. **Every model call is traceable** to a routing decision with recorded components.
7. **Bounded autonomy** — every loop has a cap.
