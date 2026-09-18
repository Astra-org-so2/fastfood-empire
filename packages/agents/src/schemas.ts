import { z } from 'zod';
import type { AgentRoleDefinition } from '@aido/types';

/**
 * Output contracts for agents.
 *
 * Every agent must return structured output. This is what makes the system an
 * engineering pipeline rather than a chat interface: the orchestrator validates
 * what came back, and a malformed response becomes a bounded, retryable failure
 * instead of silently corrupted project state.
 *
 * The JSON Schemas below are sent to providers that support structured output;
 * the Zod schemas validate whatever comes back (including from providers that do
 * not, where we parse leniently and then validate strictly).
 */

export const ToolCallSchema = z.object({
  tool: z.enum([
    'read_file',
    'write_file',
    'list_files',
    'search_files',
    'run_tests',
    'run_lint',
    'run_build',
    'run_command',
    'git_status',
    'git_diff',
    'git_commit',
    'git_branch',
    'static_analysis',
    'package_manager',
    'web_search',
  ]),
  args: z.record(z.unknown()).default({}),
  /** Why the agent needs this; shown in the activity stream. */
  purpose: z.string().max(400).optional(),
});

export const FindingSchema = z.object({
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  message: z.string().min(1).max(2_000),
  location: z.string().max(500).optional(),
});

export const ArtifactSchema = z.object({
  path: z.string().min(1).max(500),
  action: z.enum(['created', 'modified', 'deleted']),
  diff: z.string().max(20_000).optional(),
});

/**
 * The universal agent response envelope. Agents either report a completed result
 * or request more tool calls. `reasoning_summary` is deliberately a *summary*:
 * hidden chain-of-thought is neither requested nor exposed (§25).
 */
export const AgentResponseSchema = z.object({
  reasoning_summary: z.string().max(2_000).default(''),
  actions: z.array(ToolCallSchema).max(8).default([]),
  result: z
    .object({
      summary: z.string().min(1).max(8_000),
      artifacts: z.array(ArtifactSchema).max(100).default([]),
      testsRun: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string().optional() })).max(200).optional(),
      findings: z.array(FindingSchema).max(100).optional(),
      decisions: z.array(z.object({ title: z.string(), rationale: z.string() })).max(40).optional(),
      data: z.record(z.unknown()).optional(),
      approvalRequest: z
        .object({
          action: z.string(),
          reason: z.string(),
          risk: z.enum(['low', 'medium', 'high']),
        })
        .optional(),
    })
    .nullable()
    .default(null),
  status: z.enum(['working', 'completed', 'blocked', 'needs_approval']).default('working'),
  blocker: z.string().max(2_000).nullable().default(null),
});

export type AgentResponsePayload = z.infer<typeof AgentResponseSchema>;

/** JSON Schema for the response envelope, used with structured-output providers. */
export const AGENT_RESPONSE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reasoning_summary: { type: 'string', description: 'Two or three sentences: what you did and why. Not private deliberation.' },
    actions: {
      type: 'array',
      description: 'Tool calls to run before you can produce a final result. Empty when you are finishing.',
      items: {
        type: 'object',
        properties: {
          tool: {
            type: 'string',
            enum: [
              'read_file',
              'write_file',
              'list_files',
              'search_files',
              'run_tests',
              'run_lint',
              'run_build',
              'run_command',
              'git_status',
              'git_diff',
              'git_commit',
              'git_branch',
              'static_analysis',
              'package_manager',
              'web_search',
            ],
          },
          args: { type: 'object' },
          purpose: { type: 'string' },
        },
        required: ['tool'],
      },
    },
    result: {
      type: ['object', 'null'],
      properties: {
        summary: { type: 'string' },
        artifacts: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, action: { type: 'string', enum: ['created', 'modified', 'deleted'] } }, required: ['path', 'action'] } },
        findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] }, message: { type: 'string' }, location: { type: 'string' } }, required: ['severity', 'message'] } },
        decisions: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, rationale: { type: 'string' } }, required: ['title', 'rationale'] } },
      },
      required: ['summary'],
    },
    status: { type: 'string', enum: ['working', 'completed', 'blocked', 'needs_approval'] },
    blocker: { type: ['string', 'null'] },
  },
  required: ['reasoning_summary', 'status'],
};

// ---------------------------------------------------------------------------
// Architecture proposal
// ---------------------------------------------------------------------------

export const ArchitectureProposalSchema = z.object({
  summary: z.string().min(10).max(4_000),
  assumptions: z.array(z.string().max(500)).max(30).default([]),
  stack: z.array(z.object({ layer: z.string(), choice: z.string(), rationale: z.string() })).min(1).max(40),
  components: z
    .array(
      z.object({
        name: z.string(),
        responsibility: z.string(),
        technologies: z.array(z.string()).max(20).default([]),
        dependsOn: z.array(z.string()).max(30).default([]),
      }),
    )
    .min(1)
    .max(60),
  dataModel: z
    .array(z.object({ entity: z.string(), fields: z.array(z.string()).max(80), relations: z.array(z.string()).max(40).default([]) }))
    .max(60)
    .default([]),
  apiSurface: z.array(z.object({ method: z.string(), path: z.string(), purpose: z.string() })).max(200).default([]),
  projectStructure: z.array(z.object({ path: z.string(), purpose: z.string() })).max(200).default([]),
  risks: z.array(z.object({ risk: z.string(), mitigation: z.string(), severity: z.enum(['low', 'medium', 'high']) })).max(40).default([]),
  openQuestions: z.array(z.string().max(500)).max(30).default([]),
  delivery: z.array(z.string()).max(40).default([]),
});

export const ARCHITECTURE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    stack: { type: 'array', items: { type: 'object', properties: { layer: { type: 'string' }, choice: { type: 'string' }, rationale: { type: 'string' } }, required: ['layer', 'choice', 'rationale'] } },
    components: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, responsibility: { type: 'string' }, technologies: { type: 'array', items: { type: 'string' } }, dependsOn: { type: 'array', items: { type: 'string' } } }, required: ['name', 'responsibility'] },
    },
    dataModel: { type: 'array', items: { type: 'object', properties: { entity: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } }, relations: { type: 'array', items: { type: 'string' } } }, required: ['entity'] } },
    apiSurface: { type: 'array', items: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, purpose: { type: 'string' } }, required: ['method', 'path', 'purpose'] } },
    projectStructure: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, purpose: { type: 'string' } }, required: ['path', 'purpose'] } },
    risks: { type: 'array', items: { type: 'object', properties: { risk: { type: 'string' }, mitigation: { type: 'string' }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['risk', 'mitigation', 'severity'] } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    delivery: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'stack', 'components'],
};

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export const PlanTaskSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(6_000),
  agent: z.enum(['architect', 'project_manager', 'frontend', 'backend', 'database', 'qa', 'security', 'code_review', 'devops', 'performance', 'research']),
  taskType: z.enum([
    'architecture',
    'planning',
    'code_generation',
    'refactor',
    'test_generation',
    'test_execution_analysis',
    'security_audit',
    'code_review',
    'documentation',
    'research',
    'devops',
    'database_design',
    'performance_analysis',
    'summarization',
    'classification',
    'general',
  ]),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  dependsOn: z.array(z.string()).max(30).default([]),
  resourceLocks: z.array(z.string()).max(30).default([]),
  acceptanceCriteria: z.array(z.string()).max(20).default([]),
});

export const PlanSchema = z.object({
  summary: z.string().min(10).max(4_000),
  tasks: z.array(PlanTaskSchema).min(1).max(120),
  notes: z.array(z.string().max(500)).max(30).default([]),
});

export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          agent: { type: 'string', enum: ['architect', 'project_manager', 'frontend', 'backend', 'database', 'qa', 'security', 'code_review', 'devops', 'performance', 'research'] },
          taskType: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'critical'] },
          dependsOn: { type: 'array', items: { type: 'string' } },
          resourceLocks: { type: 'array', items: { type: 'string' } },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'description', 'agent', 'taskType'],
      },
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'tasks'],
};

// ---------------------------------------------------------------------------
// Review / security / test report
// ---------------------------------------------------------------------------

export const ReviewSchema = z.object({
  summary: z.string().min(5).max(4_000),
  verdict: z.enum(['approve', 'approve_with_suggestions', 'request_changes', 'block']),
  blocking: z
    .array(z.object({ message: z.string(), location: z.string().optional(), why: z.string().optional() }))
    .max(60)
    .default([]),
  suggestions: z.array(z.object({ message: z.string(), location: z.string().optional() })).max(60).default([]),
  positives: z.array(z.string().max(500)).max(30).default([]),
  confidence: z.number().min(0).max(1).default(0.6),
  /** Whether the reviewer actually inspected the diff. */
  inspected: z.object({ diff: z.boolean().default(false), files: z.array(z.string()).max(100).default([]) }).default({ diff: false, files: [] }),
});

export const REVIEW_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    verdict: { type: 'string', enum: ['approve', 'approve_with_suggestions', 'request_changes', 'block'] },
    blocking: { type: 'array', items: { type: 'object', properties: { message: { type: 'string' }, location: { type: 'string' }, why: { type: 'string' } }, required: ['message'] } },
    suggestions: { type: 'array', items: { type: 'object', properties: { message: { type: 'string' }, location: { type: 'string' } }, required: ['message'] } },
    positives: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
    inspected: { type: 'object', properties: { diff: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } } } },
  },
  required: ['summary', 'verdict'],
};

export const TestReportSchema = z.object({
  summary: z.string().min(5).max(4_000),
  command: z.string().max(400).default(''),
  passed: z.number().int().min(0).default(0),
  failed: z.number().int().min(0).default(0),
  skipped: z.number().int().min(0).default(0),
  durationMs: z.number().min(0).nullable().default(null),
  executed: z.boolean().default(false),
  failures: z.array(z.object({ name: z.string(), message: z.string().max(2_000) })).max(100).default([]),
  coverageNotes: z.string().max(2_000).optional(),
});

export const TEST_REPORT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    command: { type: 'string' },
    passed: { type: 'number' },
    failed: { type: 'number' },
    skipped: { type: 'number' },
    durationMs: { type: ['number', 'null'] },
    executed: { type: 'boolean' },
    failures: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, message: { type: 'string' } }, required: ['name'] } },
    coverageNotes: { type: 'string' },
  },
  required: ['summary', 'executed'],
};

export type SchemaName = AgentRoleDefinition['outputSchema'];

export function schemaFor(name: SchemaName): { jsonSchema: Record<string, unknown> | null; zod: z.ZodTypeAny | null } {
  switch (name) {
    case 'architecture_proposal':
      return { jsonSchema: ARCHITECTURE_JSON_SCHEMA, zod: ArchitectureProposalSchema };
    case 'plan':
      return { jsonSchema: PLAN_JSON_SCHEMA, zod: PlanSchema };
    case 'review':
      return { jsonSchema: REVIEW_JSON_SCHEMA, zod: ReviewSchema };
    case 'test_report':
      return { jsonSchema: TEST_REPORT_JSON_SCHEMA, zod: TestReportSchema };
    case 'task_result':
      return { jsonSchema: AGENT_RESPONSE_JSON_SCHEMA, zod: null };
    case 'plain':
    default:
      return { jsonSchema: null, zod: null };
  }
}

/** Instructions appended to the system prompt describing the required output. */
export function outputInstructions(name: SchemaName): string {
  switch (name) {
    case 'architecture_proposal':
      return [
        'Return a single JSON object matching this shape (no prose outside the JSON):',
        '{"summary": string, "assumptions": string[], "stack": [{"layer","choice","rationale"}], "components": [{"name","responsibility","technologies": [],"dependsOn": []}], "dataModel": [{"entity","fields": [],"relations": []}], "apiSurface": [{"method","path","purpose"}], "projectStructure": [{"path","purpose"}], "risks": [{"risk","mitigation","severity":"low|medium|high"}], "openQuestions": string[], "delivery": string[]}',
        'Every stack choice needs its rationale in the same sentence. Keep component responsibilities to one sentence each.',
      ].join('\n');
    case 'plan':
      return [
        'Return a single JSON object matching this shape (no prose outside the JSON):',
        '{"summary": string, "tasks": [{"id","title","description","agent":"architect|project_manager|frontend|backend|database|qa|security|code_review|devops|performance|research","taskType":"architecture|planning|code_generation|refactor|test_generation|security_audit|code_review|documentation|research|devops|database_design|performance_analysis","priority":"low|normal|high|critical","dependsOn": [taskId], "resourceLocks": ["file:path"], "acceptanceCriteria": string[]}], "notes": string[]}',
        'Task ids must be short slugs and must be unique. dependsOn may only reference ids declared in this same plan. resourceLocks must list the files each task will write, so parallel tasks cannot collide.',
      ].join('\n');
    case 'review':
      return [
        'Return a single JSON object matching this shape (no prose outside the JSON):',
        '{"summary": string, "verdict":"approve|approve_with_suggestions|request_changes|block", "blocking": [{"message","location","why"}], "suggestions": [{"message","location"}], "positives": string[], "confidence": 0..1, "inspected": {"diff": boolean, "files": string[]}}',
        'Only report issues you are confident about. An empty blocking list with an approve verdict is a valid and welcome outcome when the change is correct.',
      ].join('\n');
    case 'test_report':
      return [
        'Return a single JSON object matching this shape (no prose outside the JSON):',
        '{"summary": string, "command": string, "passed": number, "failed": number, "skipped": number, "durationMs": number|null, "executed": boolean, "failures": [{"name","message"}], "coverageNotes": string}',
        'Set "executed": true only if you actually ran a test command and saw its output. Never report a pass you did not observe.',
      ].join('\n');
    case 'task_result':
      return [
        'Return a single JSON object:',
        '{"reasoning_summary": string, "actions": [{"tool": string, "args": object, "purpose": string}], "result": {"summary": string, "artifacts": [{"path","action":"created|modified|deleted"}], "findings": [{"severity":"info|low|medium|high|critical","message","location"}], "decisions": [{"title","rationale"}], "approvalRequest": {"action","reason","risk":"low|medium|high"}} | null, "status": "working|completed|blocked|needs_approval", "blocker": string|null}',
        'Use "status": "working" with a non-empty actions list when you need to inspect or change something first. Use "status": "completed" with a populated result when the task is done.',
        'If the task requires a destructive operation (deleting files, force-pushing, dropping data, deploying), do not perform it: set status "needs_approval" with an approvalRequest describing the action and its risk.',
      ].join('\n');
    default:
      return '';
  }
}
