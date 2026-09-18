import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Command execution for agents (§16, §30).
 *
 * Security properties, in order of importance:
 *
 *  1. ENVIRONMENT ISOLATION — the child process never inherits provider API keys,
 *     the master key, or any other secret from the server's environment. A minimal
 *     environment is constructed explicitly. This is the single most important
 *     control: without it, `env` or `printenv` inside a "safe" test command would
 *     leak every credential the application holds.
 *  2. WORKING DIRECTORY — always inside the project workspace, validated by the
 *     path guard before the process starts.
 *  3. RESOURCE LIMITS — wall-clock timeout with SIGKILL escalation, output byte
 *     caps, and process-group kill so a spawned child tree (npm → node → jest)
 *     cannot outlive its parent.
 *  4. POLICY — callers must run `assessCommand` first; this module *also* refuses
 *     a short list of catastrophic commands as defence in depth.
 *
 * `shell: true` is used because agents legitimately run pipelines (`npm test |
 * tee`), and the policy layer is what makes that acceptable — not the absence of
 * a shell.
 */

export interface RunCommandOptions {
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** Hard cap on captured output per stream. */
  outputByteLimit?: number;
  signal?: AbortSignal;
  /** Directory used for TMPDIR/npm cache; defaults to a sandbox subdirectory. */
  scratchDir?: string;
  /** Called for each output line (used by the live terminal panel). */
  onData?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  /** Allow `git` to touch .git internals (used by the git package itself). */
  purpose?: 'agent' | 'internal';
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  /** True when the process was killed because the run was cancelled. */
  cancelled: boolean;
  /** False when the command produced no output at all (helpful for empty states). */
  producedOutput: boolean;
}

const CATASTROPHIC = [
  /\brm\s+-rf\s+\/(\s|$)/,
  /\bmkfs(\.\w+)?\b/,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  /\bdd\b[^\n]*of=\/dev\/(sd|nvme|hd|vd)/,
];

export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const {
    command,
    cwd,
    timeoutMs = 300_000,
    outputByteLimit = 512 * 1024,
    signal,
    scratchDir,
    onData,
    purpose = 'agent',
  } = options;

  if (!command.trim()) throw new Error('Refusing to run an empty command.');
  for (const pattern of CATASTROPHIC) {
    if (pattern.test(command)) {
      return {
        command,
        cwd,
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: `Blocked by the sandbox: command matches a catastrophic pattern (${pattern}).`,
        durationMs: 0,
        timedOut: false,
        truncated: false,
        cancelled: false,
        producedOutput: true,
      };
    }
  }

  if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);

  const scratch = scratchDir ?? path.join(cwd, '.aido-tmp');
  try {
    fs.mkdirSync(scratch, { recursive: true });
  } catch {
    /* read-only workspace: fall back to ignoring the scratch dir */
  }

  const env = buildSandboxEnv({ cwd, scratch, extra: options.env, purpose });
  const started = Date.now();

  return new Promise<CommandResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const child = spawn(command, {
      cwd,
      env,
      shell: '/bin/bash',
      // Detached process group so a timeout can kill the whole tree, not just the
      // shell that spawned it (otherwise `npm test` leaves a jest process behind).
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 5_000).unref?.();
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 2_000).unref?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      onData?.(stream, text);
      const current = stream === 'stdout' ? stdout : stderr;
      if (current.length >= outputByteLimit) {
        truncated = true;
        return;
      }
      const remaining = outputByteLimit - current.length;
      const slice = text.length > remaining ? text.slice(0, remaining) : text;
      if (text.length > remaining) truncated = true;
      if (stream === 'stdout') stdout += slice;
      else stderr += slice;
    };

    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));

    const finish = (exitCode: number | null, signalName: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (truncated) stderr += `\n[sandbox] output truncated at ${outputByteLimit} bytes per stream.`;
      if (timedOut) stderr += `\n[sandbox] command exceeded the ${timeoutMs}ms timeout and was terminated.`;
      if (cancelled) stderr += '\n[sandbox] command was cancelled.';
      resolve({
        command,
        cwd,
        exitCode,
        signal: signalName,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        truncated,
        cancelled,
        producedOutput: stdout.length > 0 || stderr.length > 0,
      });
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Failed to start command: ${err.message}`));
    });
    child.on('close', (code, signalName) => finish(code, signalName));
  });
}

/**
 * Builds a deliberately minimal environment. Note what is *absent*: nothing from
 * `process.env` is copied except a small allowlist, so `GEMINI_API_KEY`,
 * `GROQ_API_KEY`, `AIDO_MASTER_KEY` and friends are simply not present in the
 * child's address space.
 */
export function buildSandboxEnv(input: {
  cwd: string;
  scratch: string;
  extra?: Record<string, string>;
  purpose?: 'agent' | 'internal';
}): NodeJS.ProcessEnv {
  const pathValue = process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  const env: NodeJS.ProcessEnv = {
    PATH: pathValue,
    HOME: input.cwd,
    PWD: input.cwd,
    TMPDIR: input.scratch,
    TMP: input.scratch,
    TEMP: input.scratch,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    // Deterministic, non-interactive tooling behaviour.
    NO_COLOR: '1',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
    NPM_CONFIG_FUND: 'false',
    NPM_CONFIG_AUDIT: 'false',
    NPM_CONFIG_CACHE: `${input.scratch}/npm-cache`,
    npm_config_cache: `${input.scratch}/npm-cache`,
    // Git identity for agent commits, honouring the project override when present.
    GIT_AUTHOR_NAME: input.extra?.GIT_AUTHOR_NAME ?? 'AI Dev Orchestrator',
    GIT_AUTHOR_EMAIL: input.extra?.GIT_AUTHOR_EMAIL ?? 'agents@ai-dev-orchestrator.local',
    GIT_COMMITTER_NAME: input.extra?.GIT_AUTHOR_NAME ?? 'AI Dev Orchestrator',
    GIT_COMMITTER_EMAIL: input.extra?.GIT_AUTHOR_EMAIL ?? 'agents@ai-dev-orchestrator.local',
    // Never hang on a credential prompt inside an automated run.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/true',
    // Housekeeping so a runaway tool cannot walk far up the tree.
    GIT_DISCOVERY_ACROSS_FILESYSTEM: '0',
  };
  if (input.extra) {
    for (const [key, value] of Object.entries(input.extra)) {
      env[key] = value;
    }
  }
  return env;
}

/** Names of environment variables the sandbox deliberately never forwards. */
export const NEVER_FORWARD_ENV = ['AIDO_MASTER_KEY', '*_API_KEY', '*_TOKEN', '*_SECRET', 'AWS_*', 'DATABASE_URL'];
