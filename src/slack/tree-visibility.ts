import { ensureSlackRenderV2Activation, getSlackRenderV2ActivatedAt } from "../be/db";
import { observeSlackTreeVisibility } from "../be/db/slack-trees";
import type { AgentTask } from "../types";
import { isEnvFlagEnabled } from "../utils/env-flag";

let generation = 0;
let observed: boolean | undefined;
let visibilityTail: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

export function isSlackTaskTreeEnabled(): boolean {
  return (
    isEnvFlagEnabled("SLACK_RENDER_V2", true) &&
    isEnvFlagEnabled("SLACK_RENDER_V2_TASK_TREE_ENABLED", true)
  );
}

export function invalidateSlackTreeOperations(): void {
  generation++;
  for (const listener of listeners) listener();
}

export function onSlackTreeInvalidated(listener: () => void): void {
  listeners.add(listener);
}

/** Called at hydration too: a rapid off/on between watcher ticks must be persisted. */
export async function syncSlackTreeVisibility(): Promise<string | null> {
  const enabled = isSlackTaskTreeEnabled();
  if (observed !== enabled) {
    observed = enabled;
    invalidateSlackTreeOperations();
  }
  const v2Enabled = isEnvFlagEnabled("SLACK_RENDER_V2", true);
  const run = visibilityTail
    .catch(() => {})
    .then(async () => {
      if (v2Enabled && !(await getSlackRenderV2ActivatedAt()))
        await ensureSlackRenderV2Activation();
      return observeSlackTreeVisibility(enabled);
    });
  visibilityTail = run;
  return run;
}

export function slackTreeGeneration(): number {
  return generation;
}

export class SlackTreeSuppressed extends Error {}

export function assertSlackTreeCurrent(expected: number): void {
  if (!isSlackTaskTreeEnabled() || expected !== generation) throw new SlackTreeSuppressed();
}

export function canPresentSlackTree(tasks: AgentTask[], cutoff: string | null): boolean {
  if (!isSlackTaskTreeEnabled()) return false;
  if (!cutoff) return true;
  return tasks.some(
    (task) =>
      !["completed", "failed", "cancelled", "superseded", "skipped"].includes(task.status) ||
      (task.finishedAt !== undefined && task.finishedAt > cutoff),
  );
}
