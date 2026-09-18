import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, type ServerHandle } from '../../apps/api/src/server.js';

/**
 * Static web serving (§54).
 *
 * The packaged API serves the same bundle the desktop shell loads, so the browser and the
 * desktop app are guaranteed to run identical code. The failure this guards against is
 * subtle and shipped once already: with static routes missing, the SPA fallback answered
 * `/assets/index-*.js` with `index.html`, the browser refused the module because it arrived
 * as `text/html`, and the app rendered a blank page that looked like a broken build.
 */
describe('static web serving', () => {
  let root: string;
  let distDir: string;
  let server: ServerHandle | null = null;
  let previousEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'aido-static-'));
    distDir = path.join(root, 'web');
    fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("aido");');
    previousEnv = { ...process.env };
    process.env.AIDO_DATA_DIR = path.join(root, 'data');
    process.env.AIDO_WORKSPACE_ROOT = path.join(root, 'workspaces');
    process.env.AIDO_PROVIDER_DIR = path.join(process.cwd(), 'config/providers');
    process.env.AIDO_LOG_LEVEL = 'error';
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the bundle, routes deep links to the shell, and never answers an asset with HTML', async () => {
    server = await buildServer({ serveWeb: true, webDistDir: distDir });
    const url = await server.listen({ host: '127.0.0.1', port: 0 });

    const index = await fetch(`${url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');

    const asset = await fetch(`${url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toContain('console.log');

    // A missing asset is a 404, not the shell: an HTML body would be refused by the browser
    // as a module and blank the page.
    const missing = await fetch(`${url}/assets/index-8f21c0.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/json');

    // Client-side routes belong to the SPA router.
    const deepLink = await fetch(`${url}/providers/groq`);
    expect(deepLink.status).toBe(200);
    expect(deepLink.headers.get('content-type')).toContain('text/html');

    // API paths never fall through to the shell, so a typo fails loudly instead of
    // returning HTML that the client would try to parse as JSON.
    const apiMissing = await fetch(`${url}/api/does-not-exist`);
    expect(apiMissing.status).toBe(404);
    expect(apiMissing.headers.get('content-type')).toContain('application/json');
    expect(((await apiMissing.json()) as { error: string }).error).toContain('No API route');

    // Writes to a page path are not pages.
    const posted = await fetch(`${url}/providers/groq`, { method: 'POST', body: '{}' });
    expect(posted.status).toBe(404);
  });

  it('serves an asset that appears after the server started', async () => {
    server = await buildServer({ serveWeb: true, webDistDir: distDir });
    const url = await server.listen({ host: '127.0.0.1', port: 0 });

    // A rebuild replaces the hashed bundle while the server keeps running; a route table
    // built at boot would answer the new hash with the SPA shell (or a 404) until restart.
    fs.writeFileSync(path.join(distDir, 'assets', 'index-newhash.js'), 'console.log("rebuilt");');
    const asset = await fetch(`${url}/assets/index-newhash.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toContain('rebuilt');
  });

  it('refuses to serve files outside the bundle directory', async () => {
    server = await buildServer({ serveWeb: true, webDistDir: distDir });
    const url = await server.listen({ host: '127.0.0.1', port: 0 });

    for (const attempt of ['/../package.json', '/..%2fpackage.json', '/assets/../../package.json']) {
      const response = await fetch(`${url}${attempt}`);
      expect(response.status, attempt).toBe(404);
      const body = await response.text();
      expect(body, attempt).not.toContain('"name": "ai-dev-orchestrator"');
    }
  });

  it('serves the API without the bundle when none is built', async () => {
    server = await buildServer({ serveWeb: true, webDistDir: path.join(root, 'missing') });
    const url = await server.listen({ host: '127.0.0.1', port: 0 });

    expect((await fetch(`${url}/api/ping`)).status).toBe(200);
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain('Web UI is not built');
  });
});
