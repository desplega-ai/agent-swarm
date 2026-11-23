import pkg from "../../../../package.json";
import { defaultAssetKey } from "../../../assets/key";
import { sessionSourceKey } from "../../../assets/source-key";
import type { TaskTelemetryEvent, TaskTelemetryInput } from "../../../telemetry-trigger";
import type {
  Agent,
  AgentLog,
  AgentLogEventType,
  AgentTask,
  AgentTaskSource,
  ProviderName,
  ReasoningEffort,
  RuntimePool,
  TaskAttachment,
  TaskStatusKindFor,
} from "../../../types";
import {
  isTaskStatusKindFor,
  isTerminalTaskStatus,
  SUPERSEDED_WORKFLOW_TASK_REASON,
} from "../../../types";
import { scrubSecrets } from "../../../utils/secret-scrubber";
import { getStorage } from "../../storage";
import { emitTaskStarted } from "../../task-lifecycle-events";
import { publishWorkerNudge } from "../../worker-nudges";
import { getAgentById, isAgentEligibleForTask } from "../agents";
import { dropSessionDescendants } from "../session-summaries";
import {
  classifyTaskHumanFree,
  reclassifyTaskHumanFree,
  tagWriteChangesHumanFree,
} from "./human-free";
import { getTaskById, NEVER_STARTED_TASK_STATUSES, rowToAgentTask } from "./read";

function tasksRepo() {
  return getStorage().repos.tasks;
}

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
  emitTaskLifecycleTelemetryAfterCommit: <S extends TaskTelemetryEvent>(
    event: S,
    props: TaskTelemetryInput<S>,
    verify?: (task: AgentTask | null) => boolean,
    actorUserId?: string | null,
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
  const isHumanFree = await classifyTaskHumanFree({ source });
  const row = await tasksRepo().insertSimpleTask({
    id,
    key:
      sessionSourceKey({
        id,
        slackChannelId: options?.slackChannelId,
        slackThreadTs: options?.slackThreadTs,
      }) ?? defaultAssetKey("task", id),
    agentId,
    task: scrubSecrets(task),
    status: "pending",
    source,
    slackChannelId: options?.slackChannelId ?? null,
    slackThreadTs: options?.slackThreadTs ?? null,
    slackUserId: options?.slackUserId ?? null,
    swarmVersion: pkg.version,
    isHumanFree,
  });
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

/** Passed by the read-only poll probe: flags a due skip log instead of writing it. */
type PendingTaskProbe = { skipLogDue: boolean };

async function logAffinityDispatchSkip(
  agent: Pick<Agent, "id" | "isLead" | "role">,
  task: Pick<AgentTask, "id" | "routingAffinity" | "routingAffinityInvalid">,
  probe?: PendingTaskProbe,
): Promise<void> {
  const now = Date.now();
  const lastLoggedAt = lastAffinityDispatchSkipLoggedAt.get(task.id);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < AFFINITY_DISPATCH_SKIP_LOG_COOLDOWN_MS) {
    return;
  }
  // No write and no cooldown stamp: the write pass the flag triggers logs it.
  if (probe) {
    probe.skipLogDue = true;
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

export async function getPendingTaskForAgent(
  agentId: string,
  probe?: PendingTaskProbe,
): Promise<AgentTask | null> {
  // Get all pending tasks for this agent, ordered by priority (desc) then creation time (asc)
  const rows = await tasksRepo().listPendingTasksForAgent(agentId);

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
      await logAffinityDispatchSkip(agent, task, probe);
      continue;
    }
    if (task.routingAffinity?.leadOnly && !isAgentEligibleForTask(agent, task)) {
      await logAffinityDispatchSkip(agent, task, probe);
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
  options: {
    poolWakeAt?: string;
    routingSnapshot?: { task: AgentTask; agent: Agent; pool?: RuntimePool };
  } = {},
): Promise<AgentTask | null> {
  // This guard is always needed for lead-only tasks; the predicate itself
  // handles the optional role/capability kill-switch.
  {
    const task = options.routingSnapshot?.task ?? (await getTaskById(taskId));
    const agent = options.routingSnapshot?.agent ?? (await getAgentById(agentId));
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
  const snapshot = options.routingSnapshot;
  // Revalidate snapshots and capacity in the write itself, without holding a lock during routing.
  const row = await tasksRepo().assignUnassignedTask({
    taskId,
    agentId,
    now,
    poolWakeAt: options.poolWakeAt ?? null,
    guards: {
      snapshot: snapshot
        ? {
            taskLastUpdatedAt: snapshot.task.lastUpdatedAt,
            agentLastUpdatedAt: snapshot.agent.lastUpdatedAt,
          }
        : undefined,
      pool: snapshot?.pool
        ? {
            id: snapshot.pool.id,
            updatedAt: snapshot.pool.updatedAt,
            at: options.poolWakeAt ?? now,
          }
        : undefined,
    },
  });

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
    getStorage().afterCommit(() => publishWorkerNudge(agentId, { kind: "work", taskId }));
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

  const row = await tasksRepo().startTask(taskId);
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
  // Notify lifecycle subscribers only after the claim commits (e.g. GitHub eyes reaction).
  if (result && oldTask.status !== "in_progress") {
    getStorage().afterCommit(() => emitTaskStarted(result));
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
  /** Effort the session runs at; null records that the harness default applied. */
  resolvedEffort?: ReasoningEffort | null,
): Promise<AgentTask | null> {
  const row = await tasksRepo().setTaskSessionColumns(
    taskId,
    {
      claudeSessionId,
      provider,
      providerMeta: providerMeta !== undefined ? JSON.stringify(providerMeta) : undefined,
      model,
      harnessVariant,
      harnessVariantMeta:
        harnessVariantMeta !== undefined ? JSON.stringify(harnessVariantMeta) : undefined,
      resolvedEffort,
    },
    new Date().toISOString(),
  );
  return row ? rowToAgentTask(row) : null;
}

/**
 * Records the harness that ran (or tried to run) a task when no session ever
 * reported it. `provider` is otherwise written only by the session-init path,
 * so a task whose harness failed to spawn kept `provider` NULL and looked like
 * a task that never started. Never overwrites a provider already recorded.
 */
export async function recordTaskProviderIfUnset(
  taskId: string,
  provider: ProviderName,
): Promise<void> {
  await tasksRepo().setTaskProviderIfUnset(taskId, provider);
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
  const row = await tasksRepo().setTaskTitle(taskId, normalized);
  return row ? rowToAgentTask(row) : null;
}

/**
 * Adds and removes tags on a task. A tag in both lists is removed. Like
 * `updateTaskTitle`, it does not bump `lastUpdatedAt`: a tag is a label, not
 * progress, and lists that sort by recency (Needs you failures) must not move.
 */
export async function updateTaskTags(
  taskId: string,
  change: { add?: string[]; remove?: string[] },
): Promise<AgentTask | null> {
  const repo = tasksRepo();
  const row = await getStorage().transaction(async () => {
    const current = await repo.findTaskTags(taskId);
    if (!current) return null;
    const previousTagsJson = current.tags;
    const existing: string[] = previousTagsJson ? JSON.parse(previousTagsJson) : [];
    const removed = new Set(change.remove ?? []);
    const nextTags = Array.from(new Set([...existing, ...(change.add ?? [])])).filter(
      (tag) => !removed.has(tag),
    );
    const nextTagsJson = JSON.stringify(nextTags);
    const updated = await repo.setTaskTags(taskId, nextTagsJson, false);
    if (updated && tagWriteChangesHumanFree(previousTagsJson, nextTagsJson)) {
      await reclassifyTaskHumanFree([taskId]);
    }
    return updated;
  });
  return row ? rowToAgentTask(row) : null;
}

/**
 * Sets a generated display title only while the task has none. A rename that
 * landed first (a person, or another API replica) wins: the row is left alone
 * and `null` comes back. Like `updateTaskTitle`, it does not bump
 * `lastUpdatedAt`.
 */
export async function setTaskTitleIfUnset(
  taskId: string,
  title: string,
): Promise<AgentTask | null> {
  const normalized = title.trim();
  if (!normalized) return null;
  const row = await tasksRepo().setTaskTitleIfUnset(taskId, normalized);
  return row ? rowToAgentTask(row) : null;
}

export async function completeTask(
  id: string,
  output?: string,
  options?: {
    addTags?: string[];
    deferredAt?: string;
    /** The deferral's wake-up ceiling (ISO). Written only with `deferredAt`. */
    deferredUntil?: string;
    /** Why it completed; see TASK_STATUS_KINDS. Omitted stores NULL (unknown). */
    statusKind?: TaskStatusKindFor<"completed">;
  },
): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-complete a task already in a terminal state.
  // Mirrors cancelTask. Prevents duplicate task.completed events, duplicate
  // log entries, and duplicate follow-up tasks when multiple sessions race.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  // One scrubbed copy feeds both the stored row and the task.completed event.
  const scrubbedOutput = output ? scrubSecrets(output) : output;
  const repo = tasksRepo();
  const row = await getStorage().transaction(async () => {
    const finishedAt = new Date().toISOString();
    // The status predicate re-checks the idempotency guard atomically: the
    // await between the guard read above and this write lets a racing
    // terminal transition (e.g. heartbeat failTask) land first.
    let completed = await repo.finishTask(id, {
      status: "completed",
      statusKind: options?.statusKind ?? null,
      finishedAt,
    });
    if (!completed) return null;

    if (scrubbedOutput) {
      completed = await repo.setTaskOutput(id, scrubbedOutput);
    }
    if (completed && options?.addTags?.length) {
      const existingTags: string[] = completed.tags ? JSON.parse(completed.tags) : [];
      const nextTags = Array.from(new Set([...existingTags, ...options.addTags]));
      const previousTagsJson = completed.tags;
      const nextTagsJson = JSON.stringify(nextTags);
      completed = await repo.setTaskTags(id, nextTagsJson, true);
      // Only a tag the classifier reads (e.g. "heartbeat") can flip the flag;
      // a "deferred" write must not walk the task's whole subtree.
      if (tagWriteChangesHumanFree(previousTagsJson, nextTagsJson)) {
        await reclassifyTaskHumanFree([id]);
      }
    }
    if (completed && options?.deferredAt) {
      completed = await repo.setTaskDeferral(id, options.deferredAt, options.deferredUntil ?? null);
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
    getStorage().afterCommit(() => {
      import("../../../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.completed", {
            taskId: id,
            previousStatus: oldTask.status,
            output: scrubbedOutput,
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

export async function failTask(
  id: string,
  reason: string,
  opts: {
    /**
     * Compare-and-swap on the `lastUpdatedAt` the caller observed. The
     * heartbeat passes it so a progress write that lands after its read
     * cancels the remediation instead of being overwritten.
     */
    expectedLastUpdatedAt?: string;
    /**
     * `false` skips the dependent cascade. Only for a caller that settles the
     * dependents itself — the reboot sweep re-points them to the retry child,
     * then cascades whatever is left.
     */
    cascadeDependents?: boolean;
    /**
     * Why it failed: `agent` when the agent chose to, `error` when the system
     * gave up on the run, `cascade` / `external` otherwise. See
     * TASK_STATUS_KINDS. Omitted stores NULL (unknown).
     */
    statusKind?: TaskStatusKindFor<"failed">;
  } = {},
): Promise<AgentTask | null> {
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
  const row = await tasksRepo().finishTask(id, {
    status: "failed",
    statusKind: opts.statusKind ?? null,
    failureReason: scrubbedReason,
    finishedAt,
    expectedLastUpdatedAt: opts.expectedLastUpdatedAt,
  });
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
    getStorage().afterCommit(() => {
      import("../../../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.failed", {
            taskId: id,
            previousStatus: oldTask.status,
            failureReason: scrubbedReason,
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
    // The swallowed writes below run in savepoints: on Postgres a failed
    // statement would otherwise abort the caller's transaction and drop the
    // failure itself.
    try {
      await getStorage().transaction(() =>
        dependencies.promotePendingSteeringForTask(id, "Task failed before steering was delivered"),
      );
    } catch (error) {
      console.error(
        "[failTask] pending steering promotion error:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }

    // Cascade-fail any non-terminal tasks that depend on this one.
    // The cascade is recursive (transitive closure) and cycle-safe.
    if (opts.cascadeDependents !== false) {
      try {
        await getStorage().transaction(() => dependencies.cascadeFailDependents(id, "failed"));
      } catch (err) {
        console.error("[failTask] cascade-fail dependents error:", err);
      }
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
  const repo = tasksRepo();
  const row = await getStorage().transaction(async () => {
    const updated = await repo.overwriteTerminalResultText(id, output, failureReason);
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

/**
 * `cascadeDependents: false` skips the dependents sweep for a caller that
 * already knows no task depends on this one (a bulk cancel looks once).
 */
export async function cancelTask(
  id: string,
  reason?: string,
  options: {
    cascadeDependents?: boolean;
    /** Who cancelled it; see TASK_STATUS_KINDS. Omitted stores NULL (unknown). */
    statusKind?: TaskStatusKindFor<"cancelled">;
  } = {},
): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Only cancel tasks that are not already in a terminal state
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const cancelReason = scrubSecrets(reason ?? "Cancelled by user");
  // Status predicate re-checks the idempotency guard atomically (a racing
  // terminal transition can land during the await above).
  const row = await tasksRepo().finishTask(id, {
    status: "cancelled",
    statusKind: options.statusKind ?? null,
    failureReason: cancelReason,
    finishedAt,
  });

  if (row && oldTask) {
    const recipients = new Set([row.agentId, row.offeredTo]);
    getStorage().afterCommit(() => {
      for (const agentId of recipients) {
        if (agentId) publishWorkerNudge(agentId, { kind: "cancel", taskId: id });
      }
    });
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
        metadata: reason ? { reason: cancelReason } : undefined,
      });
    } catch {}
    getStorage().afterCommit(() => {
      import("../../../workflows/event-bus")
        .then(({ workflowEventBus }) => {
          workflowEventBus.emit("task.cancelled", {
            taskId: id,
            previousStatus: oldTask.status,
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
    // Deferral suppresses the original worker completion's Lead follow-up.
    // If its wake-up is cancelled, report that outcome after the cancel commits.
    if (row.source === "schedule" && row.taskType === "deferred" && row.parentTaskId) {
      getStorage().afterCommit(async () => {
        try {
          const { createWorkerTaskFollowUp } = await import("../../../tasks/worker-follow-up");
          await createWorkerTaskFollowUp({
            task: rowToAgentTask(row),
            status: "failed",
            failureReason: `Deferred continuation cancelled: ${cancelReason}`,
          });
        } catch (error) {
          console.error(
            "[cancelTask] deferred cancellation follow-up failed:",
            scrubSecrets(error instanceof Error ? error.message : String(error)),
          );
        }
      });
    }
    // The swallowed writes below run in savepoints: on Postgres a failed
    // statement would otherwise abort the caller's transaction and drop the
    // cancel itself.
    try {
      await getStorage().transaction(() =>
        dependencies.promotePendingSteeringForTask(
          id,
          "Task was cancelled before steering was delivered",
        ),
      );
    } catch (error) {
      console.error(
        "[cancelTask] pending steering promotion error:",
        scrubSecrets(error instanceof Error ? error.message : String(error)),
      );
    }

    if (options.cascadeDependents !== false) {
      try {
        await getStorage().transaction(() => dependencies.cascadeFailDependents(id, "cancelled"));
      } catch (err) {
        console.error("[cancelTask] cascade-fail dependents error:", err);
      }
    }
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Skip a task: the agent decided the work is not its to handle (for example a
 * Slack thread message addressed to someone else). `skipped` is terminal. The
 * one-line reason lands in `failureReason`, like a cancel's, so `output` stays
 * empty and nothing that publishes a task's output has text to post.
 *
 * Unlike `cancelTask` it does not cascade-fail dependents: a skipped
 * dependency satisfies `dependsOn` (see `checkDependencies`). It emits
 * `task.skipped`, which defer-task waits and workflow resume listen for; the
 * Slack, chat, Jira and Linear outbound paths do not, so a skip notifies no one.
 */
export async function skipTask(
  id: string,
  reason: string,
  opts: { statusKind?: TaskStatusKindFor<"skipped"> } = {},
): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;
  if (isTerminalTaskStatus(oldTask.status)) return null;

  const finishedAt = new Date().toISOString();
  const skipReason = scrubSecrets(reason);
  // Status predicate re-checks the idempotency guard atomically (a racing
  // terminal transition can land during the await above).
  const row = await tasksRepo().finishTask(id, {
    status: "skipped",
    statusKind: opts.statusKind ?? null,
    failureReason: skipReason,
    finishedAt,
  });
  if (!row) return null;

  try {
    await dependencies.createLogEntry({
      eventType: "task_status_change",
      taskId: id,
      agentId: row.agentId ?? undefined,
      oldValue: oldTask.status,
      newValue: "skipped",
      metadata: { reason: skipReason },
    });
  } catch {}
  getStorage().afterCommit(() => {
    import("../../../workflows/event-bus")
      .then(({ workflowEventBus }) => {
        workflowEventBus.emit("task.skipped", {
          taskId: id,
          failureReason: skipReason,
          agentId: row.agentId,
          workflowRunId: row.workflowRunId,
          workflowRunStepId: row.workflowRunStepId,
        });
      })
      .catch((err) =>
        console.error(
          "[db] task.skipped event not emitted:",
          scrubSecrets(err instanceof Error ? err.message : String(err)),
        ),
      );
  });
  try {
    await dependencies.promotePendingSteeringForTask(
      id,
      "Task was skipped before steering was delivered",
    );
  } catch (error) {
    console.error(
      "[skipTask] pending steering promotion error:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  }

  return rowToAgentTask(row);
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
  args: {
    reason: string;
    resumeTaskId: string | null;
    /** Compare-and-swap on the observed `lastUpdatedAt`; see `failTask`. */
    expectedLastUpdatedAt?: string;
    /** Defaults to `reason` when it is a resume reason; a free-form reason stores NULL. */
    statusKind?: TaskStatusKindFor<"superseded">;
  },
): Promise<AgentTask | null> {
  const oldTask = await getTaskById(id);
  if (!oldTask) return null;

  // Idempotency guard: don't re-supersede a task already in a terminal state.
  if (isTerminalTaskStatus(oldTask.status)) {
    return null;
  }

  const finishedAt = new Date().toISOString();
  const row = await tasksRepo().finishTask(id, {
    status: "superseded",
    statusKind:
      args.statusKind ?? (isTaskStatusKindFor("superseded", args.reason) ? args.reason : null),
    finishedAt,
    expectedLastUpdatedAt: args.expectedLastUpdatedAt,
  });

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
    getStorage().afterCommit(() => {
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

    // Without a resume id the dependents wait: every caller supersedes first,
    // creates the resume, then calls `backfillSupersedeTaskResumeTaskId`, which
    // settles them. Cascading here would fail work the resume is about to carry.
    // A caller whose resume is not created settles with `null`; heartbeat
    // repair settles whatever a crash left in between.
    if (args.resumeTaskId) await settleSupersededTaskDependents(id, args.resumeTaskId);
  }

  return row ? rowToAgentTask(row) : null;
}

/**
 * Move a workflow-step task that a supersede cut failed (`failed` with
 * `SUPERSEDED_WORKFLOW_TASK_REASON`) to `superseded` once the engine has
 * queued a retry for its step or settled the step without failing it, so it
 * no longer counts as a real failure. The
 * engine still sees `failed` first: its retry path runs off `task.failed`.
 * Keeps `failureReason` and `finishedAt`; emits no `task.superseded` event
 * (there is no resume task, and the failure listeners already ran). No-op
 * unless the row is still exactly that failure. Returns whether it moved.
 */
export async function markWorkflowStepTaskSuperseded(id: string): Promise<boolean> {
  const row = await tasksRepo().markWorkflowStepTaskSuperseded(id, SUPERSEDED_WORKFLOW_TASK_REASON);
  if (!row) return false;
  try {
    await dependencies.createLogEntry({
      eventType: "task_superseded",
      taskId: id,
      agentId: row.agentId ?? undefined,
      oldValue: "failed",
      newValue: "superseded",
      metadata: { reason: SUPERSEDED_WORKFLOW_TASK_REASON, resumeTaskId: null },
    });
  } catch {}
  return true;
}

/**
 * Settle the dependents of a superseded task. With a resume id, every
 * never-started dependent has the superseded id in `dependsOn` replaced by the
 * resume id, so it waits on the resume instead of dying with
 * `Blocked dependency … was superseded`. Anything still depending on the
 * superseded task afterwards (a dependent that already started, or every
 * dependent when there is no resume) cascade-fails. Idempotent.
 */
export async function settleSupersededTaskDependents(
  supersededId: string,
  resumeTaskId: string | null,
): Promise<void> {
  try {
    if (resumeTaskId) {
      // One statement: settlements of a shared dependent compose, and the
      // status predicate is evaluated at write time, so a claim into
      // `in_progress` is skipped while offered -> reviewing/pending is not.
      const repointed = await tasksRepo().repointDependents(
        supersededId,
        resumeTaskId,
        NEVER_STARTED_TASK_STATUSES,
      );
      for (const dep of repointed) {
        try {
          await dependencies.createLogEntry({
            eventType: "task_dependency_repointed",
            taskId: dep.id,
            agentId: dep.agentId ?? undefined,
            oldValue: supersededId,
            newValue: resumeTaskId,
            metadata: { reason: "supersede_resume" },
          });
        } catch {}
      }
      // Repair can settle onto a resume that already failed; its own cascade
      // ran before these dependents pointed at it.
      const resume = await getTaskById(resumeTaskId);
      if (repointed.length > 0 && (resume?.status === "failed" || resume?.status === "cancelled")) {
        await dependencies.cascadeFailDependents(resumeTaskId, resume.status);
      }
    }
    await dependencies.cascadeFailDependents(supersededId, "superseded");
  } catch (err) {
    console.error("[supersedeTask] settling dependents error:", err);
  }
}

/**
 * Attach the resume id to the task's `task_superseded` log entry, then settle
 * the dependents `supersedeTask` left waiting (re-point to the resume, cascade
 * the rest).
 */
export async function backfillSupersedeTaskResumeTaskId(
  taskId: string,
  resumeTaskId: string,
): Promise<boolean> {
  if ((await getTaskById(taskId))?.status === "superseded") {
    await settleSupersededTaskDependents(taskId, resumeTaskId);
  }

  const agents = getStorage().repos.agents;
  const row = await agents.findLatestTaskLog(taskId, "task_superseded");
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

  return (await agents.setLogMetadata(row.id, JSON.stringify(metadata))) > 0;
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

  const row = await tasksRepo().pauseTask(id);

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

  const row = await tasksRepo().resumePausedTask(taskId);

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
export async function getPausedTasksForAgent(
  agentId: string,
  readableBy?: { userId: string | null },
): Promise<AgentTask[]> {
  const rows = await tasksRepo().listPausedTasksForAgent(agentId, readableBy);
  return rows.map(rowToAgentTask);
}

export async function getOrphanedInProgressTasksForAgent(
  agentId: string,
  minAgeSeconds = 60,
): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const rows = await tasksRepo().listOrphanedInProgressTasks(agentId, cutoff);
  return rows.map(rowToAgentTask);
}

export async function resetOrphanedInProgressTasksForAgent(
  agentId: string,
  minAgeSeconds = 60,
): Promise<AgentTask[]> {
  const cutoff = new Date(Date.now() - minAgeSeconds * 1000).toISOString();
  const rows = await tasksRepo().resetOrphanedInProgressTasks(agentId, cutoff);

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
export async function getRecentlyCancelledTasksForAgent(
  agentId: string,
  readableBy?: { userId: string | null },
): Promise<AgentTask[]> {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const rows = await tasksRepo().listRecentlyCancelledTasks(agentId, fiveMinutesAgo, readableBy);
  return rows.map(rowToAgentTask);
}

export async function deleteTask(id: string): Promise<boolean> {
  const repo = tasksRepo();
  return await getStorage().transaction(async () => {
    // `parentTaskId` has no foreign key, so children survive with a dangling
    // parent. The human-free rule reads the parent row, so they are reclassified
    // once it is gone.
    const childIds = await repo.listChildTaskIds(id);
    // Its descendants leave the session too; the delete trigger handles the rest.
    await dropSessionDescendants(id);
    const changes = await repo.deleteTask(id);
    await reclassifyTaskHumanFree(childIds);
    return changes > 0;
  });
}

export async function updateTaskProgress(id: string, progress: string): Promise<AgentTask | null> {
  const scrubbedProgress = scrubSecrets(progress);
  const row = await tasksRepo().updateTaskProgress(id, scrubbedProgress);
  if (row) {
    try {
      await dependencies.createLogEntry({
        eventType: "task_progress",
        taskId: id,
        agentId: row.agentId ?? undefined,
        newValue: scrubbedProgress,
      });
    } catch {}
    getStorage().afterCommit(() => {
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
