/**
 * `SessionThread`'s pure dispatch model — no React, and only type imports
 * from `@/` (erased at runtime), so it stays unit-testable under `bun test`
 * without the component's hook/UI tree. See `session-thread.tsx`'s module doc
 * comment for the behavioral contract this implements.
 */

import { getByPath } from "@json-render/core";
import type { AgentTask } from "@/api/types";
import { resolveScopedParams } from "./action-params";
import type { ActionChain } from "./catalog";
import { truncateText } from "./json-preview";

/** Longest person message shown per turn; the task page keeps the full prompt. */
export const SESSION_THREAD_MAX_REQUEST_CHARS = 4_000;

/**
 * `task.task` for an app-dispatched task is the FULL resolved agent prompt
 * from the `task.app.action` template (`src/prompts/session-templates.ts`):
 * the action's `prompt`, then a marker line
 * `[App action] app=<id> action=<name> input=<json>`, then further lines
 * (today `Caller (server-verified): <json>`). `input_json` is
 * `JSON.stringify(input)`, a single line, so the marker is matched line by
 * line and never assumed to be the last one. The last marker line wins, since
 * the configured `prompt` comes first and could quote one. A root test
 * renders the real template through this parser so the two cannot drift.
 */
const APP_ACTION_MARKER_LINE = /^\[App action\] app=\S+ action=\S+ input=(\{.*\})[ \t]*$/gm;

/**
 * The person's message in an app-dispatched task (`input.message` of its
 * marker line), or `null` for a task with no marker, no `message`, or
 * malformed input JSON.
 */
export function appActionMessage(task: Pick<AgentTask, "task">): string | null {
  let inputJson: string | undefined;
  for (const match of task.task.matchAll(APP_ACTION_MARKER_LINE)) inputJson = match[1];
  if (inputJson === undefined) return null;
  try {
    const input = JSON.parse(inputJson) as Record<string, unknown>;
    if (typeof input.message === "string" && input.message.trim().length > 0) {
      return input.message;
    }
  } catch {
    // Malformed JSON: not a message.
  }
  return null;
}

/**
 * The person bubble text of a thread turn (`TurnTimeline`'s `requestText`):
 * the app action's message, capped at `SESSION_THREAD_MAX_REQUEST_CHARS`.
 * Only `api` tasks qualify (`app.action` creates its tasks with that source),
 * so a worker task whose prompt quotes a marker stays a worker step. Null:
 * the timeline's own rules place the task.
 */
export function threadRequestText(task: AgentTask): string | null {
  if (task.source !== "api") return null;
  const message = appActionMessage(task);
  return message === null ? null : truncateText(message, SESSION_THREAD_MAX_REQUEST_CHARS);
}

export interface DispatchChainResult {
  /** The newly created task's id, read off `/actions/<name>` after an `app.action` step — undefined if no such step ran or it hasn't landed yet. */
  newTaskId: string | undefined;
}

/** An `app.action` slot as `app-surface.tsx` writes it to `/actions/<name>`. */
interface ActionSlotView {
  status?: string;
  taskId?: string;
  error?: string;
}

/**
 * Pure orchestration for `onDispatch` (+ `onRootCreated` when applicable) —
 * no React, so it's testable with a mock `execute`/`getSnapshot`. Mirrors
 * `app-surface.tsx`'s `"app.action"` handler contract: that handler writes
 * its response (incl. `taskId`) to `/actions/<name>` (or
 * `/refs/<app>/actions/<name>` for a borrowed instance) SYNCHRONOUSLY before
 * `execute` resolves — that's the only way to learn the newly created task's
 * id, since `execute` itself returns void.
 */
export async function runDispatchChain(options: {
  onDispatch: ActionChain | undefined;
  onRootCreated: ActionChain | undefined;
  message: string;
  wasEmpty: boolean;
  /** The leaf to chain under, or `null` on a brand-new thread (no root yet). */
  leafTaskId: string | null;
  execute: (binding: { action: string; params?: Record<string, unknown> }) => Promise<void>;
  getSnapshot: () => Record<string, unknown>;
}): Promise<DispatchChainResult> {
  const { onDispatch, onRootCreated, message, wasEmpty, leafTaskId, execute, getSnapshot } =
    options;
  if (!onDispatch || onDispatch.length === 0) return { newTaskId: undefined };
  // `null` means "no leaf" and drops `parentTaskId`, which is only right for a
  // brand-new thread. A follow-up with no leaf would start a disconnected root.
  if (!wasEmpty && leafTaskId === null) {
    throw new Error("Cannot continue this conversation: its latest task is unknown");
  }

  // Explicit absence: every chain key is published, `null` when there is no
  // value yet. On a brand-new thread `leafTaskId` is `null`, so a
  // `"parentTaskId": { "$chain": "leafTaskId" }` param is dropped and the
  // first message creates a root task (see `resolveScopedValue`).
  const scope = {
    form: { message },
    state: getSnapshot(),
    chain: { leafTaskId, newTaskId: null },
  };
  let newTaskId: string | undefined;
  for (const binding of onDispatch) {
    const params = resolveScopedParams(binding.params, scope);
    await execute({ ...binding, params });
    if (binding.action === "app.action" && typeof params.name === "string") {
      const slotPath =
        typeof params.$app === "string"
          ? `/refs/${params.$app}/actions/${params.name}`
          : `/actions/${params.name}`;
      const slot = getByPath(getSnapshot(), slotPath) as ActionSlotView | undefined;
      // The handler reports a failure on the slot instead of throwing; stop the
      // chain so later steps (and `onRootCreated`) never run on a failed send.
      if (slot?.status === "error") {
        throw new Error(slot.error || `Action ${params.name} failed`);
      }
      if (slot?.taskId) newTaskId = slot.taskId;
    }
  }

  if (wasEmpty && newTaskId && onRootCreated && onRootCreated.length > 0) {
    const rootScope = { chain: { leafTaskId: null, newTaskId }, state: getSnapshot() };
    for (const binding of onRootCreated) {
      const params = resolveScopedParams(binding.params, rootScope);
      await execute({ ...binding, params });
    }
  }

  return { newTaskId };
}

/** Pure orchestration for `onReset` — clears `rootTaskId` (app-side via `app.mutate`, not here). */
export async function runResetChain(options: {
  onReset: ActionChain | undefined;
  execute: (binding: { action: string; params?: Record<string, unknown> }) => Promise<void>;
  getSnapshot: () => Record<string, unknown>;
}): Promise<void> {
  const { onReset, execute, getSnapshot } = options;
  if (!onReset || onReset.length === 0) return;
  const scope = { state: getSnapshot() };
  for (const binding of onReset) {
    const params = resolveScopedParams(binding.params, scope);
    await execute({ ...binding, params });
  }
}

/**
 * Whether a send that created `pendingTaskId` has shown up: the chain holds
 * the task, or (first send) the page bound the new root. Until then the send
 * stays pending, so a quick second message cannot chain off the old leaf or
 * start a second root.
 */
export function isDispatchSettled(input: {
  pendingTaskId: string | null;
  rootTaskId: string;
  chain: readonly Pick<AgentTask, "id">[];
}): boolean {
  const { pendingTaskId, rootTaskId, chain } = input;
  if (pendingTaskId === null) return true;
  if (rootTaskId === pendingTaskId) return true;
  return chain.some((task) => task.id === pendingTaskId);
}
