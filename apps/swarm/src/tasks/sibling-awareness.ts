/**
 * DB-backed orchestrator for cross-ingress sibling-task awareness (Phase 2).
 *
 * Wraps the pure renderer/picker in `sibling-block.ts` with a single round-trip
 * to the DB so any ingress can call ONE function before `createTaskExtended`
 * to (a) prepend the sibling block to the task description and (b) auto-wire
 * `parentTaskId` for same-agent resume.
 *
 * Lives on the server side — safe to import from any of `src/slack/`,
 * `src/github/`, `src/gitlab/`, `src/agentmail/`, `src/linear/`,
 * `src/scheduler/`, `src/http/`, `src/tools/`. Workers don't call this.
 */

import {
  type CreateTaskOptions,
  createTaskExtended,
  getAgentById,
  getInProgressTasksByContextKey,
} from "../be/db";
import type { AgentTask } from "../types";
import {
  pickResumeParent,
  prependSiblingBlock,
  type SiblingTaskInfo,
  stripSiblingBlock,
} from "./sibling-block";

export type ApplySiblingAwarenessInput = {
  description: string;
  contextKey: string;
  // The agent that will own the new task. When provided, sibling auto-wiring
  // for `parentTaskId` only fires if a sibling on the same agent exists.
  // When null/undefined, no parent is wired (resume semantics undefined).
  currentAgentId?: string | null;
  // Optional override for "now" — used by tests for deterministic output.
  now?: number;
};

export type ApplySiblingAwarenessResult = {
  // The description with the sibling block prepended (or unchanged if no
  // siblings were found).
  description: string;
  // The id of the sibling that should be wired as `parentTaskId`, or
  // undefined when no eligible sibling exists. Callers MUST pass this through
  // to `createTaskExtended` to get session resume.
  parentTaskId?: string;
  // The siblings the orchestrator considered. Useful for callers that want to
  // log / instrument; safe to ignore.
  siblings: SiblingTaskInfo[];
};

function toSiblingTaskInfo(task: AgentTask): SiblingTaskInfo {
  const agent = task.agentId ? getAgentById(task.agentId) : null;
  return {
    id: task.id,
    status: task.status,
    agentId: task.agentId,
    agentName: agent?.name ?? null,
    description: stripSiblingBlock(task.task),
    updatedAt: task.lastUpdatedAt,
  };
}

/**
 * Look up siblings for a given contextKey, render the prompt block, and
 * return the (potentially) modified description plus the parent task id to
 * wire. Safe to call when no siblings exist — returns the description
 * unchanged and `parentTaskId: undefined`.
 *
 * Callers should NOT pass `parentTaskId` to `createTaskExtended` separately —
 * the returned value already takes precedence. (If both are passed, callers
 * are responsible for deciding which one wins.)
 */
export function applySiblingAwareness(
  input: ApplySiblingAwarenessInput,
): ApplySiblingAwarenessResult {
  const { description, contextKey, currentAgentId } = input;
  if (!contextKey) {
    return { description, siblings: [] };
  }

  const tasks = getInProgressTasksByContextKey(contextKey);
  if (tasks.length === 0) {
    return { description, siblings: [] };
  }

  const siblings = tasks.map(toSiblingTaskInfo);
  const parent = pickResumeParent(siblings, currentAgentId ?? null);
  const newDescription = prependSiblingBlock(description, contextKey, siblings, input.now);

  return {
    description: newDescription,
    parentTaskId: parent?.id,
    siblings,
  };
}

/**
 * Convenience wrapper that applies sibling-awareness to a `(description,
 * options)` pair ready to be passed to `createTaskExtended`.
 *
 * Semantics:
 *   - `contextKey` is read from `options.contextKey` — callers must set it
 *     before calling this helper (Phase 1 already does that at every ingress).
 *   - If `options.parentTaskId` is already set, it is respected and NOT
 *     overridden by sibling-awareness. This means any ingress that has its
 *     own parent-picking logic (e.g. Slack lead handler) keeps working.
 *   - The returned `options` object is a shallow copy; callers may pass it
 *     directly to `createTaskExtended`.
 */
export function withSiblingAwareness(
  description: string,
  options: CreateTaskOptions,
): { description: string; options: CreateTaskOptions } {
  const contextKey = options.contextKey;
  if (!contextKey) {
    return { description, options };
  }
  const result = applySiblingAwareness({
    description,
    contextKey,
    currentAgentId: options.agentId ?? null,
  });
  return {
    description: result.description,
    options: {
      ...options,
      parentTaskId: options.parentTaskId ?? result.parentTaskId,
    },
  };
}

/**
 * Drop-in replacement for `createTaskExtended` that applies sibling-awareness
 * first. Use this from every ingress that has a `contextKey` so cross-ingress
 * sibling coordination is uniform without duplicating the wrapper boilerplate.
 */
export function createTaskWithSiblingAwareness(
  description: string,
  options: CreateTaskOptions,
): AgentTask {
  const { description: d, options: o } = withSiblingAwareness(description, options);
  return createTaskExtended(d, o);
}
