import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { PlatformId, ShellIntegration } from './index.js';

/**
 * Desktop shell integration: opening links, revealing files, opening a terminal.
 *
 * Each command is launched directly (never through a shell) with an argument array, so
 * a path containing `;` or `$()` cannot turn into command execution. Paths are checked
 * for existence first, because `xdg-open` on a missing path either fails silently or
 * opens the file manager at an unrelated location.
 */
export interface NodeShellOptions {
  platform: PlatformId;
  env: NodeJS.ProcessEnv;
}

export interface NodeShellIntegration extends ShellIntegration {
  /** Current badge count, for a desktop shell that has a dock/tray. */
  badge(): number;
}

export function createNodeShellIntegration(options: NodeShellOptions): NodeShellIntegration {
  const { platform, env } = options;

  const run = (command: string, args: string[]): Promise<boolean> =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: 10_000 }, (error) => resolve(!error));
    });

  const openExternal = async (url: string): Promise<boolean> => {
    // Only ever hand a URL to the OS; no other scheme handling happens here.
    if (!/^https?:\/\//i.test(url)) return false;
    if (platform === 'darwin') return run('open', [url]);
    if (platform === 'win32') return run('cmd', ['/c', 'start', '', url]);
    return run(env.AIDO_OPEN_COMMAND ?? 'xdg-open', [url]);
  };

  const showInFileManager = async (target: string): Promise<boolean> => {
    if (!fs.existsSync(target)) return false;
    if (platform === 'darwin') return run('open', ['-R', target]);
    if (platform === 'win32') return run('explorer', [target]);
    return run(env.AIDO_OPEN_COMMAND ?? 'xdg-open', [fs.statSync(target).isDirectory() ? target : path.dirname(target)]);
  };

  const openTerminal = async (cwd: string): Promise<{ opened: boolean; reason?: string }> => {
    if (!fs.existsSync(cwd)) return { opened: false, reason: `Directory ${cwd} does not exist.` };
    if (platform === 'linux') {
      const candidates = [
        { command: env.AIDO_TERMINAL ?? 'x-terminal-emulator', args: [`--working-directory=${cwd}`] },
        { command: 'gnome-terminal', args: [`--working-directory=${cwd}`] },
        { command: 'konsole', args: ['--workdir', cwd] },
        { command: 'xfce4-terminal', args: [`--working-directory=${cwd}`] },
        { command: 'xterm', args: [] },
      ];
      for (const candidate of candidates) {
        if (await run(candidate.command, candidate.args)) return { opened: true };
      }
      return { opened: false, reason: 'No supported terminal emulator was found (tried x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, xterm).' };
    }
    if (platform === 'darwin') {
      return (await run('open', ['-a', 'Terminal', cwd])) ? { opened: true } : { opened: false, reason: 'Could not launch Terminal.' };
    }
    return { opened: false, reason: `Opening a terminal is not implemented for ${platform} yet.` };
  };

  let badgeCount = 0;
  return {
    openExternal,
    showInFileManager,
    openTerminal,
    setBadge(count: number) {
      // In the browser and the worker there is no dock or tray badge. The value is kept
      // so a desktop shell can read it on its next tick.
      badgeCount = count;
    },
    badge: () => badgeCount,
  };
}
