import pkg from "../../../../package.json";
import { defaultAssetKey } from "../../../assets/key";
import type { telemetry } from "../../../telemetry";
import type {
  Agent,
  AgentLog,
  AgentLogEventType,
  AgentTask,
  AgentTaskSource,
  ProviderName,
  TaskAttachment,
} from "../../../types";
import { isTerminalTaskStatus } from "../../../types";
import { scrubSecrets } from "../../../utils/secret-scrubber";
import { emitTaskStarted } from "../../task-lifecycle-events";
import { getAgentById, isAgentEligibleForTask } from "../agents";
import { getDbClient } from "../runtime";
import { type AgentTaskRow, getTaskById, rowToAgentTask } from "./read";

type TaskWriteDependencies = {
  createLogEntry: (entry: {
    eventType: AgentLogEventType;
    agentId?: string;
    taskId?: string;
    oldValue?: string;
    newValue?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<AgentLog>;
  checkDependencies: (taskId: string) => Promise<{ ready: boolean; blockedBy: string[] }>;
  reconcileTaskPullRequestAttachments: (
    taskId: string,
    agentId: string | null,
    sourceTexts: Array<string | null | undefined>,
  ) => Promise<TaskAttachment[]>;
  emitTaskLifecycleTelemetryAfterCommit: (
    event: string,
    props: Parameters<typeof telemetry.taskEvent>[1],
    verify?: (task: AgentTask | null) => boolean,
  ) => void;
  taskContextForTelemetry: (task: AgentTask) => {
    provider?: ProviderName;
    harnessVariant?: string;
    harnessVersion?: string;
  };
  promotePendingSteeringForTask: (taskId: string, reason: string) => Promise<unknown>;
  cascadeFailDependents: (
    parentId: string,
    parentStatus: string,
  ) => Promise<Array<{ taskId: string; taskSubject: string }>>;
};

let dependencies: TaskWriteDependencies;

// Registration only stores deferred callbacks; the facade still owns these callees.
export function configureTaskWriteDependencies(value: TaskWriteDependencies): void {
  dependencies = value;
}

export async function createTask(
  agentId: string,
  task: string,
  options?: {
    source?: AgentTaskSource;
    slackChannelId?: string;
    slackThreadTs?: string;
    slackUserId?: string;
  },
): Promise<AgentTask> {
  const id = crypto.randomUUID();
  const source = options?.source ?? "mcp";
  const row = await getDbClient().get<AgentTaskRow>(
    `INSERT INTO agent_tasks (id, "key", agentId, task, status, source, slackChannelId, slackThreadTs, slackUserId, swarmVersion, createdAt, lastUpdatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING *`,
    [
      id,
      defaultAssetKey("task", id),
      agentId,
      task,
      "pending",
      source,
      options?.slackChannelId ?? null,
      options?.slackThreadTs ?? null,
      options?.slackUserId ?? null,
      pkg.version,
    ],
  );
  if (!row) throw new Error("Failed to create task");
  try {
    await dependencies.createLogEntry({
      eventType: "task_created",
      agentId,
      taskId: id,
      newValue: "pending",
      metadata: { source },
    });
  } catch {}
  return rowToAgentTask(row);
}

/**
 * In-process dedup for `task_dispatch_rejected_affinity` logging in
 * `getPendingTaskForAgent` below — that function runs on every poll tick for
 * every agent with a directly-assigned pending task, so an unresolved skip
 * (e.g. a corrupt/misassigned legacy row) would otherwise write one log row
 * per poll forever. Keyed by taskId; per-process, like `alarmActive` in
 * `queue-stall-alarm.ts` — an API restart re-arms it, which is fine since the
 * point is "don't spam," not "log exactly once ever."
 */
const AFFINITY_DISPATCH_SKIP_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const lastAffinityDispatchSkipLoggedAt = new Map<string, number>();

async function logAffinityDispatchSkip(
  agent: Pick<Agent, "id" | "isLead" | "role">,
  task: Pick<AgentTask, "id" | "routingAffinity" | "routingAffinityInvalid">,
): Promise<void> {
  const now = Date.now();
  const lastLoggedAt = lastAffinityDispatchSkipLoggedAt.get(task.id);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < AFFINITY_DISPATCH_SKIP_LOG_COOLDOWN_MS) {
    return;
  }
  lastAffinityDispatchSkipLoggedAt.set(task.id, now);
  try {
    await dependencies.createLogEntry({
      eventType: "task_dispatch_rejected_affinity",
      agentId: agent.id,
      taskId: task.id,
      metadata: {
        agentRole: agent.role ?? null,
        requiredRole: task.routingAffinity?.role ?? null,
        leadOnly: task.routingAffinity?.leadOnly === true,
        agentIsLead: agent.isLead ?? false,
        routingAffinityInvalid: task.routingAffinityInvalid === true,
      },
    });
  } catch {}
}

export async function getPendingTaskForAgent(agentId: string): Promise<AgentTask | null> {
  // Get all pending tasks for this agent, ordered by priority (desc) then creation time (asc)
  const rows = await getDbClient().query<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE agentId = ? AND status = 'pending' ORDER BY priority DESC, createdAt ASC",
    [agentId],
  );

  const agent = await getAgentById(agentId);
  if (!agent) return null;

  for (const row of rows) {
    const task = rowToAgentTask(row);
    // `task.agentId` (the WHERE clause above) is a direct-assignment decision
    // already made by the task's creator — `createTaskExtended` enforces a
    // caller-declared requirement at creation time (see
    // `routingAffinityIsInheritedProvenance` there). Re-running the FULL
    // role/capability match here re-litigates that decision using metadata
    // that may be pure inherited PROVENANCE (e.g. a Lead-routed
    // worker-completion follow-up that inherits the finishing worker's
    // role/capabilities as lineage, not a requirement anyone declared) —
    // which permanently stalls dispatch to the agent the task is already
    // pinned to (the #1276-regression this fixes; see PR body). Mirror the
    // convention `acceptTask`/`claimOfferedTask` already use for an
    // established offer: only `leadOnly` (a real authorization boundary) and
    // `routingAffinityInvalid` (quarantined corrupt data) still veto a
    // directly-assigned task. Pool-claim paths (`claimTask`,
    // `assignUnassignedTaskPending`) are untouched and keep the full gate —
    // they are deciding "who gets this" from the pool, not redispatching an
    // assignment that was already authorized (or, for provenance, never a
    // requirement) at creation time.
    if (task.routingAffinityInvalid) {
      await logAffinityDispatchSkip(agent, task);
      continue;
    }
    if (task.routingAffinity?.leadOnly && !isAgentEligibleForTask(agent, task)) {
      await logAffinityDispatchSkip(agent, task);
      continue;
    }
    const { ready } = await dependencies.checkDependencies(task.id);
    if (ready) return task;
  }

  return null;
}

export async function assignUnassignedTaskPending(
  taskId: string,
  agentId: string,
): Promise<AgentTask | null> {
  // This guard is always needed for lead-only tasks; the predicate itself
  // handles the optional role/capability kill-switch.
  {
    const task = await getTaskById(taskId);
    const agent = await getAgentById(agentId);
    if (task && (!agent || !isAgentEligibleForTask(agent, task))) {
      try {
        await dependencies.createLogEntry({
          eventType: "task_claim_rejected_affinity",
          agentId,
          taskId,
          metadata: {
            agentRole: agent?.role ?? null,
            requiredRole: task.routingAffinity?.role ?? null,
            leadOnly: task.routingAffinity?.leadOnly === true,
            agentIsLead: agent?.isLead ?? false,
          },
        });
      } catch {}
      return null;
    }
  }

  const now = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET agentId = ?, status = 'pending', lastUpdatedAt = ?
       WHERE id = ? AND status = 'unassigned' RETURNING *`,
    [agentId, now, taskId],
  );

  if (row) {
    try {
      await dependencies.createLogEntry({
        eventType: "task_status_change",
        agentId,
        taskId,
        oldValue: "unassigned",
        newValue: "pending",
        metadata: { pendingDispatch: true },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

export async function startTask(taskId: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(taskId);
  if (!oldTask) return null;

  // Guard: never revive tasks that are already in a terminal state
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = 'in_progress', lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded') RETURNING *`,
    [taskId],
  );
  if (row && oldTask) {
    try {
      await dependencies.createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "in_progress",
      });
    } catch {}
  }
  const result = row ? rowToAgentTask(row) : null;
  // Fire-and-forget: notify lifecycle subscribers (e.g. GitHub eyes reaction)
  if (result && oldTask.status !== "in_progress") {
    emitTaskStarted(result);
  }
  return result;
}

export async function updateTaskClaudeSessionId(
  taskId: string,
  claudeSessionId: string,
  provider?: ProviderName,
  providerMeta?: Record<string, unknown>,
  model?: string,
  harnessVariant?: string,
  harnessVariantMeta?: Record<string, unknown>,
): Promise<AgentTask | null> {
  const setClauses = ["claudeSessionId = ?", "lastUpdatedAt = ?"];
  const params: (string | null)[] = [claudeSessionId, new Date().toISOString()];

  if (provider !== undefined) {
    setClauses.push("provider = ?");
    params.push(provider);
  }
  if (providerMeta !== undefined) {
    setClauses.push("providerMeta = ?");
    params.push(JSON.stringify(providerMeta));
  }
  if (model !== undefined) {
    setClauses.push("model = ?");
    params.push(model);
  }
  if (harnessVariant !== undefined) {
    setClauses.push("harnessVariant = ?");
    params.push(harnessVariant);
  }
  if (harnessVariantMeta !== undefined) {
    setClauses.push("harnessVariantMeta = ?");
    params.push(JSON.stringify(harnessVariantMeta));
  }

  params.push(taskId);

  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET ${setClauses.join(", ")} WHERE id = ? RETURNING *`,
    params,
  );
  return row ? rowToAgentTask(row) : null;
}

/**
 * Sets or clears a task's display title (session rename). Trims the input and
 * normalizes an empty string to NULL (clear). Deliberately does NOT touch
 * `lastUpdatedAt` — a rename is not activity, and the sessions sidebar sorts
 * on chain-wide max `lastUpdatedAt`, so bumping it here would reorder the list.
 */
export async function updateTaskTitle(
  taskId: string,
  title: string | null,
): Promise<AgentTask | null> {
  const normalized = title === null ? null : title.trim() || null;
  const row = await getDbClient().get<AgentTaskRow>(
    "UPDATE agent_tasks SET title = ? WHERE id = ? RETURNING *",
    [normalized, taskId],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function completeTask(
  id: string,
  output?: string,
  options?: { addTags?: string[] },
): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-complete a task already in a terminal state.
  // Mirrors cancelTask. Prevents duplicate task.completed events, duplicate
  // log entries, and duplicate follow-up tasks when multiple sessions race.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const row = await getDbClient().transaction(async () => {
    const finishedAt = new Date().toISOString();
    // The status predicate re-checks the idempotency guard atomically: the
    // await between the guard read above and this write lets a racing
    // terminal transition (e.g. heartbeat failTask) land first.
    let completed = await getDbClient().get<AgentTaskRow>(
      `UPDATE agent_tasks SET status = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded') RETURNING *`,
      ["completed", finishedAt, id],
    );
    if (!completed) return null;

    if (output) {
      completed = await getDbClient().get<AgentTaskRow>(
        "UPDATE agent_tasks SET output = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
        [scrubSecrets(output), id],
      );
    }
    if (completed && options?.addTags?.length) {
      const existingTags: string[] = completed.tags ? JSON.parse(completed.tags) : [];
      const nextTags = Array.from(new Set([...existingTags, ...options.addTags]));
      completed = await getDbClient().get<AgentTaskRow>(
        "UPDATE agent_tasks SET tags = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? RETURNING *",
        [JSON.stringify(nextTags), id],
      );
    }
    if (completed) {
      await dependencies.reconcileTaskPullRequestAttachments(id, completed.agentId, [
        completed.output,
        completed.vcsProvider === "github" ? completed.vcsUrl : null,
      ]);
    }
    return completed;
  });
  if (!row) return null;

  if (row && oldTask) {
    dependencies.emitTaskLifecycleTelemetryAfterCommit(
      "completed",
      {
        taskId: id,
        source: oldTask.source,
        ...dependencies.taskContextForTelemetry(oldTask),
        agentId: row.agentId ?? undefined,
        durationMs: row.createdAt ? Date.now() - new Date(row.createdAt).getTime() : undefined,
      },
      (task) => task?.status === "completed",
    );

    try {
      await dependencies.createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "completed",
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../../../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.completed", {
            taskId: id,
            output,
            agentId: row.agentId,
            workflowRunId: row.workflowRunId,
            workflowRunStepId: row.workflowRunStepId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.completed event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });
    try {
      await dependencies.promotePendingSteeringForTask(
        id,
        "Task completed before steering was delivered",
      );
    } catch (error) {
      console.error(
        "[completeTask] pending steering promotion error:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return row ? rowToAgentTask(row) : null;
}

export async function failTask(id: string, reason: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-fail a task already in a terminal state.
  // Mirrors cancelTask / completeTask. Prevents duplicate task.failed events
  // and duplicate follow-up tasks when multiple sessions race.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const scrubbedReason = scrubSecrets(reason);
  // Status predicate re-checks the idempotency guard atomically (a racing
  // terminal transition can land during the await above).
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = 'failed', failureReason = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded') RETURNING *`,
    [scrubbedReason, finishedAt, id],
  );
  if (row && oldTask) {
    dependencies.emitTaskLifecycleTelemetryAfterCommit(
      "failed",
      {
        taskId: id,
        source: oldTask.source,
        ...dependencies.taskContextForTelemetry(oldTask),
        agentId: row.agentId ?? undefined,
        durationMs: row.createdAt ? Date.now() - new Date(row.createdAt).getTime() : undefined,
      },
      (task) => task?.status === "failed",
    );

    try {
      await dependencies.createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "failed",
        metadata: { reason: scrubbedReason },
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../../../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.failed", {
            taskId: id,
            failureReason: reason,
            agentId: row.agentId,
            workflowRunId: row.workflowRunId,
            workflowRunStepId: row.workflowRunStepId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.failed event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });
    try {
      await dependencies.promotePendingSteeringForTask(
        id,
        "Task failed before steering was delivered",
      );
    } catch (error) {
      console.error(
        "[failTask] pending steering promotion error:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }

    // Cascade-fail any non-terminal tasks that depend on this one.
    // The cascade is recursive (transitive closure) and cycle-safe.
    try {
      await dependencies.cascadeFailDependents(id, "failed");
    } catch (err) {
      console.error("[failTask] cascade-fail dependents error:", err);
    }
  }
  return row ? rowToAgentTask(row) : null;
}

/**
 * Replace result text on an already-terminal task without replaying terminal
 * side effects or moving any lifecycle timestamps. Callers must opt in to
 * this narrow escape hatch; ordinary completion remains first-call-wins.
 */
export async function overwriteTerminalTaskResultText(
  id: string,
  patch: { output?: string; failureReason?: string },
): Promise<AgentTask | null> {
  const task = await getTaskById(id);
  if (!task || !isTerminalTaskStatus(task.status)) return null;

  const output = patch.output !== undefined ? scrubSecrets(patch.output) : (task.output ?? null);
  const failureReason =
    patch.failureReason !== undefined
      ? scrubSecrets(patch.failureReason)
      : (task.failureReason ?? null);
  const row = await getDbClient().transaction(async () => {
    const updated =
      (await getDbClient().get<AgentTaskRow>(
        `UPDATE agent_tasks SET output = ?, failureReason = ?
         WHERE id = ? AND status IN ('completed', 'failed', 'cancelled', 'superseded')
         RETURNING *`,
        [output, failureReason, id],
      )) ?? null;
    if (updated && patch.output !== undefined) {
      await dependencies.reconcileTaskPullRequestAttachments(id, updated.agentId, [
        updated.output,
        updated.vcsProvider === "github" ? updated.vcsUrl : null,
      ]);
    }
    return updated;
  });

  return row ? rowToAgentTask(row) : task;
}

export async function cancelTask(id: string, reason?: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Only cancel tasks that are not already in a terminal state
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const cancelReason = reason ?? "Cancelled by user";
  // Status predicate re-checks the idempotency guard atomically (a racing
  // terminal transition can land during the await above).
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET status = 'cancelled', failureReason = ?, finishedAt = ?, lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded') RETURNING *`,
    [cancelReason, finishedAt, id],
  );

  if (row && oldTask) {
    dependencies.emitTaskLifecycleTelemetryAfterCommit(
      "cancelled",
      {
        taskId: id,
        source: oldTask.source,
        agentId: oldTask.agentId ?? undefined,
        previousStatus: oldTask.status,
        durationMs: oldTask.createdAt
          ? Date.now() - new Date(oldTask.createdAt).getTime()
          : undefined,
      },
      (task) => task?.status === "cancelled",
    );

    try {
      await dependencies.createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "cancelled",
        metadata: reason ? { reason } : undefined,
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../../../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.cancelled", {
            taskId: id,
            agentId: row.agentId,
            workflowRunId: row.workflowRunId,
            workflowRunStepId: row.workflowRunStepId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.cancelled event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });
    try {
      await dependencies.promotePendingSteeringForTask(
        id,
        "Task was cancelled before steering was delivered",
      );
    } catch (error) {
      console.error(
        "[cancelTask] pending steering promotion error:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }

    try {
      await dependencies.cascadeFailDependents(id, "cancelled");
    } catch (err) {
      console.error("[cancelTask] cascade-fail dependents error:", err);
    }
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Supersede a task: mark it as `superseded` (terminal) so a fresh "resume"
 * follow-up task can pick up where it left off. Used by the graceful-shutdown
 * path and the `POST /api/tasks/:id/supersede` route. Returns null if the task
 * is already terminal (mirrors `completeTask` / `cancelTask` idempotency).
 *
 * Writes a `task_superseded` agent_log with `{ reason, resumeTaskId }` payload
 * and emits a `task.superseded` workflow event. The caller is responsible for
 * creating the resume follow-up (via `createResumeFollowUp`) and passing the
 * resulting id as `resumeTaskId`.
 */
export async function supersedeTask(
  id: string,
  args: { reason: string; resumeTaskId: string | null },
): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-supersede a task already in a terminal state.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks
       SET status = 'superseded',
           finishedAt = ?,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       RETURNING *`,
    [finishedAt, id],
  );

  if (row && oldTask) {
    dependencies.emitTaskLifecycleTelemetryAfterCommit(
      "superseded",
      {
        taskId: id,
        source: oldTask.source,
        ...dependencies.taskContextForTelemetry(oldTask),
        agentId: row.agentId ?? undefined,
        reason: args.reason,
        durationMs: oldTask.createdAt
          ? Date.now() - new Date(oldTask.createdAt).getTime()
          : undefined,
      },
      (task) => task?.status === "superseded",
    );

    try {
      await dependencies.createLogEntry({
        eventType: "task_superseded",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "superseded",
        metadata: { reason: args.reason, resumeTaskId: args.resumeTaskId },
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../../../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.superseded", {
            taskId: id,
            reason: args.reason,
            resumeTaskId: args.resumeTaskId,
            agentId: row.agentId,
            workflowRunId: row.workflowRunId,
            workflowRunStepId: row.workflowRunStepId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.superseded event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });

    try {
      await dependencies.cascadeFailDependents(id, "superseded");
    } catch (err) {
      console.error("[supersedeTask] cascade-fail dependents error:", err);
    }
  }

  return row ? rowToAgentTask(row) : null;
}

export async function backfillSupersedeTaskResumeTaskId(
  taskId: string,
  resumeTaskId: string,
): Promise<boolean> {
  const row = await getDbClient().get<{ id: string; metadata: string | null }>(
    `SELECT id, metadata
       FROM agent_log
       WHERE taskId = ? AND eventType = 'task_superseded'
       ORDER BY createdAt DESC
       LIMIT 1`,
    [taskId],
  );
  if (!row) return false;

  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  metadata.resumeTaskId = resumeTaskId;

  const result = await getDbClient().run("UPDATE agent_log SET metadata = ? WHERE id = ?", [
    JSON.stringify(metadata),
    row.id,
  ]);
  return result.changes > 0;
}

/**
 * Pause a task that is currently in progress.
 * Used during graceful shutdown to allow tasks to resume after container restart.
 * Unlike failTask, paused tasks retain their agent assignment and can be resumed.
 */
export async function pauseTask(id: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Only pause tasks that are in progress
  if (oldTask.status !== "in_progress") {
    return null;
  }

  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks
       SET status = 'paused',
           was_paused = 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'in_progress'
       RETURNING *`,
    [id],
  );

  if (row && oldTask) {
    try {
      await dependencies.createLogEntry({
        eventType: "task_status_change",
        taskId: id,
        agentId: row.agentId ?? undefined,
        oldValue: oldTask.status,
        newValue: "paused",
        metadata: { pausedForShutdown: true },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Resume a paused task - transitions it back to in_progress.
 * Called when worker restarts and picks up paused work.
 */
export async function resumeTask(taskId: string): Promise<AgentTask | null> {
  const oldTask = await getTaskById(taskId);
  if (!oldTask || oldTask.status !== "paused") return null;

  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks
       SET status = 'in_progress',
           was_paused = 1,
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'paused'
       RETURNING *`,
    [taskId],
  );

  if (row && oldTask) {
    try {
      await dependencies.createLogEntry({
        eventType: "task_status_change",
        taskId,
        agentId: row.agentId ?? undefined,
        oldValue: "paused",
        newValue: "in_progress",
        metadata: { resumed: true },
      });
    } catch {}
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Get paused tasks for a specific agent.
 * Used on startup to resume tasks that were interrupted by deployment.
 * Returns tasks ordered by creation time (oldest first for FIFO).
 */
export async function getPausedTasksForAgent(agentId: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE agentId = ? AND status = 'paused'
       ORDER BY createdAt ASC, rowid ASC`,
    [agentId],
  );
  return rows.map(rowToAgentTask);
}

export async function getOrphanedInProgressTasksForAgent(
  agentId: string,
  minAgeSeconds = 60,
): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT t.* FROM agent_tasks t
       LEFT JOIN active_sessions s ON s.taskId = t.id
       WHERE t.agentId = ?
         AND t.status = 'in_progress'
         AND t.claudeSessionId IS NULL
         AND t.lastUpdatedAt < ?
         AND s.id IS NULL
         AND t.finishedAt IS NULL
       ORDER BY t.createdAt ASC, t.rowid ASC`,
    [agentId, cutoff],
  );
  return rows.map(rowToAgentTask);
}

export async function resetOrphanedInProgressTasksForAgent(
  agentId: string,
  minAgeSeconds = 60,
): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const rows = await getDbClient().query<AgentTaskRow>(
    `UPDATE agent_tasks
       SET status = 'pending',
           lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id IN (
         SELECT t.id FROM agent_tasks t
         LEFT JOIN active_sessions s ON s.taskId = t.id
         WHERE t.agentId = ?
           AND t.status = 'in_progress'
           AND t.claudeSessionId IS NULL
           AND t.lastUpdatedAt < ?
           AND s.id IS NULL
           AND t.finishedAt IS NULL
       )
       RETURNING *`,
    [agentId, cutoff],
  );

  for (const row of rows) {
    try {
      await dependencies.createLogEntry({
        eventType: "task_status_change",
        taskId: row.id,
        agentId,
        oldValue: "in_progress",
        newValue: "pending",
        metadata: { orphanedInProgressRecovery: true },
      });
    } catch {}
  }

  return rows.map(rowToAgentTask);
}

/**
 * Get recently cancelled tasks for an agent.
 * Used by hooks to detect task cancellation and stop the worker loop.
 * Returns tasks cancelled within the last 5 minutes.
 */
export async function getRecentlyCancelledTasksForAgent(agentId: string): Promise<AgentTask[]> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE agentId = ?
       AND status = 'cancelled'
       AND finishedAt > ?
       ORDER BY finishedAt DESC`,
    [agentId, fiveMinutesAgo],
  );
  return rows.map(rowToAgentTask);
}

export async function deleteTask(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM agent_tasks WHERE id = ?", [id]);
  return result.changes > 0;
}

export async function updateTaskProgress(id: string, progress: string): Promise<AgentTask | null> {
  const scrubbedProgress = scrubSecrets(progress);
  const row = await getDbClient().get<AgentTaskRow>(
    `UPDATE agent_tasks SET progress = ?,
       status = CASE WHEN status IN ('completed', 'failed', 'cancelled', 'superseded') THEN status ELSE 'in_progress' END,
       lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? RETURNING *`,
    [scrubbedProgress, id],
  );
  if (row) {
    try {
      await dependencies.createLogEntry({
        eventType: "task_progress",
        taskId: id,
        agentId: row.agentId ?? undefined,
        newValue: scrubbedProgress,
      });
    } catch {}
    getDbClient().afterCommit(() => {
      import("../../../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.progress", {
            taskId: id,
            progress: scrubbedProgress,
            agentId: row.agentId,
          });
        })
        .catch((err) =>
          console.error(
            "[db] task.progress event not emitted:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
    });
  }
  return row ? rowToAgentTask(row) : null;
}
