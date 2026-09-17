/** Task graph, agents, approvals and orchestration types. */
import type { Priority, TaskType } from './provider.js';

export type TaskStatus =
  | 'backlog'
  | 'blocked'
  | 'ready'
  | 'running'
  | 'in_review'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'paused';

export type AgentId =
  | 'architect'
  | 'project_manager'
  | 'frontend'
  | 'backend'
  | 'database'
  | 'qa'
  | 'security'
  | 'code_review'
  | 'devops'
  | 'performance'
  | 'research'
  | 'supervisor';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  /** Which agent role should own this task. */
  agentRole: AgentId;
  taskType: TaskType;
  status: TaskStatus;
  priority: Priority;
  /** DAG edges: ids of tasks that must be `done` first. */
  dependsOn: string[];
  /** Resource locks (e.g. 'file:src/app.ts', 'git:index') preventing concurrent writes. */
  resourceLocks: string[];
  /** Parent task for hierarchical decomposition. */
  parentId: string | null;
  orderIndex: number;
  estimatedInputTokens: number | null;
  estimatedOutputTokens: number | null;
  /** Result payload (structured, validated against the agent's output schema). */
  result: TaskResult | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  /** Model chosen for the last/current run — kept for "why this model?" inspection. */
  lastModelId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TaskResult {
  summary: string;
  /** Files the agent claims it changed (verified against the sandbox afterwards). */
  artifacts: TaskArtifact[];
  testsRun?: { name: string; passed: boolean; detail?: string }[];
  findings?: { severity: 'info' | 'low' | 'medium' | 'high' | 'critical'; message: string; location?: string }[];
  decisions?: { title: string; rationale: string }[];
  /** Free-form structured output validated by the agent's schema. */
  data?: Record<string, unknown>;
  tokenUsage?: { input: number; output: number };
  /** Set when the agent requests human approval before continuing. */
  approvalRequest?: { action: string; reason: string; risk: 'low' | 'medium' | 'high' };
}

export interface TaskArtifact {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  /** Unified diff snippet, truncated for storage sanity. */
  diff?: string;
  bytes?: number;
}

export type AgentState = 'idle' | 'working' | 'waiting' | 'blocked' | 'error' | 'paused' | 'offline';

export interface AgentRuntimeStatus {
  agentId: AgentId;
  state: AgentState;
  currentTaskId: string | null;
  currentModelId: string | null;
  currentProviderId: string | null;
  iterations: number;
  tokensUsedToday: number;
  requestsToday: number;
  lastActionAt: string | null;
  lastError: string | null;
  /** Rolling success rate over recent tasks. */
  successRate: number | null;
  tasksCompleted: number;
  tasksFailed: number;
  enabled: boolean;
}

export interface AgentRoleDefinition {
  id: AgentId;
  name: string;
  tagline: string;
  responsibility: string;
  responsibilities: string[];
  /** Task types this agent consumes. */
  handledTaskTypes: TaskType[];
  /** Preferred model attributes; the router turns these into scoring weights. */
  modelPreference: {
    requiredCapabilities: (keyof import('./provider.js').ModelCapabilities)[];
    preferCapabilities: (keyof import('./provider.js').ModelCapabilities)[];
    minContextWindow: number;
    qualityRequirement: 'low' | 'medium' | 'high' | 'maximum';
    maxLatencyMs: number | null;
    /** Whether this agent may fall back to paid models when FREE_ONLY is off. */
    allowTrialCredits: boolean;
  };
  /** Tools the agent may invoke inside the sandbox. */
  tools: AgentTool[];
  /** Output contract the orchestrator validates before accepting a result. */
  outputSchema: 'task_result' | 'architecture_proposal' | 'plan' | 'review' | 'test_report' | 'plain';
  /** Hard resource limits (§43). */
  limits: AgentLimits;
  /** Colour/icon hint for the UI. */
  accent: string;
  systemPrompt: string;
}

export type AgentTool =
  | 'read_file'
  | 'write_file'
  | 'list_files'
  | 'search_files'
  | 'run_tests'
  | 'run_lint'
  | 'run_build'
  | 'run_command'
  | 'git_status'
  | 'git_diff'
  | 'git_commit'
  | 'git_branch'
  | 'static_analysis'
  | 'package_manager'
  | 'web_search';

export interface AgentLimits {
  maxTokens: number;
  maxRequests: number;
  maxRuntimeMs: number;
  maxRetries: number;
  maxFilesChanged: number;
  maxShellCommands: number;
}

export interface ApprovalRequest {
  id: string;
  projectId: string;
  taskId: string | null;
  agentId: AgentId | null;
  action: string;
  reason: string;
  risk: 'low' | 'medium' | 'high';
  payload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  /**
   * How far the decision reaches: `once` covers the paused step (the next attempt of the
   * task), `task` covers the rest of that task. Null while the request is undecided.
   */
  decisionScope: 'once' | 'task' | null;
}

export type ExecutionMode = 'auto' | 'supervised' | 'manual';

/** Result of a single agent step, used by the scheduler loop. */
export interface AgentStepOutcome {
  taskId: string;
  agentId: AgentId;
  status: 'completed' | 'failed' | 'blocked' | 'paused' | 'awaiting_approval';
  result?: TaskResult;
  error?: string;
  modelId?: string;
  providerId?: string;
  tokenUsage?: { input: number; output: number };
  durationMs: number;
  /** Iterations consumed this step (for runaway detection). */
  iterations: number;
}
