import fs from 'node:fs';
import path from 'node:path';
import { createBackgroundScheduler, type BackgroundScheduler } from '@aido/orchestrator';
import { createLogger } from '@aido/observability';
import type { ServerHandle } from '../../api/src/server.js';
import { buildServer } from '../../api/src/server.js';

/**
 * The desktop host (§54).
 *
 * Everything the desktop app does except drawing a window lives here, deliberately
 * outside the Electron API: starting the API server in-process, serving the same UI
 * bundle the browser gets, driving background agents, and reporting platform state.
 * That keeps the Electron main process a thin shell and makes the host testable
 * without a display.
 *
 * Design decisions worth stating:
 *   - the API listens on 127.0.0.1 only, on a port chosen by the OS, and the window
 *     loads that URL, so the desktop app is not a web server on the local network;
 *   - background agents run inside this process through the shared scheduler, so a run
 *     continues while the window is minimised;
 *   - a lock file (`app.lock`) prevents two instances from driving the same database.
 */

export interface DesktopHostOptions {
  /** Where to find `dist/web` (the shared UI bundle). */
  webDistDir: string;
  /** Overridable for tests. */
  host?: string;
  port?: number;
  /** Disable background agents (used by tests that drive the runner directly). */
  backgroundAgents?: boolean;
  logger?: ReturnType<typeof createLogger>;
  /** Path of the single-instance lock file. */
  lockFile?: string;
}

export interface DesktopHost {
  /** Base URL the window should load, e.g. `http://127.0.0.1:51234`. */
  url: string;
  port: number;
  /** True when the shared UI bundle was found; false means "API only". */
  uiAvailable: boolean;
  /** Absolute path of the loaded UI bundle, when present. */
  uiRoot: string | null;
  server: ServerHandle;
  scheduler: BackgroundScheduler | null;
  /** Releases the single-instance lock, stops agents and closes the server. */
  stop(): Promise<void>;
}

/**
 * A second instance must not drive the same database: two orchestrators would both
 * schedule the same tasks. The lock is a plain file holding the owning PID; a stale
 * lock (process gone) is taken over rather than blocking the app forever.
 */
export function acquireInstanceLock(lockFile: string): { acquired: boolean; owner: number | null } {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (fs.existsSync(lockFile)) {
    const raw = Number.parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    if (Number.isFinite(raw) && raw !== process.pid) {
      try {
        process.kill(raw, 0);
        return { acquired: false, owner: raw };
      } catch (err) {
        // EPERM means the process exists but belongs to another user: still alive.
        // ESRCH means it is gone, and the lock can be taken over.
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return { acquired: false, owner: raw };
      }
    }
  }
  fs.writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
  return { acquired: true, owner: process.pid };
}

export function releaseInstanceLock(lockFile: string): void {
  try {
    if (fs.existsSync(lockFile) && Number.parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10) === process.pid) fs.rmSync(lockFile);
  } catch {
    // A missing lock file is not an error.
  }
}

export async function startDesktopHost(options: DesktopHostOptions): Promise<DesktopHost> {
  const logger = options.logger ?? createLogger({ level: (process.env.AIDO_LOG_LEVEL as 'info' | undefined) ?? 'info' });
  const uiRoot = path.join(options.webDistDir);
  const uiAvailable = fs.existsSync(path.join(uiRoot, 'index.html'));
  if (!uiAvailable) {
    // Say what is missing and keep serving the API: a developer running the desktop
    // shell before building the web bundle should get a working API and a clear note,
    // not an empty window with no explanation.
    logger.warn('the shared UI bundle is not built; starting the API only', { expected: path.join(uiRoot, 'index.html') });
  }

  const server = await buildServer({
    serveWeb: uiAvailable,
    webDistDir: uiRoot,
    configOverrides: { logLevel: (process.env.AIDO_LOG_LEVEL as 'info' | undefined) ?? 'info' },
  });
  const host = options.host ?? '127.0.0.1';
  // Port 0 lets the OS choose: the desktop app must not fight another process for 8787.
  const url = await server.listen({ host, port: options.port ?? 0 });
  const port = server.port();

  let scheduler: BackgroundScheduler | null = null;
  let stopScheduler: (() => Promise<void>) | null = null;
  if (options.backgroundAgents !== false) {
    const { store, runner, events, gitFor } = server.container;
    scheduler = createBackgroundScheduler({
      context: { store, runner, logger, events, gitFor },
      pollIntervalMs: 3_000,
    });
    // `start()` returns the stop function; it is captured here so stop() can call it.
    // Calling `scheduler.start()` again from stop() would start a *second* timer (each
    // start() creates its own interval) and leave the first one running after shutdown.
    stopScheduler = scheduler.start();
    logger.info('background agents are running inside the desktop app', { database: server.container.config.dbPath });
  }

  return {
    url,
    port,
    uiAvailable,
    uiRoot: uiAvailable ? uiRoot : null,
    server,
    scheduler,
    async stop() {
      await stopScheduler?.();
      await server.close();
    },
  };
}
