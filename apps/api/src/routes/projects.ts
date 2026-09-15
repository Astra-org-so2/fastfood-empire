import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentId, Project, ProjectStatus, Task, TaskStatus } from '@aido/types';
import { DEFAULT_TEAM } from '@aido/agents';
import { estimateCapacity } from '@aido/quota-engine';
import { PathGuardError } from '@aido/security';
import type { Container } from '../container.js';
import { ApiError, handler, limitFrom, parse, requireParam } from '../http.js';

/**
 * Project, task, run-control, workspace and Git routes.
 *
 * This is the surface the Project / Tasks / Git screens use, and the same surface
 * the desktop shell calls, so both shells see identical behaviour (§54).
 */

const SpecSchema = z.object({
  goal: z.string().min(3).max(2_000),
  description: z.string().max(10_000).default(''),
  techStack: z.array(z.string().max(100)).max(30).default([]),
  constraints: z.array(z.string().max(500)).max(50).default([]),
  nonFunctional: z.array(z.string().max(500)).max(50).default([]),
  acceptanceCriteria: z.array(z.string().max(500)).max(50).default([]),
  targetUsers: z.string().max(500).default(''),
  deliverable: z.string().max(1_000).default(''),
});

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  spec: SpecSchema,
  /** Existing repository to work in, or a fresh directory. */
  sourceRepo: z.string().max(500).nullable().default(null),
  workspacePath: z.string().max(1_000).optional(),
  executionMode: z.enum(['auto', 'supervised', 'manual']).optional(),
  freeOnlyMode: z.boolean().nullable().optional(),
  maxParallelAgents: z.number().int().min(1).max(8).optional(),
});

const TaskInputSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(20_000).default(''),
  agentRole: z.enum(['architect', 'project_manager', 'frontend', 'backend', 'database', 'qa', 'security', 'code_review', 'devops', 'performance', 'research', 'supervisor']),
  taskType: z
    .enum([
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
    ])
    .default('code_generation'),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
  dependsOn: z.array(z.string()).max(50).default([]),
  resourceLocks: z.array(z.string().max(300)).max(50).default([]),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});

export function registerProjectRoutes(app: FastifyInstance, container: Container): void {
  const { store, events, runner, memory, logger } = container;

  // ---------------------------------------------------------------- projects

  app.get(
    '/api/projects',
    handler(() =>
      store.projects.list().map((project) => ({
        ...project,
        counts: store.tasks.countsByStatus(project.id),
        run: runner.status(project.id),
        lastActivity: store.events.query({ projectId: project.id, limit: 1 })[0]?.at ?? project.updatedAt,
      })),
    ),
  );

  app.post(
    '/api/projects',
    handler(async (request, reply) => {
      const input = parse(CreateProjectSchema, request.body, 'project');
      const slug = uniqueSlug(store.projects.list().map((project) => project.slug), slugify(input.name));
      const id = crypto.randomUUID();
      const workspacePath = input.workspacePath
        ? path.resolve(input.workspacePath)
        : path.join(container.config.workspaceRoot, slug);

      if (input.sourceRepo) {
        const existing = fs.existsSync(workspacePath) && fs.readdirSync(workspacePath).length > 0;
        if (existing) throw ApiError.conflict(`Workspace ${workspacePath} is not empty; refusing to clone into it.`);
      }

      const project: Project = {
        id,
        name: input.name,
        slug,
        description: input.description,
        spec: input.spec,
        status: 'draft',
        workspacePath,
        branch: 'main',
        sourceRepo: input.sourceRepo,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
        settings: {
          executionMode: input.executionMode ?? container.settings().executionMode,
          maxParallelAgents: input.maxParallelAgents ?? container.settings().supervisor.maxParallelAgents,
          autoStart: false,
          enabledAgents: [...DEFAULT_TEAM] as AgentId[],
          freeOnlyMode: input.freeOnlyMode ?? null,
          maxTotalTokens: null,
          gitAuthorName: 'AI Dev Orchestrator',
          gitAuthorEmail: 'agents@aido.local',
        },
      };

      store.projects.create(project);
      memory.setSpecification(project.id, project.spec, { trust: 'system' });

      const workspace = await container.provisionWorkspace(project);
      if (input.sourceRepo && !workspace.cloned) {
        logger.warn('project created without a clone of the source repository', { projectId: project.id, sourceRepo: input.sourceRepo });
      }

      events.emit(
        'project.created',
        { projectId: project.id, name: project.name },
        { message: `Project created: ${project.name}`, projectId: project.id },
      );
      reply.status(201);
      return project;
    }),
  );

  app.get(
    '/api/projects/:projectId',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const project = store.projects.get(projectId);
      if (!project) throw ApiError.notFound(`Project ${projectId} not found.`);
      return {
        project,
        counts: store.tasks.countsByStatus(projectId),
        agentCounts: store.tasks.countsByAgent(projectId),
        run: runner.status(projectId),
        memory: memory.stats(projectId),
        quota: estimateCapacity({
          store,
          effectiveLimits: (providerId, model) => container.quota.effectiveLimits(providerId, model),
          usage: (providerId, model) => container.quota.usage(providerId, model),
          reserveFraction: container.settings().quota.reserveFraction,
          freeOnlyMode: container.settings().freeOnlyMode,
          providerSummaries: () =>
            container.registry.summaries().map((summary) => ({
              id: summary.id,
              name: summary.name,
              enabled: summary.enabled,
              configured: summary.configured,
              simulated: summary.simulated ?? false,
            })),
        }),
        agents: store.agents.list(projectId),
        pendingApprovals: store.approvals.listPending(projectId).length,
        git: path.join(project.workspacePath, '.git'),
      };
    }),
  );

  app.patch(
    '/api/projects/:projectId',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const patch = parse(
        z.object({
          name: z.string().min(1).max(120).optional(),
          description: z.string().max(2_000).optional(),
          status: z.enum(['draft', 'planning', 'building', 'reviewing', 'blocked', 'completed', 'archived']).optional(),
          spec: SpecSchema.partial().optional(),
          settings: z
            .object({
              executionMode: z.enum(['auto', 'supervised', 'manual']).optional(),
              maxParallelAgents: z.number().int().min(1).max(8).optional(),
              freeOnlyMode: z.boolean().nullable().optional(),
              enabledAgents: z.array(z.string()).optional(),
              maxTotalTokens: z.number().int().min(0).nullable().optional(),
            })
            .optional(),
        }),
        request.body,
        'project patch',
      );

      const existing = store.projects.get(projectId);
      if (!existing) throw ApiError.notFound(`Project ${projectId} not found.`);
      const updated = store.projects.update(projectId, {
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.status ? { status: patch.status as ProjectStatus } : {}),
        ...(patch.spec ? { spec: { ...existing.spec, ...patch.spec } } : {}),
        ...(patch.settings ? { settings: { ...existing.settings, ...patch.settings } as Project['settings'] } : {}),
      });
      if (patch.spec) memory.setSpecification(projectId, { ...existing.spec, ...patch.spec }, { trust: 'system' });
      events.emit('project.updated', { projectId, patch: Object.keys(patch) }, { message: `Project updated: ${updated?.name ?? projectId}`, projectId });
      return updated;
    }),
  );

  app.delete(
    '/api/projects/:projectId',
    handler((request, reply) => {
      const projectId = requireParam(request, 'projectId');
      const project = store.projects.get(projectId);
      if (!project) throw ApiError.notFound(`Project ${projectId} not found.`);
      const run = runner.status(projectId);
      if (run.running) throw ApiError.conflict('Stop the run before deleting the project.');
      // Project deletion is destructive: the workspace on disk is never removed by
      // the API, only the database record, so nothing is lost by accident.
      store.projects.delete(projectId);
      events.emit('project.archived', { projectId }, { message: `Project deleted: ${project.name}`, projectId });
      reply.status(204);
      return null;
    }),
  );

  // ---------------------------------------------------------------- planning & runs

  app.post(
    '/api/projects/:projectId/plan',
    handler(async (request) => {
      const projectId = requireParam(request, 'projectId');
      const project = store.projects.get(projectId);
      if (!project) throw ApiError.notFound(`Project ${projectId} not found.`);
      if (store.tasks.listByProject(projectId).length > 0) {
        const replace = parse(z.object({ replace: z.boolean().default(false) }), request.body ?? {}, 'request');
        if (!replace.replace) throw ApiError.conflict('This project already has tasks. Pass {"replace": true} to re-plan.');
        for (const task of store.tasks.listByProject(projectId)) store.tasks.delete(task.id);
      }
      store.projects.setStatus(projectId, 'planning');
      const result = await container.planProject(project as Project);
      store.projects.setStatus(projectId, 'building');
      return result;
    }),
  );

  app.post(
    '/api/projects/:projectId/run',
    handler(async (request) => {
      const projectId = requireParam(request, 'projectId');
      const project = store.projects.get(projectId);
      if (!project) throw ApiError.notFound(`Project ${projectId} not found.`);
      const options = parse(z.object({ plan: z.boolean().optional(), taskId: z.string().optional() }), request.body ?? {}, 'request');

      if (options.taskId) {
        // Single-task run: bypass the loop so an operator can retry one task now.
        const task = store.tasks.get(options.taskId);
        if (!task || task.projectId !== projectId) throw ApiError.notFound(`Task ${options.taskId} not found in this project.`);
        store.tasks.update(task.id, { status: 'ready' });
      }

      const status = await runner.start(projectId, { plan: options.plan });
      return status;
    }),
  );

  app.post('/api/projects/:projectId/pause', handler((request) => runner.pause(requireParam(request, 'projectId'))));
  app.post('/api/projects/:projectId/resume', handler((request) => runner.resume(requireParam(request, 'projectId'))));
  app.post(
    '/api/projects/:projectId/stop',
    handler(async (request) => {
      const body = parse(z.object({ reason: z.string().max(500).optional() }), request.body ?? {}, 'request');
      return runner.stop(requireParam(request, 'projectId'), body.reason ?? 'stopped by the operator');
    }),
  );

  app.get('/api/projects/:projectId/run', handler((request) => runner.status(requireParam(request, 'projectId'))));

  app.get(
    '/api/projects/:projectId/supervision',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const report = container.supervisor.inspect(projectId);
      return report;
    }),
  );

  // ---------------------------------------------------------------- tasks

  app.get(
    '/api/projects/:projectId/tasks',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const query = request.query as Record<string, string | undefined>;
      const tasks = store.tasks.listByProject(projectId);
      const filtered = query.status ? tasks.filter((task) => task.status === query.status) : tasks;
      const dependencyCounts = store.tasks.dependencyCounts(projectId);
      return filtered.map((task) => ({
        ...task,
        dependencies: dependencyCounts.get(task.id) ?? { total: 0, done: 0 },
        executionCount: store.executions.listForTask(task.id).length,
        lastTrace: store.traces.list({ taskId: task.id, limit: 1 })[0] ?? null,
      }));
    }),
  );

  app.post(
    '/api/projects/:projectId/tasks',
    handler((request, reply) => {
      const projectId = requireParam(request, 'projectId');
      const project = store.projects.get(projectId);
      if (!project) throw ApiError.notFound(`Project ${projectId} not found.`);
      const input = parse(TaskInputSchema, request.body, 'task');
      const now = new Date().toISOString();
      const task: Task = {
        id: crypto.randomUUID(),
        projectId,
        title: input.title,
        description: input.description,
        agentRole: input.agentRole,
        taskType: input.taskType,
        status: input.dependsOn.length ? 'blocked' : 'ready',
        priority: input.priority,
        dependsOn: input.dependsOn,
        resourceLocks: input.resourceLocks,
        parentId: null,
        orderIndex: store.tasks.nextOrderIndex(projectId),
        estimatedInputTokens: null,
        estimatedOutputTokens: null,
        result: null,
        attempts: 0,
        maxAttempts: input.maxAttempts,
        lastError: null,
        lastModelId: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
      };
      store.tasks.create(task);
      events.emit('task.created', { taskId: task.id, agentRole: task.agentRole }, { message: `Task created: ${task.title}`, projectId, taskId: task.id });
      reply.status(201);
      return task;
    }),
  );

  app.patch(
    '/api/tasks/:taskId',
    handler((request) => {
      const taskId = requireParam(request, 'taskId');
      const patch = parse(
        z.object({
          title: z.string().min(3).max(200).optional(),
          description: z.string().max(20_000).optional(),
          status: z.enum(['backlog', 'blocked', 'ready', 'running', 'in_review', 'done', 'failed', 'cancelled', 'paused']).optional(),
          priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
          agentRole: TaskInputSchema.shape.agentRole.optional(),
          dependsOn: z.array(z.string()).optional(),
          resourceLocks: z.array(z.string()).optional(),
          maxAttempts: z.number().int().min(1).max(10).optional(),
        }),
        request.body,
        'task patch',
      );
      const task = store.tasks.get(taskId);
      if (!task) throw ApiError.notFound(`Task ${taskId} not found.`);
      const updated = store.tasks.update(taskId, {
        ...patch,
        ...(patch.status ? { status: patch.status as TaskStatus } : {}),
        ...(patch.status === 'ready' && task.status === 'blocked' ? { lastError: null } : {}),
      });
      events.emit('task.updated' as never, { taskId, patch: Object.keys(patch) }, { message: `Task updated: ${updated?.title ?? taskId}`, projectId: task.projectId, taskId });
      return updated;
    }),
  );

  app.get(
    '/api/tasks/:taskId',
    handler((request) => {
      const task = store.tasks.get(requireParam(request, 'taskId'));
      if (!task) throw ApiError.notFound('Task not found.');
      return {
        ...task,
        dependencies: store.tasks.dependencyStatuses([task.id]).get(task.id) ?? [],
        executions: store.executions.listForTask(task.id),
      };
    }),
  );

  app.delete(
    '/api/tasks/:taskId',
    handler((request, reply) => {
      const task = store.tasks.get(requireParam(request, 'taskId'));
      if (!task) throw ApiError.notFound('Task not found.');
      store.tasks.delete(task.id);
      reply.status(204);
      return null;
    }),
  );

  /** Dependency graph for the DAG view. */
  app.get(
    '/api/projects/:projectId/graph',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const tasks = store.tasks.listByProject(projectId);
      const counts = store.tasks.dependencyCounts(projectId);
      return {
        nodes: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          agentRole: task.agentRole,
          taskType: task.taskType,
          priority: task.priority,
          attempts: task.attempts,
          maxAttempts: task.maxAttempts,
          dependencies: counts.get(task.id) ?? { total: 0, done: 0 },
          locks: task.resourceLocks,
          durationMs: durationOf(task),
        })),
        edges: tasks.flatMap((task) => task.dependsOn.map((dependency) => ({ from: dependency, to: task.id }))),
        // Reported rather than assumed empty: the planner breaks cycles when it
        // materialises a plan (§12), and this is how an operator can see that it did.
        cycles: findDependencyCycles(tasks),
      };
    }),
  );

  // ---------------------------------------------------------------- workspace files

  app.get(
    '/api/projects/:projectId/files',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const project = store.projects.get(projectId);
      if (!project) throw ApiError.notFound(`Project ${projectId} not found.`);
      const query = request.query as Record<string, string | undefined>;
      const workspace = container.workspaceFor(project);
      return { path: query.path ?? '.', entries: workspace.list(query.path ?? '.', { maxEntries: 2_000, includeHidden: query.hidden === 'true' }) };
    }),
  );

  app.get(
    '/api/projects/:projectId/file',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const project = store.projects.get(projectId);
      if (!project) throw ApiError.notFound(`Project ${projectId} not found.`);
      const query = request.query as Record<string, string | undefined>;
      if (!query.path) throw ApiError.badRequest('A "path" query parameter is required.');
      try {
        return container.workspaceFor(project).read(query.path);
      } catch (err) {
        if (err instanceof PathGuardError) throw ApiError.badRequest(`Refused to read ${query.path}: ${err.decision.reason}`);
        throw err;
      }
    }),
  );

  // ---------------------------------------------------------------- google-free evidence: git

  app.get(
    '/api/projects/:projectId/git/status',
    handler(async (request) => {
      const project = requireProject(store, requireParam(request, 'projectId'));
      const git = container.gitFor(project);
      const [status, headSha, branches] = await Promise.all([git.status(), git.headSha(), git.branches()]);
      return { ...status, headSha, branches };
    }),
  );

  app.get(
    '/api/projects/:projectId/git/log',
    handler(async (request) => {
      const project = requireProject(store, requireParam(request, 'projectId'));
      const query = request.query as Record<string, string | undefined>;
      const git = container.gitFor(project);
      const commits = await git.log({ limit: limitFrom(request, 50, 400), branch: query.branch });
      return { commits, recorded: store.commits.list(project.id, 200), byAgent: store.commits.byAgent(project.id) };
    }),
  );

  app.get(
    '/api/projects/:projectId/git/diff',
    handler(async (request) => {
      const project = requireProject(store, requireParam(request, 'projectId'));
      const query = request.query as Record<string, string | undefined>;
      const git = container.gitFor(project);
      const [diff, summary] = await Promise.all([
        git.diff({ staged: query.staged === 'true', ref: query.ref, path: query.path, maxBytes: 400_000 }),
        git.diffSummary({ staged: query.staged === 'true', ref: query.ref }),
      ]);
      return { diff, summary };
    }),
  );

  app.post(
    '/api/projects/:projectId/git/commit',
    handler(async (request) => {
      const project = requireProject(store, requireParam(request, 'projectId'));
      const body = parse(z.object({ message: z.string().min(3).max(2_000), paths: z.array(z.string()).optional() }), request.body, 'commit');
      const git = container.gitFor(project);
      const commit = await git.commit({ message: body.message, paths: body.paths ?? 'all' });
      if (!commit) return { committed: false, reason: 'Nothing staged: the working tree matches HEAD.' };
      const summary = await git.diffSummary({ ref: 'HEAD' });
      store.commits.record({
        projectId: project.id,
        sha: commit.sha,
        branch: (await git.currentBranch()) ?? project.branch,
        message: commit.message,
        authorName: commit.authorName,
        authorEmail: commit.authorEmail,
        agentId: null,
        taskId: null,
        filesChanged: summary.files.length,
        insertions: summary.insertions,
        deletions: summary.deletions,
        committedAt: commit.committedAt,
      });
      events.emit('git.commit_created', { sha: commit.sha, message: commit.message }, { message: `Commit ${commit.shortSha}: ${commit.message.split('\n')[0]}`, projectId: project.id });
      return { committed: true, commit };
    }),
  );

  app.post(
    '/api/projects/:projectId/git/merge',
    handler(async (request) => {
      const project = requireProject(store, requireParam(request, 'projectId'));
      const body = parse(z.object({ branch: z.string().min(1).max(200), message: z.string().max(500).optional() }), request.body, 'merge');
      const git = container.gitFor(project);
      const result = await git.merge(body.branch, { message: body.message });
      if (!result.ok) {
        events.emit('git.conflict', { branch: body.branch, conflicts: result.conflicts }, { message: `Merge conflict on ${body.branch}: ${result.conflicts.join(', ')}`, projectId: project.id, severity: 'warning' });
      }
      return result;
    }),
  );

  app.post(
    '/api/projects/:projectId/git/branch',
    handler(async (request) => {
      const project = requireProject(store, requireParam(request, 'projectId'));
      const body = parse(z.object({ name: z.string().min(1).max(200), checkout: z.boolean().default(true) }), request.body, 'branch');
      const git = container.gitFor(project);
      await git.createBranch(body.name, { checkout: body.checkout });
      events.emit('git.branch_created', { branch: body.name }, { message: `Branch created: ${body.name}`, projectId: project.id });
      return { created: true, branch: body.name };
    }),
  );

  // ---------------------------------------------------------------- tests

  app.get(
    '/api/projects/:projectId/tests',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const runs = store.tests.listRuns(projectId, limitFrom(request, 50, 200));
      return {
        runs,
        latest: store.tests.latestForProject(projectId),
        summary: store.tests.summary(projectId, new Date(Date.now() - 30 * 86_400_000).toISOString()),
        cases: runs[0] ? store.tests.cases(runs[0].id) : [],
      };
    }),
  );

  /** Runs the project's test command in the sandbox and records the real output. */
  app.post(
    '/api/projects/:projectId/tests/run',
    handler(async (request) => {
      const project = requireProject(store, requireParam(request, 'projectId'));
      const body = parse(z.object({ command: z.string().max(500).optional(), timeoutMs: z.number().int().min(1_000).max(600_000).optional() }), request.body ?? {}, 'request');
      const workspace = container.workspaceFor(project);
      const command = body.command ?? detectTestCommand(workspace) ?? 'npm test';
      const run = store.tests.startRun({
        projectId: project.id,
        taskId: null,
        suite: command,
        command,
        framework: detectTestFramework(command),
        status: 'running',
        passed: 0,
        failed: 0,
        skipped: 0,
        durationMs: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        output: null,
        coverage: null,
      });
      events.emit('test.started', { runId: run.id, command }, { message: `Running tests: ${command}`, projectId: project.id });

      const result = await workspace.run(command, { approved: true, timeoutMs: body.timeoutMs ?? 300_000 });
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      const parsedCounts = parseTestCounts(output);
      store.tests.finishRun(run.id, {
        status: result.exitCode === 0 ? 'passed' : 'failed',
        passed: parsedCounts.passed,
        failed: parsedCounts.failed,
        skipped: parsedCounts.skipped,
        durationMs: result.durationMs,
        finishedAt: new Date().toISOString(),
        output: output.slice(0, 200_000),
      });
      if (parsedCounts.cases.length) store.tests.addCases(run.id, parsedCounts.cases);

      events.emit(
        result.exitCode === 0 ? 'test.passed' : 'test.failed',
        { runId: run.id, exitCode: result.exitCode, ...parsedCounts },
        {
          message: result.exitCode === 0 ? `Tests passed (${parsedCounts.passed} passed)` : `Tests failed (${parsedCounts.failed} failing)`,
          projectId: project.id,
          severity: result.exitCode === 0 ? 'info' : 'error',
        },
      );
      return { run: store.tests.getRun(run.id), exitCode: result.exitCode, timedOut: result.timedOut, output: output.slice(0, 20_000) };
    }),
  );

  // ---------------------------------------------------------------- memory, messages, executions

  app.get(
    '/api/projects/:projectId/memory',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const query = request.query as Record<string, string | undefined>;
      return {
        stats: memory.stats(projectId),
        entries: memory.list(projectId, { limit: limitFrom(request, 200, 1_000), kinds: query.kind ? [query.kind as never] : undefined }),
        specification: memory.specification(projectId),
        architecture: memory.architecture(projectId),
        codeState: memory.codeState(projectId),
        testState: memory.testState(projectId),
        issues: memory.openIssues(projectId),
      };
    }),
  );

  app.get(
    '/api/projects/:projectId/messages',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const query = request.query as Record<string, string | undefined>;
      if (query.taskId) return store.messages.listForTask(query.taskId, limitFrom(request, 200));
      if (query.agentId) return store.messages.listForAgent(projectId, query.agentId as never, limitFrom(request, 200));
      return store.messages.recentForProject(projectId, limitFrom(request, 200));
    }),
  );

  app.get(
    '/api/projects/:projectId/executions',
    handler((request) => {
      const projectId = requireParam(request, 'projectId');
      const query = request.query as Record<string, string | undefined>;
      if (query.taskId) return store.executions.listForTask(query.taskId);
      return store.executions.listForProject(projectId, limitFrom(request, 200));
    }),
  );
}

function requireProject(store: Container['store'], projectId: string): Project {
  const project = store.projects.get(projectId);
  if (!project) throw ApiError.notFound(`Project ${projectId} not found.`);
  return project;
}

/** Ascertainable duration for the DAG view: real elapsed time for finished tasks. */
function durationOf(task: Task): number | null {
  if (!task.startedAt) return null;
  const end = task.completedAt ? Date.parse(task.completedAt) : Date.now();
  return Math.max(0, end - Date.parse(task.startedAt));
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'project'
  );
}

function uniqueSlug(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Best-effort detection of the project's own test command (no assumptions baked in). */
/** Records which framework produced the output, from the command itself only. */
function detectTestFramework(command: string): string | null {
  if (/vitest/.test(command)) return 'vitest';
  if (/jest/.test(command)) return 'jest';
  if (/pytest/.test(command)) return 'pytest';
  if (/cargo/.test(command)) return 'cargo';
  if (/go test/.test(command)) return 'go';
  if (/npm test|npm run test/.test(command)) return 'npm';
  return null;
}

function detectTestCommand(workspace: ReturnType<Container['workspaceFor']>): string | null {
  if (workspace.exists('package.json')) {
    try {
      const parsed = JSON.parse(workspace.read('package.json').content) as { scripts?: Record<string, string> };
      if (parsed.scripts?.test) return 'npm test';
      if (parsed.scripts?.['test:unit']) return 'npm run test:unit';
    } catch {
      return null;
    }
  }
  if (workspace.exists('pyproject.toml') || workspace.exists('pytest.ini')) return 'python3 -m pytest -q';
  if (workspace.exists('Cargo.toml')) return 'cargo test';
  if (workspace.exists('go.mod')) return 'go test ./...';
  return null;
}

/**
 * Extracts pass/fail counts from real test output. Only counts what the output
 * actually states; anything unrecognised stays at zero rather than being guessed.
 */
export function parseTestCounts(output: string): {
  passed: number;
  failed: number;
  skipped: number;
  cases: { name: string; status: string; durationMs: number | null; message: string | null; file: string | null }[];
} {
  const cases: { name: string; status: string; durationMs: number | null; message: string | null; file: string | null }[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const vitest = output.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/i);
  if (vitest) {
    failed = Number(vitest[1] ?? 0);
    passed = Number(vitest[2] ?? 0);
    skipped = Number(vitest[3] ?? 0);
  } else {
    const jest = output.match(/Tests:\s*(?:(\d+)\s+failed,\s*)?(?:(\d+)\s+skipped,\s*)?(\d+)\s+passed/i);
    if (jest) {
      failed = Number(jest[1] ?? 0);
      skipped = Number(jest[2] ?? 0);
      passed = Number(jest[3] ?? 0);
    } else {
      const pytest = output.match(/(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?/i);
      if (pytest) {
        passed = Number(pytest[1] ?? 0);
        failed = Number(pytest[2] ?? 0);
        skipped = Number(pytest[3] ?? 0);
      }
    }
  }

  for (const line of output.split('\n')) {
    const fail = line.match(/^\s*(?:✗|×|FAIL|not ok)\s+(.{3,200})$/);
    if (fail?.[1]) cases.push({ name: fail[1].trim(), status: 'failed', durationMs: null, message: null, file: null });
  }

  return { passed, failed, skipped, cases };
}

/**
 * Dependency cycles reachable in the task graph.
 *
 * Each cycle is returned once, as the list of task ids on it, so the UI can show which
 * tasks are mutually blocked. The planner is expected to prevent these; a non-empty list
 * means a plan was written by something that bypassed it.
 */
function findDependencyCycles(tasks: { id: string; dependsOn: string[] }[]): string[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const index = stack.indexOf(id);
      const cycle = stack.slice(index);
      // Normalise so the same cycle found from two entry points is reported once.
      const key = [...cycle].sort().join('|');
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    const task = byId.get(id);
    if (!task) return;
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of task.dependsOn) visit(dependency);
    stack.pop();
    state.set(id, 'done');
  };

  for (const task of tasks) visit(task.id);
  return cycles;
}
