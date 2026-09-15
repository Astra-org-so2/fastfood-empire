#!/usr/bin/env node
/**
 * Installer build and desktop launcher (§54).
 *
 * This directory is *not* an npm workspace, on purpose: Electron is a ~100 MB binary
 * download that many environments (CI images, offline machines, corporate networks)
 * cannot fetch, and a default `npm install` must not depend on it. Nothing else in the
 * repository needs Electron — the main process bundles without it, and the API, worker
 * and web build run without it.
 *
 * Install once, when you actually need to run or package the desktop app:
 *
 *     cd apps/desktop/packaging && npm install
 *     # or, on a machine that cannot reach the Electron download host:
 *     ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packagingDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(packagingDir, '..', '..', '..');

function requireToolchain() {
  const electron = path.join(packagingDir, 'node_modules', 'electron');
  const builder = path.join(packagingDir, 'node_modules', 'electron-builder');
  if (!fs.existsSync(electron) || !fs.existsSync(builder)) {
    console.error('The desktop toolchain is not installed.');
    console.error(`Run:  cd ${path.relative(process.cwd(), packagingDir) || '.'} && npm install`);
    console.error('Without network access to the Electron download host, set ELECTRON_SKIP_BINARY_DOWNLOAD=1 and use `npm run build:desktop` (bundling only).');
    process.exit(1);
  }
}

function ensureBundles() {
  const main = path.join(repoRoot, 'dist', 'desktop', 'main.cjs');
  if (!fs.existsSync(main)) {
    console.log('Bundling the desktop shell first…');
    const build = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-desktop.mjs')], { cwd: repoRoot, stdio: 'inherit' });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  if (!fs.existsSync(path.join(repoRoot, 'dist', 'web', 'index.html'))) {
    console.warn('dist/web/index.html is missing: the desktop app will start with the API only. Run `npm run build:web` first.');
  }
}

const args = process.argv.slice(2);
const mode = args.includes('--start') ? 'start' : 'package';
const targets = args.filter((arg) => arg.startsWith('--target=')).map((arg) => arg.slice('--target='.length));

requireToolchain();
ensureBundles();

if (mode === 'start') {
  // Runs Electron against a directory whose package.json points at dist/desktop/main.cjs.
  const launcherDir = path.join(packagingDir, '.launcher');
  fs.mkdirSync(launcherDir, { recursive: true });
  fs.writeFileSync(
    path.join(launcherDir, 'package.json'),
    JSON.stringify({ name: 'aido-desktop-launcher', version: '0.1.0', private: true, main: path.join(repoRoot, 'dist', 'desktop', 'main.cjs') }, null, 2),
  );
  const electronBinary = path.join(packagingDir, 'node_modules', '.bin', 'electron');
  const run = spawnSync(electronBinary, [launcherDir], { cwd: repoRoot, stdio: 'inherit', env: process.env });
  process.exit(run.status ?? 1);
}

const builderBinary = path.join(packagingDir, 'node_modules', '.bin', 'electron-builder');
const linuxTargets = (targets.length ? targets : ['deb']).map((target) => `--${target}`);
const run = spawnSync(builderBinary, ['--linux', ...linuxTargets, '--config', path.join(packagingDir, 'electron-builder.json'), '--project', repoRoot], {
  cwd: packagingDir,
  stdio: 'inherit',
  env: process.env,
});
process.exit(run.status ?? 1);
