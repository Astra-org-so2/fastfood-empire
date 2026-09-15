/**
 * Command policy for the sandbox (§16, §30, §44).
 *
 * Agents run real commands. This module is the single chokepoint that decides
 * whether a command may run, must be approved by a human, or is forbidden
 * outright. It is intentionally conservative and *deterministic*: the model's
 * opinion about whether something is safe is never an input.
 *
 * Categories:
 *  - forbidden: never run, regardless of mode (kernel/filesystem destruction,
 *    privilege escalation, credential exfiltration, reverse shells).
 *  - approval_required: legitimate but dangerous (force push, deletes outside
 *    the workspace, package publishing, database drops, chmod 777).
 *  - allowed: everything else that passes the shell-metacharacter audit.
 */

export type CommandVerdict = 'allowed' | 'approval_required' | 'forbidden';

export interface CommandRule {
  id: string;
  verdict: Exclude<CommandVerdict, 'allowed'>;
  /** Regex tested against the raw command string. */
  pattern: RegExp;
  reason: string;
}

export interface CommandAssessment {
  verdict: CommandVerdict;
  reasons: { rule: string; reason: string; severity: 'low' | 'medium' | 'high' | 'critical' }[];
  /** Human readable summary for the approval dialog or the log. */
  summary: string;
}

export const FORBIDDEN_RULES: CommandRule[] = [
  { id: 'rm-root', verdict: 'forbidden', pattern: /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, reason: 'recursive delete of the filesystem root' },
  { id: 'rm-home-wildcard', verdict: 'forbidden', pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?[a-zA-Z]*\s+(~|\$HOME)\b/, reason: 'recursive delete of the home directory' },
  { id: 'mkfs', verdict: 'forbidden', pattern: /\bmkfs(\.\w+)?\b/, reason: 'filesystem format' },
  { id: 'dd-device', verdict: 'forbidden', pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|vd)/, reason: 'raw write to a block device' },
  { id: 'redirect-device', verdict: 'forbidden', pattern: />\s*\/dev\/(sd|nvme|hd|vd)/, reason: 'raw write to a block device' },
  { id: 'fork-bomb', verdict: 'forbidden', pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { id: 'chmod-root', verdict: 'forbidden', pattern: /\bchmod\s+(-R\s+)?777\s+\/(\s|$)/, reason: 'world-writable root' },
  { id: 'chown-system', verdict: 'forbidden', pattern: /\bchown\s+(-R\s+)?[^\s]+\s+(\/(usr|etc|bin|boot|sys|proc)\b)/, reason: 'ownership change on system directories' },
  { id: 'sudo', verdict: 'forbidden', pattern: /(^|[;&|]\s*)sudo\b/, reason: 'privilege escalation is never permitted inside the sandbox' },
  { id: 'su', verdict: 'forbidden', pattern: /(^|[;&|]\s*)(su|doas)\s+(-\s+)?\w*/, reason: 'user switching is never permitted inside the sandbox' },
  { id: 'pipe-to-shell', verdict: 'forbidden', pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k|d)?sh\b/, reason: 'piping a remote script into a shell' },
  { id: 'bash-remote', verdict: 'forbidden', pattern: /\b(ba|z|k)?sh\s+-c\s+["']\$?\(\s*(curl|wget)/, reason: 'executing a remotely fetched script' },
  { id: 'reverse-shell', verdict: 'forbidden', pattern: /\b(nc|ncat|netcat|socat)\b[^\n]*\b(-e|-c)\b[^\n]*\/(ba)?sh\b/, reason: 'reverse shell' },
  { id: 'devtcp', verdict: 'forbidden', pattern: /\/dev\/tcp\//, reason: 'raw network socket via /dev/tcp' },
  { id: 'history-clear', verdict: 'forbidden', pattern: /\b(history\s+-c|unset\s+HISTFILE)\b/, reason: 'audit trail tampering' },
  { id: 'logs-clear', verdict: 'forbidden', pattern: />\s*\/var\/log\//, reason: 'log tampering' },
  { id: 'crontab', verdict: 'forbidden', pattern: /\bcrontab\b/, reason: 'scheduling persistent jobs outside the sandbox' },
  { id: 'systemctl', verdict: 'forbidden', pattern: /\b(systemctl|service)\s+(start|stop|restart|disable|enable|mask)\b/, reason: 'host service control' },
  { id: 'ssh-write', verdict: 'forbidden', pattern: /(>>?|tee)\s*[^\n]*\.ssh\/(authorized_keys|id_)/, reason: 'SSH key manipulation' },
  { id: 'exfil-env', verdict: 'forbidden', pattern: /\b(curl|wget|nc)\b[^\n]*(\$\(?env\b|printenv|process\.env|\$\{?[A-Z_]*(KEY|TOKEN|SECRET))/, reason: 'attempting to send credentials over the network' },
  { id: 'npm-publish', verdict: 'forbidden', pattern: /\b(npm|yarn|pnpm)\s+publish\b/, reason: 'publishing a package is never an autonomous action' },
  { id: 'docker-host', verdict: 'forbidden', pattern: /\bdocker\s+(run|exec)[^\n]*(-v|--volume)\s*\/:/, reason: 'mounting the host filesystem into a container' },
];

export const APPROVAL_RULES: CommandRule[] = [
  { id: 'git-force-push', verdict: 'approval_required', pattern: /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease)/, reason: 'force push rewrites shared history' },
  { id: 'git-reset-hard', verdict: 'approval_required', pattern: /\bgit\s+reset\s+--hard\b/, reason: 'discards uncommitted work irreversibly' },
  { id: 'git-clean', verdict: 'approval_required', pattern: /\bgit\s+clean\b[^\n]*-[a-zA-Z]*[fd]/, reason: 'deletes untracked files irreversibly' },
  { id: 'git-filter', verdict: 'approval_required', pattern: /\bgit\s+filter-(branch|repo)\b/, reason: 'rewrites repository history' },
  { id: 'rm-rf', verdict: 'approval_required', pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s/, reason: 'recursive forced delete' },
  { id: 'rm-any-recursive', verdict: 'approval_required', pattern: /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s/, reason: 'recursive delete' },
  { id: 'sql-drop', verdict: 'approval_required', pattern: /\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA|INDEX)\b/i, reason: 'destructive database operation' },
  { id: 'sql-delete-all', verdict: 'approval_required', pattern: /\bDELETE\s+FROM\s+\w+\s*(;|$)/i, reason: 'unbounded DELETE (no WHERE clause)' },
  { id: 'db-migrate-down', verdict: 'approval_required', pattern: /\b(migrate|migration)\b[^\n]*\b(down|revert|rollback)\b/i, reason: 'reverting a migration destroys data' },
  { id: 'prod-deploy', verdict: 'approval_required', pattern: /\b(kubectl\s+(apply|delete|rollout)|terraform\s+(apply|destroy)|helm\s+(install|upgrade|delete)|vercel\s+--prod|netlify\s+deploy\s+--prod|aws\s+\w+\s+(create|delete|update)|gcloud\s+\w+\s+(create|delete|update)|fly\s+deploy|heroku\s+(deploy|pg:reset))\b/, reason: 'production infrastructure or deployment change' },
  { id: 'env-write', verdict: 'approval_required', pattern: /(>>?|tee)\s*[^\n]*\.env(\.\w+)?\b/, reason: 'writing environment files can expose or destroy secrets' },
  { id: 'chmod-setuid', verdict: 'approval_required', pattern: /\bchmod\s+[ugoa]*\+s\b|\bchmod\s+4[0-9]{3}\b/, reason: 'setuid bit grants privilege escalation' },
  { id: 'shell-profile', verdict: 'approval_required', pattern: /(>>?|tee)\s*[^\n]*\.(bashrc|zshrc|profile|bash_profile)\b/, reason: 'modifying shell profiles creates persistence' },
  { id: 'npm-global-install', verdict: 'approval_required', pattern: /\b(npm|yarn|pnpm)\s+(i|install|add)\s+(-g|--global)\b/, reason: 'global package installation affects the whole machine' },
  { id: 'kill-broad', verdict: 'approval_required', pattern: /\b(pkill|killall)\b|\bkill\s+-9\s+-1\b/, reason: 'broad process termination can kill unrelated work' },
  { id: 'disk-write-large', verdict: 'approval_required', pattern: /\bfallocate\b|\bfallocr?ate\s+-l\s+\d{10,}/, reason: 'large preallocated disk write' },
];

const SHELL_METACHARACTER_AUDIT: { id: string; pattern: RegExp; reason: string; severity: 'low' | 'medium' | 'high' }[] = [
  { id: 'command-substitution', pattern: /\$\(|`/, reason: 'command substitution present; arguments are not statically verifiable', severity: 'medium' },
  { id: 'unquoted-variable', pattern: /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?![^ ]*")/, reason: 'unquoted variable expansion', severity: 'low' },
];

export function assessCommand(
  command: string,
  options: {
    cwd?: string;
    workspaceRoot?: string;
    /** Extra operator-configured prefixes that always require approval. */
    approvalRequiredPrefixes?: string[];
    /** Operator-configured allowlist prefixes (empty = no restriction). */
    allowedCommandPrefixes?: string[];
    /** Absolute paths that must never appear as command targets. */
    deniedPaths?: string[];
  } = {},
): CommandAssessment {
  const reasons: CommandAssessment['reasons'] = [];
  const cmd = command.trim();
  if (!cmd) {
    return { verdict: 'forbidden', reasons: [{ rule: 'empty', reason: 'empty command', severity: 'low' }], summary: 'Empty command rejected.' };
  }

  for (const rule of FORBIDDEN_RULES) {
    if (rule.pattern.test(cmd)) {
      return {
        verdict: 'forbidden',
        reasons: [{ rule: rule.id, reason: rule.reason, severity: 'critical' }],
        summary: `Forbidden command (${rule.id}): ${rule.reason}.`,
      };
    }
  }

  for (const rule of APPROVAL_RULES) {
    if (rule.pattern.test(cmd)) {
      reasons.push({ rule: rule.id, reason: rule.reason, severity: 'high' });
    }
  }

  for (const prefix of options.approvalRequiredPrefixes ?? []) {
    if (prefix && cmd.includes(prefix)) {
      reasons.push({ rule: 'configured-prefix', reason: `command contains configured dangerous sequence "${prefix}"`, severity: 'high' });
    }
  }

  for (const denied of options.deniedPaths ?? []) {
    if (denied && cmd.includes(denied)) {
      return {
        verdict: 'forbidden',
        reasons: [{ rule: 'denied-path', reason: `command references denied path ${denied}`, severity: 'critical' }],
        summary: `Forbidden: command references a denied path (${denied}).`,
      };
    }
  }

  for (const audit of SHELL_METACHARACTER_AUDIT) {
    if (audit.pattern.test(cmd)) {
      reasons.push({ rule: audit.id, reason: audit.reason, severity: audit.severity });
    }
  }

  if (options.allowedCommandPrefixes?.length) {
    const first = cmd.split(/\s|;|&&|\|\|/)[0] ?? '';
    const permitted = options.allowedCommandPrefixes.some((p) => p && (first === p || cmd.startsWith(p)));
    if (!permitted) {
      reasons.push({ rule: 'not-in-allowlist', reason: `"${first}" is not in the configured command allowlist`, severity: 'high' });
    }
  }

  if (reasons.length === 0) {
    return { verdict: 'allowed', reasons: [], summary: 'Command allowed.' };
  }

  const worst = reasons.some((r) => r.severity === 'high') ? 'approval_required' : 'approval_required';
  return {
    verdict: worst,
    reasons,
    summary: `Approval required: ${reasons.map((r) => r.reason).join('; ')}.`,
  };
}

/** Commands we consider safe to run read-only for analysis without approval. */
export const READ_ONLY_COMMANDS = ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'stat', 'file', 'which', 'git status', 'git diff', 'git log', 'git branch', 'git show', 'node -e', 'npm test', 'npm run lint', 'npm run build', 'npm run typecheck', 'pytest', 'cargo test', 'go test'];

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (/[>|&;`$()]/.test(trimmed)) return false;
  return READ_ONLY_COMMANDS.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `));
}
