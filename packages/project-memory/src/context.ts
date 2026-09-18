import type {
  ContextBundle,
  MemoryEntry,
  ModelInfo,
  Task,
  TaskType,
} from '@aido/types';
import type { Store } from '@aido/storage';
import type { Logger } from '@aido/observability';
import { TokenEstimator } from '@aido/ai-core';
import type { PromptSection } from '@aido/ai-core';
import type { Workspace } from '@aido/sandbox';
import type { ProjectMemory } from './memory.js';

/**
 * Context management (§15).
 *
 * Goal: MAXIMUM INFORMATION / MINIMUM TOKENS. Every free quota token spent on
 * irrelevant context is a token unavailable for actual work, so the builder is
 * aggressively selective:
 *
 *   1. the task statement and its acceptance criteria always make the cut,
 *   2. project memory is retrieved *by relevance* (task type, related files,
 *      importance) rather than dumped wholesale,
 *   3. files are pulled in only when they relate to the task (explicit paths,
 *      resource locks, or a bounded keyword search),
 *   4. history is represented by a compact digest of prior attempts and recent
 *      agent messages instead of the full transcript,
 *   5. everything is measured: the bundle reports the naive size versus what was
 *      actually sent, so the saving is observable rather than claimed.
 */

export interface ContextRequest {
  projectId: string;
  task: Task;
  agentId: string;
  /** Explicit files the agent must see. */
  requiredFiles?: string[];
  /** Extra untrusted sources (e.g. command output the agent just produced). */
  extraSections?: PromptSection[];
  /** Model chosen by the router; its context window sets the budget. */
  model: ModelInfo | null;
  /** Fraction of the context window to use for input (rest is output headroom). */
  inputBudgetFraction?: number;
  maxInputTokensOverride?: number;
  workspace?: Workspace | null;
}

export interface ContextBuilderOptions {
  store: Store;
  memory: ProjectMemory;
  logger: Logger;
  estimator?: TokenEstimator;
}

export class ContextBuilder {
  private readonly estimator: TokenEstimator;

  constructor(private readonly options: ContextBuilderOptions) {
    this.estimator = options.estimator ?? new TokenEstimator();
  }

  build(request: ContextRequest): ContextBundle {
    const { store, memory } = this.options;
    const project = store.projects.get(request.projectId);
    const notes: string[] = [];
    const includedFiles: ContextBundle['includedFiles'] = [];
    const includedMemory: ContextBundle['includedMemory'] = [];

    const contextWindow = request.model?.contextWindow ?? 32_768;
    const outputReserve = Math.min(request.model?.maxOutputTokens ?? 4_096, Math.floor(contextWindow * 0.25));
    const budget =
      request.maxInputTokensOverride ??
      Math.max(
        2_000,
        Math.floor((contextWindow - outputReserve) * (request.inputBudgetFraction ?? 0.72)),
      );

    // ---------------------------------------------------------------- trusted
    const sections: PromptSection[] = [];

    sections.push({
      title: 'Task',
      trust: 'trusted',
      priority: 100,
      body: [
        `Title: ${request.task.title}`,
        `Type: ${request.task.taskType}`,
        `Priority: ${request.task.priority}`,
        request.task.description ? `\n${request.task.description}` : '',
        request.task.dependsOn.length
          ? `\nThis task was unblocked by: ${request.task.dependsOn.map((id) => store.tasks.get(id)?.title ?? id).join(', ')}`
          : '',
        // The files a task is permitted to change, stated explicitly: the model
        // should not have to infer its own blast radius, and the sandbox enforces
        // these paths anyway.
        request.task.resourceLocks.some((lock) => lock.startsWith('file:'))
          ? `\nFiles this task may create or change: ${request.task.resourceLocks
              .filter((lock) => lock.startsWith('file:'))
              .map((lock) => lock.replace(/^file:/, ''))
              .join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });

    // Specification and architecture are the highest-value memories; always include
    // the specification, and the architecture when the task plausibly depends on it.
    const spec = memory.specification(request.projectId);
    if (spec) {
      sections.push({ title: 'Project specification', trust: 'trusted', priority: 95, body: spec.body });
      includedMemory.push({ id: spec.id, title: spec.title, kind: spec.kind });
    } else if (project) {
      notes.push('No specification stored yet; the task description is the only statement of intent.');
    }

    const architectureRelevant = ['architecture', 'code_generation', 'refactor', 'code_review', 'database_design', 'devops', 'security_audit', 'performance_analysis'].includes(
      request.task.taskType,
    );
    const architecture = memory.architecture(request.projectId);
    if (architecture && architectureRelevant) {
      sections.push({ title: 'Architecture', trust: 'trusted', priority: 90, body: architecture.body });
      includedMemory.push({ id: architecture.id, title: architecture.title, kind: architecture.kind });
    }

    const constraints = memory.constraints(request.projectId);
    if (constraints.length) {
      sections.push({
        title: 'Constraints',
        trust: 'trusted',
        priority: 92,
        body: constraints.map((c) => `- ${c.title}: ${c.body.split('\n')[0]}`).join('\n'),
      });
      for (const constraint of constraints) includedMemory.push({ id: constraint.id, title: constraint.title, kind: constraint.kind });
    }

    // Relevant decisions (by file or task type), most important first, capped.
    const decisions = this.relevantMemory(request, memory.decisions(request.projectId)).slice(0, 6);
    if (decisions.length) {
      sections.push({
        title: 'Relevant decisions',
        trust: 'trusted',
        priority: 80,
        body: decisions.map((d) => `- ${d.title}: ${firstLine(d.body, 240)}`).join('\n'),
      });
      for (const decision of decisions) includedMemory.push({ id: decision.id, title: decision.title, kind: decision.kind });
    }

    const issues = this.relevantMemory(request, memory.openIssues(request.projectId, 0.65)).slice(0, 8);
    if (issues.length) {
      // Findings produced by agents are DATA: an agent conclusion must not be able
      // to smuggle instructions into another agent's prompt (§31).
      sections.push({
        title: 'Known issues and findings',
        trust: 'untrusted',
        source: 'project memory (agent-written)',
        kind: 'agent_output',
        priority: 70,
        body: issues.map((i) => `- ${i.title}: ${firstLine(i.body, 240)}`).join('\n'),
      });
      for (const issue of issues) includedMemory.push({ id: issue.id, title: issue.title, kind: issue.kind });
    }

    const codeState = memory.codeState(request.projectId);
    if (codeState && request.task.taskType !== 'documentation') {
      sections.push({ title: 'Code state', trust: 'untrusted', source: 'git state', kind: 'command_output', priority: 60, body: codeState.body });
      includedMemory.push({ id: codeState.id, title: codeState.title, kind: codeState.kind });
    }

    const testState = memory.testState(request.projectId);
    if (testState) {
      sections.push({ title: 'Test state', trust: 'untrusted', source: 'test runner', kind: 'command_output', priority: 65, body: testState.body });
      includedMemory.push({ id: testState.id, title: testState.title, kind: testState.kind });
    }

    // Prior attempts of this same task, so an agent does not repeat a failed approach.
    const executions = store.executions.listForTask(request.task.id);
    if (executions.length > 0) {
      sections.push({
        title: 'Previous attempts on this task',
        trust: 'trusted',
        priority: 85,
        body: executions
          .slice(-3)
          .map(
            (execution, index) =>
              `Attempt ${index + 1} (${execution.status}, ${execution.modelId ?? 'unknown model'}): ${
                execution.error ? `failed with: ${firstLine(execution.error, 200)}` : execution.outcome ? JSON.stringify(execution.outcome).slice(0, 300) : 'no outcome recorded'
              }`,
          )
          .join('\n'),
      });
    }

    // ------------------------------------------------------------- untrusted
    if (request.workspace) {
      const fileSections = this.collectFiles(request, notes);
      for (const section of fileSections) {
        sections.push(section);
        includedFiles.push({
          path: section.source ?? section.title,
          bytes: section.body.length,
          reason: section.title.startsWith('Requested file') ? 'explicitly requested by the task' : 'matched task keywords',
        });
      }
    }

    for (const extra of request.extraSections ?? []) sections.push(extra);

    // Recent agent messages: a compact digest, not the raw transcript.
    const messages = store.messages.recentForProject(request.projectId, 40);
    if (messages.length) {
      const digest = messages
        .slice(-12)
        .map((m) => `[${m.agentId ?? m.role}] ${firstLine(m.content, 160)}`)
        .join('\n');
      sections.push({ title: 'Recent team activity', trust: 'untrusted', source: 'agent message log', kind: 'agent_output', priority: 40, body: digest });
      notes.push(`Included a digest of ${Math.min(12, messages.length)} recent messages instead of the full ${messages.length}-message transcript.`);
    }

    // ------------------------------------------------------------- assembly
    let budgetRemaining = budget;
    const kept: { section: PromptSection; tokens: number }[] = [];
    // Highest priority first so trimming removes the least valuable material.
    for (const section of [...sections].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
      const tokens = this.estimator.estimate(section.body, kindFor(section)).tokens;
      if (tokens <= budgetRemaining || (section.priority ?? 0) >= 95) {
        budgetRemaining -= tokens;
        kept.push({ section, tokens });
      } else {
        notes.push(`Omitted "${section.title}" (~${tokens} tokens) to stay inside the ${budget}-token input budget.`);
      }
    }
    kept.sort((a, b) => (b.section.priority ?? 0) - (a.section.priority ?? 0));

    const text = kept
      .map(({ section }) => `--- ${section.title}${section.trust === 'untrusted' ? ' (untrusted data)' : ''} ---\n${section.body}`)
      .join('\n\n');
    const actualTokens = this.estimator.estimate(text, 'mixed').tokens;

    // Naive baseline: every memory entry + every listed file, untrimmed.
    const naiveTokens =
      this.estimator.estimate(
        [
          ...sections.map((s) => s.body),
          ...memory.list(request.projectId, { limit: 200 }).map((entry) => entry.body),
        ].join('\n'),
        'mixed',
      ).tokens + actualTokens;

    return {
      text,
      includedFiles,
      includedMemory,
      includedMessages: Math.min(12, messages.length),
      estimatedTokens: actualTokens,
      compression: {
        naiveTokens,
        actualTokens,
        savedFraction: naiveTokens > 0 ? Math.max(0, 1 - actualTokens / naiveTokens) : 0,
      },
      notes,
    };
  }

  /**
   * File selection: explicit paths win, then paths mentioned in the task text,
   * then a bounded keyword search. Everything is size-capped so one large file
   * cannot consume the entire budget.
   */
  private collectFiles(request: ContextRequest, notes: string[]): PromptSection[] {
    const workspace = request.workspace;
    if (!workspace) return [];
    const sections: PromptSection[] = [];
    const explicit = new Set(request.requiredFiles ?? []);
    const perFileBudget = 12_000;

    const pushFile = (path: string, reason: 'requested' | 'matched') => {
      const decision = workspace.resolve(path);
      if (!decision.allowed) {
        notes.push(`Skipped ${path}: ${decision.reason}`);
        return;
      }
      if (!workspace.exists(path)) return;
      try {
        const file = workspace.read(path, { maxBytes: perFileBudget * 4 });
        if (file.injectionFindings.length) {
          notes.push(`${path} contains ${file.injectionFindings.length} possible prompt-injection pattern(s); it is sent as untrusted data only.`);
        }
        sections.push({
          title: reason === 'requested' ? `Requested file: ${path}` : `File: ${path}`,
          source: path,
          kind: 'file',
          trust: 'untrusted',
          priority: reason === 'requested' ? 88 : 50,
          body: file.truncated ? `${file.content}\n\n[truncated at ${perFileBudget} bytes; the file is ${file.bytes} bytes]` : file.content,
        });
      } catch (err) {
        notes.push(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    for (const path of explicit) pushFile(path, 'requested');

    // Resource locks name the files a task is allowed to touch: highly relevant.
    for (const lock of request.task.resourceLocks) {
      const match = /^file:(.+)$/.exec(lock);
      if (match?.[1] && !explicit.has(match[1])) {
        pushFile(match[1], 'requested');
        explicit.add(match[1]);
      }
    }

    // Keyword search over the task text, bounded to a handful of files.
    if (sections.length < 6 && request.task.description.length > 20) {
      const keywords = extractKeywords(`${request.task.title} ${request.task.description}`).slice(0, 6);
      const found = new Map<string, number>();
      for (const keyword of keywords) {
        for (const result of workspace.search(keyword, { maxResults: 30 })) {
          found.set(result.path, (found.get(result.path) ?? 0) + 1);
        }
      }
      const ranked = [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      for (const [path] of ranked) {
        if (explicit.has(path)) continue;
        pushFile(path, 'matched');
        explicit.add(path);
      }
      if (ranked.length) notes.push(`Selected ${ranked.length} file(s) by keyword match on the task text.`);
    }

    return sections;
  }

  private relevantMemory(request: ContextRequest, entries: MemoryEntry[]): MemoryEntry[] {
    if (!entries.length) return entries;
    const taskFiles = new Set([
      ...request.task.resourceLocks.map((lock) => lock.replace(/^file:/, '')),
      ...(request.requiredFiles ?? []),
    ]);
    const taskType: TaskType = request.task.taskType;
    return [...entries]
      .map((entry) => {
        let score = entry.importance;
        if (entry.relatedTaskTypes.includes(taskType)) score += 0.3;
        else if (entry.relatedTaskTypes.length > 0) score -= 0.2;
        if (entry.relatedFiles.length && taskFiles.size && entry.relatedFiles.some((file) => taskFiles.has(file))) score += 0.3;
        // Recent memories are more likely to still be true.
        const ageDays = (Date.now() - Date.parse(entry.updatedAt)) / 86_400_000;
        score -= Math.min(0.25, ageDays / 120);
        return { entry, score };
      })
      .sort((a, b) => b.score - a.score)
      .map(({ entry }) => entry);
  }
}

function kindFor(section: PromptSection): 'prose' | 'code' | 'mixed' {
  const title = section.title.toLowerCase();
  if (title.includes('file') || title.includes('diff') || title.includes('code')) return 'code';
  return 'mixed';
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? text;
  return line.length > max ? `${line.slice(0, max)}…` : line.trim();
}

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'must', 'should', 'will', 'have', 'each', 'when', 'then', 'than', 'over', 'under', 'using', 'use', 'add', 'also', 'all', 'any', 'our', 'its', 'are', 'was', 'were', 'not', 'but']);

export function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>();
  for (const rawWord of text.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    const word = rawWord.replace(/^[.-]+|[.-]+$/g, '');
    if (word.length < 4 || STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([word]) => word);
}
