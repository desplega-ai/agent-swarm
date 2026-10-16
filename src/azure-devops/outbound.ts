import { getDbClient } from "../be/db";
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
  if (ok) {
    console.log(
      scrubSecrets(`[AzureDevOps] Work item #${workItemId} -> ${state} (task ${taskId})`),
    );
  }
}

const transitionChains = new Map<string, Promise<void>>();

/**
 * Run transitions for one task in the order they were requested, so a slow
 * "Doing" PATCH cannot land after "Done". Callers never wait on the chain.
 */
function enqueueTransition(taskId: string, state: string, eventName: string): void {
  const run = (transitionChains.get(taskId) ?? Promise.resolve())
    .then(() => transitionLinkedWorkItem(taskId, state))
    .catch((error) => report(eventName, error));
  transitionChains.set(taskId, run);
  void run.then(() => {
    if (transitionChains.get(taskId) === run) transitionChains.delete(taskId);
  });
}

function report(eventName: string, error: unknown): void {
  console.error(
    `[AzureDevOps Outbound] ${eventName} handler failed:`,
    scrubSecrets(error instanceof Error ? error.message : String(error)),
  );
}

function handleTaskStarted(task: AgentTask): void {
  const state = getWorkItemState("STARTED");
  if (state) enqueueTransition(task.id, state, "task.started");
}

const onTaskCompleted = (data: unknown): void => {
  const { taskId } = (data ?? {}) as { taskId?: string };
  const state = getWorkItemState("DONE");
  if (taskId && state) enqueueTransition(taskId, state, "task.completed");
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
      // startTask/claimTask can emit inside a transaction; a rollback must not reach Azure.
      if (subscribed) getDbClient().afterCommit(() => handleTaskStarted(task));
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
