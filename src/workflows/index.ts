export { findEntryNodes, getSuccessors } from "./definition";
export { startWorkflowExecution } from "./engine";
export { workflowEventBus } from "./event-bus";
export { recoverIncompleteRuns } from "./recovery";
export {
  cancelWorkflowRun,
  initWaitBusSubscriptions,
  resumeWaitState,
  retryFailedRun,
  setupWorkflowResumeListener,
  subscribeWaitToBus,
} from "./resume";
export { startRetryPoller, stopRetryPoller } from "./retry-poller";
export { interpolate } from "./template";
export { instantiateTemplate, validateTemplateVariables } from "./templates";
export {
  handleEventTrigger,
  handleScheduleTrigger,
  handleWebhookTrigger,
  logOpenWebhookTriggers,
} from "./triggers";
export { snapshotWorkflow } from "./version";
export { startWaitPoller, stopWaitPoller } from "./wait-poller";

import * as db from "../be/db";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "./event-bus";
import type { ExecutorRegistry } from "./executors/registry";
import { createExecutorRegistry } from "./executors/registry";
import { recoverIncompleteRuns } from "./recovery";
import { initWaitBusSubscriptions, setupWorkflowResumeListener } from "./resume";
import { startRetryPoller } from "./retry-poller";
import { interpolate } from "./template";
import { handleEventTrigger, logOpenWebhookTriggers } from "./triggers";
import { startWaitPoller } from "./wait-poller";

// ─── Module-level singleton ────────────────────────────────

let _registry: ExecutorRegistry | null = null;
let eventTriggerListenersInitialized = false;

/** Bus events that start workflows with a matching `event` trigger. Keep in sync with `TriggerConfigSchema`. */
const EVENT_TRIGGER_NAMES = [
  "slack.message",
  "azure-devops.work_item.assigned",
  "azure-devops.work_item.commented",
] as const;

function createBuiltInExecutorRegistry(): ExecutorRegistry {
  return createExecutorRegistry({
    db,
    eventBus: workflowEventBus,
    interpolate: (template, ctx) => interpolate(template, ctx).result,
  });
}

/**
 * Get the executor registry singleton, constructing its side-effect-free
 * executor catalog on first use so authoring validation is available before
 * the workflow pollers/listeners start.
 */
export function getExecutorRegistry(): ExecutorRegistry {
  _registry ??= createBuiltInExecutorRegistry();
  return _registry;
}

function setupEventTriggerListeners(): void {
  if (eventTriggerListenersInitialized) return;

  for (const eventName of EVENT_TRIGGER_NAMES) {
    workflowEventBus.on(eventName, (payload) => {
      void handleEventTrigger(eventName, payload, getExecutorRegistry()).catch((err) => {
        console.error(
          `[workflows] Failed to dispatch ${eventName} event trigger:`,
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        );
      });
    });
  }
  eventTriggerListenersInitialized = true;
}

/**
 * Initialize the workflow engine:
 * 1. Create executor registry with all built-in executors
 * 2. Wire up event bus listeners for task lifecycle resume
 * 3. Recover incomplete runs from previous server lifecycle
 * 4. Start the retry poller for failed steps with pending retries
 */
export async function initWorkflows(): Promise<void> {
  // 1. Create the executor registry singleton
  _registry = getExecutorRegistry();

  // 2. Wire up resume listener (task.completed / task.failed / task.cancelled)
  setupWorkflowResumeListener(workflowEventBus, _registry);
  setupEventTriggerListeners();

  // 3. Recover incomplete runs (running + waiting) from previous lifecycle
  recoverIncompleteRuns(_registry).catch((err) => {
    console.error("[workflows] Failed to recover incomplete runs on startup:", err);
  });

  // 4. Start retry poller for failed steps with nextRetryAt
  startRetryPoller(_registry);

  // 5. Start wait poller for time-mode waits + event-mode timeouts
  startWaitPoller(_registry);

  // 6. Initialize wait-bus subscriptions for event-mode waits (Phase 3).
  // Re-attaches one bus listener per distinct pending eventName from the DB.
  await initWaitBusSubscriptions(_registry);

  // 7. Inventory (non-blocking, informational) which enabled workflows expose
  // an open — intentionally unsigned — webhook trigger.
  void logOpenWebhookTriggers();
}
