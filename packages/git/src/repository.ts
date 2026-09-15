import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from '@aido/types';
import type { Logger } from '@aido/observability';
import { runCommand, type CommandResult } from '@aido/sandbox';

/**
 * Git integration (§17).
 *
 * Git is the source of truth for code changes: agents work on branches, commit
 * with an identifiable author, and the UI shows real branches/diffs/conflicts.
 *
 * All git interaction goes through the sandbox runner, so the same isolation and
 * timeouts apply. Commands are constructed as arrays joined with explicit quoting
 * — we never interpolate model-provided text into a shell string unquoted.
 */

export interface GitCommit {
  sha: string;
  shortSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedAt: string;
  refs: string;
}

export interface GitStatusEntry {
  path: string;
  /** Two-character porcelain code, e.g. ' M', '??', 'UU'. */
  code: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  entries: GitStatusEntry[];
  conflictedPaths: string[];
  /** True while a merge/rebase is mid-flight. */
  operationInProgress: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
  isRepository: boolean;
}

export interface GitDiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: { path: string; insertions: number; deletions: number; binary: boolean }[];
}

export interface GitRepositoryOptions {
  path: string;
  logger: Logger;
  /** Commit identity for agent commits (per project). */
  authorName: string;
  authorEmail: string;
  /** Timeout for git operations. */
  timeoutMs?: number;
}

export class GitRepository {
  readonly path: string;
  private readonly logger: Logger;
  private readonly authorName: string;
  private readonly authorEmail: string;
  private readonly timeoutMs: number;

  constructor(options: GitRepositoryOptions) {
    this.path = path.resolve(options.path);
    this.logger = options.logger.child?.({ scope: 'git', repo: options.path }) ?? options.logger;
    this.authorName = options.authorName;
    this.authorEmail = options.authorEmail;
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  private async git(args: string[], options: { allowFailure?: boolean } = {}): Promise<CommandResult> {
    // Quote each argument so a path containing spaces or quotes cannot break out.
    const command = `git ${args.map(quoteArg).join(' ')}`;
    const result = await runCommand({
      command,
      cwd: this.path,
      timeoutMs: this.timeoutMs,
      scratchDir: path.join(this.path, '.aido-tmp'),
      purpose: 'internal',
      env: {
        GIT_AUTHOR_NAME: this.authorName,
        GIT_AUTHOR_EMAIL: this.authorEmail,
      },
    });
    if (result.exitCode !== 0 && !options.allowFailure) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 800);
      throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${detail}`);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Repository lifecycle
  // -------------------------------------------------------------------------

  async isRepository(): Promise<boolean> {
    if (!fs.existsSync(path.join(this.path, '.git'))) return false;
    const result = await this.git(['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
    return result.exitCode === 0 && result.stdout.trim() === 'true';
  }

  /** Creates a repository with an initial commit on the given branch. */
  async init(branch = 'main'): Promise<void> {
    fs.mkdirSync(this.path, { recursive: true });
    await this.git(['init', '-b', branch]);
    await this.git(['config', 'user.name', this.authorName]);
    await this.git(['config', 'user.email', this.authorEmail]);
    await this.git(['config', 'commit.gpgsign', 'false']);
    this.logger.info('repository initialised', { branch });
  }

  /**
   * Clones an existing repository. `--depth=1` keeps a free-tier workflow cheap in
   * time and disk; the full history can be fetched later if needed.
   */
  async clone(url: string, options: { branch?: string; depth?: number } = {}): Promise<void> {
    const args = ['clone', '--depth', String(options.depth ?? 1)];
    if (options.branch) args.push('--branch', options.branch);
    args.push(url, '.');
    const parent = path.dirname(this.path);
    fs.mkdirSync(this.path, { recursive: true });
    const result = await runCommand({
      command: `git ${args.map(quoteArg).join(' ')}`,
      cwd: this.path,
      timeoutMs: Math.max(this.timeoutMs, 300_000),
      scratchDir: path.join(this.path, '.aido-tmp'),
      purpose: 'internal',
      env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/true' },
    });
    if (result.exitCode !== 0) {
      throw new Error(`git clone failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    }
    void parent;
    this.logger.info('repository cloned', { url, branch: options.branch ?? 'default' });
  }

  async currentBranch(): Promise<string | null> {
    const result = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
    if (result.exitCode !== 0) return null;
    const branch = result.stdout.trim();
    return branch === 'HEAD' ? null : branch;
  }

  async branches(): Promise<{ name: string; current: boolean; sha: string; lastCommitAt: string | null }[]> {
    const result = await this.git(
      ['for-each-ref', '--format=%(refname:short)|%(objectname)|%(committerdate:iso-strict)', 'refs/heads'],
      { allowFailure: true },
    );
    if (result.exitCode !== 0) return [];
    const current = await this.currentBranch();
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name = '', sha = '', lastCommitAt = ''] = line.split('|');
        return { name, sha, current: name === current, lastCommitAt: lastCommitAt || null };
      });
  }

  async createBranch(name: string, options: { checkout?: boolean } = {}): Promise<void> {
    const safe = sanitiseRefName(name);
    if (options.checkout === false) await this.git(['branch', safe]);
    else await this.git(['checkout', '-b', safe]);
    this.logger.info('branch created', { branch: safe });
  }

  async checkout(ref: string): Promise<void> {
    await this.git(['checkout', sanitiseRefName(ref)]);
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.git(force ? ['branch', '-D', sanitiseRefName(name)] : ['branch', '-d', sanitiseRefName(name)]);
  }

  // -------------------------------------------------------------------------
  // Status / diff
  // -------------------------------------------------------------------------

  async status(): Promise<GitStatus> {
    if (!(await this.isRepository())) {
      return {
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        clean: true,
        entries: [],
        conflictedPaths: [],
        operationInProgress: null,
        isRepository: false,
      };
    }

    const porcelain = await this.git(['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
    const entries: GitStatusEntry[] = [];
    let branch: string | null = null;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;

    for (const rawLine of porcelain.stdout.split('\n')) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length).trim();
      else if (line.startsWith('# branch.upstream ')) upstream = line.slice('# branch.upstream '.length).trim();
      else if (line.startsWith('# branch.ab ')) {
        const match = line.match(/\+(\d+)\s+-(\d+)/);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const parts = line.split(' ');
        const xy = parts[1] ?? '..';
        const filePath = line.startsWith('2 ') ? (parts.slice(9).join(' ').split('\t')[0] ?? '') : (parts.slice(8).join(' '));
        entries.push(toEntry(filePath, xy));
      } else if (line.startsWith('u ')) {
        const parts = line.split(' ');
        entries.push(toEntry(parts.slice(10).join(' '), 'UU'));
      } else if (line.startsWith('? ')) {
        entries.push(toEntry(line.slice(2), '??'));
      } else if (line.startsWith('! ')) {
        // ignored: not reported
      }
    }

    const conflictedPaths = entries.filter((e) => e.conflicted).map((e) => e.path);
    return {
      branch,
      upstream,
      ahead,
      behind,
      clean: entries.length === 0,
      entries,
      conflictedPaths,
      operationInProgress: detectOperation(this.path),
      isRepository: true,
    };
  }

  async diff(options: { staged?: boolean; ref?: string; path?: string; contextLines?: number; maxBytes?: number } = {}): Promise<string> {
    const args = ['diff', '--no-color', `--unified=${options.contextLines ?? 3}`];
    if (options.staged) args.push('--cached');
    if (options.ref) args.push(sanitiseRefName(options.ref));
    if (options.path) args.push('--', options.path);
    const result = await this.git(args, { allowFailure: true });
    const text = result.stdout;
    const maxBytes = options.maxBytes ?? 400_000;
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[diff truncated by AI Dev Orchestrator at ${maxBytes} bytes]` : text;
  }

  async diffSummary(options: { staged?: boolean; ref?: string } = {}): Promise<GitDiffSummary> {
    const args = ['diff', '--numstat', '--no-color'];
    if (options.staged) args.push('--cached');
    if (options.ref) args.push(sanitiseRefName(options.ref));
    const result = await this.git(args, { allowFailure: true });
    const files: GitDiffSummary['files'] = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [added = '', removed = '', ...rest] = line.split('\t');
      const filePath = rest.join('\t');
      const binary = added === '-' || removed === '-';
      const insert = binary ? 0 : Number(added) || 0;
      const remove = binary ? 0 : Number(removed) || 0;
      insertions += insert;
      deletions += remove;
      files.push({ path: filePath, insertions: insert, deletions: remove, binary });
    }
    return { filesChanged: files.length, insertions, deletions, files };
  }

  async log(options: { limit?: number; branch?: string; path?: string } = {}): Promise<GitCommit[]> {
    const limit = options.limit ?? 50;
    const args = ['log', `--max-count=${limit}`, '--format=%H|%h|%s|%an|%ae|%cI|%D'];
    if (options.branch) args.push(sanitiseRefName(options.branch));
    if (options.path) args.push('--', options.path);
    const result = await this.git(args, { allowFailure: true });
    if (result.exitCode !== 0) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [sha = '', shortSha = '', message = '', authorName = '', authorEmail = '', committedAt = '', refs = ''] = line.split('|');
        return { sha, shortSha, message, authorName, authorEmail, committedAt, refs };
      });
  }

  async headSha(): Promise<string | null> {
    const result = await this.git(['rev-parse', 'HEAD'], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async hasCommits(): Promise<boolean> {
    return (await this.headSha()) !== null;
  }

  // -------------------------------------------------------------------------
  // Committing
  // -------------------------------------------------------------------------

  async stage(paths: string[] | 'all'): Promise<void> {
    if (paths === 'all') await this.git(['add', '--all']);
    else if (paths.length) await this.git(['add', '--', ...paths.map(quoteArg)]);
  }

  /**
   * Creates a commit. Files are staged first so the commit content is exactly what
   * the agent produced, and the commit is attributed to the agent that made the
   * change (visible in the Git screen and in `git log`).
   */
  async commit(input: {
    message: string;
    agentId?: AgentId | null;
    taskId?: string | null;
    paths?: string[] | 'all';
    allowEmpty?: boolean;
  }): Promise<GitCommit | null> {
    await this.stage(input.paths ?? 'all');

    const staged = await this.git(['diff', '--cached', '--name-only'], { allowFailure: true });
    if (!staged.stdout.trim() && !input.allowEmpty) {
      this.logger.debug('nothing staged; skipping commit', { message: input.message });
      return null;
    }

    const trailers = [
      input.agentId ? `Agent: ${input.agentId}` : null,
      input.taskId ? `Task: ${input.taskId}` : null,
      'Generated-By: AI Dev Orchestrator',
    ].filter(Boolean) as string[];

    const fullMessage = [input.message.trim(), '', ...trailers].join('\n');
    const args = ['commit', '--no-verify', '-m', fullMessage];
    if (input.allowEmpty) args.push('--allow-empty');
    const result = await this.git(args);

    const sha = (await this.headSha()) ?? '';
    const commit: GitCommit = {
      sha,
      shortSha: sha.slice(0, 7),
      message: input.message.split('\n')[0] ?? '',
      authorName: this.authorName,
      authorEmail: this.authorEmail,
      committedAt: new Date().toISOString(),
      refs: '',
    };
    this.logger.info('commit created', { sha: commit.shortSha, agent: input.agentId ?? 'system', files: staged.stdout.trim().split('\n').length });
    void result;
    return commit;
  }

  // -------------------------------------------------------------------------
  // Merging / conflicts
  // -------------------------------------------------------------------------

  async merge(branch: string, options: { message?: string; noFf?: boolean } = {}): Promise<{ ok: boolean; conflicts: string[]; message: string }> {
    const args = ['merge', '--no-edit'];
    if (options.noFf !== false) args.push('--no-ff');
    if (options.message) args.push('-m', options.message);
    args.push(sanitiseRefName(branch));
    const result = await this.git(args, { allowFailure: true });
    if (result.exitCode === 0) return { ok: true, conflicts: [], message: result.stdout.trim() || 'merge completed' };
    const status = await this.status();
    return {
      ok: false,
      conflicts: status.conflictedPaths,
      message: (result.stderr || result.stdout).trim().slice(0, 800),
    };
  }

  async abortMerge(): Promise<void> {
    await this.git(['merge', '--abort'], { allowFailure: true });
  }

  /** Unified view of a conflicted file with the standard conflict markers. */
  async conflictedFile(pathRelative: string): Promise<{ path: string; content: string; ours: string[]; theirs: string[] } | null> {
    const absolute = path.resolve(this.path, pathRelative);
    if (!fs.existsSync(absolute)) return null;
    const content = fs.readFileSync(absolute, 'utf8');
    const ours: string[] = [];
    const theirs: string[] = [];
    let mode: 'ours' | 'theirs' | null = null;
    for (const line of content.split('\n')) {
      if (line.startsWith('<<<<<<<')) {
        mode = 'ours';
        continue;
      }
      if (line.startsWith('=======')) {
        mode = 'theirs';
        continue;
      }
      if (line.startsWith('>>>>>>>')) {
        mode = null;
        continue;
      }
      if (mode === 'ours') ours.push(line);
      else if (mode === 'theirs') theirs.push(line);
    }
    return { path: pathRelative, content, ours, theirs };
  }

  /** Resolves a conflict by taking one side. Requires explicit confirmation upstream. */
  async resolveConflict(pathRelative: string, side: 'ours' | 'theirs' | 'union'): Promise<void> {
    const args = side === 'union' ? ['checkout', '--conflict=merge', '--', pathRelative] : ['checkout', `--${side}`, '--', pathRelative];
    await this.git(args);
    await this.git(['add', '--', pathRelative]);
    this.logger.info('conflict resolved', { path: pathRelative, side });
  }

  async stash(message?: string): Promise<void> {
    const args = ['stash', 'push', '--include-untracked'];
    if (message) args.push('-m', message);
    await this.git(args, { allowFailure: true });
  }

  async restore(ref = 'HEAD', paths: string[] = []): Promise<void> {
    const args = ['restore', '--source', sanitiseRefName(ref), '--'];
    await this.git(args.concat(paths.length ? paths : ['.']), { allowFailure: true });
  }
}

function toEntry(filePath: string, xy: string): GitStatusEntry {
  const stagedCode = xy[0] ?? '.';
  const unstagedCode = xy[1] ?? '.';
  const conflicted = stagedCode === 'U' || unstagedCode === 'U' || xy === 'AA' || xy === 'DD';
  return {
    path: filePath,
    code: xy,
    staged: stagedCode !== '.' && stagedCode !== '?',
    unstaged: unstagedCode !== '.' && unstagedCode !== '?',
    untracked: xy === '??',
    conflicted,
  };
}

function detectOperation(repoPath: string): GitStatus['operationInProgress'] {
  if (fs.existsSync(path.join(repoPath, '.git', 'MERGE_HEAD'))) return 'merge';
  if (fs.existsSync(path.join(repoPath, '.git', 'rebase-merge')) || fs.existsSync(path.join(repoPath, '.git', 'rebase-apply'))) return 'rebase';
  if (fs.existsSync(path.join(repoPath, '.git', 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (fs.existsSync(path.join(repoPath, '.git', 'REVERT_HEAD'))) return 'revert';
  return null;
}

/** Rejects ref names that could be interpreted as options or path escapes. */
export function sanitiseRefName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith('-') || /[\s~^:?*[\\]/.test(trimmed) || trimmed.includes('..')) {
    throw new Error(`Invalid git ref name: "${name}". Ref names may not start with "-" or contain whitespace, ~^:?*[\\, or "..".`);
  }
  return trimmed;
}

function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Branch name for an agent's work stream (§17). */
export function agentBranchName(agentId: string, topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `agent/${agentId.replace(/_/g, '-')}${slug ? `-${slug}` : ''}`;
}
