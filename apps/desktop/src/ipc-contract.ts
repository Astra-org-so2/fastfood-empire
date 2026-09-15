import { z } from 'zod';
import type { DesktopPlatformInfo, DesktopBridge, UpdateCheckResponse } from '@aido/types';

/**
 * The desktop IPC contract (§54).
 *
 * The renderer is a web page: it must not be able to ask the main process for anything
 * the browser could not ask for, and nothing reaches the OS without passing through
 * this schema. Both sides import the same definitions, so a channel cannot drift.
 *
 * Deliberately absent: a generic "run this command" or "read this file" channel. The
 * renderer's file access goes through the HTTP API's path guard, and shell commands go
 * through the sandbox, because those are the components that validate arguments and
 * record what happened.
 */

export const IPC_CHANNELS = {
  platformInfo: 'aido:platform-info',
  openExternal: 'aido:open-external',
  showInFileManager: 'aido:show-in-file-manager',
  notifyTest: 'aido:notify-test',
  checkUpdates: 'aido:check-updates',
  setBadge: 'aido:set-badge',
  windowControl: 'aido:window-control',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export const OpenExternalRequest = z.object({
  /** Only http(s): a `file:` URL from the renderer must never reach the OS handler. */
  url: z
    .string()
    .max(2_000)
    .refine((value) => /^https?:\/\//i.test(value), 'only http(s) URLs may be opened externally'),
});

export const ShowInFileManagerRequest = z.object({
  /** Absolute path; the main process re-checks it is inside the configured workspace. */
  path: z.string().min(1).max(4_000),
});

export const NotifyTestRequest = z.object({
  title: z.string().min(1).max(120).default('AI Dev Orchestrator'),
  body: z.string().min(1).max(400).default('System notifications are working.'),
});

export const SetBadgeRequest = z.object({ count: z.number().int().min(0).max(9_999) });

export const WindowControlRequest = z.object({ action: z.enum(['minimize', 'maximize', 'close', 'show']) });

export type { DesktopPlatformInfo, DesktopBridge, UpdateCheckResponse };

/** Called in the main process before a path is revealed: it must be inside the workspace. */
export function isWithinRoot(candidate: string, root: string): boolean {
  const normalisedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  return candidate === normalisedRoot || candidate.startsWith(`${normalisedRoot}/`);
}
