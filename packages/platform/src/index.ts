/**
 * Platform abstraction (§54).
 *
 * The product is one application with several shells: a browser (web), an Electron
 * desktop app on Linux, and a headless worker. Everything that differs between those
 * shells — where the data lives, where a secret is stored, how a notification is
 * shown, how the app updates — sits behind the interfaces in this package. No other
 * package may branch on `process.platform` (or on `process.versions.electron`) for
 * these concerns; if a new platform needs different behaviour, it implements these
 * interfaces and nothing else changes.
 *
 * Every capability reports what it can actually do (`supported`, `kind`, `degraded`)
 * rather than pretending: a Linux box without `secret-tool` says "encrypted file",
 * and an update check that cannot reach the network says so instead of showing
 * "up to date".
 */

export type PlatformId = 'linux' | 'darwin' | 'win32' | 'unknown';

export type ShellKind = 'web' | 'desktop' | 'headless';

export interface PlatformInfo {
  platform: PlatformId;
  arch: string;
  shell: ShellKind;
  /** Display name of the host, for diagnostics. */
  hostname: string;
  /** True when the process is the Electron main process. */
  isElectron: boolean;
  /** True when a real window is available (desktop shell only). */
  hasWindow: boolean;
}

// ---------------------------------------------------------------------------
// Secret storage
// ---------------------------------------------------------------------------

export type SecretStoreKind = 'os-keyring' | 'encrypted-file' | 'in-memory';

export interface SecretStoreInfo {
  kind: SecretStoreKind;
  /** Whether secrets survive a restart. */
  persistent: boolean;
  /** Whether an OS facility (Keychain / Secret Service / DPAPI) backs the store. */
  osBacked: boolean;
  detail: string;
}

/**
 * Stores provider credentials. Implementations must never return a secret to a
 * caller that only asked for metadata, and must never log a secret value.
 */
export interface SecretStore {
  info(): SecretStoreInfo;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<{ key: string; fingerprint: string }[]>;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface PathProvider {
  /** Directory for the database, logs and the master key. */
  dataDir(): string;
  /** Directory for caches that can be deleted safely. */
  cacheDir(): string;
  /** Directory for generated project workspaces. */
  workspaceRoot(): string;
  /** Directory for logs. */
  logDir(): string;
  /** Where the app is installed / unpacked. */
  installDir(): string;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationRequest {
  title: string;
  body: string;
  /** Coarse importance; the OS decides the presentation. */
  urgency?: 'low' | 'normal' | 'critical';
  /** Grouping key so repeated messages about one project collapse. */
  tag?: string;
}

export interface NotificationResult {
  delivered: boolean;
  /** Why it was not delivered, when it was not. */
  reason?: string;
}

export interface NotificationSink {
  supported(): boolean;
  notify(request: NotificationRequest): Promise<NotificationResult>;
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export interface UpdateManifest {
  version: string;
  notes: string;
  /** Direct download URLs per artefact, keyed by format (`deb`, `AppImage`). */
  artifacts: Record<string, string>;
  publishedAt: string;
}

export interface UpdateCheckResult {
  /** 'unsupported' when this install cannot be updated automatically. */
  status: 'up-to-date' | 'update-available' | 'unsupported' | 'check-failed';
  currentVersion: string;
  latest?: UpdateManifest;
  /** Instructions the UI shows when automatic update is not available. */
  instructions: string;
  error?: string;
}

export interface Updater {
  /** Where this install should look for updates, if it can. */
  feedUrl(): string | null;
  check(currentVersion: string): Promise<UpdateCheckResult>;
}

// ---------------------------------------------------------------------------
// Shell integration
// ---------------------------------------------------------------------------

export interface ShellIntegration {
  /** Opens a URL in the user's browser. */
  openExternal(url: string): Promise<boolean>;
  /** Reveals a path in the file manager. */
  showInFileManager(path: string): Promise<boolean>;
  /** Opens a terminal at a path, when the platform supports it. */
  openTerminal(path: string): Promise<{ opened: boolean; reason?: string }>;
  /** Native title/dock badge; a no-op in the browser. */
  setBadge(count: number): void;
}

// ---------------------------------------------------------------------------
// App info
// ---------------------------------------------------------------------------

export interface AppInfo {
  name: string;
  version: string;
  channel: 'development' | 'stable';
  platform: PlatformInfo;
}

export interface PlatformAdapter {
  info: PlatformInfo;
  appInfo: AppInfo;
  paths: PathProvider;
  secrets: SecretStore;
  notifications: NotificationSink;
  updater: Updater;
  shell: ShellIntegration;
}

export * from './detect.js';
export * from './paths.js';
export * from './notifications.js';
export * from './updater.js';
export * from './shell.js';
export * from './secrets.js';
export * from './notify-bridge.js';
