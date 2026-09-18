/**
 * Re-export of the shared background helpers.
 *
 * The implementation lives in `@aido/orchestrator` because the desktop shell uses the
 * same scheduler; this file keeps the worker's import path stable.
 */
export { agentBranchName, ensureAgentBranch, reclaimInterruptedTasks, resumeRun, type BackgroundContext } from '@aido/orchestrator';
