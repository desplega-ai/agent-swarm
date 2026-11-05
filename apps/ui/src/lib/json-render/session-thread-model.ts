/**
 * `SessionThread`'s pure routing/dispatch model — no React, and only type
 * imports from `@/` (erased at runtime), so it stays unit-testable under
 * `bun test` without the component's hook/UI tree. See `session-thread.tsx`'s
 * module doc comment for the behavioral contract this implements.
 */

import { getByPath } from "@json-render/core";
import type { AgentTask, AgentTaskStatus } from "@/api/types";
import { resolveScopedParams } from "./action-params";
import type { ActionChain } from "./catalog";
import { truncateText } from "./json-preview";

/** Most turns rendered: the latest ones; older turns sit behind a notice. */
export const SESSION_THREAD_MAX_TURNS = 100;

/** Longest request text (the user's message, or a raw agent-written task) shown per turn. */
export const SESSION_THREAD_MAX_REQUEST_CHARS = 4_000;

/** Longest output or failure reason shown per turn; the detail sheet has the full text. */
export const SESSION_THREAD_MAX_OUTPUT_CHARS = 20_000;

/**
 * Terminal leaf statuses: the leaf task can no longer receive a steer, so a
 * new message must chain a fresh task off it instead. Mirrors `taskIsRunning`'s
 * terminal set plus `draft` — a draft task is not in the pool, so a steer
 * would 4xx. Deliberately NOT `!taskIsRunning(status)`: that helper returns
 * `undefined` (not `false`) for `draft` (and for `paused`/`reviewing`/etc,
 * correctly — those DO still accept a steer), so using its negation here
 * would route a draft leaf into `steerRoute` and 4xx.
 */
const TERMINAL_LEAF_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
  "skipped",
  "draft",
]);

/** The chain entry with the latest `createdAt`, or `undefined` for an empty chain. */
export function resolveLeafTask(chain: AgentTask[]): AgentTask | undefined {
  if (chain.length === 0) return undefined;
  return [...chain].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

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
 * Falls back to the raw `task.task` for a task that did not come through an
 * app action (e.g. steered from the dashboard) or whose input has no
 * `message`.
 */
const APP_ACTION_MARKER_LINE = /^\[App action\] app=\S+ action=\S+ input=(\{.*\})[ \t]*$/gm;

export function extractRequestText(task: AgentTask): string {
  let inputJson: string | undefined;
  for (const match of task.task.matchAll(APP_ACTION_MARKER_LINE)) inputJson = match[1];
  if (inputJson !== undefined) {
    try {
      const input = JSON.parse(inputJson) as Record<string, unknown>;
      if (typeof input.message === "string" && input.message.trim().length > 0) {
        return input.message;
      }
    } catch {
      // Malformed JSON — fall through to the raw task text.
    }
  }
  return task.task;
}

/** The user-visible request line of a turn, capped at `SESSION_THREAD_MAX_REQUEST_CHARS`. */
export function turnRequestText(task: AgentTask): string {
  return truncateText(extractRequestText(task), SESSION_THREAD_MAX_REQUEST_CHARS);
}

/**
 * A copy of the task for `TaskOutcome` with its agent-written `output` and
 * `failureReason` capped at `SESSION_THREAD_MAX_OUTPUT_CHARS`, so one huge
 * result cannot stall the markdown renderer. Unchanged tasks keep identity.
 */
export function boundTurnTask(task: AgentTask): AgentTask {
  const output =
    typeof task.output === "string"
      ? truncateText(task.output, SESSION_THREAD_MAX_OUTPUT_CHARS)
      : task.output;
  const failureReason =
    typeof task.failureReason === "string"
      ? truncateText(task.failureReason, SESSION_THREAD_MAX_OUTPUT_CHARS)
      : task.failureReason;
  if (output === task.output && failureReason === task.failureReason) return task;
  return { ...task, output, failureReason };
}

/**
 * The turns to render, oldest first: the chain sorted by `createdAt`, cut to
 * the latest `SESSION_THREAD_MAX_TURNS`. `hidden` counts the older turns left out.
 */
export function visibleTurns(chain: readonly AgentTask[]): { turns: AgentTask[]; hidden: number } {
  const ordered = [...chain].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const hidden = Math.max(0, ordered.length - SESSION_THREAD_MAX_TURNS);
  return { turns: hidden > 0 ? ordered.slice(hidden) : ordered, hidden };
}

export interface SessionThreadRoute {
  /** No root at all — a message dispatches a brand-new, disconnected task. */
  dispatchRoute: boolean;
  /** A bound root whose leaf is not finished — a message steers it. */
  steerRoute: boolean;
  /** A bound root whose leaf is terminal — a message chains a new task off it. */
  chainedDispatchRoute: boolean;
  /**
   * A bound root whose loaded chain is empty (deleted, or not visible to this
   * viewer). Sending is blocked: there is no leaf to chain under, and a
   * dispatch would start a disconnected root the page never adopts.
   */
  chainMissing: boolean;
}

/**
 * Pure routing decision — see `session-thread.tsx`'s module doc comment for
 * the full policy. `chainLoaded` must be `true` for `rootTaskId === ""`
 * (nothing to load) or once the bound root's chain has resolved; while a
 * bound root's chain is still loading, both `steerRoute` and
 * `chainedDispatchRoute` stay `false` rather than guess.
 */
export function resolveSessionThreadRoute(input: {
  rootTaskId: string;
  chainLoaded: boolean;
  leafTask: AgentTask | undefined;
}): SessionThreadRoute {
  const { rootTaskId, chainLoaded, leafTask } = input;
  const hasRoot = rootTaskId !== "";
  const leafKnown = hasRoot && chainLoaded && leafTask !== undefined;
  const leafTerminal = leafTask !== undefined && TERMINAL_LEAF_STATUSES.has(leafTask.status);
  return {
    dispatchRoute: !hasRoot,
    steerRoute: leafKnown && !leafTerminal,
    chainedDispatchRoute: leafKnown && leafTerminal,
    chainMissing: hasRoot && chainLoaded && leafTask === undefined,
  };
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
 * The label of a turn that has no outcome yet, or `null` once it has one
 * (`TaskOutcome` renders it). Only `in_progress` is "Working…"; a task that is
 * waiting, paused, or in review says so. Separate from
 * `TERMINAL_LEAF_STATUSES`, which governs steer-vs-chain routing: `draft`
 * sits in both (not steerable, but shown as waiting rather than an outcome).
 */
const PENDING_TURN_LABELS: Partial<Record<AgentTaskStatus, string>> = {
  in_progress: "Working…",
  pending: "Queued",
  offered: "Queued",
  unassigned: "Queued",
  backlog: "Queued",
  draft: "Draft",
  paused: "Paused",
  reviewing: "In review",
};

export function pendingTurnLabel(status: AgentTaskStatus): string | null {
  return PENDING_TURN_LABELS[status] ?? null;
}

/**
 * Whether a send that created `pendingTaskId` has shown up: the chain holds
 * the task, or (first send) the page bound the new root. Until then sending
 * stays blocked, so a quick second message cannot chain off the old leaf or
 * start a second root.
 */
export function isDispatchSettled(input: {
  pendingTaskId: string | null;
  rootTaskId: string;
  chain: readonly AgentTask[];
}): boolean {
  const { pendingTaskId, rootTaskId, chain } = input;
  if (pendingTaskId === null) return true;
  if (rootTaskId === pendingTaskId) return true;
  return chain.some((task) => task.id === pendingTaskId);
}

/**
 * The summary of the newest activity entry that has one, or `null`: the live
 * turn's subtitle under "Working…". Picks by `createdAt`, not array position,
 * because `GET /api/tasks/{id}` returns logs newest-first (`ORDER BY createdAt
 * DESC`). The component passes the dashboard transcript's `summarizeAgentLog`
 * (which caps a progress note at 140 chars); it is a parameter so this module
 * has no runtime `@/` imports.
 */
export function latestStepText<T extends { createdAt: string }>(
  logs: readonly T[],
  summarize: (log: T) => string | null,
): string | null {
  let newest: { at: string; text: string } | null = null;
  for (const log of logs) {
    if (newest !== null && log.createdAt <= newest.at) continue;
    const text = summarize(log);
    if (text) newest = { at: log.createdAt, text };
  }
  return newest?.text ?? null;
}
