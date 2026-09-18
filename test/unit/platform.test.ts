import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, createLogger } from '@aido/observability';
import {
  attachNotificationBridge,
  compareVersions,
  createNodeNotificationSink,
  createNodePaths,
  createNodeSecretStore,
  createNodeShellIntegration,
  createNodeUpdater,
  detectPlatformInfo,
  updateInstructions,
} from '@aido/platform';

/**
 * Platform layer (§54): the interfaces every shell shares.
 *
 * These tests assert the honest-reporting rules as much as the happy paths: an
 * environment without a keyring, notifications or an update feed must say so rather
 * than pretend the capability exists.
 */
describe('platform abstraction', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'aido-platform-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('follows XDG paths and honours the explicit overrides', () => {
    const paths = createNodePaths({
      platform: 'linux',
      env: { XDG_DATA_HOME: path.join(dir, 'data'), XDG_CACHE_HOME: path.join(dir, 'cache'), AIDO_WORKSPACE_ROOT: path.join(dir, 'ws') },
    });
    expect(paths.dataDir()).toBe(path.join(dir, 'data', 'aido'));
    expect(paths.cacheDir()).toBe(path.join(dir, 'cache', 'aido'));
    expect(paths.workspaceRoot()).toBe(path.join(dir, 'ws'));
    // Directories are created on access: a missing data directory never breaks startup.
    expect(statSync(paths.logDir()).isDirectory()).toBe(true);
  });

  it('uses the platform data directory for macOS and Windows conventions', () => {
    const mac = createNodePaths({ platform: 'darwin', env: { HOME: dir } });
    expect(mac.dataDir()).toContain(path.join('Library', 'Application Support'));
    const win = createNodePaths({ platform: 'win32', env: { USERPROFILE: dir, APPDATA: path.join(dir, 'Roaming') } });
    expect(win.dataDir()).toContain(path.join('Roaming', 'AI Dev Orchestrator'));
  });

  it('detects the shell from explicit evidence, not from a guess', () => {
    expect(detectPlatformInfo({ AIDO_SHELL: 'desktop' }).shell).toBe('desktop');
    expect(detectPlatformInfo({ AIDO_SHELL: 'headless' }).shell).toBe('headless');
    expect(detectPlatformInfo({}).isElectron).toBe(false);
  });

  it('encrypts shell secrets at rest and never stores them in clear text', async () => {
    const store = createNodeSecretStore({ platform: 'linux', env: { AIDO_SECRET_DIR: dir }, forceKind: 'encrypted-file' });
    expect(store.info()).toMatchObject({ kind: 'encrypted-file', persistent: true, osBacked: false });

    await store.set('updateToken', 'super-secret-value');
    const raw = readFileSync(path.join(dir, 'shell-secrets.json'), 'utf8');
    expect(raw).not.toContain('super-secret-value');
    expect(await store.get('updateToken')).toBe('super-secret-value');

    expect(await store.delete('updateToken')).toBe(true);
    expect(await store.get('updateToken')).toBeNull();
    // The key file is not world readable.
    expect(statSync(path.join(dir, 'shell-secrets.key')).mode & 0o077).toBe(0);
  });

  it('reports a non-persistent store instead of silently dropping secrets', async () => {
    const store = createNodeSecretStore({ platform: 'linux', env: { AIDO_SECRET_DIR: dir }, forceKind: 'in-memory' });
    expect(store.info().persistent).toBe(false);
    expect(store.info().detail).toMatch(/lost when the process exits/);
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
  });

  it('reports notifications as unavailable when the platform cannot deliver them', async () => {
    const sink = createNodeNotificationSink({ platform: 'linux', env: {}, supportedOverride: false });
    expect(sink.supported()).toBe(false);
    const result = await sink.notify({ title: 'x', body: 'y' });
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/not implemented|unavailable/i);
  });

  it('compares versions and never claims an update it cannot install', async () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0-beta.1', '1.2.0')).toBe(-1);

    const updater = createNodeUpdater({ platform: 'linux', feedUrl: null });
    const unsupported = await updater.check('1.0.0');
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported.instructions).toContain('.deb');

    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({ version: '1.1.0', notes: 'Fixes', artifacts: { deb: 'https://example.invalid/aido.deb' }, publishedAt: new Date().toISOString() }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    const updater2 = createNodeUpdater({ platform: 'linux', feedUrl: 'https://example.invalid/update.json', fetchImpl: fakeFetch });
    const available = await updater2.check('1.0.0');
    expect(available.status).toBe('update-available');
    expect(available.instructions).toContain('apt install --reinstall');
    expect(updateInstructions('linux', null)).toMatch(/replacing the .deb/);
  });

  it('reports a failed update check rather than "up to date"', async () => {
    const failing = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    const updater = createNodeUpdater({ platform: 'linux', feedUrl: 'https://example.invalid/update.json', fetchImpl: failing });
    const result = await updater.check('1.0.0');
    expect(result.status).toBe('check-failed');
    expect(result.error).toContain('503');
  });

  it('refuses to open non-http URLs or reveal paths that do not exist', async () => {
    const shell = createNodeShellIntegration({ platform: 'linux', env: {} });
    expect(await shell.openExternal('file:///etc/passwd')).toBe(false);
    expect(await shell.showInFileManager(path.join(dir, 'missing'))).toBe(false);
    const terminal = await shell.openTerminal(path.join(dir, 'missing'));
    expect(terminal.opened).toBe(false);
    expect(terminal.reason).toMatch(/does not exist/);
    shell.setBadge(3);
    expect(shell.badge()).toBe(3);
  });

  it('forwards only human-relevant events to notifications, with a cooldown', async () => {
    const events = new EventBus({ logger: createLogger({ level: 'error' }) });
    const sent: { title: string; body: string }[] = [];
    // A controllable clock: the cooldown is measured against real time passing, so a
    // frozen small timestamp would make the first notification look suppressed.
    let clock = 1_000_000;
    const bridge = attachNotificationBridge({
      events,
      sink: {
        supported: () => true,
        notify: async (request) => {
          sent.push({ title: request.title, body: request.body });
          return { delivered: true };
        },
      },
      logger: createLogger({ level: 'error' }),
      cooldownMs: 60_000,
      now: () => clock,
    });

    events.emit('task.started', {}, { message: 'debug noise', severity: 'info' });
    events.emit('system.notice', { phase: 'x' }, { message: 'informational', severity: 'info' });
    events.emit('approval.requested', { approvalId: 'a1' }, { message: 'Deleting 12 files', severity: 'warning' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Approval required');

    // A second approval inside the cooldown window is collapsed.
    events.emit('approval.requested', { approvalId: 'a2' }, { message: 'Another risky action', severity: 'warning' });
    expect(sent).toHaveLength(1);
    expect(bridge.stats().suppressed).toBe(1);

    // Outside the cooldown window the next approval is delivered again.
    clock += 120_000;
    events.emit('approval.requested', { approvalId: 'a2b' }, { message: 'later approval', severity: 'warning' });
    expect(sent).toHaveLength(2);

    bridge.dispose();
    events.emit('approval.requested', { approvalId: 'a3' }, { message: 'after dispose', severity: 'warning' });
    expect(sent).toHaveLength(2);
    // Delivery is asynchronous; give the microtask queue a turn before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.stats().delivered).toBe(2);
  });
});
