import path from 'node:path';
import type { AppSettings } from '@aido/types';
import { createNodePaths, detectPlatformInfo, type ShellKind } from '@aido/platform';
import { env, envInt, envList, loadDotEnv } from './env.js';
import { ensureDir, findRepoRoot, resolveFromRepoRoot } from './paths.js';
import { loadProviderCatalog, type ProviderCatalog } from './provider-catalog.js';
import { defaultAppSettings } from './defaults.js';

export * from './env.js';
export * from './paths.js';
export * from './defaults.js';
export * from './provider-catalog.js';
export * from './settings.js';

export interface AppConfig {
  repoRoot: string;
  /** Shell override, used by the desktop launcher and tests (defaults to detection). */
  shell?: ShellKind;
  dataDir: string;
  dbPath: string;
  masterKeyFile: string;
  providerDir: string;
  webDistDir: string;
  host: string;
  apiPort: number;
  webPort: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  executionMode: 'auto' | 'supervised' | 'manual';
  workspaceRoot: string;
  deniedPaths: string[];
  dotenv: { loaded: string | null; error: string | null };
  defaults: AppSettings;
  /** True when running the bundled production build (serves dist/web). */
  isProduction: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const repoRoot = overrides.repoRoot ?? findRepoRoot();
  const dotenv = loadDotEnv(repoRoot);
  const shell = detectPlatformInfo().shell;

  // A packaged desktop app has no repository checkout to write into, so it stores data
  // in the platform location ($XDG_DATA_HOME/aido on Linux). A checkout keeps using
  // `.data` so development and tests stay self-contained. An explicit AIDO_DATA_DIR
  // always wins — that is what the probes and the packaged launcher use.
  const platformPaths = createNodePaths({ platform: detectPlatformInfo().platform, env: process.env, installDir: repoRoot });
  const configuredDataDir = env('AIDO_DATA_DIR');
  const dataDir =
    overrides.dataDir ??
    (configuredDataDir
      ? resolveFromRepoRoot(configuredDataDir, repoRoot)
      : shell === 'desktop' && env('NODE_ENV') === 'production'
        ? platformPaths.dataDir()
        : resolveFromRepoRoot('.data', repoRoot));
  ensureDir(dataDir);

  const logLevelRaw = env('AIDO_LOG_LEVEL') ?? 'info';
  const logLevel = (['trace', 'debug', 'info', 'warn', 'error'] as const).includes(logLevelRaw as never)
    ? (logLevelRaw as AppConfig['logLevel'])
    : 'info';

  const executionModeRaw = env('AIDO_EXECUTION_MODE') ?? 'supervised';
  const executionMode = (['auto', 'supervised', 'manual'] as const).includes(executionModeRaw as never)
    ? (executionModeRaw as AppConfig['executionMode'])
    : 'supervised';

  const defaults = defaultAppSettings();
  defaults.executionMode = executionMode;
  defaults.sandbox.deniedPaths = envList('AIDO_FS_DENY_PATHS');

  const config: AppConfig = {
    repoRoot,
    dataDir,
    // `AIDO_DATA_DIR` is the storage root, so the database lives inside it unless a
    // fully explicit path is given. (Relying on the repo-relative default here made
    // `AIDO_DATA_DIR` silently ignore the database, which broke test isolation.)
    dbPath: overrides.dbPath ?? resolveFromRepoRoot(env('AIDO_DB_PATH') ?? path.relative(repoRoot, path.join(dataDir, 'aido.db')), repoRoot),
    masterKeyFile: overrides.masterKeyFile ?? path.join(dataDir, 'master.key'),
    providerDir: overrides.providerDir ?? resolveFromRepoRoot(env('AIDO_PROVIDER_DIR') ?? 'config/providers', repoRoot),
    webDistDir: overrides.webDistDir ?? path.join(repoRoot, 'dist', 'web'),
    host: overrides.host ?? env('AIDO_HOST') ?? '0.0.0.0',
    apiPort: overrides.apiPort ?? envInt('AIDO_API_PORT', 8787),
    webPort: overrides.webPort ?? envInt('AIDO_WEB_PORT', 5173),
    logLevel: overrides.logLevel ?? logLevel,
    executionMode: overrides.executionMode ?? executionMode,
    workspaceRoot:
      overrides.workspaceRoot ?? resolveFromRepoRoot(env('AIDO_WORKSPACE_ROOT') ?? defaults.sandbox.workspaceRoot, repoRoot),
    deniedPaths: overrides.deniedPaths ?? envList('AIDO_FS_DENY_PATHS'),
    dotenv,
    defaults,
    isProduction: overrides.isProduction ?? env('NODE_ENV') === 'production',
    shell: overrides.shell ?? shell,
  };

  return config;
}

/** Loads provider definitions, optionally layering DB overrides (see ProviderRegistry). */
export function loadProviders(
  config: AppConfig,
  options: { overrides?: import('./provider-catalog.js').ProviderOverride[]; logger?: { warn: (m: string, meta?: Record<string, unknown>) => void } } = {},
): ProviderCatalog {
  return loadProviderCatalog({ dir: config.providerDir, overrides: options.overrides, logger: options.logger });
}
