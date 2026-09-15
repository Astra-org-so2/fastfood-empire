#!/usr/bin/env node
/**
 * Applies pending database migrations and exits. Useful in CI/deploy pipelines
 * where migrations must be applied before the API starts.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const { loadConfig } = await import('../packages/config/src/index.ts');
const { openDatabase } = await import('../packages/storage/src/index.ts');

const config = loadConfig();
const db = openDatabase({ path: config.dbPath, migrate: true });
const status = db.migrations();
console.log(`database: ${config.dbPath}`);
console.log(`applied migrations: ${status.applied.length}`);
for (const m of status.applied) console.log(`  - ${m}`);
console.log(`schema version: ${status.version}`);
db.close();
