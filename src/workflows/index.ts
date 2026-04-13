export { findEntryNodes, getSuccessors } from "./definition";
export { startWorkflowExecution } from "./engine";
export { workflowEventBus } from "./event-bus";
export { recoverIncompleteRuns } from "./recovery";
export { cancelWorkflowRun, retryFailedRun, setupWorkflowResumeListener } from "./resume";
export { startRetryPoller, stopRetryPoller } from "./retry-poller";
export { interpolate } from "./template";
export { instantiateTemplate, validateTemplateVariables } from "./templates";
export { handleScheduleTrigger, handleWebhookTrigger } from "./triggers";
export { snapshotWorkflow } from "./version";

import * as db from "../be/db";
import { workflowEventBus } from "./event-bus";
import type { ExecutorRegistry } from "./executors/registry";
import { createExecutorRegistry } from "./executors/registry";
import { recoverIncompleteRuns } from "./recovery";
import { setupWorkflowResumeListener } from "./resume";
import { startRetryPoller } from "./retry-poller";
import { interpolate } from "./template";

// ─── Module-level singleton ────────────────────────────────

let _registry: ExecutorRegistry | null = null;

/**
 * Get the executor registry singleton.
 * Throws if called before `initWorkflows()`.
 */
export function getExecutorRegistry(): ExecutorRegistry {
  if (!_registry) {
    throw new Error("Workflow engine not initialized — call initWorkflows() first");
  }
  return _registry;
}

/**
 * Initialize the workflow engine:
 * 1. Create executor registry with all built-in executors
 * 2. Wire up event bus listeners for task lifecycle resume
 * 3. Recover incomplete runs from previous server lifecycle
 * 4. Start the retry poller for failed steps with pending retries
 */
export function initWorkflows(): void {
  // 1. Create the executor registry singleton
  _registry = createExecutorRegistry({
    db,
    eventBus: workflowEventBus,
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  });

  // 2. Wire up resume listener (task.completed / task.failed / task.cancelled)
  setupWorkflowResumeListener(workflowEventBus, _registry);

  // 3. Recover incomplete runs (running + waiting) from previous lifecycle
  recoverIncompleteRuns(_registry).catch((err) => {
    console.error("[workflows] Failed to recover incomplete runs on startup:", err);
  });

  // 4. Start retry poller for failed steps with nextRetryAt
  startRetryPoller(_registry);
}
