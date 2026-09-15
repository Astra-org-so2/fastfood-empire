import os from 'node:os';
import type { PlatformAdapter, PlatformId, PlatformInfo, ShellKind } from './index.js';
import { createNodePaths } from './paths.js';
import { createNodeNotificationSink } from './notifications.js';
import { createNodeSecretStore } from './secrets.js';
import { createNodeShellIntegration } from './shell.js';
import { createNodeUpdater } from './updater.js';

/**
 * Detects the host and assembles the adapter.
 *
 * The shell is decided from explicit evidence — an Electron environment, or an
 * `AIDO_SHELL` override used by the worker and by tests — never guessed from the
 * presence of a display.
 */
export function detectPlatformInfo(env: NodeJS.ProcessEnv = process.env): PlatformInfo {
  const platform: PlatformId =
    process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'unknown';

  const isElectron = typeof process.versions.electron === 'string';
  const envShell = env.AIDO_SHELL;
  const shell: ShellKind = envShell === 'web' || envShell === 'desktop' || envShell === 'headless' ? envShell : isElectron ? 'desktop' : 'web';

  return {
    platform,
    arch: process.arch,
    shell,
    hostname: os.hostname(),
    isElectron,
    hasWindow: isElectron || shell === 'desktop',
  };
}

export interface CreatePlatformOptions {
  /** Overrides for the desktop shell, which knows its own install directory. */
  installDir?: string;
  version?: string;
  /** Directory holding the update manifest; `null` disables automatic checks. */
  updateFeedUrl?: string | null;
  /** Alias used by callers that think in terms of an update feed URL. */
  feedUrl?: string | null;
  env?: NodeJS.ProcessEnv;
}

/** Builds the adapter for the current process. */
export function createPlatform(options: CreatePlatformOptions = {}): PlatformAdapter {
  const env = options.env ?? process.env;
  const info = detectPlatformInfo(env);
  const paths = createNodePaths({ platform: info.platform, env, installDir: options.installDir });
  const version = options.version ?? env.npm_package_version ?? '0.1.0';

  return {
    info,
    appInfo: {
      name: 'AI Dev Orchestrator',
      version,
      channel: env.NODE_ENV === 'production' ? 'stable' : 'development',
      platform: info,
    },
    paths,
    secrets: createNodeSecretStore({ platform: info.platform, env }),
    notifications: createNodeNotificationSink({ platform: info.platform, env }),
    updater: createNodeUpdater({ platform: info.platform, feedUrl: options.updateFeedUrl ?? options.feedUrl ?? null }),
    shell: createNodeShellIntegration({ platform: info.platform, env }),
  };
}
