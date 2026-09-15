#!/usr/bin/env node
/**
 * Production build.
 *  - bundles apps/api  -> dist/api/index.mjs   (single ESM file, node builtins external)
 *  - bundles apps/worker -> dist/worker/index.mjs
 *  - builds apps/web   -> dist/web            (static assets, served by the API)
 *
 * Bundling the workspace packages into one file keeps deployment simple
 * (no node_modules diffing, no separate build step per package).
 */
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`))));
  });
}

const external = [
  'node:*',
  'node:sqlite',
  // native/optional deps that must not be bundled
  'fsevents',
];

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
  banner: {
    // esbuild ESM output for CJS deps sometimes needs these shims.
    js: "import { createRequire as __aidoCreateRequire } from 'node:module'; const require = __aidoCreateRequire(import.meta.url);",
  },
};

fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });

await build({ ...shared, entryPoints: ['apps/api/src/index.ts'], outfile: 'dist/api/index.mjs' });
await build({ ...shared, entryPoints: ['apps/worker/src/index.ts'], outfile: 'dist/worker/index.mjs' });

await run('npx', ['vite', 'build', '--config', 'apps/web/vite.config.ts'], { AIDO_BUILD: '1' });

console.log('\n✓ build complete:');
console.log('  dist/api/index.mjs');
console.log('  dist/worker/index.mjs');
console.log('  dist/web/');
