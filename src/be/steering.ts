import {
  type Agent,
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
  createLogEntry,
  createSteeringMessage,
  createTaskExtended,
  getAgentById,
  getDbClient,
  getPendingSteeringForTask,
  getSteeringMessageById,
  getTaskById,
  markSteeringPromoted,
  resumeTask,
} from "./db";

/** 409 body for a worker callback about a row that moved to a successor task. */
export const STEERING_MOVED_ERROR = "Steering message moved to another task";

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

async function providerForTask(task: AgentTask): Promise<ProviderName> {
  const agent = task.agentId ? await getAgentById(task.agentId) : null;
  return agent?.harnessProvider ?? agent?.provider ?? task.provider ?? "claude";
}

export interface TaskSteeringFields {
  isLeadTask: boolean;
  supportedSteerModes: SteerMode[];
}

type SteeringAgent = Pick<Agent, "isLead" | "provider" | "harnessProvider">;

function steeringFieldsFor(task: AgentTask, agent: SteeringAgent | null): TaskSteeringFields {
  const provider = agent?.harnessProvider ?? agent?.provider ?? task.provider;
  return {
    isLeadTask: agent?.isLead ?? false,
    supportedSteerModes: provider ? PROVIDER_STEER_CAPABILITIES[provider] : [],
  };
}

export async function getTaskSteeringFields(task: AgentTask): Promise<TaskSteeringFields> {
  const agent = task.agentId ? await getAgentById(task.agentId) : null;
  return steeringFieldsFor(task, agent);
}

/** Bound-parameter chunk for `IN (...)`, well under SQLite's variable limit. */
const AGENT_ID_CHUNK = 500;

/**
 * Batched {@link getTaskSteeringFields}: one query per 500 distinct assignees
 * instead of one full agent row per task. Selects only the three columns the
 * steering fields read. Keyed by task id.
 */
export async function getTaskSteeringFieldsForTasks(
  tasks: AgentTask[],
): Promise<Map<string, TaskSteeringFields>> {
  const agentIds = [...new Set(tasks.flatMap((task) => (task.agentId ? [task.agentId] : [])))];
  const agents = new Map<string, SteeringAgent>();
  for (let i = 0; i < agentIds.length; i += AGENT_ID_CHUNK) {
    const ids = agentIds.slice(i, i + AGENT_ID_CHUNK);
    const rows = await getDbClient().query<{
      id: string;
      isLead: number;
      provider: string | null;
      harness_provider: string | null;
    }>(
      `SELECT id, isLead, provider, harness_provider FROM agents WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    for (const row of rows) {
      // Same mapping as rowToAgent for these three fields.
      agents.set(row.id, {
        isLead: row.isLead === 1,
        provider: (row.provider as ProviderName | null) ?? undefined,
        harnessProvider: (row.harness_provider as ProviderName | null) ?? null,
      });
    }
  }
  return new Map(
    tasks.map((task) => [
      task.id,
      steeringFieldsFor(task, task.agentId ? (agents.get(task.agentId) ?? null) : null),
    ]),
  );
}

/**
 * Convert an undeliverable steering message into a normal follow-up task.
 * Step 2 reuses this seam for pending rows discovered during terminal sweeps.
 */
export async function promoteSteeringToTask(
  task: AgentTask,
  message: SteeringMessage,
): Promise<AgentTask> {
  return await createTaskExtended(message.body, {
    agentId: task.agentId,
    routingReason: task.agentId ? "continuity" : undefined,
    routingSource: task.agentId ? "engine_default" : undefined,
    creatorAgentId: message.createdByAgentId,
    source: message.source === "script" ? "api" : message.source,
    taskType: "follow-up",
    parentTaskId: task.id,
    requestedByUserId: message.createdByUserId,
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
export async function promotePendingSteeringForTask(
  taskId: string,
  reason: string,
): Promise<MarkSteeringUndeliverableResult[]> {
  if (!reason.trim()) {
    throw new SteeringRequestError("Promotion reason must not be empty", 400);
  }

  const results: MarkSteeringUndeliverableResult[] = [];
  for (const message of await getPendingSteeringForTask(taskId)) {
    try {
      results.push(await markSteeringUndeliverable(message.id, reason));
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
export async function markSteeringUndeliverable(
  id: string,
  reason: string,
  expectedTaskId?: string,
): Promise<MarkSteeringUndeliverableResult> {
  if (!reason.trim()) {
    throw new SteeringRequestError("Undeliverable reason must not be empty", 400);
  }

  return await getDbClient().transaction(async () => {
    const message = await getSteeringMessageById(id);
    if (!message) {
      throw new SteeringRequestError("Steering message not found", 404);
    }
    // A predecessor session's late rejection must not promote a row its
    // successor now owns.
    if (expectedTaskId && message.taskId !== expectedTaskId) {
      throw new SteeringRequestError(STEERING_MOVED_ERROR, 409);
    }
    if (message.status !== "pending") {
      return {
        message,
        promotedTaskId: message.promotedTaskId,
      };
    }

    const task = await getTaskById(message.taskId);
    if (!task) {
      throw new SteeringRequestError("Task not found", 404);
    }

    const promotedTask = await promoteSteeringToTask(task, message);
    const promotedMessage = await markSteeringPromoted(message.id, promotedTask.id);
    if (!promotedMessage) {
      throw new SteeringRequestError("Failed to promote steering message", 500);
    }
    return {
      message: promotedMessage,
      promotedTaskId: promotedTask.id,
    };
  });
}

/**
 * Hand a predecessor's unacknowledged steering to the task that continues its
 * work (defer-task wake-up, reboot-sweep retry, resume follow-up).
 *
 * Each row moves to the successor, so its assignee is the one `accept-steer`
 * authorizes. A `delivered` row goes back to `pending` so the successor's
 * session receives it. The predecessor's session may still be running at this
 * point; worker delivery is scoped to the session's own task (poll filter and
 * the `taskId` fence on the delivered/undeliverable callbacks), so that
 * session can no longer take or settle a moved row. Nothing is copied into
 * task text: one row, one delivery path. Handled, promoted and cancelled rows
 * stay on the predecessor.
 *
 * Never throws: losing the hand-off must not block creating the successor.
 */
export async function carryUnhandledSteering(
  predecessorTaskId: string,
  successorTaskId: string,
): Promise<string[]> {
  try {
    const rows = await getDbClient().query<{ id: string }>(
      `UPDATE task_steering_messages
         SET task_id = ?, status = 'pending', delivered_mode = NULL, delivered_at = NULL
         WHERE task_id = ? AND status IN ('pending', 'delivered')
         RETURNING id`,
      [successorTaskId, predecessorTaskId],
    );
    for (const { id } of rows) {
      try {
        await createLogEntry({
          eventType: "task_steering",
          taskId: successorTaskId,
          newValue: "pending",
          metadata: { steeringMessageId: id, carriedFromTaskId: predecessorTaskId },
        });
      } catch {}
    }
    return rows.map((row) => row.id);
  } catch (error) {
    console.error(
      `[steering] Failed to carry steering from ${predecessorTaskId} to ${successorTaskId}:`,
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
    return [];
  }
}

/** Single server-side write path for HTTP, MCP, script, and Slack steering. */
export async function requestSteering(args: RequestSteeringArgs): Promise<SteerResult> {
  if (!isSteeringEnabled()) {
    throw new SteeringRequestError(
      "Steering is disabled on this server (set STEERING_ENABLED=true to enable)",
      403,
    );
  }

  const task = await getTaskById(args.taskId);
  if (!task) {
    throw new SteeringRequestError("Task not found", 404);
  }

  if (!args.message.trim()) {
    throw new SteeringRequestError("Steering message must not be empty", 400);
  }

  const requestedMode = args.mode ?? "queue";
  const onUnsupported = args.onUnsupported ?? "degrade";
  const provider = await providerForTask(task);
  const supportedModes = PROVIDER_STEER_CAPABILITIES[provider];

  if (onUnsupported === "fail" && !supportedModes.includes(requestedMode)) {
    const supported = supportedModes.length > 0 ? supportedModes.join(", ") : "none";
    throw new SteeringRequestError(
      `Harness provider '${provider}' does not support steering mode '${requestedMode}' (supported modes: ${supported})`,
      422,
    );
  }

  const activeTask = task.status === "paused" ? await resumeTask(task.id) : task;
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

  const steeringMessage = await createSteeringMessage({
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
    const promotedTask = await promoteSteeringToTask(activeTask, steeringMessage);
    await markSteeringPromoted(steeringMessage.id, promotedTask.id);
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
