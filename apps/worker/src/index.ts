#!/usr/bin/env node
/**
 * Headless worker (§43, §54).
 *
 * Runs the same orchestration as the API process, with no HTTP server, so long agent
 * runs survive a closed browser or a quit desktop app. It shares one database with the
 * API and the desktop shell and takes over projects that are queued for background
 * execution — two processes never work on the same project at once because the claim
 * is a single transactional database update and active runs are excluded.
 *
 * Usage:
 *   npm run dev:worker                 # watch mode, one worker, all projects
 *   node apps/worker/dist/index.mjs --project <id> --once
 *   AIDO_WORKER_PROJECTS=<id>,<id>     # restrict to specific projects
 */
import { createBackgroundScheduler } from '@aido/orchestrator';
import { createContainer } from '../../api/src/container.js';

const args = process.argv.slice(2);
/**
 * Reads `--flag value` or the bare `--flag` form. A following `--other` is a new
 * flag, not this flag's value (that mistake silently turned `--once --interval 1000`
 * into a daemon).
 */
const flag = (name: string): string | null => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return null;
  const next = args[index + 1];
  return next && !next.startsWith('--') ? next : 'true';
};

const projectFilter = flag('project')
  ? [flag('project') as string]
  : (process.env.AIDO_WORKER_PROJECTS?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? []);
const once = flag('once') === 'true';
/** Ceiling for a `--once` run, so a stuck project cannot hold the process forever. */
const onceTimeoutMs = Number(flag('timeout-ms') ?? process.env.AIDO_WORKER_ONCE_TIMEOUT_MS ?? 30 * 60_000);
const pollIntervalMs = Number(flag('interval') ?? process.env.AIDO_WORKER_INTERVAL_MS ?? 3_000);

const container = createContainer();
const { store, runner, logger, events, gitFor } = container;

logger.info('worker starting', {
  database: container.config.dbPath,
  workspaceRoot: container.config.workspaceRoot,
  executionMode: container.settings().executionMode,
  projectFilter: projectFilter.length ? projectFilter : 'all',
  once,
});

const scheduler = createBackgroundScheduler({
  context: { store, runner, logger, events, gitFor },
  projectFilter,
  pollIntervalMs,
  onceTimeoutMs,
});

try {
  if (once) {
    const { remaining } = await scheduler.runOnce();
    if (remaining.length) logger.warn('projects still unfinished after the --once run', { projects: remaining });
    await container.close();
  } else {
    const stop = scheduler.start();

    const shutdown = async (signal: string): Promise<void> => {
      await stop();
      logger.info('worker stopping', { signal, active: runner.listActive().length });
      for (const projectId of runner.listActive()) {
        store.tasks.listByProject(projectId).forEach((task) => {
          if (task.status === 'running') store.tasks.update(task.id, { status: 'ready', lastError: 'paused by worker shutdown' });
        });
      }
      events.emit('system.notice', { worker: 'stopped' }, { message: 'Worker stopped; unfinished tasks were returned to the queue.', severity: 'warning' });
      await container.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  }
} catch (err) {
  logger.error('worker failed to start', { error: err instanceof Error ? err.message : String(err) });
  await container.close();
  process.exit(1);
}
