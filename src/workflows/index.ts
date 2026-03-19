export { findEntryNodes, getSuccessors } from "./definition";
export { startWorkflowExecution } from "./engine";
export { workflowEventBus } from "./event-bus";
export { recoverIncompleteRuns, recoverStuckWorkflowRuns } from "./recovery";
export { retryFailedRun, setupWorkflowResumeListener } from "./resume";
export { startRetryPoller, stopRetryPoller } from "./retry-poller";
export { interpolate } from "./template";
export { instantiateTemplate, validateTemplateVariables } from "./templates";
export { handleWebhookTrigger } from "./triggers";
export { snapshotWorkflow } from "./version";

import { workflowEventBus } from "./event-bus";
import { setupWorkflowResumeListener } from "./resume";

export function initWorkflows(): void {
  // Note: Phase 4 adds registry parameter. For now, resume listener is set up
  // with the event bus only. The registry will be injected in Phase 7's
  // full initWorkflows() rewrite via createExecutorRegistry().
  setupWorkflowResumeListener(workflowEventBus, undefined as never);

  // Event-based trigger subscriptions removed in Phase 5.
  // Workflows are now triggered via:
  // - Webhook: POST /api/webhooks/:workflowId (HMAC-verified)
  // - Schedule: scheduler calls startWorkflowExecution() via scheduleId reference
  // - Manual: POST /api/workflows/:id/trigger (API key auth)
}
