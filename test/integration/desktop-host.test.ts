import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, releaseInstanceLock, startDesktopHost, type DesktopHost } from '../../apps/desktop/src/host.js';
import { IPC_CHANNELS, OpenExternalRequest, SetBadgeRequest, ShowInFileManagerRequest, WindowControlRequest, isWithinRoot } from '../../apps/desktop/src/ipc-contract.js';

/**
 * The desktop shell host (§54).
 *
 * Everything the Electron app does except drawing the window is exercised here against
 * a real API server: the window would only add a renderer, so if these pass, the
 * remaining failure modes are Electron-specific and reported explicitly at startup.
 */
describe('desktop host', () => {
  let root: string;
  let host: DesktopHost | null = null;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'aido-desktop-'));
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html><title>AI Dev Orchestrator</title>');
    previousEnv = { ...process.env };
    process.env.AIDO_DATA_DIR = path.join(root, 'data');
    process.env.AIDO_WORKSPACE_ROOT = path.join(root, 'workspaces');
    process.env.AIDO_PROVIDER_DIR = path.join(process.cwd(), 'config/providers');
    process.env.AIDO_SHELL = 'desktop';
    process.env.AIDO_LOG_LEVEL = 'error';
  });

  afterEach(async () => {
    if (host) await host.stop();
    host = null;
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the shared UI bundle and the API on a loopback, OS-assigned port', async () => {
    host = await startDesktopHost({ webDistDir: path.join(root, 'web'), backgroundAgents: false, port: 0 });
    expect(host.uiAvailable).toBe(true);
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(host.port).toBeGreaterThan(1024);

    const page = await fetch(`${host.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('AI Dev Orchestrator');

    // The client-side router must keep working on a deep link (SPA fallback).
    const deepLink = await fetch(`${host.url}/projects/whatever`);
    expect(deepLink.status).toBe(200);

    const ping = await fetch(`${host.url}/api/ping`);
    expect(ping.status).toBe(200);

    const platform = (await (await fetch(`${host.url}/api/platform`)).json()) as {
      info: { shell: string; platform: string; arch: string };
      paths: { dataDir: string; databaseFile: string; workspaceRoot: string };
      secrets: { shellStore: { kind: string; persistent: boolean }; credentialVault: { source: string } };
      notifications: { supported: boolean };
      updates: { feedUrl: string | null; currentVersion: string };
    };
    expect(platform.info.shell).toBe('desktop');
    expect(platform.paths.dataDir).toBe(path.join(root, 'data'));
    expect(platform.paths.databaseFile).toBe(path.join(root, 'data', 'aido.db'));
    // The report must be honest about where secrets live, whatever this machine has.
    expect(['os-keyring', 'encrypted-file', 'in-memory']).toContain(platform.secrets.shellStore.kind);
    expect(typeof platform.secrets.shellStore.persistent).toBe('boolean');
    expect(platform.secrets.credentialVault.source).toMatch(/env|file/);
    expect(platform.updates.feedUrl).toBeNull();
  }, 60_000);

  it('reports a missing UI bundle instead of serving an empty window', async () => {
    host = await startDesktopHost({ webDistDir: path.join(root, 'nope'), backgroundAgents: false, port: 0 });
    expect(host.uiAvailable).toBe(false);
    expect(host.uiRoot).toBeNull();
    // The API still works, and the browser gets an explanation rather than a blank page.
    expect((await fetch(`${host.url}/api/ping`)).status).toBe(200);
    const page = await fetch(`${host.url}/`);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain('Web UI is not built');
  }, 60_000);

  it('checks the update feed through the shared updater', async () => {
    host = await startDesktopHost({ webDistDir: path.join(root, 'web'), backgroundAgents: false, port: 0 });
    const updates = (await (await fetch(`${host.url}/api/platform/updates`)).json()) as { status: string; instructions: string };
    expect(updates.status).toBe('unsupported');
    expect(updates.instructions).toMatch(/\.deb|AppImage/);
  }, 60_000);

  it('prevents a second instance from driving the same database', () => {
    const lockFile = path.join(root, 'data', 'app.lock');
    expect(acquireInstanceLock(lockFile).acquired).toBe(true);
    // Re-acquiring inside the owning process is a no-op, so a restart path cannot
    // deadlock on its own lock file.
    expect(acquireInstanceLock(lockFile).acquired).toBe(true);

    // A foreign, live owner refuses the lock: this is the second-instance case.
    fs.writeFileSync(lockFile, '1');
    const second = acquireInstanceLock(lockFile);
    expect(second.acquired).toBe(false);
    expect(second.owner).toBe(1);

    // A stale lock (dead pid) is taken over rather than blocking the app forever.
    fs.writeFileSync(lockFile, '999999');
    expect(acquireInstanceLock(lockFile).acquired).toBe(true);
    releaseInstanceLock(lockFile);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('validates every IPC payload and refuses to touch paths outside the workspace', () => {
    expect(Object.values(IPC_CHANNELS).every((channel) => channel.startsWith('aido:'))).toBe(true);
    expect(OpenExternalRequest.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(OpenExternalRequest.safeParse({ url: 'https://example.com/docs' }).success).toBe(true);
    expect(ShowInFileManagerRequest.safeParse({ path: '' }).success).toBe(false);
    expect(SetBadgeRequest.safeParse({ count: -1 }).success).toBe(false);
    expect(SetBadgeRequest.safeParse({ count: 3 }).success).toBe(true);
    expect(WindowControlRequest.safeParse({ action: 'rm -rf /' }).success).toBe(false);
    expect(isWithinRoot('/home/me/.local/share/aido/workspaces/p/src', '/home/me/.local/share/aido/workspaces')).toBe(true);
    // A sibling directory that merely shares a prefix is not inside the root.
    expect(isWithinRoot('/home/me/.local/share/aido/workspaces-evil/x', '/home/me/.local/share/aido/workspaces')).toBe(false);
  });
});
