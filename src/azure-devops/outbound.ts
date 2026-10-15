import { getTrackerSync } from "../be/db-queries/tracker";
import { onTaskStarted } from "../be/task-lifecycle-events";
import type { AgentTask } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { workflowEventBus } from "../workflows/event-bus";
import { updateWorkItemFields } from "./api";

const PROVIDER = "azure-devops";

/**
 * Target state names are process-specific (Agile Active/Closed, Scrum
 * Committed/Done, Basic Doing/Done), so they are operator-set. Unset or blank
 * means the swarm never changes the work item state.
 */
export function getWorkItemState(which: "STARTED" | "DONE"): string | null {
  return process.env[`AZURE_DEVOPS_WORKITEM_STATE_${which}`]?.trim() || null;
}

/** Move the work item linked to `taskId` to `state`. Tasks without a link are ignored. */
async function transitionLinkedWorkItem(taskId: string, state: string): Promise<void> {
  const sync = await getTrackerSync(PROVIDER, "task", taskId);
  if (!sync) return;
  // externalId is `{orgKey}#{workItemId}`, orgKey `dev.azure.com/{org}` or `{org}.visualstudio.com`.
  const [orgKey, id] = sync.externalId.split("#");
  const workItemId = Number(id);
  if (!orgKey || !Number.isInteger(workItemId)) return;
  const ok = await updateWorkItemFields(`https://${orgKey}`, workItemId, [
    { op: "add", path: "/fields/System.State", value: state },
  ]);
  if (ok) console.log(`[AzureDevOps] Work item #${workItemId} -> ${state} (task ${taskId})`);
}

function report(eventName: string, error: unknown): void {
  console.error(
    `[AzureDevOps Outbound] ${eventName} handler failed:`,
    scrubSecrets(error instanceof Error ? error.message : String(error)),
  );
}

async function handleTaskStarted(task: AgentTask): Promise<void> {
  const state = getWorkItemState("STARTED");
  if (state) await transitionLinkedWorkItem(task.id, state);
}

async function handleTaskCompleted(data: unknown): Promise<void> {
  const { taskId } = (data ?? {}) as { taskId?: string };
  const state = getWorkItemState("DONE");
  if (taskId && state) await transitionLinkedWorkItem(taskId, state);
}

const onTaskCompleted = (data: unknown): void => {
  handleTaskCompleted(data).catch((error) => report("task.completed", error));
};

let subscribed = false;
let startedHookRegistered = false;

/** Subscribe work-item state transitions to task lifecycle events. Idempotent, API-server only. */
export function initAzureDevOpsOutbound(): void {
  if (subscribed) return;
  subscribed = true;
  // onTaskStarted has no unregister, so register once and gate on `subscribed`.
  if (!startedHookRegistered) {
    startedHookRegistered = true;
    onTaskStarted((task) => {
      if (subscribed) handleTaskStarted(task).catch((error) => report("task.started", error));
    });
  }
  workflowEventBus.on("task.completed", onTaskCompleted);
}

/** Unsubscribe from lifecycle events (tests, config reloads). */
export function teardownAzureDevOpsOutbound(): void {
  if (!subscribed) return;
  subscribed = false;
  workflowEventBus.off("task.completed", onTaskCompleted);
}
