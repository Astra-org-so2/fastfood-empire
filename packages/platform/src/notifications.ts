import { execFile } from 'node:child_process';
import type { NotificationResult, NotificationSink, PlatformId } from './index.js';

/**
 * System notifications.
 *
 * On Linux the freedesktop notification daemon is used through `notify-send`, which is
 * present on GNOME, KDE, XFCE and most other desktops. Where the command is missing
 * (a container, a headless server, a minimal install) `supported()` returns false and
 * `notify()` explains why — the UI then keeps the in-app notification centre as the
 * only channel rather than silently dropping messages.
 *
 * A missing notification daemon must never fail an agent run, so delivery errors are
 * reported, not thrown.
 */
export interface NodeNotificationOptions {
  platform: PlatformId;
  env: NodeJS.ProcessEnv;
  /** Overrides for tests: pretend the platform does or does not support notifications. */
  supportedOverride?: boolean;
}

export function createNodeNotificationSink(options: NodeNotificationOptions): NotificationSink {
  const supported = options.supportedOverride ?? options.platform === 'linux';
  const command = options.env.AIDO_NOTIFY_COMMAND ?? 'notify-send';

  const send = (args: string[]): Promise<NotificationResult> =>
    new Promise((resolve) => {
      execFile(command, args, { timeout: 5_000 }, (error) => {
        if (error) {
          resolve({ delivered: false, reason: `notification command failed: ${error.message}` });
          return;
        }
        resolve({ delivered: true });
      });
    });

  return {
    supported: () => supported,
    async notify(request) {
      if (!supported) {
        return { delivered: false, reason: `System notifications are not implemented for ${options.platform} yet; the in-app activity feed still shows this event.` };
      }
      const args = ['--app-name', 'AI Dev Orchestrator'];
      if (request.urgency) args.push('--urgency', request.urgency);
      if (request.tag) args.push('--hint', `string:x-canonical-private-synchronous:${request.tag}`);
      args.push(request.title, request.body);
      return send(args);
    },
  };
}
