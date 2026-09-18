#!/usr/bin/env node
/** Launches the desktop shell from a checkout. Requires the opt-in toolchain (see package-tool.mjs). */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packagingDir = path.dirname(fileURLToPath(import.meta.url));
const run = spawnSync(process.execPath, [path.join(packagingDir, 'package-tool.mjs'), '--start', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(run.status ?? 1);
