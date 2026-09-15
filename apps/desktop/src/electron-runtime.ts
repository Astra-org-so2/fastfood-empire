/**
 * The Electron surface this app uses, declared locally.
 *
 * `electron` is a native dependency that is only installed for desktop builds, so the
 * main suite must typecheck without it. `loadElectron()` therefore imports it through a
 * non-literal specifier (no module resolution at build time) and validates the shape at
 * runtime: if the installed Electron ever stops providing one of these members, the app
 * says exactly which one instead of failing with a stack trace somewhere unrelated.
 */

export interface ElectronWebPreferences {
  preload?: string;
  contextIsolation?: boolean;
  nodeIntegration?: boolean;
  sandbox?: boolean;
  webSecurity?: boolean;
  allowRunningInsecureContent?: boolean;
  spellcheck?: boolean;
}

export interface ElectronBrowserWindow {
  loadURL(url: string): Promise<void>;
  loadFile(file: string): Promise<void>;
  show(): void;
  focus(): void;
  minimize(): void;
  maximize(): void;
  close(): void;
  isMinimized(): boolean;
  restore(): void;
  isDestroyed(): boolean;
  destroy(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  webContents: {
    setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
    send(channel: string, ...args: unknown[]): void;
    openDevTools(options?: { mode?: string }): void;
  };
}

export interface ElectronApp {
  whenReady(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  quit(): void;
  exit(code?: number): void;
  getVersion(): string;
  getName(): string;
  getPath(name: string): string;
  /** Electron's app directory. Optional because a partially-mocked Electron may omit it. */
  getAppPath?(): string;
  setAppUserModelId(id: string): void;
  requestSingleInstanceLock(): boolean;
  setBadgeCount?(count: number): boolean;
}

export interface ElectronIpcMain {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface ElectronShell {
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): void;
}

export interface ElectronNotificationConstructor {
  isSupported(): boolean;
  new (options: { title: string; body: string; urgency?: string; silent?: boolean }): {
    show(): void;
    on(event: string, listener: (...args: unknown[]) => void): void;
  };
}

export interface ElectronModule {
  app: ElectronApp;
  BrowserWindow: new (options: Record<string, unknown>) => ElectronBrowserWindow;
  ipcMain: ElectronIpcMain;
  shell: ElectronShell;
  Notification: ElectronNotificationConstructor;
  dialog?: { showMessageBox(options: Record<string, unknown>): Promise<{ response: number }> };
}

const REQUIRED_MEMBERS: (keyof ElectronModule)[] = ['app', 'BrowserWindow', 'ipcMain', 'shell', 'Notification'];

/** Throws with a precise message when an expected Electron member is missing. */
export function assertElectronShape(candidate: unknown): ElectronModule {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('The electron module did not load. Install it with `npm install --workspace apps/desktop`.');
  }
  const missing = REQUIRED_MEMBERS.filter((member) => (candidate as Record<string, unknown>)[member] === undefined);
  if (missing.length) {
    throw new Error(`The installed Electron build does not provide: ${missing.join(', ')}. Update apps/desktop/package.json.`);
  }
  return candidate as ElectronModule;
}

/**
 * Loads Electron without a static import, so the rest of the repository typechecks and
 * runs without the native dependency present.
 */
export async function loadElectron(specifier = 'electron'): Promise<ElectronModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  try {
    return assertElectronShape(await dynamicImport(specifier));
  } catch (err) {
    throw new Error(`Electron is unavailable (${err instanceof Error ? err.message : String(err)}).`);
  }
}
