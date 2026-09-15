#!/usr/bin/env node
/**
 * Dev launcher: runs the API, the web dev server and the worker in one process
 * group with prefixed, colourised logs and clean shutdown. Avoids pulling in an
 * extra dependency (`concurrently`) for something that is ~60 lines.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const COLOURS = { api: '\x1b[36m', web: '\x1b[35m', worker: '\x1b[33m', reset: '\x1b[0m' };

/** @type {{name:string,cmd:string,args:string[],env:Record<string,string>}[]} */
const targets = [
  { name: 'api', cmd: npx, args: ['tsx', 'watch', '--clear-screen=false', 'apps/api/src/index.ts'], env: {} },
  { name: 'worker', cmd: npx, args: ['tsx', 'watch', '--clear-screen=false', 'apps/worker/src/index.ts'], env: {} },
  { name: 'web', cmd: npx, args: ['vite', '--config', 'apps/web/vite.config.ts'], env: {} },
];

const only = process.argv.slice(2);
const selected = only.length ? targets.filter((t) => only.includes(t.name)) : targets;
if (!selected.length) {
  console.error(`Unknown target(s): ${only.join(', ')}. Valid: ${targets.map((t) => t.name).join(', ')}`);
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function prefixLines(name, chunk) {
  const colour = COLOURS[name] ?? '';
  const text = chunk.toString();
  return text
    .split('\n')
    .filter((line, i, arr) => line.length > 0 || i < arr.length - 1)
    .map((line) => `${colour}[${name.padEnd(6)}]${COLOURS.reset} ${line}`)
    .join('\n');
}

for (const target of selected) {
  const child = spawn(target.cmd, target.args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1', ...target.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => process.stdout.write(prefixLines(target.name, c) + '\n'));
  child.stderr.on('data', (c) => process.stderr.write(prefixLines(target.name, c) + '\n'));
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`${COLOURS[target.name]}[${target.name}]${COLOURS.reset} exited (code=${code} signal=${signal})`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const child of children) if (!child.killed) child.kill('SIGKILL');
    process.exit(code);
  }, 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
