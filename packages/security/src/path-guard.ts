/**
 * Sandbox path policy (§16, §30, §44).
 *
 * Every filesystem access made on behalf of an agent goes through `resolveSafePath`.
 * The rules, in order:
 *   1. the resolved path must stay inside the workspace root (no `..` escape),
 *   2. symlinks are resolved and re-checked, so a symlink cannot point outside,
 *   3. secret-looking files are denied unless explicitly allowed,
 *   4. operator-configured deny paths (absolute) are refused,
 *   5. writes to `.git` internals are refused (agents use the git tool, not raw writes).
 *
 * Returning a discriminated result instead of throwing keeps error handling at
 * the call site explicit and testable.
 */
import fs from 'node:fs';
import path from 'node:path';

export type PathDecision =
  | { allowed: true; absolutePath: string; relativePath: string; reason: string }
  | { allowed: false; absolutePath: string; relativePath: string; reason: string; category: PathDenyReason };

export type PathDenyReason =
  | 'outside_workspace'
  | 'symlink_escape'
  | 'secret_file'
  | 'denied_path'
  | 'git_internals'
  | 'invalid_path'
  | 'not_found';

export interface PathGuardOptions {
  workspaceRoot: string;
  /** Absolute paths that must never be touched. */
  deniedPaths?: string[];
  /** Glob-ish patterns of files that must never be read (secrets). */
  secretFileGlobs?: string[];
  /** Skip the secret-file check (used by the credential manager itself, never by agents). */
  allowSecrets?: boolean;
  /** Skip the .git internals check (used by the git package's own plumbing). */
  allowGitInternals?: boolean;
}

/** Glob matching limited to the shapes we actually use: *, **, ? and *.ext */
export function matchGlob(glob: string, target: string): boolean {
  const g = glob.trim();
  if (!g) return false;
  // Basename-only patterns (e.g. ".env") match any directory level.
  if (!g.includes('/')) {
    const base = target.split('/').pop() ?? target;
    return globToRegExp(g).test(base);
  }
  return globToRegExp(g).test(target);
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^$(){}[]|\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(out + '$');
}

export function resolveSafePath(target: string, options: PathGuardOptions): PathDecision {
  const root = path.resolve(options.workspaceRoot);
  const rootReal = safeRealpath(root) ?? root;

  if (typeof target !== 'string' || target.includes('\0')) {
    return deny(root, target, 'invalid_path', 'path contains NUL byte or is not a string');
  }

  const absolute = path.resolve(root, target);
  const relative = path.relative(root, absolute).split(path.sep).join('/');

  if (!isInside(root, absolute)) {
    return deny(absolute, relative, 'outside_workspace', `path escapes the workspace root (${root})`);
  }

  // Deny operator-configured absolute paths (prefix match on resolved path).
  for (const denied of options.deniedPaths ?? []) {
    if (!denied) continue;
    const deniedAbs = path.resolve(denied);
    if (absolute === deniedAbs || isInside(deniedAbs, absolute)) {
      return deny(absolute, relative, 'denied_path', `path is inside a denied location: ${deniedAbs}`);
    }
  }

  if (!options.allowGitInternals && (relative === '.git' || relative.startsWith('.git/'))) {
    return deny(absolute, relative, 'git_internals', 'direct access to git internals is not allowed; use the git tool');
  }

  if (!options.allowSecrets) {
    for (const glob of options.secretFileGlobs ?? []) {
      if (matchGlob(glob, relative)) {
        return deny(absolute, relative, 'secret_file', `file matches secret pattern "${glob}" and is never exposed to agents`);
      }
    }
  }

  // Symlink check on the deepest existing ancestor.
  const existing = deepestExisting(absolute);
  if (existing) {
    const real = safeRealpath(existing);
    if (real && !isInside(rootReal, real)) {
      return deny(absolute, relative, 'symlink_escape', `symlink resolves outside the workspace (${real})`);
    }
  }

  return { allowed: true, absolutePath: absolute, relativePath: relative, reason: 'inside workspace' };
}

export function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function deny(absolutePath: string, relative: string, category: PathDenyReason, reason: string): PathDecision {
  return { allowed: false, absolutePath, relativePath: relative, reason, category };
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function deepestExisting(target: string): string | null {
  let current = target;
  for (let i = 0; i < 64; i += 1) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function assertSafePath(target: string, options: PathGuardOptions): string {
  const decision = resolveSafePath(target, options);
  if (!decision.allowed) throw new PathGuardError(decision);
  return decision.absolutePath;
}

export class PathGuardError extends Error {
  constructor(readonly decision: Extract<PathDecision, { allowed: false }>) {
    super(`Blocked: ${decision.reason}`);
    this.name = 'PathGuardError';
  }
}
