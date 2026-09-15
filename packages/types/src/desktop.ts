/**
 * Desktop shell contract (§54).
 *
 * Declared here, in the shared types package, because two sides need it: the Electron
 * preload script that exposes it, and the web UI that detects it at runtime to enable
 * desktop-only affordances ("reveal in file manager", "open terminal", notifications
 * test, update check). The browser build simply finds `window.aido` undefined.
 */

export interface DesktopPlatformInfo {
  shell: 'desktop';
  platform: string;
  arch: string;
  appVersion: string;
  electronVersion: string;
  chromeVersion: string;
  /** Loopback URL of the in-process API. */
  apiUrl: string;
  dataDir: string;
  workspaceRoot: string;
  uiRoot: string | null;
  notificationsSupported: boolean;
  updateFeedUrl: string | null;
  singleInstance: boolean;
}

export interface UpdateCheckResponse {
  status: 'up-to-date' | 'update-available' | 'unsupported' | 'check-failed';
  currentVersion: string;
  /** Plain instructions shown to the operator; never a silent install. */
  instructions: string;
  latestVersion?: string;
  error?: string;
}

export interface DesktopBridge {
  getPlatformInfo(): Promise<DesktopPlatformInfo>;
  openExternal(request: { url: string }): Promise<{ opened: boolean; reason?: string }>;
  showInFileManager(request: { path: string }): Promise<{ revealed: boolean; reason?: string }>;
  notifyTest(request: { title?: string; body?: string }): Promise<{ delivered: boolean; reason?: string }>;
  checkUpdates(): Promise<UpdateCheckResponse>;
  setBadge(request: { count: number }): Promise<void>;
  windowControl(request: { action: 'minimize' | 'maximize' | 'close' | 'show' }): Promise<void>;
}

declare global {
  interface Window {
    /** Present only when the UI is running inside the desktop shell. */
    aido?: DesktopBridge;
  }
}
