#!/usr/bin/env node
/**
 * API entry point (`npm run dev:api`, `npm start`).
 *
 * Binds 0.0.0.0 so the desktop shell, the sandbox preview and other Machines on
 * the network can reach it. Nothing privileged happens here: the whole application
 * lives in `container.ts` + `server.ts` so it can also be embedded in Electron and
 * in the worker without a second implementation (§54).
 */
import { buildServer } from './server.js';

const server = await buildServer();
const url = await server.listen();
const { container } = server;

container.logger.info('AI Dev Orchestrator API listening', {
  url,
  database: container.config.dbPath,
  providers: container.registry.summaries().length,
  freeOnlyMode: container.settings().freeOnlyMode,
  executionMode: container.settings().executionMode,
  shell: container.shell.kind,
});

for (const warning of container.healthWarnings()) {
  container.logger.warn(`provider warning [${warning.providerId}] ${warning.message}`);
}

const shutdown = async (signal: string): Promise<void> => {
  container.logger.info('shutting down', { signal });
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
