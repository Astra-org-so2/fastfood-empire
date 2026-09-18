#!/usr/bin/env node
/**
 * Builds the desktop shell (§54).
 *
 * Two steps:
 *   1. bundle the Electron main process and preload script with esbuild
 *      (`dist/desktop/main.cjs`, `dist/desktop/preload.cjs`);
 *   2. optionally package the installers with electron-builder when `--package` is
 *      passed and electron-builder is installed.
 *
 * Nothing here needs Electron installed to run step 1: bundling only resolves our own
 * sources, and `electron` stays an external reference resolved at runtime by Electron.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist', 'desktop');
const wantPackage = process.argv.includes('--package');
const targets = process.argv.filter((arg) => arg.startsWith('--target=')).map((arg) => arg.slice('--target='.length));
const electronTargets = targets.length ? targets : ['deb'];

fs.mkdirSync(outDir, { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron'],
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

await build({ ...shared, entryPoints: [path.join(root, 'apps/desktop/src/main.ts')], outfile: path.join(outDir, 'main.cjs') });
await build({ ...shared, entryPoints: [path.join(root, 'apps/desktop/src/preload.ts')], outfile: path.join(outDir, 'preload.cjs') });

console.log(`desktop bundles written to ${path.relative(root, outDir)}`);

const webIndex = path.join(root, 'dist', 'web', 'index.html');
if (!fs.existsSync(webIndex)) {
  console.warn('dist/web/index.html is missing: the desktop app will start with the API only. Run `npm run build:web` first.');
}

if (!wantPackage) {
  console.log('packaging skipped (pass --package to build installers)');
  process.exit(0);
}

const builder = spawnSync('npx', ['electron-builder', `--linux`, ...electronTargets.flatMap((target) => [target])], {
  cwd: path.join(root, 'apps', 'desktop'),
  stdio: 'inherit',
});
if (builder.error) {
  console.error(`electron-builder could not be started: ${builder.error.message}`);
  console.error('Install the desktop development dependencies first: npm install --workspace apps/desktop');
  process.exit(1);
}
process.exit(builder.status ?? 1);
