import fs from 'node:fs';
import path from 'node:path';

/** Present in CommonJS bundles (the desktop build); absent under ESM. */
declare const __dirname: string | undefined;

/**
 * Where the running code lives, in a way that works for ESM sources, bundles and the
 * CommonJS desktop bundle.
 *
 * Deliberately not `import.meta.url`: the desktop shell is bundled to CommonJS, where
 * `import.meta` does not exist. `process.argv[1]` is the entry script — the same
 * starting point for a dev run, a bundled worker and the Electron main process — and
 * `__dirname` covers bundled code invoked without a script path.
 */
function moduleRoot(): string {
  if (typeof __dirname === 'string' && __dirname) return __dirname;
  const entry = process.argv[1];
  if (entry) return path.dirname(path.resolve(entry));
  return process.cwd();
}

/**
 * Resolves the repository root by walking up until a `package.json` with the workspace
 * name (or a `.git` directory) is found. Falls back to the process working directory,
 * which is what a packaged desktop install gets: there is no repository, and the data
 * directory comes from the platform paths instead.
 */
export function findRepoRoot(startDir: string = moduleRoot()): string {
  let dir = startDir;
  const root = path.parse(dir).root;
  while (dir !== root) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { name?: string; workspaces?: unknown };
        if (parsed.name === 'ai-dev-orchestrator' || Array.isArray(parsed.workspaces)) return dir;
      } catch {
        /* keep walking */
      }
    }
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function resolveFromRepoRoot(p: string, repoRoot: string): string {
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
}
