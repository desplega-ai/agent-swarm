/**
 * `SessionThread`'s pure routing/dispatch logic — no React, no `@/`-aliased
 * imports, so it can be unit-tested without mocking the whole component's
 * hook/UI dependency tree. See `session-thread.tsx`'s module doc comment for
 * the full behavioral contract this implements.
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
  "draft",
]);

/** The chain entry with the latest `createdAt`, or `undefined` for an empty chain. */
export function resolveLeafTask(chain: AgentTask[]): AgentTask | undefined {
  if (chain.length === 0) return undefined;
  return [...chain].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/**
 * `task.task` for an app-dispatched task is the FULL resolved agent prompt
 * (the action's configured `prompt` plus a trailing
 * `[App action] app=<id> action=<name> input=<json>` marker appended by the
 * `task.app.action` template — see `src/prompts/session-templates.ts`), not
 * the user's short message. Pull the real message back out of that trailing
 * JSON's `message` field for display; fall back to the raw `task.task` for
 * any chain entry that didn't come through an app action (e.g. steered
 * directly from the dashboard) or whose input has no `message` field.
 */
const APP_ACTION_MARKER = /\[App action\] app=\S+ action=\S+ input=(\{.*\})\s*$/s;

export function extractRequestText(task: AgentTask): string {
  const match = APP_ACTION_MARKER.exec(task.task);
  if (match) {
    try {
      const input = JSON.parse(match[1]) as Record<string, unknown>;
      if (typeof input.message === "string" && input.message.trim().length > 0) {
        return input.message;
      }
    } catch {
      // Malformed JSON tail — fall through to the raw task text.
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
  /** A bound root whose leaf can still receive a steer. */
  steerRoute: boolean;
  /** A bound root whose leaf is terminal (or not yet loaded) — a message chains a new task off it. */
  chainedDispatchRoute: boolean;
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
  const leafTerminal = leafTask === undefined || TERMINAL_LEAF_STATUSES.has(leafTask.status);
  return {
    dispatchRoute: !hasRoot,
    steerRoute: hasRoot && chainLoaded && leafTask !== undefined && !leafTerminal,
    chainedDispatchRoute: hasRoot && chainLoaded && leafTerminal,
  };
}

export interface DispatchChainResult {
  /** The newly created task's id, read off `/actions/<name>` after an `app.action` step — undefined if no such step ran or it hasn't landed yet. */
  newTaskId: string | undefined;
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
      const slot = getByPath(getSnapshot(), slotPath) as { taskId?: string } | undefined;
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
 * Display-active statuses: a turn in one of these shows a live "Working…"
 * indicator instead of `TaskOutcome`. Deliberately separate from
 * `TERMINAL_LEAF_STATUSES` above — that set governs STEER-vs-CHAIN routing
 * for the leaf; this one governs per-turn DISPLAY, and `draft` sits in both
 * (not steerable, but still shown as "waiting" rather than an outcome).
 * Mirrors `ChainOfThought`'s `ACTIVE_STATUSES` (`chain-of-thought.tsx`).
 */
const ACTIVE_DISPLAY_STATUSES: ReadonlySet<AgentTaskStatus> = new Set([
  "pending",
  "offered",
  "backlog",
  "unassigned",
  "draft",
  "in_progress",
  "paused",
  "reviewing",
]);

/** Whether a turn should render the live "Working…" indicator rather than `TaskOutcome`. */
export function isActiveForDisplay(status: AgentTaskStatus): boolean {
  return ACTIVE_DISPLAY_STATUSES.has(status);
}

/**
 * The latest non-null summary line of an activity stream, scanning backwards,
 * or `null`: the live turn's subtitle under "Working…". The component passes
 * the dashboard transcript's `summarizeAgentLog` (which caps a progress note at
 * 140 chars); it is a parameter so this module stays free of `@/` imports.
 */
export function latestStepText<T>(
  logs: readonly T[],
  summarize: (log: T) => string | null,
): string | null {
  for (let i = logs.length - 1; i >= 0; i--) {
    const text = summarize(logs[i] as T);
    if (text) return text;
  }
  return null;
}
