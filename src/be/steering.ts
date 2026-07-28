import {
  type AgentTask,
  type OnUnsupported,
  PROVIDER_STEER_CAPABILITIES,
  type ProviderName,
  type SteeringMessage,
  type SteeringSource,
  type SteerMode,
  type SteerResult,
} from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { isSteeringEnabled as readSteeringEnabled } from "../utils/steering-enabled";
import {
  createSteeringMessage,
  createTaskExtended,
  getAgentById,
  getDb,
  getPendingSteeringForTask,
  getSteeringMessageById,
  getTaskById,
  markSteeringPromoted,
  resumeTask,
} from "./db";

export class SteeringRequestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "SteeringRequestError";
  }
}

/** Server-side entry point for the global steering kill switch. */
export function isSteeringEnabled(): boolean {
  return readSteeringEnabled();
}

export interface RequestSteeringArgs {
  taskId: string;
  message: string;
  mode?: SteerMode;
  onUnsupported?: OnUnsupported;
  source?: SteeringSource;
  createdByKind?: SteeringMessage["createdByKind"];
  createdByUserId?: string;
  createdByAgentId?: string;
}

function providerForTask(task: AgentTask): ProviderName {
  const agent = task.agentId ? getAgentById(task.agentId) : null;
  return agent?.harnessProvider ?? agent?.provider ?? task.provider ?? "claude";
}

export function getTaskSteeringFields(task: AgentTask): {
  isLeadTask: boolean;
  supportedSteerModes: SteerMode[];
} {
  const agent = task.agentId ? getAgentById(task.agentId) : null;
  const provider = agent?.harnessProvider ?? agent?.provider ?? task.provider;
  return {
    isLeadTask: agent?.isLead ?? false,
    supportedSteerModes: provider ? PROVIDER_STEER_CAPABILITIES[provider] : [],
  };
}

/**
 * Convert an undeliverable steering message into a normal follow-up task.
 * Step 2 reuses this seam for pending rows discovered during terminal sweeps.
 */
export function promoteSteeringToTask(task: AgentTask, message: SteeringMessage): AgentTask {
  return createTaskExtended(message.body, {
    agentId: task.agentId,
    creatorAgentId: message.createdByAgentId,
    source: message.source === "script" ? "api" : message.source,
    taskType: "follow-up",
    parentTaskId: task.id,
    requestedByUserId: message.createdByUserId ?? task.requestedByUserId,
    bypassTrackerContextDedup: true,
  });
}

export interface MarkSteeringUndeliverableResult {
  message: SteeringMessage;
  promotedTaskId?: string;
}

/**
 * Promote every steering message that remains undelivered when its task has
 * reached a terminal state. Each message promotion is independently
 * transactional and idempotent, so terminal-status retries cannot create a
 * duplicate follow-up or recursively re-promote the same message.
 */
export function promotePendingSteeringForTask(
  taskId: string,
  reason: string,
): MarkSteeringUndeliverableResult[] {
  if (!reason.trim()) {
    throw new SteeringRequestError("Promotion reason must not be empty", 400);
  }

  const results: MarkSteeringUndeliverableResult[] = [];
  for (const message of getPendingSteeringForTask(taskId)) {
    try {
      results.push(markSteeringUndeliverable(message.id, reason));
    } catch (error) {
      // One malformed or concurrently-deleted row must not keep the remaining
      // pending steers from being promoted after the parent reaches terminal.
      console.error(
        `[steering] Failed to promote pending message ${message.id} for task ${taskId}:`,
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return results;
}

/**
 * Promote a worker-rejected steering message exactly once.
 *
 * Non-pending rows are returned unchanged so retries are safe. A successfully
 * promoted row always includes `promotedTaskId`.
 */
export function markSteeringUndeliverable(
  id: string,
  reason: string,
): MarkSteeringUndeliverableResult {
  if (!reason.trim()) {
    throw new SteeringRequestError("Undeliverable reason must not be empty", 400);
  }

  return getDb().transaction(() => {
    const message = getSteeringMessageById(id);
    if (!message) {
      throw new SteeringRequestError("Steering message not found", 404);
    }
    if (message.status !== "pending") {
      return {
        message,
        promotedTaskId: message.promotedTaskId,
      };
    }

    const task = getTaskById(message.taskId);
    if (!task) {
      throw new SteeringRequestError("Task not found", 404);
    }

    const promotedTask = promoteSteeringToTask(task, message);
    const promotedMessage = markSteeringPromoted(message.id, promotedTask.id);
    if (!promotedMessage) {
      throw new SteeringRequestError("Failed to promote steering message", 500);
    }
    return {
      message: promotedMessage,
      promotedTaskId: promotedTask.id,
    };
  })();
}

/** Single server-side write path for HTTP, MCP, script, and Slack steering. */
export function requestSteering(args: RequestSteeringArgs): SteerResult {
  if (!isSteeringEnabled()) {
    throw new SteeringRequestError(
      "Steering is disabled on this server (set STEERING_ENABLED=true to enable)",
      403,
    );
  }

  const task = getTaskById(args.taskId);
  if (!task) {
    throw new SteeringRequestError("Task not found", 404);
  }

  if (!args.message.trim()) {
    throw new SteeringRequestError("Steering message must not be empty", 400);
  }

  const requestedMode = args.mode ?? "queue";
  const onUnsupported = args.onUnsupported ?? "degrade";
  const provider = providerForTask(task);
  const supportedModes = PROVIDER_STEER_CAPABILITIES[provider];

  if (onUnsupported === "fail" && !supportedModes.includes(requestedMode)) {
    const supported = supportedModes.length > 0 ? supportedModes.join(", ") : "none";
    throw new SteeringRequestError(
      `Harness provider '${provider}' does not support steering mode '${requestedMode}' (supported modes: ${supported})`,
      422,
    );
  }

  const activeTask = task.status === "paused" ? resumeTask(task.id) : task;
  if (!activeTask) {
    throw new SteeringRequestError("Failed to resume paused task", 500);
  }

  const body = scrubSecrets(args.message);
  // A task whose session hasn't started yet can still accept queued steering:
  // the row stays `pending` and the worker delivers it once the session is
  // live (the dispatch poll covers every active task). Interrupting a session
  // that doesn't exist is meaningless, so a `steer` request on a pre-start
  // task degrades to queue (degrade, not fail — the harness does support the
  // mode; it just isn't applicable yet).
  const preStart =
    activeTask.status === "unassigned" ||
    activeTask.status === "offered" ||
    activeTask.status === "pending";
  // Degrade off the capability map, not off a hardcoded provider name — any
  // provider that can't honor the requested mode downgrades to queue, and the
  // caller is told via `degradedFrom`. (Providers with no live steering at all
  // fall through to the promotion branch below.)
  const degradedFrom =
    requestedMode === "steer" &&
    supportedModes.length > 0 &&
    (!supportedModes.includes("steer") || preStart)
      ? requestedMode
      : undefined;
  const effectiveMode: SteerMode = degradedFrom ? "queue" : requestedMode;

  const steeringMessage = createSteeringMessage({
    taskId: activeTask.id,
    body,
    mode: requestedMode,
    source: args.source ?? "api",
    createdByKind: args.createdByKind ?? "system",
    createdByUserId: args.createdByUserId,
    createdByAgentId: args.createdByAgentId,
  });

  const canReachLiveSession =
    supportedModes.length > 0 && (activeTask.status === "in_progress" || preStart);
  if (!canReachLiveSession) {
    const promotedTask = promoteSteeringToTask(activeTask, steeringMessage);
    markSteeringPromoted(steeringMessage.id, promotedTask.id);
    return {
      outcome: "promoted",
      steeringMessageId: steeringMessage.id,
      promotedTaskId: promotedTask.id,
      effectiveMode,
      degradedFrom,
    };
  }

  return {
    outcome: effectiveMode === "steer" ? "steered" : "queued",
    steeringMessageId: steeringMessage.id,
    effectiveMode,
    degradedFrom,
  };
}
