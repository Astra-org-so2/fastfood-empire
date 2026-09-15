/** Application + per-project settings (§26, §27, §28, §44). */
import type { ExecutionMode } from './task.js';
import type { RouterSettings } from './routing.js';

export type ThemeMode = 'dark' | 'light' | 'system';

export interface SandboxSettings {
  /** Directory that holds all project workspaces. */
  workspaceRoot: string;
  /** Absolute paths that agents may never read or write. */
  deniedPaths: string[];
  /** Wall-clock ceiling for a single shell command. */
  commandTimeoutMs: number;
  outputByteLimit: number;
  /** Allow commands to reach the network (npm install, etc.). */
  allowNetwork: boolean;
  /** Command allowlist prefixes; empty = use built-in safe default list. */
  allowedCommandPrefixes: string[];
  /** Extra commands that always need human approval. */
  approvalRequiredPrefixes: string[];
}

export interface QuotaSettings {
  /** Safety margin reserved on every bucket (fraction of limit) so we never hit a wall. */
  reserveFraction: number;
  /** How long a reservation may live before it is auto-released. */
  reservationTtlMs: number;
  /** Cooldown applied after a 429 when the provider gives no retry-after. */
  defaultCooldownMs: number;
  /** Extra cooldown backoff multiplier per consecutive 429 on the same model. */
  cooldownBackoffMultiplier: number;
  maxCooldownMs: number;
  /** Learn limits from provider headers (recommended). */
  learnFromHeaders: boolean;
  /**
   * When true, unknown limits are treated as unlimited *but* the system still
   * records usage and reacts to real 429s (fail fast + cooldown).
   */
  assumeUnknownIsUnlimited: boolean;
}

export interface SupervisorSettings {
  maxRetriesPerTask: number;
  maxTokensPerTask: number;
  maxTaskRuntimeMs: number;
  maxAgentIterations: number;
  maxParallelAgents: number;
  maxTotalRunTokens: number | null;
  /** Stop a run when failures exceed this count within the window. */
  failureCircuitBreaker: { failures: number; windowMs: number };
  /** Automatically retry a failed task with a different model. */
  retryWithDifferentModel: boolean;
  /** Detects identical repeated prompts/outputs (loop protection). */
  loopDetectionWindow: number;
  enabled: boolean;
}

export interface SecuritySettings {
  /** Encrypt credentials at rest (always true in practice; exposed for transparency). */
  encryptCredentials: boolean;
  /** Redact secrets from logs and API responses. */
  redactLogs: boolean;
  /** Fence untrusted content (repo files, web) in prompts. */
  promptInjectionDefense: boolean;
  /** Require approval for destructive ops even in AUTO mode. */
  alwaysConfirmDestructive: boolean;
  /** Block agents from reading files matching these globs (e.g. .env). */
  secretFileGlobs: string[];
  /** Send repo content to providers at all (a hard privacy gate). */
  allowRepoContentToProviders: boolean;
}

export interface AppSettings {
  theme: ThemeMode;
  /** Keyboard shortcut hints shown in the UI. */
  denseMode: boolean;
  executionMode: ExecutionMode;
  freeOnlyMode: boolean;
  telemetryRetentionDays: number;
  eventRetentionDays: number;
  router: RouterSettings;
  sandbox: SandboxSettings;
  quota: QuotaSettings;
  supervisor: SupervisorSettings;
  security: SecuritySettings;
  /** Notifications toggles. */
  notifications: { approvals: boolean; failures: boolean; quota: boolean; desktop: boolean };
}

export const DEFAULT_RESERVE_FRACTION = 0.05;
