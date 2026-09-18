import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PathGuardError, assessCommand, resolveSafePath, scanForInjection, type InjectionFinding, type PathDecision } from '@aido/security';
import type { AppSettings, ExecutionMode, AgentTool } from '@aido/types';
import type { Logger } from '@aido/observability';
import { runCommand, type CommandResult } from './command-runner.js';

/**
 * Workspace: the agent-facing filesystem + command surface (§16).
 *
 * Every operation goes through the path guard, so no tool can escape the project
 * directory, read a `.env`, or touch another project's files. Commands are
 * policy-assessed and can require human approval; this class never decides to
 * skip that check.
 */

export interface WorkspaceOptions {
  rootPath: string;
  settings: () => AppSettings;
  executionMode: () => ExecutionMode;
  logger: Logger;
  /** Called when an operation is blocked by policy (for events/approvals). */
  onBlocked?: (info: { operation: string; reason: string; category: string; detail: Record<string, unknown> }) => void;
  /** Called when untrusted content contains injection patterns. */
  onInjection?: (findings: InjectionFinding[], source: string) => void;
}

export interface FileReadResult {
  path: string;
  content: string;
  bytes: number;
  lines: number;
  truncated: boolean;
  injectionFindings: InjectionFinding[];
}

export interface FileWriteResult {
  path: string;
  bytes: number;
  created: boolean;
  /** sha256 of the written content, used for change tracking. */
  hash: string;
}

export interface FileEntry {
  path: string;
  type: 'file' | 'directory';
  bytes: number;
  modifiedAt: string;
}

export interface SearchResult {
  path: string;
  line: number;
  text: string;
}

export interface CommandOutcome extends CommandResult {
  assessment: { verdict: 'allowed' | 'approval_required' | 'forbidden'; summary: string; reasons: { rule: string; reason: string; severity: string }[] };
}

export class Workspace {
  readonly rootPath: string;
  private readonly options: WorkspaceOptions;

  constructor(options: WorkspaceOptions) {
    this.options = options;
    this.rootPath = path.resolve(options.rootPath);
  }

  private guard(allowSecrets = false) {
    const settings = this.options.settings();
    return {
      workspaceRoot: this.rootPath,
      deniedPaths: settings.sandbox.deniedPaths,
      secretFileGlobs: settings.security.secretFileGlobs,
      allowSecrets,
    };
  }

  /** Resolves a path, returning a decision instead of throwing. */
  resolve(target: string, allowSecrets = false): PathDecision {
    const decision = resolveSafePath(target, this.guard(allowSecrets));
    if (!decision.allowed) {
      this.options.onBlocked?.({
        operation: 'resolve_path',
        reason: decision.reason,
        category: decision.category,
        detail: { requested: target },
      });
    }
    return decision;
  }

  // -------------------------------------------------------------------------
  // Filesystem
  // -------------------------------------------------------------------------

  list(relativeDir = '.', options: { maxEntries?: number; includeHidden?: boolean } = {}): FileEntry[] {
    const decision = this.resolve(relativeDir);
    if (!decision.allowed) throw new PathGuardError(decision);
    if (!fs.existsSync(decision.absolutePath)) return [];
    const maxEntries = options.maxEntries ?? 2_000;
    const out: FileEntry[] = [];
    const walk = (dir: string, depth: number) => {
      if (out.length >= maxEntries || depth > 12) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= maxEntries) return;
        if (!options.includeHidden && entry.name.startsWith('.')) continue;
        const absolute = path.join(dir, entry.name);
        const relative = path.relative(this.rootPath, absolute).split(path.sep).join('/');
        // Never surface ignored paths in listings either.
        if (!resolveSafePath(relative, this.guard()).allowed) continue;
        if (entry.isDirectory()) {
          out.push({ path: relative, type: 'directory', bytes: 0, modifiedAt: '' });
          walk(absolute, depth + 1);
        } else if (entry.isFile()) {
          const stat = fs.statSync(absolute);
          out.push({ path: relative, type: 'file', bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
        }
      }
    };
    walk(decision.absolutePath, 0);
    return out;
  }

  /** Reads a file as untrusted content and scans it for injection attempts. */
  read(relativePath: string, options: { maxBytes?: number } = {}): FileReadResult {
    const decision = this.resolve(relativePath);
    if (!decision.allowed) throw new PathGuardError(decision);
    const maxBytes = options.maxBytes ?? 512 * 1024;
    const stat = fs.statSync(decision.absolutePath);
    const truncated = stat.size > maxBytes;
    const buffer = fs.readFileSync(decision.absolutePath);
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer;
    if (looksBinary(slice)) {
      return {
        path: decision.relativePath,
        content: `[binary file omitted: ${stat.size} bytes, ${detectBinaryKind(slice)}]`,
        bytes: stat.size,
        lines: 0,
        truncated,
        injectionFindings: [],
      };
    }
    const content = slice.toString('utf8');
    const injectionFindings = scanForInjection(content);
    if (injectionFindings.length) this.options.onInjection?.(injectionFindings, decision.relativePath);
    return {
      path: decision.relativePath,
      content,
      bytes: stat.size,
      lines: content.split('\n').length,
      truncated,
      injectionFindings,
    };
  }

  write(relativePath: string, content: string): FileWriteResult {
    const decision = this.resolve(relativePath);
    if (!decision.allowed) throw new PathGuardError(decision);
    const created = !fs.existsSync(decision.absolutePath);
    fs.mkdirSync(path.dirname(decision.absolutePath), { recursive: true });
    fs.writeFileSync(decision.absolutePath, content, 'utf8');
    return {
      path: decision.relativePath,
      bytes: Buffer.byteLength(content, 'utf8'),
      created,
      hash: createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  }

  /** Deletes a file. Callers must have obtained approval (destructive op). */
  delete(relativePath: string): boolean {
    const decision = this.resolve(relativePath);
    if (!decision.allowed) throw new PathGuardError(decision);
    if (!fs.existsSync(decision.absolutePath)) return false;
    const stat = fs.statSync(decision.absolutePath);
    if (stat.isDirectory()) throw new Error('Refusing to delete a directory through the file API; use an explicit command with approval.');
    fs.unlinkSync(decision.absolutePath);
    return true;
  }

  exists(relativePath: string): boolean {
    const decision = this.resolve(relativePath);
    return decision.allowed && fs.existsSync(decision.absolutePath);
  }

  /** Substring search with a hard result cap so a broad query cannot hang the runner. */
  search(query: string, options: { globSuffix?: string; maxResults?: number; caseSensitive?: boolean } = {}): SearchResult[] {
    const maxResults = options.maxResults ?? 200;
    const needle = options.caseSensitive ? query : query.toLowerCase();
    const results: SearchResult[] = [];
    const files = this.list('.', { maxEntries: 20_000 }).filter((entry) => entry.type === 'file');
    for (const file of files) {
      if (results.length >= maxResults) break;
      if (options.globSuffix && !file.path.endsWith(options.globSuffix)) continue;
      if (file.bytes > 512 * 1024) continue;
      const decision = this.resolve(file.path);
      if (!decision.allowed) continue;
      let content: string;
      try {
        content = fs.readFileSync(decision.absolutePath, 'utf8');
      } catch {
        continue;
      }
      if (looksBinary(Buffer.from(content.slice(0, 512)))) continue;
      const lines = content.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        const haystack = options.caseSensitive ? line : line.toLowerCase();
        if (haystack.includes(needle)) {
          results.push({ path: file.path, line: index + 1, text: line.trim().slice(0, 400) });
          if (results.length >= maxResults) break;
        }
      }
    }
    return results;
  }

  /** Lightweight structural summary for context building (no LLM involved). */
  summary(): { files: number; directories: number; bytes: number; byExtension: { extension: string; count: number; bytes: number }[] } {
    const entries = this.list('.', { maxEntries: 20_000 });
    const files = entries.filter((e) => e.type === 'file');
    const byExtension = new Map<string, { count: number; bytes: number }>();
    let bytes = 0;
    for (const file of files) {
      bytes += file.bytes;
      const extension = path.extname(file.path) || '(none)';
      const current = byExtension.get(extension) ?? { count: 0, bytes: 0 };
      current.count += 1;
      current.bytes += file.bytes;
      byExtension.set(extension, current);
    }
    return {
      files: files.length,
      directories: entries.length - files.length,
      bytes,
      byExtension: [...byExtension.entries()]
        .map(([extension, value]) => ({ extension, ...value }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20),
    };
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Runs a command after policy assessment. `approved` must be set by the caller
   * only after a human approval was granted (or when the mode is AUTO and the
   * command is not destructive).
   */
  async run(
    command: string,
    options: { approved?: boolean; timeoutMs?: number; onData?: (stream: 'stdout' | 'stderr', chunk: string) => void; signal?: AbortSignal } = {},
  ): Promise<CommandOutcome> {
    const settings = this.options.settings();
    const assessment = assessCommand(command, {
      workspaceRoot: this.rootPath,
      deniedPaths: settings.sandbox.deniedPaths,
      approvalRequiredPrefixes: settings.sandbox.approvalRequiredPrefixes,
      allowedCommandPrefixes: settings.sandbox.allowedCommandPrefixes,
    });

    if (assessment.verdict === 'forbidden') {
      this.options.onBlocked?.({
        operation: 'run_command',
        reason: assessment.summary,
        category: 'forbidden_command',
        detail: { command },
      });
      throw new Error(`Command blocked by policy: ${assessment.summary}`);
    }

    const mode = this.options.executionMode();
    const requiresApproval = assessment.verdict === 'approval_required' || mode === 'manual' || (mode === 'supervised' && !isObviouslySafe(command));
    if (requiresApproval && !options.approved) {
      this.options.onBlocked?.({
        operation: 'run_command',
        reason: assessment.summary,
        category: 'approval_required',
        detail: { command, mode },
      });
      throw new Error(`Approval required before running: ${command}`);
    }

    const result = await runCommand({
      command,
      cwd: this.rootPath,
      timeoutMs: options.timeoutMs ?? settings.sandbox.commandTimeoutMs,
      outputByteLimit: settings.sandbox.outputByteLimit,
      signal: options.signal,
      onData: options.onData,
      scratchDir: path.join(this.rootPath, '.aido-tmp'),
    });

    return { ...result, assessment: { verdict: assessment.verdict, summary: assessment.summary, reasons: assessment.reasons } };
  }

  /** Command allowed without approval in SUPERVISED mode: read-only, no redirection. */
  static toolRequiresApproval(tool: AgentTool): boolean {
    switch (tool) {
      case 'read_file':
      case 'list_files':
      case 'search_files':
      case 'git_status':
      case 'git_diff':
        return false;
      default:
        return true;
    }
  }
}

const SAFE_COMMANDS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'stat', 'file', 'which', 'pwd', 'git', 'npm', 'node', 'npx', 'python3', 'pytest', 'tsc', 'eslint', 'prettier']);

function isObviouslySafe(command: string): boolean {
  const trimmed = command.trim();
  // Anything with shell metacharacters is not "obviously safe" — it can chain into
  // something destructive, so it goes through approval in SUPERVISED mode.
  if (/[>|&;`$()]/.test(trimmed)) return false;
  const head = trimmed.split(/\s+/)[0] ?? '';
  if (!SAFE_COMMANDS.has(head)) return false;
  // `git push` and friends are state-changing even without metacharacters.
  if (head === 'git' && /^(push|reset|clean|rebase|checkout|merge|filter-branch)/.test(trimmed.slice(4))) return false;
  return true;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 512);
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

function detectBinaryKind(buffer: Buffer): string {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50) return 'PNG image';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'JPEG image';
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'ZIP archive';
  if (buffer.subarray(0, 4).toString('utf8') === '%PDF') return 'PDF document';
  return 'binary data';
}
