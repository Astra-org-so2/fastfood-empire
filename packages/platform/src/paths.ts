import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PathProvider, PlatformId } from './index.js';

/**
 * Where the application keeps its files, per platform convention:
 *   Linux  $XDG_DATA_HOME/aido        (~/.local/share/aido)  and $XDG_CACHE_HOME
 *   macOS  ~/Library/Application Support/AI Dev Orchestrator
 *   Windows %APPDATA%\AI Dev Orchestrator
 *
 * All of these can be overridden by `AIDO_DATA_DIR`, `AIDO_WORKSPACE_ROOT` and
 * `AIDO_CACHE_DIR`, which is what the tests and portable installs use. Directories are
 * created on first access, because a missing data directory should never be the reason
 * a first run fails.
 */
export interface NodePathOptions {
  platform: PlatformId;
  env: NodeJS.ProcessEnv;
  installDir?: string;
}

const APP_DIR_NAME = 'aido';

export function createNodePaths(options: NodePathOptions): PathProvider {
  const { env, platform } = options;
  const home = os.homedir();

  const dataDir =
    env.AIDO_DATA_DIR ??
    (platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'AI Dev Orchestrator')
      : platform === 'win32'
        ? path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'AI Dev Orchestrator')
        : path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), APP_DIR_NAME));

  const cacheDir =
    env.AIDO_CACHE_DIR ??
    (platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'AI Dev Orchestrator')
      : platform === 'win32'
        ? path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'AI Dev Orchestrator', 'Cache')
        : path.join(env.XDG_CACHE_HOME ?? path.join(home, '.cache'), APP_DIR_NAME));

  const workspaceRoot = env.AIDO_WORKSPACE_ROOT ?? path.join(dataDir, 'workspaces');
  const logDir = env.AIDO_LOG_DIR ?? path.join(dataDir, 'logs');
  const installDir = options.installDir ?? env.AIDO_INSTALL_DIR ?? process.cwd();

  const ensure = (dir: string): string => {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  return {
    dataDir: () => ensure(dataDir),
    cacheDir: () => ensure(cacheDir),
    workspaceRoot: () => ensure(workspaceRoot),
    logDir: () => ensure(logDir),
    installDir: () => installDir,
  };
}
