import type { TaskUiSpec } from "../utils/task-ui-spec";
import { renderTaskUiSpec } from "./validate";

/**
 * Slack Block Kit blocks for a stored task UI spec. Re-runs the render steps,
 * because a package bump can change what a stored spec converts to. Returns
 * `[]` when the stored spec no longer converts; the caller then shows the
 * stored fallback text. Logs the issues, never the spec body.
 */
export function taskUiSpecSlackBlocks(stored: TaskUiSpec, taskId: string): unknown[] {
  const rendered = renderTaskUiSpec(stored.spec, taskId);
  if (rendered.ok) return rendered.blocks;
  console.warn(
    `[ui-spec] stored spec for task ${taskId} no longer renders: ${rendered.issues.join(" | ")}`,
  );
  return [];
}
