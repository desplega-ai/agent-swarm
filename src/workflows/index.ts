export { findEntryNodes, getSuccessors, startWorkflowExecution } from "./engine";
export { workflowEventBus } from "./event-bus";
export { retryFailedRun } from "./resume";
export { interpolate } from "./template";

import { workflowEventBus } from "./event-bus";
import { setupWorkflowResumeListener } from "./resume";

export function initWorkflows(): void {
  setupWorkflowResumeListener(workflowEventBus);
}
