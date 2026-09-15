import crypto from 'node:crypto';
import type {
  ArchitectureProposal,
  Project,
  Task,
  Priority,
  TaskType,
  AgentId,
} from '@aido/types';
import type { EventBus, Logger } from '@aido/observability';
import type { Store } from '@aido/storage';
import type { ProjectMemory } from '@aido/project-memory';
import type { Workspace } from '@aido/sandbox';
import type { GitRepository } from '@aido/git';
import { getAgentRole, PlanSchema, ArchitectureProposalSchema, type AgentRunResult, type BaseAgent } from '@aido/agents';

/**
 * Planning pipeline (§12 Architect → Project Manager).
 *
 * The planner does not "ask a model to make a todo list". It runs a real
 * two-stage process:
 *
 *   1. ARCHITECT: produces a structured architecture proposal which is persisted
 *      to project memory. If the model's output fails schema validation, the run
 *      fails loudly rather than silently degrading into an unstructured blob.
 *   2. PROJECT MANAGER: converts the architecture into a task plan with real
 *      dependencies and resource locks. Plan-local task ids are remapped to
 *      database ids, self/unknown dependencies are dropped (with a warning), and
 *      dependency cycles are broken so the DAG can never deadlock the scheduler.
 */

export interface PlannerOptions {
  store: Store;
  memory: ProjectMemory;
  events: EventBus;
  logger: Logger;
  /** Factory so the planner does not own agent construction. */
  createAgent: (agentId: AgentId) => BaseAgent;
  /** Workspace and Git handles for the project being planned. */
  workspaceFor: (project: Project) => Workspace;
  gitFor: (project: Project) => GitRepository;
  maxPlanTasks?: number;
}

export interface PlanningResult {
  architecture: ArchitectureProposal;
  architectureTaskId: string;
  planTaskId: string;
  createdTasks: Task[];
  warnings: string[];
  tokensUsed: { input: number; output: number };
}

export class PlannerService {
  constructor(private readonly options: PlannerOptions) {}

  /**
   * Runs the architecture and planning stages for a project.
   *
   * The two stages are represented as real tasks in the graph, so the UI shows the
   * same thing the scheduler did and the run can be resumed from any point.
   */
  async planProject(project: Project): Promise<PlanningResult> {
    const { store, memory, events } = this.options;
    const warnings: string[] = [];
    const tokensUsed = { input: 0, output: 0 };

    // ---- 1. Architecture ----------------------------------------------------
    const architectureTask = this.createStageTask({
      projectId: project.id,
      title: 'Design the architecture',
      description: [
        `Goal: ${project.spec.goal}`,
        project.spec.description ? `Context: ${project.spec.description}` : '',
        project.spec.constraints.length ? `Constraints:\n${project.spec.constraints.map((c) => `- ${c}`).join('\n')}` : '',
        project.spec.techStack.length ? `Requested stack (respect it unless it conflicts with a constraint): ${project.spec.techStack.join(', ')}` : '',
        '',
        'Produce the architecture proposal for this project. Inspect the workspace first if it already contains code.',
      ]
        .filter(Boolean)
        .join('\n'),
      agentRole: 'architect',
      taskType: 'architecture',
      priority: 'critical',
    });

    events.emit(
      'task.started',
      { taskId: architectureTask.id, stage: 'architecture' },
      { message: 'Architect is designing the system', projectId: project.id, taskId: architectureTask.id, agentId: 'architect' },
    );

    const architect = this.options.createAgent('architect');
    store.tasks.update(architectureTask.id, { status: 'running', startedAt: new Date().toISOString() });
    // The planning stages run an agent just like the scheduler does, so they publish the
    // same state and counters: an architect that is thinking must not read as "idle".
    store.agents.patch(project.id, 'architect', { state: 'working', currentTaskId: architectureTask.id, lastActionAt: new Date().toISOString() });
    const architectureResult = await architect.run({
      projectId: project.id,
      task: architectureTask,
      workspace: this.options.workspaceFor(project),
      git: this.options.gitFor(project),
      requestApproval: async () => null,
    });

    if (architectureResult.status !== 'completed' || !architectureResult.structured) {
      store.tasks.update(architectureTask.id, {
        status: 'failed',
        lastError: architectureResult.error ?? 'Architecture stage did not return structured output.',
      });
      this.settleStage(project.id, 'architect', architectureResult, 'failed');
      throw new Error(`Architecture stage failed: ${architectureResult.error ?? 'no structured output returned'}`);
    }

    const architecture = ArchitectureProposalSchema.parse(architectureResult.structured) as ArchitectureProposal;
    tokensUsed.input += architectureResult.tokenUsage?.input ?? 0;
    tokensUsed.output += architectureResult.tokenUsage?.output ?? 0;

    memory.setArchitecture(project.id, architecture, { agentId: 'architect', taskId: architectureTask.id });
    const assumptions = (architectureResult.structured as { assumptions?: string[] }).assumptions ?? [];
    for (const assumption of assumptions) {
      memory.addConstraint(project.id, { title: `Assumption: ${assumption.slice(0, 60)}`, body: assumption }, { agentId: 'architect', taskId: architectureTask.id });
    }

    store.tasks.update(architectureTask.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      result: {
        summary: architecture.summary,
        artifacts: [],
        data: architecture as unknown as Record<string, unknown>,
        tokenUsage: architectureResult.tokenUsage,
      },
      lastModelId: architectureResult.modelId ?? null,
    });
    this.settleStage(project.id, 'architect', architectureResult, 'completed');
    events.emit(
      'task.completed',
      { taskId: architectureTask.id, stage: 'architecture', components: architecture.components.length },
      { message: `Architecture defined: ${architecture.components.length} components, ${architecture.stack.length} stack choices`, projectId: project.id, taskId: architectureTask.id, agentId: 'architect' },
    );

    // ---- 2. Plan ------------------------------------------------------------
    const planTask = this.createStageTask({
      projectId: project.id,
      title: 'Decompose the architecture into tasks',
      description: [
        `Goal: ${project.spec.goal}`,
        '',
        'Architecture (already approved — plan against it):',
        JSON.stringify(architecture, null, 1).slice(0, 12_000),
        '',
        'Break this into a dependency-ordered task plan following your output contract.',
      ].join('\n'),
      agentRole: 'project_manager',
      taskType: 'planning',
      priority: 'critical',
      dependsOn: [architectureTask.id],
    });

    const manager = this.options.createAgent('project_manager');
    store.tasks.update(planTask.id, { status: 'running', startedAt: new Date().toISOString() });
    store.agents.patch(project.id, 'project_manager', { state: 'working', currentTaskId: planTask.id, lastActionAt: new Date().toISOString() });
    const planResult = await manager.run({
      projectId: project.id,
      task: planTask,
      workspace: this.options.workspaceFor(project),
      git: this.options.gitFor(project),
      requestApproval: async () => null,
    });

    if (planResult.status !== 'completed' || !planResult.structured) {
      store.tasks.update(planTask.id, { status: 'failed', lastError: planResult.error ?? 'no plan returned' });
      this.settleStage(project.id, 'project_manager', planResult, 'failed');
      throw new Error(`Planning stage failed: ${planResult.error ?? 'no structured output returned'}`);
    }

    const plan = PlanSchema.parse(planResult.structured);
    tokensUsed.input += planResult.tokenUsage?.input ?? 0;
    tokensUsed.output += planResult.tokenUsage?.output ?? 0;

    const created = this.persistPlan(project.id, plan.tasks.slice(0, this.options.maxPlanTasks ?? 60), warnings);

    store.tasks.update(planTask.id, {
      status: 'done',
      completedAt: new Date().toISOString(),
      result: {
        summary: plan.summary,
        artifacts: [],
        data: { tasks: plan.tasks.length, notes: plan.notes },
        tokenUsage: planResult.tokenUsage,
      },
      lastModelId: planResult.modelId ?? null,
    });
    this.settleStage(project.id, 'project_manager', planResult, 'completed');
    events.emit(
      'plan.created',
      { taskId: planTask.id, taskCount: created.length, warnings },
      { message: `Plan created: ${created.length} tasks across ${new Set(created.map((t) => t.agentRole)).size} agents`, projectId: project.id, taskId: planTask.id, agentId: 'project_manager' },
    );

    store.projects.setStatus(project.id, 'building');
    return { architecture, architectureTaskId: architectureTask.id, planTaskId: planTask.id, createdTasks: created, warnings, tokensUsed };
  }

  /**
   * Publishes the outcome of a planning-stage agent run: the agent returns to idle and
   * its counters move, exactly as they do for a task the scheduler dispatched.
   */
  private settleStage(projectId: string, agentId: AgentId, result: AgentRunResult, outcome: 'completed' | 'failed'): void {
    const tokens = (result.tokenUsage?.input ?? 0) + (result.tokenUsage?.output ?? 0);
    this.options.store.agents.patch(projectId, agentId, {
      state: 'idle',
      currentTaskId: null,
      lastActionAt: new Date().toISOString(),
      ...(outcome === 'failed' ? { lastError: result.error ?? 'stage failed' } : {}),
    });
    this.options.store.agents.increment(projectId, agentId, {
      ...(outcome === 'completed' ? { tasksCompleted: 1 } : { tasksFailed: 1 }),
      tokensUsedToday: tokens,
      iterations: result.iterations ?? 0,
      requestsToday: 1,
    });
  }

  /**
   * Materialises plan tasks into the database, remapping plan-local ids to real
   * ids and sanitising the dependency graph.
   */
  private persistPlan(
    projectId: string,
    planTasks: { id: string; title: string; description: string; agent: AgentId; taskType: TaskType; priority: Priority; dependsOn: string[]; resourceLocks: string[]; acceptanceCriteria: string[] }[],
    warnings: string[],
  ): Task[] {
    const { store } = this.options;
    const idMap = new Map<string, string>();
    for (const planTask of planTasks) {
      idMap.set(planTask.id, crypto.randomUUID());
    }

    const created: Task[] = [];
    let orderIndex = store.tasks.nextOrderIndex(projectId);

    // Detect cycles before persisting: a cyclic plan would deadlock the scheduler.
    const cycled = detectCycles(planTasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn })));
    for (const cycle of cycled) {
      warnings.push(`Removed dependency edges that formed a cycle: ${cycle.join(' → ')}`);
    }

    // A task that declares it will write files must be given to an agent that is
    // allowed to write files. Plans come from a model, so this is validated rather
    // than assumed; an impossible assignment is corrected and reported.
    const writeCapable: AgentId[] = ['frontend', 'backend', 'database', 'qa', 'devops', 'performance'];
    const assignments = new Map<string, AgentId>();
    for (const planTask of planTasks) {
      const writesFiles = planTask.resourceLocks.some((lock) => lock.startsWith('file:'));
      const role = getAgentRole(planTask.agent);
      if (writesFiles && !role.tools.includes('write_file')) {
        const replacement = writeCapable.find((candidate) => getAgentRole(candidate).tools.includes('write_file')) ?? 'backend';
        warnings.push(
          `Task "${planTask.title}" was assigned to ${planTask.agent}, which cannot write files, so it was reassigned to ${replacement}.`,
        );
        assignments.set(planTask.id, replacement);
      } else {
        assignments.set(planTask.id, planTask.agent);
      }
    }

    for (const planTask of planTasks) {
      const id = idMap.get(planTask.id)!;
      const dependsOn = planTask.dependsOn
        .filter((dependency) => {
          if (dependency === planTask.id) {
            warnings.push(`Task "${planTask.title}" depended on itself; the edge was dropped.`);
            return false;
          }
          if (!idMap.has(dependency)) {
            warnings.push(`Task "${planTask.title}" referenced unknown dependency "${dependency}"; the edge was dropped.`);
            return false;
          }
          if (cycled.some((cycle) => cycle.includes(planTask.id) && cycle.includes(dependency))) {
            return false;
          }
          return true;
        })
        .map((dependency) => idMap.get(dependency)!);

      const description = [
        planTask.description,
        planTask.acceptanceCriteria.length ? `\nAcceptance criteria:\n${planTask.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : '',
      ].join('');

      const task: Task = {
        id,
        projectId,
        title: planTask.title.slice(0, 200),
        description,
        agentRole: assignments.get(planTask.id) ?? planTask.agent,
        taskType: planTask.taskType,
        // Tasks with unmet dependencies start blocked; the scheduler unblocks them.
        status: dependsOn.length ? 'blocked' : 'ready',
        priority: planTask.priority,
        dependsOn,
        resourceLocks: planTask.resourceLocks,
        parentId: null,
        orderIndex: orderIndex++,
        estimatedInputTokens: null,
        estimatedOutputTokens: null,
        result: null,
        attempts: 0,
        maxAttempts: 3,
        lastError: null,
        lastModelId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
      };
      store.tasks.create(task);
      created.push(task);

      this.options.events.emit(
        'task.created',
        { taskId: task.id, agentRole: task.agentRole, taskType: task.taskType, dependsOn: task.dependsOn.length },
        { message: `Task created: ${task.title} → ${task.agentRole}`, projectId, taskId: task.id, agentId: task.agentRole },
      );
    }

    // Sanity check that the plan is actually startable.
    const startable = created.filter((task) => task.status === 'ready');
    if (!startable.length) {
      warnings.push('Every planned task has a dependency; nothing can start. The first task was unblocked so the run can proceed.');
      const first = created[0];
      if (first) store.tasks.update(first.id, { status: 'ready', dependsOn: [] });
    }

    return created;
  }

  private createStageTask(input: {
    projectId: string;
    title: string;
    description: string;
    agentRole: AgentId;
    taskType: TaskType;
    priority: Priority;
    dependsOn?: string[];
  }): Task {
    const task: Task = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      agentRole: input.agentRole,
      taskType: input.taskType,
      status: 'ready',
      priority: input.priority,
      dependsOn: input.dependsOn ?? [],
      resourceLocks: [],
      parentId: null,
      orderIndex: 0,
      estimatedInputTokens: null,
      estimatedOutputTokens: null,
      result: null,
      attempts: 0,
      maxAttempts: 3,
      lastError: null,
      lastModelId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    };
    return this.options.store.tasks.create(task);
  }

}

/** Returns the node ids involved in each detected cycle. */
export function detectCycles(edges: { id: string; dependsOn: string[] }[]): string[][] {
  const graph = new Map(edges.map((edge) => [edge.id, edge.dependsOn.filter((dependency) => edges.some((e) => e.id === dependency))]));
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (node: string) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') {
      const start = stack.indexOf(node);
      if (start >= 0) cycles.push(stack.slice(start).concat(node));
      return;
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, 'done');
  };

  for (const edge of edges) visit(edge.id);
  return cycles;
}
