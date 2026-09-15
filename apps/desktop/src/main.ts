/**
 * Electron main process (§54).
 *
 * Thin on purpose: the API server, the background agents and the platform adapter all
 * live in `host.ts` and `@aido/platform`, so this file only deals with Electron —
 * the window, the single-instance lock, the IPC handlers and the shutdown sequence.
 *
 * Security posture:
 *   - the renderer is sandboxed with context isolation and no Node integration;
 *   - the window loads the local API origin only, on a loopback address and an
 *     OS-assigned port;
 *   - navigation and `window.open` are denied for anything that is not that origin,
 *     and external links are handed to the OS browser explicitly;
 *   - every IPC payload is validated against the shared schema before it does anything.
 */
import path from 'node:path';
import { acquireInstanceLock, releaseInstanceLock, startDesktopHost, type DesktopHost } from './host.js';
import { IPC_CHANNELS, NotifyTestRequest, OpenExternalRequest, SetBadgeRequest, ShowInFileManagerRequest, WindowControlRequest, isWithinRoot, type DesktopPlatformInfo, type UpdateCheckResponse } from './ipc-contract.js';
import { loadElectron, type ElectronBrowserWindow, type ElectronModule } from './electron-runtime.js';

/**
 * The directory the app was launched from.
 *
 * Electron exposes this as `app.getAppPath()`. It is wrapped because the desktop shell can
 * also run against a stubbed Electron (tests, and the `AIDO_WEB_DIST` override path), where
 * the accessor may be missing.
 */
function safeAppPath(instance: { getAppPath?(): string }): string {
  try {
    return instance.getAppPath?.() ?? process.cwd();
  } catch {
    return process.cwd();
  }
}

const DATA_DIR = process.env.AIDO_DATA_DIR ?? path.join(process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? process.cwd(), '.local', 'share'), 'aido');
const LOCK_FILE = path.join(DATA_DIR, 'app.lock');

async function main(): Promise<void> {
  const electron: ElectronModule = await loadElectron();
  const { app, BrowserWindow, ipcMain } = electron;

  // Two instances must not drive the same database; Electron's own lock gives a nice
  // "focus the existing window" behaviour, the file lock guards non-Electron launches.
  const singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
    return;
  }
  const fileLock = acquireInstanceLock(LOCK_FILE);
  if (!fileLock.acquired) {
    // Another process owns the database. Exit loudly instead of corrupting state.
    process.stderr.write(`AI Dev Orchestrator is already running (pid ${fileLock.owner}).\n`);
    app.exit(1);
    return;
  }

  app.setAppUserModelId('org.aido.orchestrator');
  await app.whenReady();

  let host: DesktopHost;
  try {
    host = await startDesktopHost({
      // `getAppPath()` is a property-style accessor in Electron; `getPath('appPath')` is not
      // a valid name for `getPath` and returns undefined, which would silently fall back to
      // the working directory and miss the bundled UI.
      webDistDir: process.env.AIDO_WEB_DIST ?? path.join(safeAppPath(app), 'dist', 'web'),
      backgroundAgents: true,
      lockFile: LOCK_FILE,
    });
  } catch (err) {
    // A startup failure must be visible: a silent exit leaves the user with nothing.
    process.stderr.write(`Failed to start the local API: ${err instanceof Error ? err.message : String(err)}\n`);
    electron.dialog
      ?.showMessageBox({ type: 'error', title: 'AI Dev Orchestrator', message: 'The local API could not start.', detail: err instanceof Error ? err.message : String(err) })
      .catch(() => undefined);
    releaseInstanceLock(LOCK_FILE);
    app.exit(1);
    return;
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1_020,
    minHeight: 680,
    backgroundColor: '#0b0d10',
    show: false,
    title: 'AI Dev Orchestrator',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(safeAppPath(app), 'dist', 'desktop', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  // Shown after the renderer has painted: showing earlier flashes a white window.
  window.once('ready-to-show', () => window.show());

  const allowedOrigin = host.url;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(allowedOrigin)) void electron.shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event: unknown, url: unknown) => {
    if (typeof url === 'string' && !url.startsWith(allowedOrigin)) {
      const target = event as { preventDefault?: () => void };
      target.preventDefault?.();
      if (/^https?:\/\//i.test(url)) void electron.shell.openExternal(url);
    }
  });

  await window.loadURL(host.url);
  if (host.uiAvailable) {
    // The window is the shared UI bundle, served by the in-process API.
  } else {
    process.stderr.write(`The web bundle was not found at ${String(host.uiRoot)}; the window will show the API's plain-text fallback.\n`);
  }

  registerIpc(ipcMain, electron, host, window);

  app.on('window-all-closed', () => {
    void shutdown(host, app);
  });
  app.on('before-quit', () => {
    releaseInstanceLock(LOCK_FILE);
  });
  process.on('SIGINT', () => void shutdown(host, app));
  process.on('SIGTERM', () => void shutdown(host, app));
}

function platformInfoFor(electron: ElectronModule, host: DesktopHost): DesktopPlatformInfo {
  return {
    shell: 'desktop',
    platform: process.platform,
    arch: process.arch,
    appVersion: electron.app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    apiUrl: host.url,
    dataDir: process.env.AIDO_DATA_DIR ?? host.server.container.config.dataDir,
    workspaceRoot: host.server.container.config.workspaceRoot,
    uiRoot: host.uiRoot,
    notificationsSupported: host.server.container.platform.notifications.supported(),
    updateFeedUrl: host.server.container.platform.updater.feedUrl(),
    singleInstance: true,
  };
}

function registerIpc(ipcMain: ElectronModule['ipcMain'], electron: ElectronModule, host: DesktopHost, window: ElectronBrowserWindow): void {
  ipcMain.handle(IPC_CHANNELS.platformInfo, () => platformInfoFor(electron, host));

  ipcMain.handle(IPC_CHANNELS.openExternal, async (_event, raw) => {
    const parsed = OpenExternalRequest.safeParse(raw);
    if (!parsed.success) return { opened: false, reason: parsed.error.issues[0]?.message ?? 'invalid request' };
    try {
      await electron.shell.openExternal(parsed.data.url);
      return { opened: true };
    } catch (err) {
      return { opened: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.showInFileManager, (_event, raw) => {
    const parsed = ShowInFileManagerRequest.safeParse(raw);
    if (!parsed.success) return { revealed: false, reason: 'invalid request' };
    // The renderer may not ask to reveal anything outside the project workspaces: that
    // would turn a UI helper into a filesystem probe.
    if (!isWithinRoot(parsed.data.path, host.server.container.config.workspaceRoot)) {
      return { revealed: false, reason: 'path is outside the project workspace root' };
    }
    electron.shell.showItemInFolder(parsed.data.path);
    return { revealed: true };
  });

  ipcMain.handle(IPC_CHANNELS.notifyTest, async (_event, raw) => {
    const parsed = NotifyTestRequest.safeParse(raw ?? {});
    if (!parsed.success) return { delivered: false, reason: 'invalid request' };
    return host.server.container.platform.notifications.notify(parsed.data);
  });

  ipcMain.handle(IPC_CHANNELS.checkUpdates, async (): Promise<UpdateCheckResponse> => {
    const result = await host.server.container.platform.updater.check(host.server.container.version);
    return {
      status: result.status,
      currentVersion: result.currentVersion,
      instructions: result.instructions,
      ...(result.latest ? { latestVersion: result.latest.version } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  });

  ipcMain.handle(IPC_CHANNELS.setBadge, (_event, raw) => {
    const parsed = SetBadgeRequest.safeParse(raw);
    if (!parsed.success) return;
    electron.app.setBadgeCount?.(parsed.data.count);
    host.server.container.platform.shell.setBadge(parsed.data.count);
  });

  ipcMain.handle(IPC_CHANNELS.windowControl, (_event, raw) => {
    const parsed = WindowControlRequest.safeParse(raw);
    if (!parsed.success) return;
    switch (parsed.data.action) {
      case 'minimize':
        window.minimize();
        break;
      case 'maximize':
        window.maximize();
        break;
      case 'show':
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        break;
      case 'close':
        window.close();
        break;
    }
  });
}

async function shutdown(host: DesktopHost, app: ElectronModule['app']): Promise<void> {
  try {
    await host.stop();
  } finally {
    releaseInstanceLock(LOCK_FILE);
    app.quit();
  }
}

void main().catch((err: unknown) => {
  process.stderr.write(`AI Dev Orchestrator failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
