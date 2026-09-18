/**
 * Execution-mode gate (§44).
 *
 * AUTO        — agents may act autonomously; only destructive operations ask.
 * SUPERVISED  — every state-changing operation that is not provably safe asks.
 * MANUAL      — nothing runs without an explicit approval decision.
 *
 * This module decides *whether* approval is needed. Granting/denying approvals
 * is handled by the orchestrator's ApprovalService (which persists them).
 */
import type { ExecutionMode } from '@aido/types';
import { assessCommand, type CommandAssessment } from './command-policy.js';
import type { PathDecision } from './path-guard.js';

export type ActionClass =
  | 'read_file'
  | 'write_file'
  | 'delete_file'
  | 'run_command'
  | 'git_commit'
  | 'git_branch'
  | 'git_push'
  | 'git_force_push'
  | 'install_dependency'
  | 'database_write'
  | 'deploy'
  | 'network_request'
  | 'spend_money';

export interface GateDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  /** Set when the action is refused regardless of mode. */
  forbidden: boolean;
}

const ALWAYS_FORBIDDEN: ActionClass[] = [];
const HIGH_RISK: ActionClass[] = ['delete_file', 'git_force_push', 'deploy', 'database_write', 'spend_money'];
const MEDIUM_RISK: ActionClass[] = ['run_command', 'install_dependency', 'git_push', 'write_file'];

export interface GateContext {
  executionMode: ExecutionMode;
  /** Operator setting: keep confirming destructive ops even in AUTO. */
  alwaysConfirmDestructive: boolean;
  commandAssessment?: CommandAssessment;
  pathDecision?: PathDecision;
  /** Destructive operations that the operator pre-approved for this project. */
  preApprovedActions?: string[];
}

export function evaluateGate(action: ActionClass, context: GateContext): GateDecision {
  const actionKey = action;
  if (ALWAYS_FORBIDDEN.includes(actionKey)) {
    return { allowed: false, requiresApproval: false, forbidden: true, risk: 'high', reason: `${action} is never permitted.` };
  }

  if (context.commandAssessment && context.commandAssessment.verdict === 'forbidden') {
    return {
      allowed: false,
      requiresApproval: false,
      forbidden: true,
      risk: 'high',
      reason: context.commandAssessment.summary,
    };
  }

  if (context.pathDecision && !context.pathDecision.allowed) {
    return {
      allowed: false,
      requiresApproval: false,
      forbidden: true,
      risk: 'high',
      reason: `Filesystem access denied (${context.pathDecision.category}): ${context.pathDecision.reason}`,
    };
  }

  if (context.preApprovedActions?.includes(action)) {
    return { allowed: true, requiresApproval: false, forbidden: false, risk: 'low', reason: `${action} was pre-approved for this project.` };
  }

  const risky = HIGH_RISK.includes(action) ? 'high' : MEDIUM_RISK.includes(action) ? 'medium' : 'low';

  switch (context.executionMode) {
    case 'manual':
      return {
        allowed: false,
        requiresApproval: true,
        forbidden: false,
        risk: risky,
        reason: `Execution mode is MANUAL: ${action} requires explicit approval.`,
      };
    case 'supervised':
      if (risky === 'low' && action === 'read_file') {
        return { allowed: true, requiresApproval: false, forbidden: false, risk: 'low', reason: 'read-only operation permitted in SUPERVISED mode.' };
      }
      if (context.commandAssessment && context.commandAssessment.verdict === 'approval_required') {
        return { allowed: false, requiresApproval: true, forbidden: false, risk: 'high', reason: context.commandAssessment.summary };
      }
      return {
        allowed: false,
        requiresApproval: true,
        forbidden: false,
        risk: risky,
        reason: `Execution mode is SUPERVISED: ${action} requires approval.`,
      };
    case 'auto':
    default: {
      if (context.commandAssessment?.verdict === 'approval_required') {
        return {
          allowed: false,
          requiresApproval: true,
          forbidden: false,
          risk: 'high',
          reason: `${context.commandAssessment.summary} (destructive operations always require confirmation)`,
        };
      }
      if (context.alwaysConfirmDestructive && risky === 'high') {
        return {
          allowed: false,
          requiresApproval: true,
          forbidden: false,
          risk: 'high',
          reason: `AUTO mode still requires confirmation for ${action} because "always confirm destructive operations" is enabled.`,
        };
      }
      return { allowed: true, requiresApproval: false, forbidden: false, risk: risky, reason: `AUTO mode permits ${action}.` };
    }
  }
}

export function assessShellAction(
  command: string,
  options: {
    workspaceRoot: string;
    deniedPaths: string[];
    approvalRequiredPrefixes: string[];
    allowedCommandPrefixes: string[];
  },
): CommandAssessment {
  return assessCommand(command, {
    workspaceRoot: options.workspaceRoot,
    deniedPaths: options.deniedPaths,
    approvalRequiredPrefixes: options.approvalRequiredPrefixes,
    allowedCommandPrefixes: options.allowedCommandPrefixes,
  });
}
