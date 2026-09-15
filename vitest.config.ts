import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Workspace aliases so tests import `@aido/*` sources directly (no build step). */
const alias: Record<string, string> = {};
for (const pkg of [
  'types',
  'config',
  'observability',
  'security',
  'storage',
  'ai-core',
  'providers',
  'quota-engine',
  'model-router',
  'agents',
  'project-memory',
  'orchestrator',
  'sandbox',
  'git',
  'platform',
  'testing',
  'ui',
]) {
  alias[`@aido/${pkg}`] = path.join(root, 'packages', pkg, 'src', 'index.ts');
}

const sqliteShim = path.join(root, 'test', 'support', 'node-sqlite.ts');
alias['node:sqlite'] = sqliteShim;
alias['sqlite'] = sqliteShim;

export default defineConfig({
  resolve: { alias },
  // `node:sqlite` is a prefix-only builtin (absent from `module.builtinModules`),
  // so Vite strips the prefix and then looks for an npm package named `sqlite`.
  // Point both forms at a shim that loads the real builtin.
  ssr: { external: ['node:sqlite', 'sqlite'] },
  optimizeDeps: { exclude: ['node:sqlite', 'sqlite'] },
  test: {
    environment: 'node',
    server: { deps: { external: [/^node:sqlite$/, /^sqlite$/] } },
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'threads',
    reporters: process.env.CI ? ['default'] : ['default'],
    coverage: { provider: 'v8', include: ['packages/**/src/**/*.ts'], exclude: ['**/index.ts'] },
  },
});
