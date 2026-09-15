/**
 * Vitest/Vite compatibility shim for `node:sqlite`.
 *
 * `node:sqlite` is a prefix-only builtin: it is absent from `module.builtinModules`,
 * so Vite's resolver strips the `node:` prefix and then tries to resolve the bare
 * specifier `sqlite` from npm. Loading it through `createRequire` keeps the real
 * builtin in use while bypassing that resolution step.
 *
 * Production code imports `node:sqlite` directly; this file exists for the test
 * runner only (see the `sqlite` alias in vitest.config.ts).
 */
import { createRequire } from 'node:module';

const requireBuiltin = createRequire(import.meta.url);
const sqlite = requireBuiltin('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export const StatementSync = sqlite.StatementSync;
export default sqlite;
