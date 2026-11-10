import { getWorkflowRun } from "../be/db";
import type { WorkflowRun, WorkflowRunStatus } from "../types";

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Bounded poll on the state a test is about to assert. Use it instead of a
 * fixed sleep: workflow continuations run fire-and-forget off the event bus,
 * so how long they take depends on what else the host is running.
 */
export async function waitUntil(
  ready: () => unknown | Promise<unknown>,
  describeTimeout: () => string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error(`${describeTimeout()} (waited ${timeoutMs}ms)`);
    await Bun.sleep(10);
  }
}

/**
 * Poll a workflow run until it has the `expected` status. `alsoReady` adds a
 * condition the status alone does not show, such as a step row that must exist.
 */
export async function waitForRunStatus(
  runId: string,
  expected: WorkflowRunStatus,
  alsoReady: (run: WorkflowRun) => boolean | Promise<boolean> = () => true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WorkflowRun> {
  let run = null as WorkflowRun | null;
  await waitUntil(
    async () => {
      run = await getWorkflowRun(runId);
      return run?.status === expected && (await alsoReady(run));
    },
    () =>
      `Workflow run ${runId} did not reach status "${expected}": last status "${run?.status ?? "run not found"}"`,
    timeoutMs,
  );
  return run as WorkflowRun;
}
