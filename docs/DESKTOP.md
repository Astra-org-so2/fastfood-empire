# Linux desktop target

AI Dev Orchestrator is one product with two shells. The web build and the desktop build
run the **same** API contract, orchestration engine, provider adapters, quota engine,
agent system, project logic and UI components. The desktop shell adds a native window
and the operating-system integrations a browser cannot have. It is not a second
application and it does not fork the core.

- Supported: **Ubuntu 22.04/24.04 LTS**, **Debian 12 (Bookworm) stable**, x86_64.
  ARM64 works where Electron ships a build for it; the packaging config is
  architecture-agnostic (`electron-builder` picks the host architecture by default).
- Distribution format: **`.deb`** (primary), **AppImage** (optional, portable).

## What the desktop build adds

| Capability | Where it is implemented | Notes |
| --- | --- | --- |
| Native application window | `apps/desktop/src/main.ts` | Sandboxed renderer, context isolation, no Node in the renderer. |
| Local project / file-system access | API path guard + `POST /api/platform/reveal` | The renderer never touches the file system directly; every path is resolved and validated server-side. |
| Secure local API-key storage | `packages/security` (credential vault) + `packages/platform/src/secrets.ts` | Provider keys are encrypted at rest with a per-install master key. Shell-level secrets use the OS keyring (Secret Service) when available, otherwise an AES-256-GCM file with a `0600` key. The UI reports which one is in use. |
| Terminal / sandbox integration | `packages/sandbox` + `POST /api/platform/open-terminal` | Commands run through the sandbox (argument validation, command policy, secret-free environment, timeouts). The button that opens a terminal at the project root is a convenience, not the execution path. |
| Git integration | `packages/git` | Per-agent branches, commits, diffs, merge-conflict reporting — identical in both shells. |
| Background agent execution | `packages/orchestrator/src/background.ts` + `apps/desktop/src/host.ts` | The desktop app runs the same scheduler as the headless worker, so a run continues while the window is minimised. |
| System notifications | `packages/platform/src/notifications.ts` + `notify-bridge.ts` | `notify-send`, with a cooldown; approval requests and finished/failed runs only. Falls back to the in-app activity feed, and says so, when no notification daemon is present. |
| Update mechanism | `packages/platform/src/updater.ts` + `GET /api/platform/updates` | Reads a JSON update manifest, compares versions, and shows the exact install command. It never silently installs: writing to `/usr` needs privileges the app deliberately does not take. |
| Single instance | `apps/desktop/src/host.ts` | A lock file plus Electron's own single-instance lock: two processes never drive one database. |

## Architecture

```
┌─────────────────────────────── Electron main process ──────────────────────────────┐
│  main.ts        window, single-instance lock, IPC handlers (validated with Zod)     │
│  preload.ts     contextBridge → window.aido  (no ipcRenderer, no Node in renderer)  │
│  host.ts        starts the API in-process, serves dist/web, runs background agents  │
└───────────────┬─────────────────────────────────────────────────────────────────────┘
                │ loopback HTTP (127.0.0.1, OS-assigned port)
┌───────────────▼─────────────────────────────────────────────────────────────────────┐
│  apps/api  ── the same Fastify server the web build uses, serving dist/web          │
│  packages/{ai-core, providers, quota-engine, model-router, agents, orchestrator,    │
│            project-memory, git, sandbox, storage, observability, security, platform}│
└─────────────────────────────────────────────────────────────────────────────────────┘
```

The renderer loads the HTTP origin, so the desktop build has all the web build's
functionality by construction. Platform-specific behaviour (paths, secrets,
notifications, updates, shell integration, window controls) goes through the interfaces
in `packages/platform`; the renderer detects the shell by the presence of `window.aido`
and enables the desktop-only affordances when it is there.

## Build

```bash
npm install                      # repository dependencies — no Electron, by design
npm run build:web               # dist/web — the shared UI bundle
npm run build:desktop           # esbuild bundles main + preload into dist/desktop

# Install the desktop toolchain once, only if you need to run or package the app.
# apps/desktop/packaging is deliberately NOT an npm workspace: Electron is a ~100 MB
# binary download that a plain `npm install` must not depend on.
cd apps/desktop/packaging && npm install && cd ../../..
# On a machine that cannot reach the Electron download host:
#   ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install   (bundling still works)

npm run start:desktop           # launches the app from the repository
```

Producing an installer:

```bash
npm run package:desktop          # dist/installers/*.deb
npm run package:desktop:all      # .deb and AppImage
```

`electron-builder` requires a Linux host with the usual packaging tools; in a container
you may also need `fakeroot` and `dpkg`. If those are unavailable, the `.deb` cannot be
produced from that machine — the configuration is complete and committed, but the
artefact has not been built there, and this document says so rather than implying a
package exists.

Installers are written to `dist/installers/`. The description, dependencies
(libnotify, git), desktop entry and icon come from `apps/desktop/packaging/electron-builder.json`.

Install the `.deb`:

```bash
sudo apt install ./dist/installers/ai-dev-orchestrator_0.1.0_amd64.deb
ai-dev-orchestrator                # or launch it from the application menu
```

## Where the desktop build keeps its data

| Path | Contents | Override |
| --- | --- | --- |
| `$XDG_DATA_HOME/aido` (`~/.local/share/aido`) | database, master key, logs, workspaces | `AIDO_DATA_DIR` |
| `$XDG_DATA_HOME/aido/workspaces` | per-project Git repositories | `AIDO_WORKSPACE_ROOT` |
| `$XDG_CACHE_HOME/aido` (`~/.cache/aido`) | disposable caches | `AIDO_CACHE_DIR` |
| `$XDG_DATA_HOME/aido/app.lock` | single-instance lock | `AIDO_DATA_DIR` |

A development checkout keeps using `./.data`, so the two do not collide.

## Operations

- **Logs**: structured lines on stdout; errors are also written to the activity stream
  visible in the UI. Set `AIDO_LOG_LEVEL=debug` for verbose output.
- **Reset**: stop the app, move `$XDG_DATA_HOME/aido` aside. Provider keys, projects and
  history live there.
- **Headless servers**: use `apps/worker` (`npm run dev:worker`) instead of the desktop
  app. It shares the database and the scheduler but has no window, which is the right
  shape for a CI machine or a server.
- **Notifications**: `notify-send` must be installed (`libnotify-bin`). The `.deb`
  declares that dependency; the UI shows a degraded state if delivery fails.

## Updating

The app reads `AIDO_UPDATE_FEED` (a URL to a JSON manifest) when set:

```json
{
  "version": "0.2.0",
  "notes": "What changed",
  "artifacts": {
    "deb": "https://example.invalid/downloads/ai-dev-orchestrator_0.2.0_amd64.deb",
    "AppImage": "https://example.invalid/downloads/AI-Dev-Orchestrator-0.2.0.AppImage"
  },
  "publishedAt": "2026-01-01T00:00:00Z"
}
```

`GET /api/platform/updates` reports `up-to-date`, `update-available`, `unsupported`
(no feed configured) or `check-failed`. When an update is available the UI shows the
version, the notes and the exact command (`sudo apt install --reinstall <file>` or
replacing the AppImage). No feed is configured by default, and the app says so.

## Portability to Windows and macOS

Nothing outside `packages/platform` branches on the operating system:

- `paths.ts` already implements the macOS (`~/Library/Application Support`) and Windows
  (`%APPDATA%`) conventions;
- `secrets.ts` uses Keychain on macOS and an encrypted file elsewhere, with a
  documented path to a Windows credential-manager binding;
- `notifications.ts`, `shell.ts` and `updater.ts` each return "not implemented for this
  platform yet" rather than failing, so a missing implementation degrades visibly.

Adding a platform therefore means adding an implementation of these interfaces plus an
`electron-builder` target, not changing the orchestration or UI layers.
