export { findEntryNodes, getSuccessors } from "./definition";
export { startWorkflowExecution } from "./engine";
export { workflowEventBus } from "./event-bus";
export { recoverIncompleteRuns, recoverStuckWorkflowRuns } from "./recovery";
export { retryFailedRun, setupWorkflowResumeListener } from "./resume";
export { startRetryPoller, stopRetryPoller } from "./retry-poller";
export { interpolate } from "./template";

import { workflowEventBus } from "./event-bus";
import { setupWorkflowResumeListener } from "./resume";
import { evaluateWorkflowTriggers } from "./triggers";

export function initWorkflows(): void {
  // Note: Phase 4 adds registry parameter. For now, resume listener is set up
  // with the event bus only. The registry will be injected in Phase 7's
  // full initWorkflows() rewrite via createExecutorRegistry().
  // Until then, the event trigger subscriptions remain for backward compat.
  setupWorkflowResumeListener(workflowEventBus, undefined as never);

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
