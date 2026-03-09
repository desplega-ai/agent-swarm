export { findEntryNodes, getSuccessors, startWorkflowExecution } from "./engine";
export { workflowEventBus } from "./event-bus";
export { recoverStuckWorkflowRuns } from "./recovery";
export { retryFailedRun } from "./resume";
export { interpolate } from "./template";

import { workflowEventBus } from "./event-bus";
import { setupWorkflowResumeListener } from "./resume";
import { evaluateWorkflowTriggers } from "./triggers";

export function initWorkflows(): void {
  setupWorkflowResumeListener(workflowEventBus);

  // Subscribe to events for trigger matching
  const triggerEvents = [
    "task.created",
    "task.completed",
    // GitHub events
    "github.pull_request.opened",
    "github.pull_request.closed",
    "github.issue.opened",
    "github.issue_comment.created",
    "github.pull_request_review.submitted",
    // GitLab events
    "gitlab.merge_request.open",
    "gitlab.merge_request.close",
    "gitlab.merge_request.merge",
    "gitlab.issue.open",
    "gitlab.note.created",
    "gitlab.pipeline.failed",
    "gitlab.pipeline.success",
    // Other
    "slack.message",
    "agentmail.message.received",
  ];
  for (const event of triggerEvents) {
    workflowEventBus.on(event, (data: unknown) => {
      evaluateWorkflowTriggers(event, data);
    });
  }
}
