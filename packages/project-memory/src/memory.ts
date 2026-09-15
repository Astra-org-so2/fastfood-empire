import type { AgentId, ArchitectureProposal, MemoryEntry, MemoryKind, ProjectSpec, TaskType } from '@aido/types';
import type { Store } from '@aido/storage';

/**
 * Shared project memory (§14).
 *
 * This is the team's long-term knowledge: what was asked for, what was decided and
 * why, what is currently true about the code and tests, and what each agent
 * concluded. Everything the agents know survives model switches, provider outages
 * and process restarts because it lives in the database, not in a chat transcript.
 *
 * Write policy:
 *  - agent-authored entries are stored with `trust: 'derived'`, which makes the
 *    context builder treat them as *data* rather than instructions (§31),
 *  - updating a key supersedes the previous version instead of deleting it, so
 *    "why did the architecture change?" stays answerable,
 *  - content-hash de-duplication stops summarisation passes from flooding the table.
 */

export interface MemoryWriteContext {
  agentId?: AgentId | null;
  taskId?: string | null;
  trust?: 'user' | 'system' | 'derived';
}

export const MEMORY_KEYS = {
  spec: 'project.specification',
  architecture: 'project.architecture',
  codeState: 'project.code_state',
  testState: 'project.test_state',
  delivery: 'project.delivery',
} as const;

export class ProjectMemory {
  constructor(private readonly store: Store) {}

  // -------------------------------------------------------------------------
  // Specification
  // -------------------------------------------------------------------------

  setSpecification(projectId: string, spec: ProjectSpec, context: MemoryWriteContext = {}): MemoryEntry {
    return this.write(
      projectId,
      {
        kind: 'specification',
        key: MEMORY_KEYS.spec,
        title: 'Project specification',
        body: renderSpecification(spec),
        importance: 1,
        relatedFiles: [],
        relatedTaskTypes: [],
      },
      context,
    );
  }

  specification(projectId: string): MemoryEntry | null {
    return this.store.memory.findByKey(projectId, MEMORY_KEYS.spec)[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Architecture & decisions
  // -------------------------------------------------------------------------

  setArchitecture(projectId: string, proposal: ArchitectureProposal, context: MemoryWriteContext = {}): MemoryEntry {
    return this.write(
      projectId,
      {
        kind: 'architecture',
        key: MEMORY_KEYS.architecture,
        title: 'Architecture',
        body: renderArchitecture(proposal),
        importance: 1,
        relatedFiles: proposal.projectStructure.map((entry) => entry.path),
        relatedTaskTypes: ['architecture', 'code_generation', 'refactor', 'code_review'],
      },
      context,
    );
  }

  architecture(projectId: string): MemoryEntry | null {
    return this.store.memory.findByKey(projectId, MEMORY_KEYS.architecture)[0] ?? null;
  }

  /** Architectural decision records: short, dated, with the reason attached. */
  addDecision(
    projectId: string,
    decision: { title: string; rationale: string; consequences?: string; alternatives?: string[]; relatedFiles?: string[] },
    context: MemoryWriteContext = {},
  ): MemoryEntry {
    const slug = decision.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);
    const body = [
      `**Decision:** ${decision.title}`,
      '',
      `**Rationale:** ${decision.rationale}`,
      decision.alternatives?.length ? `\n**Alternatives considered:** ${decision.alternatives.join('; ')}` : '',
      decision.consequences ? `\n**Consequences:** ${decision.consequences}` : '',
      context.agentId ? `\n**Decided by:** ${context.agentId}` : '',
      `**Recorded:** ${new Date().toISOString().slice(0, 10)}`,
    ]
      .filter(Boolean)
      .join('\n');
    return this.write(
      projectId,
      {
        kind: 'decision',
        key: `decision.${slug || 'untitled'}`,
        title: decision.title,
        body,
        importance: 0.85,
        relatedFiles: decision.relatedFiles ?? [],
        relatedTaskTypes: [],
      },
      context,
    );
  }

  decisions(projectId: string): MemoryEntry[] {
    return this.store.memory.list(projectId, { kinds: ['decision'] });
  }

  addConstraint(projectId: string, constraint: { title: string; body: string }, context: MemoryWriteContext = {}): MemoryEntry {
    return this.write(
      projectId,
      {
        kind: 'constraint',
        key: `constraint.${slugify(constraint.title)}`,
        title: constraint.title,
        body: constraint.body,
        importance: 0.9,
        relatedFiles: [],
        relatedTaskTypes: [],
      },
      context,
    );
  }

  constraints(projectId: string): MemoryEntry[] {
    return this.store.memory.list(projectId, { kinds: ['constraint'] });
  }

  // -------------------------------------------------------------------------
  // Agent findings, risks, known issues
  // -------------------------------------------------------------------------

  addFinding(
    projectId: string,
    finding: {
      title: string;
      body: string;
      severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
      relatedFiles?: string[];
      taskTypes?: TaskType[];
      kind?: Extract<MemoryKind, 'finding' | 'risk'>;
    },
    context: MemoryWriteContext = {},
  ): MemoryEntry {
    const severity = finding.severity ?? 'info';
    const importanceBySeverity: Record<string, number> = { critical: 1, high: 0.9, medium: 0.75, low: 0.5, info: 0.4 };
    return this.write(
      projectId,
      {
        kind: finding.kind ?? (severity === 'critical' || severity === 'high' ? 'risk' : 'finding'),
        // Findings accumulate rather than replace, so the key is unique per finding.
        key: `finding.${slugify(finding.title)}`,
        title: `[${severity.toUpperCase()}] ${finding.title}`,
        body: finding.body,
        importance: importanceBySeverity[severity] ?? 0.5,
        relatedFiles: finding.relatedFiles ?? [],
        relatedTaskTypes: finding.taskTypes ?? [],
      },
      context,
    );
  }

  openIssues(projectId: string, minImportance = 0.6): MemoryEntry[] {
    return this.store.memory.list(projectId, { kinds: ['finding', 'risk'], minImportance, limit: 100 });
  }

  // -------------------------------------------------------------------------
  // Code & test state
  // -------------------------------------------------------------------------

  setCodeState(
    projectId: string,
    state: { branch: string | null; headSha: string | null; changedFiles: { path: string; status: string }[]; commits: { sha: string; message: string }[]; summary?: string },
    context: MemoryWriteContext = {},
  ): MemoryEntry {
    const body = [
      `Branch: ${state.branch ?? '(none)'}`,
      `HEAD: ${state.headSha ?? '(no commits yet)'}`,
      state.commits.length ? `Recent commits:\n${state.commits.slice(0, 10).map((c) => `- ${c.sha.slice(0, 7)} ${c.message}`).join('\n')}` : 'No commits yet.',
      state.changedFiles.length ? `Working tree changes:\n${state.changedFiles.slice(0, 40).map((f) => `- ${f.status} ${f.path}`).join('\n')}` : 'Working tree clean.',
      state.summary ? `\n${state.summary}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return this.write(
      projectId,
      {
        kind: 'code_state',
        key: MEMORY_KEYS.codeState,
        title: 'Code state',
        body,
        importance: 0.8,
        relatedFiles: state.changedFiles.map((f) => f.path),
        relatedTaskTypes: ['code_generation', 'refactor', 'code_review'],
      },
      context,
    );
  }

  setTestState(
    projectId: string,
    state: { suite: string; command: string; status: string; passed: number; failed: number; skipped: number; durationMs: number | null; failing?: { name: string; message: string }[] },
    context: MemoryWriteContext = {},
  ): MemoryEntry {
    const body = [
      `Suite: ${state.suite} (${state.command})`,
      `Status: ${state.status}`,
      `Results: ${state.passed} passed, ${state.failed} failed, ${state.skipped} skipped${state.durationMs !== null ? ` in ${(state.durationMs / 1000).toFixed(1)}s` : ''}`,
      state.failing?.length ? `\nFailing tests:\n${state.failing.slice(0, 20).map((t) => `- ${t.name}: ${t.message.slice(0, 200)}`).join('\n')}` : '',
      `Recorded: ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join('\n');
    return this.write(
      projectId,
      {
        kind: 'test_state',
        key: MEMORY_KEYS.testState,
        title: 'Test state',
        body,
        importance: 0.85,
        relatedFiles: [],
        relatedTaskTypes: ['test_generation', 'code_review', 'security_audit'],
      },
      context,
    );
  }

  codeState(projectId: string): MemoryEntry | null {
    return this.store.memory.findByKey(projectId, MEMORY_KEYS.codeState)[0] ?? null;
  }

  testState(projectId: string): MemoryEntry | null {
    return this.store.memory.findByKey(projectId, MEMORY_KEYS.testState)[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Generic access
  // -------------------------------------------------------------------------

  list(projectId: string, query: Parameters<Store['memory']['list']>[1] = {}): MemoryEntry[] {
    return this.store.memory.list(projectId, query);
  }

  byKind(projectId: string, kind: MemoryKind): MemoryEntry[] {
    return this.store.memory.list(projectId, { kinds: [kind] });
  }

  stats(projectId: string) {
    return this.store.memory.stats(projectId);
  }

  private write(
    projectId: string,
    entry: {
      kind: MemoryKind;
      key: string;
      title: string;
      body: string;
      importance: number;
      relatedFiles: string[];
      relatedTaskTypes: TaskType[];
    },
    context: MemoryWriteContext,
  ): MemoryEntry {
    return this.store.memory.upsert({
      id: '',
      projectId,
      kind: entry.kind,
      key: entry.key,
      title: entry.title,
      body: entry.body,
      supersededBy: null,
      relatedFiles: entry.relatedFiles,
      relatedTaskTypes: entry.relatedTaskTypes,
      importance: entry.importance,
      sourceTaskId: context.taskId ?? null,
      sourceAgentId: context.agentId ?? null,
      trust: context.trust ?? (context.agentId ? 'derived' : 'system'),
    });
  }
}

export function renderSpecification(spec: ProjectSpec): string {
  return [
    `**Goal:** ${spec.goal}`,
    spec.description ? `**Description:** ${spec.description}` : '',
    spec.techStack.length ? `**Tech stack:** ${spec.techStack.join(', ')}` : '',
    spec.constraints.length ? `**Constraints:**\n${spec.constraints.map((c) => `- ${c}`).join('\n')}` : '',
    spec.nonFunctional.length ? `**Non-functional requirements:**\n${spec.nonFunctional.map((c) => `- ${c}`).join('\n')}` : '',
    spec.acceptanceCriteria.length ? `**Acceptance criteria:**\n${spec.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : '',
    spec.targetUsers ? `**Target users:** ${spec.targetUsers}` : '',
    spec.deliverable ? `**Deliverable:** ${spec.deliverable}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderArchitecture(proposal: ArchitectureProposal): string {
  return [
    `**Summary:** ${proposal.summary}`,
    proposal.stack.length ? `**Stack:**\n${proposal.stack.map((s) => `- ${s.layer}: ${s.choice} — ${s.rationale}`).join('\n')}` : '',
    proposal.components.length
      ? `**Components:**\n${proposal.components.map((c) => `- ${c.name}: ${c.responsibility} (${c.technologies.join(', ')})${c.dependsOn.length ? ` depends on ${c.dependsOn.join(', ')}` : ''}`).join('\n')}`
      : '',
    proposal.dataModel.length
      ? `**Data model:**\n${proposal.dataModel.map((e) => `- ${e.entity}(${e.fields.join(', ')})${e.relations.length ? ` → ${e.relations.join(', ')}` : ''}`).join('\n')}`
      : '',
    proposal.apiSurface.length ? `**API surface:**\n${proposal.apiSurface.map((a) => `- ${a.method} ${a.path} — ${a.purpose}`).join('\n')}` : '',
    proposal.projectStructure.length ? `**Structure:**\n${proposal.projectStructure.map((p) => `- ${p.path}: ${p.purpose}`).join('\n')}` : '',
    proposal.risks.length ? `**Risks:**\n${proposal.risks.map((r) => `- (${r.severity}) ${r.risk} → ${r.mitigation}`).join('\n')}` : '',
    proposal.openQuestions.length ? `**Open questions:**\n${proposal.openQuestions.map((q) => `- ${q}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}
