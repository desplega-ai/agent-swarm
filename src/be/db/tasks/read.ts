import {
  readableSessionSql,
  sqlColumnRef,
  TASK_PREVIEW_LENGTH,
  TASK_SIBLING_BLOCK,
  type TaskListFilters,
  type TaskRoutingReason,
  type TaskRoutingSource,
  type TaskRow,
  type TaskSource,
  type TaskStatus,
} from "@desplega/storage";
import { normalizeAssetKey } from "../../../assets/key";
import type {
  Agent,
  AgentTask,
  AgentTaskSource,
  AgentTaskStatus,
  AgentTaskSummary,
  AgentTaskTimelineItem,
  FallbackHop,
  FollowUpConfig,
  ProviderName,
  ReasoningEffort,
  RoutingAffinity,
  RoutingReason,
  RoutingSource,
  TaskSlackParticipants,
  TaskStatusKind,
} from "../../../types";
import {
  FallbackHopSchema,
  FollowUpConfigSchema,
  parseModelTier,
  ReasoningEffortSchema,
  RoutingAffinitySchema,
  SUPERSEDED_WORKFLOW_TASK_REASON,
  TaskSlackParticipantsSchema,
  TaskStatusKindSchema,
  TERMINAL_TASK_STATUSES,
} from "../../../types";
import { normalizeOutputSchema } from "../../../utils/output-schema";
import { parseProviderMeta } from "../../../utils/provider-metadata";
import { scrubSecrets } from "../../../utils/secret-scrubber";
import { memoizedRead } from "../../request-memo";
import { getStorage } from "../../storage";
import { getAgentById } from "../agents";

type TaskReadDependencies = {
  checkDependencies: (taskId: string) => Promise<{ ready: boolean; blockedBy: string[] }>;
  assetKeyPrefixPattern: (input: string) => string;
  previewText: (text: string | null | undefined, maxChars: number) => string;
};

let dependencies: TaskReadDependencies;

// The facade registers deferred calls to helpers it still owns.
export function configureTaskReadDependencies(value: TaskReadDependencies): void {
  dependencies = value;
}

/** Preview length for a task's `task` text (pool-triage needs to read it): TASK_PREVIEW_LENGTH. */

/** The repository row. Storage types its enum columns with the domain values. */
export type AgentTaskRow = TaskRow;

// Compile-time drift check: storage and `src/types.ts` list the same values.
type SameValues<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const enumColumnsMatch: [
  SameValues<TaskStatus, AgentTaskStatus>,
  SameValues<TaskSource, AgentTaskSource>,
  SameValues<TaskRoutingReason, RoutingReason>,
  SameValues<TaskRoutingSource, RoutingSource>,
] = [true, true, true, true];
void enumColumnsMatch;

function toTask(row: TaskRow): AgentTask {
  return rowToAgentTask(row);
}

function tasksRepo() {
  return getStorage().repos.tasks;
}

/**
 * `task` as the list projections read it: the full text, or the UTF-8 byte
 * prefix `TASK_PREVIEW_SQL` selects.
 */
type TaskPreviewSource = { task: string | Uint8Array | null };
type AgentTaskListRow = Omit<AgentTaskRow, "task"> & TaskPreviewSource;

/** Columns the slim list mapper reads; `task` may already be a SQL prefix. */
type AgentTaskSummaryRow = Pick<
  AgentTaskListRow,
  | "id"
  | "key"
  | "agentId"
  | "creatorAgentId"
  | "task"
  | "title"
  | "status"
  | "source"
  | "taskType"
  | "tags"
  | "priority"
  | "dependsOn"
  | "offeredTo"
  | "acceptedAt"
  | "parentTaskId"
  | "scheduleId"
  | "model"
  | "modelTier"
  | "resolvedModel"
  | "modelSource"
  | "modelAlias"
  | "effort"
  | "resolvedEffort"
  | "profile"
  | "resolvedProfile"
  | "modelGroup"
  | "provider"
  | "requestedByUserId"
  | "progress"
  | "createdAt"
  | "lastUpdatedAt"
  | "finishedAt"
  | "statusKind"
  | "peakContextPercent"
  | "totalCostUsd"
>;

type AgentTaskTimelineRow = Pick<
  AgentTaskListRow,
  | "id"
  | "agentId"
  | "parentTaskId"
  | "task"
  | "title"
  | "status"
  | "createdAt"
  | "lastUpdatedAt"
  | "finishedAt"
  | "peakContextTokens"
  | "totalCostUsd"
>;

/**
 * The list projections (the repository's `listTasks`) cut `task` to the UTF-8
 * bytes that can hold one char past the preview length, after a leading
 * `<sibling_tasks_in_progress>` block (`src/tasks/sibling-block.ts`) and the
 * `\n\n` `prependSiblingBlock` puts after it. `taskPreview` decodes the bytes
 * and truncates them exactly as it would the full text.
 */
const SIBLING_OPEN = TASK_SIBLING_BLOCK.open;
const SIBLING_CLOSE = TASK_SIBLING_BLOCK.close;
// ignoreBOM keeps a leading U+FEFF, which the full-text preview keeps too.
const taskPreviewDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** What the repository's preview cut does in SQL, for a full-text row. */
function skipSiblingBlock(text: string): string {
  if (!text.startsWith(SIBLING_OPEN)) return text;
  const close = text.indexOf(SIBLING_CLOSE);
  if (close === -1) return text;
  const end = close + SIBLING_CLOSE.length;
  return text.slice(text.startsWith("\n\n", end) ? end + 2 : end);
}

function taskPreview(task: TaskPreviewSource["task"]): string {
  // Bytes come from the repository's preview cut, which already skipped the block.
  const text =
    task instanceof Uint8Array ? taskPreviewDecoder.decode(task) : skipSiblingBlock(task ?? "");
  return dependencies.previewText(text, TASK_PREVIEW_LENGTH);
}

/** A kind this build does not know (written by a newer one) reads as unknown. */
function parseStatusKind(value: string | null | undefined): TaskStatusKind | undefined {
  const parsed = TaskStatusKindSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The stored hop list; entries that do not parse are dropped, none reads as unset. */
function parseFallbackHops(value: string | null | undefined): FallbackHop[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const hops = parsed.flatMap((entry) => {
      const hop = FallbackHopSchema.safeParse(entry);
      return hop.success ? [hop.data] : [];
    });
    return hops.length > 0 ? hops : undefined;
  } catch {
    return undefined;
  }
}

/** The stored participants; a value that does not parse reads as unset. */
function parseSlackParticipants(
  value: string | null | undefined,
): TaskSlackParticipants | undefined {
  if (!value) return undefined;
  try {
    const parsed = TaskSlackParticipantsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function rowToAgentTask(row: AgentTaskRow): AgentTask {
  let followUpConfig: FollowUpConfig | undefined;
  if (row.followUpConfig) {
    try {
      const parsed = FollowUpConfigSchema.safeParse(JSON.parse(row.followUpConfig));
      if (parsed.success) {
        followUpConfig = parsed.data;
      } else {
        console.warn(
          `[db] Ignoring invalid agent_tasks.followUpConfig for task ${row.id}:`,
          parsed.error.message,
        );
      }
    } catch (error) {
      console.warn(
        `[db] Ignoring malformed agent_tasks.followUpConfig for task ${row.id}:`,
        error instanceof Error ? error.message : String(error),
      );
      followUpConfig = undefined;
    }
  }

  let routingAffinity: RoutingAffinity | undefined;
  let routingAffinityInvalid = false;
  if (row.routingAffinity) {
    try {
      const parsed = RoutingAffinitySchema.safeParse(JSON.parse(row.routingAffinity));
      if (parsed.success) {
        routingAffinity = parsed.data;
      } else {
        routingAffinityInvalid = true;
        console.warn(
          `[db] Quarantining invalid agent_tasks.routingAffinity for task ${row.id}:`,
          parsed.error.message,
        );
      }
    } catch (error) {
      routingAffinityInvalid = true;
      console.warn(
        `[db] Quarantining malformed agent_tasks.routingAffinity for task ${row.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    id: row.id,
    key: row.key,
    agentId: row.agentId,
    creatorAgentId: row.creatorAgentId ?? undefined,
    task: row.task,
    title: row.title ?? undefined,
    status: row.status,
    source: row.source,
    routingReason: row.routing_reason ?? undefined,
    routingSource: row.routing_source ?? undefined,
    routingNote: row.routing_note ?? undefined,
    poolWakeAt: row.pool_wake_at ?? undefined,
    taskType: row.taskType ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    priority: row.priority ?? 50,
    dependsOn: row.dependsOn ? JSON.parse(row.dependsOn) : [],
    offeredTo: row.offeredTo ?? undefined,
    offeredAt: row.offeredAt ?? undefined,
    acceptedAt: row.acceptedAt ?? undefined,
    rejectionReason: row.rejectionReason ?? undefined,
    slackChannelId: row.slackChannelId ?? undefined,
    slackThreadTs: row.slackThreadTs ?? undefined,
    slackTriggerMessageTs: row.slackTriggerMessageTs ?? undefined,
    slackUserId: row.slackUserId ?? undefined,
    slackParticipants: parseSlackParticipants(row.slackParticipants),
    slackReplySent: !!row.slackReplySent,
    slackProgressMessageTs: row.slackProgressMessageTs ?? undefined,
    slackTreeRootMessageTs: row.slackTreeRootMessageTs ?? undefined,
    vcsProvider:
      (row.vcsProvider as "github" | "gitlab" | "azure-devops" | "bitbucket" | null) ?? undefined,
    vcsRepo: row.vcsRepo ?? undefined,
    vcsEventType: row.vcsEventType ?? undefined,
    vcsNumber: row.vcsNumber ?? undefined,
    vcsCommentId: row.vcsCommentId ?? undefined,
    vcsAuthor: row.vcsAuthor ?? undefined,
    vcsUrl: row.vcsUrl ?? undefined,
    vcsInstallationId: row.vcsInstallationId ?? undefined,
    vcsNodeId: row.vcsNodeId ?? undefined,
    agentmailInboxId: row.agentmailInboxId ?? undefined,
    agentmailMessageId: row.agentmailMessageId ?? undefined,
    agentmailThreadId: row.agentmailThreadId ?? undefined,
    mentionMessageId: row.mentionMessageId ?? undefined,
    mentionChannelId: row.mentionChannelId ?? undefined,
    dir: row.dir ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    dispatchedByTaskId: row.dispatchedByTaskId ?? undefined,
    claudeSessionId: row.claudeSessionId ?? undefined,
    model: row.model ?? undefined,
    modelTier: parseModelTier(row.modelTier) ?? undefined,
    resolvedModel: row.resolvedModel ?? undefined,
    modelSource: row.modelSource ?? undefined,
    modelAlias: row.modelAlias ?? undefined,
    effort: ReasoningEffortSchema.safeParse(row.effort).success
      ? (row.effort as ReasoningEffort)
      : undefined,
    resolvedEffort: ReasoningEffortSchema.safeParse(row.resolvedEffort).success
      ? (row.resolvedEffort as ReasoningEffort)
      : undefined,
    profile: row.profile ?? undefined,
    resolvedProfile: row.resolvedProfile ?? undefined,
    modelGroup: row.modelGroup ?? undefined,
    fallbackHops: parseFallbackHops(row.fallbackHops),
    scheduleId: row.scheduleId ?? undefined,
    workflowRunId: row.workflowRunId ?? undefined,
    workflowRunStepId: row.workflowRunStepId ?? undefined,
    // A stored '{}' (legacy rows, defer-task resumes that copied it) means no
    // schema: expose it as absent so no harness or validator treats it as one.
    outputSchema: row.outputSchema
      ? normalizeOutputSchema(JSON.parse(row.outputSchema))
      : undefined,
    followUpConfig,
    contextKey: row.contextKey ?? undefined,
    compactionCount: row.compactionCount ?? undefined,
    peakContextPercent: row.peakContextPercent ?? undefined,
    peakContextTokens: row.peakContextTokens ?? undefined,
    contextWindowSize: row.contextWindowSize ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    finishedAt: row.finishedAt ?? undefined,
    notifiedAt: row.notifiedAt ?? undefined,
    failureReason: row.failureReason ?? undefined,
    statusKind: parseStatusKind(row.statusKind),
    output: row.output ?? undefined,
    progress: row.progress ?? undefined,
    wasPaused: !!row.was_paused,
    deferredAt: row.deferredAt ?? undefined,
    deferredUntil: row.deferredUntil ?? undefined,
    credentialKeySuffix: row.credentialKeySuffix ?? undefined,
    credentialKeyType: row.credentialKeyType ?? undefined,
    requestedByUserId: row.requestedByUserId ?? undefined,
    swarmVersion: row.swarmVersion ?? undefined,
    provider: (row.provider as ProviderName | null) ?? undefined,
    providerMeta: parseProviderMeta(row.provider as ProviderName | null, row.providerMeta),
    harnessVariant: row.harnessVariant ?? undefined,
    harnessVariantMeta: row.harnessVariantMeta ? JSON.parse(row.harnessVariantMeta) : undefined,
    totalCostUsd: row.totalCostUsd ?? undefined,
    routingAffinity,
    routingAffinityInvalid: routingAffinityInvalid || undefined,
  };
}

/**
 * Slim list-row mapper — truncates the `task` text to a bounded preview and
 * drops completion/integration/context blobs (`output`, `failureReason`,
 * `providerMeta`, all `vcs*`/`slack*`/`agentmail*`/`credential*`/`mention*` and
 * context-window fields). The preview is long enough for pool-triage; the full
 * brief is on `get-task-details` / `GET /api/tasks/{id}`.
 */
export function rowToAgentTaskSummary(row: AgentTaskSummaryRow): AgentTaskSummary {
  return {
    id: row.id,
    key: row.key,
    agentId: row.agentId,
    creatorAgentId: row.creatorAgentId ?? undefined,
    task: taskPreview(row.task),
    title: row.title ?? undefined,
    status: row.status,
    source: row.source,
    taskType: row.taskType ?? undefined,
    tags: row.tags ? JSON.parse(row.tags) : [],
    priority: row.priority ?? 50,
    dependsOn: row.dependsOn ? JSON.parse(row.dependsOn) : [],
    offeredTo: row.offeredTo ?? undefined,
    acceptedAt: row.acceptedAt ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    scheduleId: row.scheduleId ?? undefined,
    model: row.model ?? undefined,
    modelTier: parseModelTier(row.modelTier) ?? undefined,
    resolvedModel: row.resolvedModel ?? undefined,
    modelSource: row.modelSource ?? undefined,
    modelAlias: row.modelAlias ?? undefined,
    effort: ReasoningEffortSchema.safeParse(row.effort).success
      ? (row.effort as ReasoningEffort)
      : undefined,
    resolvedEffort: ReasoningEffortSchema.safeParse(row.resolvedEffort).success
      ? (row.resolvedEffort as ReasoningEffort)
      : undefined,
    profile: row.profile ?? undefined,
    resolvedProfile: row.resolvedProfile ?? undefined,
    modelGroup: row.modelGroup ?? undefined,
    provider: (row.provider as ProviderName | null) ?? undefined,
    requestedByUserId: row.requestedByUserId ?? undefined,
    progress: row.progress ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    finishedAt: row.finishedAt ?? undefined,
    statusKind: parseStatusKind(row.statusKind),
    peakContextPercent: row.peakContextPercent ?? undefined,
    totalCostUsd: row.totalCostUsd ?? undefined,
  };
}

/** Timeline list-row mapper: only what the dashboard timeline draws. */
function rowToAgentTaskTimelineItem(row: AgentTaskTimelineRow): AgentTaskTimelineItem {
  return {
    id: row.id,
    agentId: row.agentId,
    parentTaskId: row.parentTaskId ?? undefined,
    task: taskPreview(row.task),
    title: row.title ?? undefined,
    status: row.status,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    finishedAt: row.finishedAt ?? undefined,
    peakContextTokens: row.peakContextTokens ?? undefined,
    totalCostUsd: row.totalCostUsd ?? undefined,
  };
}

export async function getTaskById(id: string): Promise<AgentTask | null> {
  return memoizedRead("task", id, async () => {
    const row = await tasksRepo().findTaskById(id);
    return row ? toTask(row) : null;
  });
}

export async function getChildTasks(parentTaskId: string): Promise<AgentTask[]> {
  return (await tasksRepo().listChildTasks(parentTaskId)).map(toTask);
}

/** Caps for {@link getTaskLineage}: a fan-out of thousands still answers in one bounded read. */
export const TASK_LINEAGE_LIMITS = { maxNodes: 500, maxDepth: 30, maxAncestors: 50 } as const;

/** One task in a lineage tree: the slim list row plus the workflow run it belongs to. */
type TaskLineageNode = AgentTaskSummary & { workflowRunId?: string };

interface TaskLineage {
  /** The topmost ancestor reached (the session root unless `truncated`). */
  rootTaskId: string;
  /** Root first, then descendants; always holds the path root → `taskId`. */
  tasks: TaskLineageNode[];
  /** True when some ancestor or descendant is missing from `tasks`. */
  truncated: boolean;
}

type TaskLineageRow = AgentTaskSummaryRow & { workflowRunId: string | null };

function rowToTaskLineageNode(row: TaskLineageRow): TaskLineageNode {
  return { ...rowToAgentTaskSummary(row), workflowRunId: row.workflowRunId ?? undefined };
}

/**
 * The whole tree `taskId` belongs to, following `parentTaskId`: up to the
 * topmost ancestor, then every descendant of that root breadth-first. The
 * descendants of `taskId` itself are walked first, so a wide tree cut at
 * `maxNodes` still shows the task's own subtree. Read-only and bounded: at
 * most `maxAncestors` hops up, `maxDepth` levels down and about `2 * maxNodes`
 * rows. Null when the task does not exist.
 */
export async function getTaskLineage(
  taskId: string,
  limits: { maxNodes?: number; maxDepth?: number; maxAncestors?: number } = {},
): Promise<TaskLineage | null> {
  const maxNodes = limits.maxNodes ?? TASK_LINEAGE_LIMITS.maxNodes;
  const maxDepth = limits.maxDepth ?? TASK_LINEAGE_LIMITS.maxDepth;
  const maxAncestors = limits.maxAncestors ?? TASK_LINEAGE_LIMITS.maxAncestors;
  const repo = tasksRepo();
  // Hops are counted, so a parentTaskId cycle stops at the cap instead of looping.
  const path = await repo.listTaskAncestors(taskId, maxAncestors);
  if (path.length === 0) return null;
  const top = path[path.length - 1]!;
  // A parent that no longer exists ends the walk like a root; a cap does not.
  let truncated = top.hops === maxAncestors && top.parentTaskId !== null;

  const descendants = async (startId: string) =>
    (await repo.listTaskDescendants(startId, maxDepth, maxNodes + 1)) as TaskLineageRow[];

  const byId = new Map<string, TaskLineageNode>();
  const add = (rows: TaskLineageRow[]) => {
    for (const row of rows) {
      if (!byId.has(row.id)) byId.set(row.id, rowToTaskLineageNode(row));
    }
  };
  const ownSubtree = await descendants(taskId);
  const fromRoot = top.id === taskId ? ownSubtree : await descendants(top.id);
  add(fromRoot.slice(0, maxNodes));
  add(ownSubtree.slice(0, maxNodes));

  // The path root → task is always present, even past the depth or node cap.
  const missing = path.map((row) => row.id).filter((id) => !byId.has(id));
  if (missing.length > 0) {
    add((await repo.listTaskLineageRows(missing)) as TaskLineageRow[]);
  }

  // The caps cut the walk at many points (depth, node count, either walk), so
  // ask the table directly: is any child of a returned task not returned?
  if (!truncated) {
    truncated = await repo.hasChildOutside([...byId.keys()]);
  }

  return { rootTaskId: top.id, tasks: [...byId.values()], truncated };
}

/**
 * Returns true if `parentId` has at least one non-terminal child task with
 * `taskType = 'resume'`. Used by the heartbeat sweep as an idempotency guard:
 * if a prior sweep tick already created a resume follow-up for this parent,
 * don't create a duplicate.
 *
 * **Filters by taskType = 'resume'** specifically. A parent task can also
 * have ordinary non-terminal delegation children (`send-task` auto-defaults
 * `parentTaskId` to the caller's current task — see src/tools/send-task.ts).
 * Treating those as "already resumed" would incorrectly skip the resume
 * path for a crashed worker that had delegated subtasks (PR #594 review).
 */
export async function hasNonTerminalResumeChild(parentId: string): Promise<boolean> {
  return tasksRepo().hasOpenChildOfType(parentId, "resume");
}

/** How far back the heartbeat repairs a superseded task that never got a resume. */
export const SUPERSEDED_RESUME_REPAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Superseded tasks that never got a resume child. Both supersede paths
 * (heartbeat remediation and `POST /api/tasks/:id/supersede`) supersede
 * first and create the resume in a later, separate write, so a process
 * crash between the two leaves this state. Workflow steps are excluded: a cut
 * step is failed, and one the workflow carried on without (a queued retry,
 * which clears its step id, or a step that still completed) is superseded with
 * its `failureReason` kept, so it is matched on the reason.
 * `finishedBefore` keeps the sweep from racing
 * an in-flight supersede; `finishedAfter` bounds how far back it repairs.
 */
export async function getSupersededTasksWithoutResume(
  finishedBefore: string,
  finishedAfter: string,
): Promise<AgentTask[]> {
  const rows = await tasksRepo().listSupersededWithoutResume(
    finishedBefore,
    finishedAfter,
    SUPERSEDED_WORKFLOW_TASK_REASON,
  );
  return rows.map(toTask);
}

/** Statuses a dependent can hold before it ever started running. */
export const NEVER_STARTED_TASK_STATUSES = [
  "draft",
  "backlog",
  "unassigned",
  "offered",
  "reviewing",
  "pending",
];

/**
 * Superseded tasks that already have a resume child but still have
 * never-started dependents waiting on them, paired with their latest resume.
 * A crash after the resume is created but before
 * `backfillSupersedeTaskResumeTaskId` leaves this state, and
 * {@link getSupersededTasksWithoutResume} no longer sees it.
 */
export async function getSupersededTasksWithUnsettledDependents(
  finishedBefore: string,
  finishedAfter: string,
): Promise<{ taskId: string; resumeTaskId: string }[]> {
  return tasksRepo().listSupersededWithUnsettledDependents(
    finishedBefore,
    finishedAfter,
    NEVER_STARTED_TASK_STATUSES,
  );
}

/**
 * True when a non-terminal `reroute-decision` child exists for `parentId`.
 *
 * Mirrors {@link hasNonTerminalResumeChild} but filters on
 * `taskType = 'reroute-decision'` — the Lead-owned re-delegation decision
 * created when a pinned crash-recovery resume is never reclaimed (DES-523).
 * Makes escalation idempotent: a later heartbeat sweep must not create a second
 * decision for the same original task. We filter on the taskType marker
 * specifically (not any child) so ordinary delegation / completion follow-up
 * children of the original cannot suppress a needed decision, and nothing else
 * is mistaken for one.
 */
export async function hasNonTerminalRerouteDecisionChild(parentId: string): Promise<boolean> {
  return tasksRepo().hasOpenChildOfType(parentId, "reroute-decision");
}

export async function getTasksByAgentId(
  agentId: string,
  readableBy?: { userId: string | null },
): Promise<AgentTask[]> {
  return (await tasksRepo().listTasksByAgent(agentId, readableBy)).map(toTask);
}

/**
 * Tasks that one of `taskIds` dispatched (send-task) and that are not in
 * `taskIds`. A continuation keeps parentTaskId on an earlier task, so the
 * task that sent it does not reach it by the parentTaskId walk.
 */
export async function getTasksDispatchedFrom(taskIds: string[]): Promise<AgentTask[]> {
  if (taskIds.length === 0) return [];
  return (await tasksRepo().listTasksDispatchedFrom(taskIds)).map(toTask);
}

/**
 * Get the most recently updated in-progress task for an agent.
 * Used as a fallback when X-Source-Task-Id header is missing (e.g. lead agent HITL requests).
 *
 * Note: if agent has multiple in-progress tasks, returns the most recently
 * updated one. This is a best-effort fallback — the X-Source-Task-Id header
 * is the authoritative source when available.
 */
export async function getAgentCurrentTask(agentId: string): Promise<AgentTask | null> {
  const row = await tasksRepo().findAgentCurrentTask(agentId);
  return row ? toTask(row) : null;
}

export async function getTasksByStatus(status: AgentTaskStatus): Promise<AgentTask[]> {
  return (await tasksRepo().listTasksByStatus(status)).map(toTask);
}

/**
 * Find a task by VCS repo and issue/PR/MR number.
 * Returns the most recent non-terminal task for this VCS entity.
 *
 * Terminal exclusion MUST stay in lock-step with `TERMINAL_TASK_STATUSES`
 * in `src/types.ts`. SQL strings can't import a TS const — if you add a
 * new terminal status, grep for `NOT IN ('completed'` across this file.
 */
/**
 * Most recent active task for a provider + repo + PR/issue number. The
 * provider is required: `owner/repo` exists on GitHub, GitLab and Bitbucket
 * alike, so an unscoped lookup lets one host's webhook act on another host's
 * task. A NULL `vcsProvider` is a legacy GitHub row (pre-provider writers), so
 * the GitHub lookup still matches it.
 */
export async function findTaskByVcs(
  vcsRepo: string,
  vcsNumber: number,
  vcsProvider: NonNullable<AgentTask["vcsProvider"]>,
): Promise<AgentTask | null> {
  const row = await tasksRepo().findActiveTaskByVcs({
    repo: vcsRepo,
    number: vcsNumber,
    provider: vcsProvider,
    includeNullProvider: vcsProvider === "github",
  });
  return row ? toTask(row) : null;
}

/**
 * Every active task for a provider + repo + PR/issue number, newest first.
 * Same scoping as `findTaskByVcs`; for callers that must settle all of them
 * (a PR close leaves no task worth running).
 */
export async function findActiveTasksByVcs(
  vcsRepo: string,
  vcsNumber: number,
  vcsProvider: NonNullable<AgentTask["vcsProvider"]>,
): Promise<AgentTask[]> {
  const rows = await tasksRepo().listActiveTasksByVcs({
    repo: vcsRepo,
    number: vcsNumber,
    provider: vcsProvider,
    includeNullProvider: vcsProvider === "github",
  });
  return rows.map(toTask);
}

/** @deprecated Use findTaskByVcs instead */
export const findTaskByGitHub = findTaskByVcs;

export interface TaskFilters {
  /** Single status (back-compat) OR array of statuses (multi-status filter). */
  status?: AgentTaskStatus | AgentTaskStatus[];
  /** Why the task ended (e.g. `error`); combine with `status` to tell `failed` kinds apart. */
  statusKind?: TaskStatusKind;
  agentId?: string;
  search?: string;
  // New filters
  unassigned?: boolean;
  offeredTo?: string;
  readyOnly?: boolean;
  taskType?: string;
  tags?: string[];
  scheduleId?: string;
  workflowRunId?: string;
  /** Exact canonical asset namespace. */
  key?: string;
  /** Canonical namespace subtree prefix. */
  keyPrefix?: string;
  /** Filter to tasks whose `source` is in this list. Empty/undefined → no filter. */
  source?: AgentTaskSource[];
  /** ISO 8601 timestamp; only return tasks where createdAt >= this. */
  createdAfter?: string;
  /** ISO 8601 timestamp; only return tasks where createdAt < this. */
  createdBefore?: string;
  /** Only return tasks requested by this canonical user. NULL rows are excluded. */
  requestedByUserId?: string;
  /** When set, restrict to rows where `requestedByUserId` IS NULL. Takes priority over `requestedByUserId`. */
  requestedByUserIdIsNull?: boolean;
  /** Sort list rows for either table freshness or timeline paging. */
  orderBy?: "lastUpdatedAt" | "createdAt";
  limit?: number;
  offset?: number;
  includeHeartbeat?: boolean;
  /** Only tasks of sessions this user may read; `userId: null` is a guest. */
  readableBy?: { userId: string | null };
}

/**
 * The SQL twin of `sessionAccessForRoot` (../../session-shares). A session's
 * root is its topmost existing task; the session is hidden when the root has
 * an owner other than the user, is not a schedule run (`scheduleId`), and no
 * active share names the user or everyone. Descending from hidden roots is linear in their tasks at any chain
 * depth, and as a WHERE term it keeps paging and `COUNT(*)` on the same rows.
 * `parentTaskId` is fixed at insert to an existing task, so no parent cycle
 * (which would have no root) can form.
 *
 * `taskIdColumn` applies the same filter to any table keyed by task id. A
 * nullable column keeps its task-less rows: they belong to no session.
 */
export function readableSessionCondition(
  userId: string | null,
  taskIdColumn = "agent_tasks.id",
  opts: { nullable?: boolean } = {},
): { sql: string; params: string[] } {
  // String form for callers that still build SQL text; the repository uses the fragment.
  const rendered = readableSessionSql(userId, sqlColumnRef(taskIdColumn), opts).render(
    getStorage().dialect,
  );
  return { sql: rendered.text, params: rendered.params as string[] };
}

/** The repository's normalized filters for a {@link TaskFilters}. */
function toListFilters(filters: TaskFilters | undefined): TaskListFilters {
  const status = filters?.status;
  return {
    statuses: !status ? undefined : Array.isArray(status) ? status : [status],
    statusKind: filters?.statusKind,
    agentId: filters?.agentId,
    search: filters?.search,
    unassigned: filters?.unassigned,
    offeredTo: filters?.offeredTo,
    taskType: filters?.taskType,
    tags: filters?.tags,
    scheduleId: filters?.scheduleId,
    workflowRunId: filters?.workflowRunId,
    key: filters?.key ? normalizeAssetKey(filters.key) : undefined,
    keyPrefixPattern:
      !filters?.key && filters?.keyPrefix
        ? dependencies.assetKeyPrefixPattern(filters.keyPrefix)
        : undefined,
    sources: filters?.source,
    createdAfter: filters?.createdAfter,
    createdBefore: filters?.createdBefore,
    requestedByUserId: filters?.requestedByUserId,
    requestedByUserIdIsNull: filters?.requestedByUserIdIsNull,
    includeHeartbeat: filters?.includeHeartbeat,
    readableBy: filters?.readableBy,
  };
}

export function getAllTasks(filters?: TaskFilters): Promise<AgentTask[]>;
export function getAllTasks(
  filters: TaskFilters | undefined,
  opts: { slim: true },
): Promise<AgentTaskSummary[]>;
export function getAllTasks(
  filters: TaskFilters | undefined,
  opts: { fields: "timeline" },
): Promise<AgentTaskTimelineItem[]>;
export async function getAllTasks(
  filters?: TaskFilters,
  opts?: { slim?: boolean; fields?: "timeline" },
): Promise<AgentTask[] | AgentTaskSummary[] | AgentTaskTimelineItem[]> {
  // One call per projection, so each branch sees the row type of its own fields value.
  const listFilters = toListFilters(filters);
  const page = {
    orderBy: filters?.orderBy,
    limit: filters?.limit ?? 25,
    offset: filters?.offset ?? 0,
  };

  if (opts?.fields === "timeline") {
    const rows = await tasksRepo().listTasks(listFilters, page, "timeline");
    return rows.map(rowToAgentTaskTimelineItem);
  }

  // Filter for ready tasks (dependencies met) if requested. Both the full and
  // the slim row shapes carry `id` + `dependsOn`, so the same predicate works.
  const filterReady = async <T extends { id: string; dependsOn: string[] }>(
    items: T[],
  ): Promise<T[]> => {
    const readyFlags = await Promise.all(
      items.map(async (task) => {
        if (!task.dependsOn || task.dependsOn.length === 0) return true;
        return (await dependencies.checkDependencies(task.id)).ready;
      }),
    );
    return items.filter((_, i) => readyFlags[i]);
  };

  if (opts?.slim) {
    const rows = await tasksRepo().listTasks(listFilters, page, "slim");
    let tasks = rows.map(rowToAgentTaskSummary);
    if (filters?.readyOnly) tasks = await filterReady(tasks);
    return tasks;
  }

  const rows = await tasksRepo().listTasks(listFilters, page, "full");
  let tasks = rows.map(rowToAgentTask);
  if (filters?.readyOnly) tasks = await filterReady(tasks);
  return tasks;
}

/**
 * Get total count of tasks matching the given filters (ignoring limit).
 * Used alongside getAllTasks to display accurate total counts in UI.
 */
export async function getTasksCount(
  filters?: Omit<TaskFilters, "limit" | "readyOnly">,
): Promise<number> {
  return tasksRepo().countTasks(toListFilters(filters));
}

/**
 * Get task statistics (counts by status) without any limit.
 * This is more efficient than fetching all tasks for stats purposes.
 */
export async function getTaskStats(): Promise<{
  total: number;
  unassigned: number;
  offered: number;
  reviewing: number;
  pending: number;
  in_progress: number;
  paused: number;
  completed: number;
  failed: number;
}> {
  const row = await tasksRepo().taskStats();

  return (
    row ?? {
      total: 0,
      unassigned: 0,
      offered: 0,
      reviewing: 0,
      pending: 0,
      in_progress: 0,
      paused: 0,
      completed: 0,
      failed: 0,
    }
  );
}

export async function getCompletedSlackTasks(): Promise<AgentTask[]> {
  return (await tasksRepo().listFinishedSlackTasks()).map(toTask);
}

/**
 * Return terminal Slack-rooted tasks whose durable relay obligation is pending.
 * The obligation is inserted by a DB trigger in the same transaction as the
 * terminal status transition, so a process restart cannot lose the send.
 */
export async function getPendingSlackRelayTasks(): Promise<AgentTask[]> {
  return (await getStorage().repos.messaging.listPendingSlackRelayTasks()).map(toTask);
}

/** Rotate attempted rows behind fresh obligations so poison rows cannot starve the queue. */
export async function markSlackRelayAttempted(taskId: string): Promise<boolean> {
  const now = new Date().toISOString();
  return (await getStorage().repos.messaging.markSlackRelayAttempted(taskId, now)) > 0;
}

/** Mark a relay obligation delivered only after Slack accepted the final result. */
export async function markSlackRelayDelivered(taskId: string): Promise<boolean> {
  const now = new Date().toISOString();
  return (await getStorage().repos.messaging.markSlackRelayDelivered(taskId, now)) > 0;
}

/** Discharge obligations already fulfilled by renderer v2's durable outcome record. */
export async function markFinalizedSlackRelaysDelivered(): Promise<number> {
  const now = new Date().toISOString();
  return await getStorage().repos.messaging.markFinalizedSlackRelaysDelivered(now);
}

/** Pending Chat SDK relay row: the terminal task plus its obligation bookkeeping. */
export interface PendingChatRelay {
  task: AgentTask;
  createdAt: string;
  lastError: string | null;
}

/**
 * Terminal chat tasks whose relay obligation is pending, out of backoff at
 * `now`, and whose `task:chat-sdk:<adapter>:` contextKey names one of
 * `adapters` (the adapters that are running). Rows of other adapters are left
 * out of the query, so a stopped adapter cannot fill the window and starve the
 * healthy ones. Returns no rows when `adapters` is empty. Never-attempted rows
 * sort first, then the oldest attempts. A contextKey that does not parse as a
 * chat key is not selected here; `giveUpStaleChatRelays` retires such rows once
 * they age out.
 */
export async function getPendingChatRelayTasks(
  now: number = Date.now(),
  limit = 200,
  adapters: readonly string[] = [],
): Promise<PendingChatRelay[]> {
  // Backoff: eligible when never attempted, or when `min(3 s * 2^attempt_count,
  // 10 min)` passed since the last attempt. Adapter names are lowercase letters.
  const rows = await getStorage().repos.messaging.listPendingChatRelayTasks(
    new Date(now).toISOString(),
    limit,
    adapters,
  );
  return rows.map((row) => ({
    task: toTask(row),
    createdAt: row.relay_created_at,
    lastError: row.relay_last_error,
  }));
}

/**
 * Give up every pending chat relay obligation created more than `olderThanMs`
 * before `now`, whatever the adapter state. Returns how many rows were retired.
 */
export async function giveUpStaleChatRelays(now: number, olderThanMs: number): Promise<number> {
  const at = new Date(now).toISOString();
  const cutoff = new Date(now - olderThanMs).toISOString();
  return await getStorage().repos.messaging.giveUpChatRelaysCreatedBefore(
    cutoff,
    at,
    "gave up: older than 24h",
  );
}

/**
 * Claim a chat relay row before the send: bump `attempt_count` and set
 * `last_attempt_at`. Conditional on the row still being pending and out of
 * backoff, so two concurrent ticks cannot both send. Returns true when claimed.
 */
export async function markChatRelayAttempted(
  taskId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const at = new Date(now).toISOString();
  return (await getStorage().repos.messaging.markChatRelayAttempted(taskId, at)) > 0;
}

/** Record why the last chat relay attempt failed. The text is scrubbed before it is stored. */
export async function recordChatRelayError(
  taskId: string,
  error: string,
  now: number = Date.now(),
): Promise<boolean> {
  const at = new Date(now).toISOString();
  return (
    (await getStorage().repos.messaging.recordChatRelayError(taskId, scrubSecrets(error), at)) > 0
  );
}

/** Mark a chat relay obligation delivered after the platform accepted every chunk. Idempotent. */
export async function markChatRelayDelivered(
  taskId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const at = new Date(now).toISOString();
  return (await getStorage().repos.messaging.markChatRelayDelivered(taskId, at)) > 0;
}

/** Stop retrying a chat relay obligation. The reason is scrubbed before it is stored. */
export async function markChatRelayGivenUp(
  taskId: string,
  error: string,
  now: number = Date.now(),
): Promise<boolean> {
  const at = new Date(now).toISOString();
  return (
    (await getStorage().repos.messaging.markChatRelayGivenUp(taskId, scrubSecrets(error), at)) > 0
  );
}

/**
 * Get tasks that were recently finished (completed/failed) by workers (non-lead agents).
 * Used by leads to know when workers complete tasks.
 */
export async function getRecentlyFinishedWorkerTasks(): Promise<AgentTask[]> {
  // Finished tasks that haven't been notified yet
  return (await tasksRepo().listUnnotifiedFinishedWorkerTasks()).map(toTask);
}

/**
 * Atomically mark finished tasks as notified.
 * Sets notifiedAt timestamp to prevent returning them in future polls.
 */
export async function markTasksNotified(taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  return tasksRepo().markTasksNotified(taskIds, new Date().toISOString());
}

/**
 * Reset notifiedAt for tasks, allowing them to be re-delivered on next poll.
 * Used when a trigger was consumed but the session that should process it failed.
 * This prevents permanent notification loss from the mark-before-process race.
 */
export async function resetTasksNotified(taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  return tasksRepo().resetTasksNotified(taskIds);
}

export async function getInProgressSlackTasks(): Promise<AgentTask[]> {
  return (await tasksRepo().listInProgressSlackTasks()).map(toTask);
}

/** How far back the missing-tree sweep looks for Slack tasks without a tree. */
const SLACK_MISSING_TREE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Slack tasks (created since render-v2 activation) whose thread has no tree
 * row yet.
 *
 * The full sweep reads only tasks updated in the last 24 h. The bound is on
 * lastUpdatedAt, not createdAt: a task that waits in backlog/unassigned for
 * days gets a fresh lastUpdatedAt when it leaves that status, so it re-enters
 * the window exactly when it starts to need a tree. idx_agent_tasks_slack_last_updated
 * makes the bound a range seek and also serves the ORDER BY. INDEXED BY:
 * without ANALYZE statistics the planner otherwise picks a wider index.
 *
 * `thread` scopes the query to one thread (event-driven render). It seeks the
 * thread through idx_agent_tasks_slack_thread_cover and has no time window,
 * so an old task in that thread is never skipped.
 */
export async function getSlackTasksMissingTree(
  options: { now?: Date; thread?: { channelId: string; threadTs: string } } = {},
): Promise<AgentTask[]> {
  const thread = options.thread;
  const since = new Date(
    (options.now ?? new Date()).getTime() - SLACK_MISSING_TREE_WINDOW_MS,
  ).toISOString();
  const rows = await getStorage().repos.slack.listSlackTasksMissingTree(
    thread ? { thread } : { since },
  );
  return rows.map(toTask);
}

/**
 * Return sibling tasks for a given cross-ingress context key, optionally
 * filtered by status. The returned shape mirrors getInProgressSlackTasks for
 * consistency; callers can narrow further in TypeScript.
 *
 * See src/tasks/context-key.ts for the key schema.
 */
export async function getInProgressTasksByContextKey(
  contextKey: string,
  statuses: AgentTaskStatus[] = ["pending", "in_progress", "offered", "paused"],
): Promise<AgentTask[]> {
  if (!contextKey || statuses.length === 0) return [];
  return (await tasksRepo().listTasksByContextKey(contextKey, statuses)).map(toTask);
}

export type ExistingTrackerContextWorkReason = "active_task" | "linked_open_pr";

export type ExistingTrackerContextWork = {
  task: AgentTask;
  reason: ExistingTrackerContextWorkReason;
};

const LINEAR_TRACKER_CONTEXT_KEY_PREFIX = "task:trackers:linear:";

export function isLinearTrackerContextKey(
  contextKey: string | null | undefined,
): contextKey is string {
  return !!contextKey && contextKey.startsWith(LINEAR_TRACKER_CONTEXT_KEY_PREFIX);
}

/**
 * Return existing work for a Linear tracker key before creating another task.
 *
 * Active means any non-terminal task. A completed task with persisted VCS PR/MR
 * metadata is also treated as existing work because the task can be complete
 * while the PR is still awaiting review/merge. Delegation excludes the tracker
 * root and all its descendants from both lookups.
 */
export async function findExistingLinearTrackerContextWork(
  contextKey: string | null | undefined,
  delegatingParentTaskId?: string,
): Promise<ExistingTrackerContextWork | null> {
  if (!isLinearTrackerContextKey(contextKey)) return null;
  const parent = delegatingParentTaskId ?? null;

  const activeRow = await tasksRepo().findTrackerContextTask(contextKey, parent, "active");
  if (activeRow) {
    return { task: toTask(activeRow), reason: "active_task" };
  }

  const linkedPrRow = await tasksRepo().findTrackerContextTask(contextKey, parent, "linkedPr");
  if (linkedPrRow) {
    return { task: toTask(linkedPrRow), reason: "linked_open_pr" };
  }

  return null;
}

/**
 * Latest task on a contextKey. `requestedByUserId` keeps only that user's
 * tasks; `notRequestedByUserId` keeps only tasks of anyone else, including
 * tasks with no requester.
 */
export async function getLatestTaskByContextKey(
  contextKey: string,
  options: { requestedByUserId?: string; notRequestedByUserId?: string } = {},
): Promise<AgentTask | null> {
  if (!contextKey) return null;
  const row = await tasksRepo().findLatestTaskByContextKey(contextKey, options);
  return row ? toTask(row) : null;
}

export async function getLatestScriptRunStepTaskByContextKey(
  contextKey: string,
): Promise<AgentTask | null> {
  if (!contextKey) return null;
  const row = await tasksRepo().findLatestScriptRunStepTask(contextKey);
  return row ? toTask(row) : null;
}

/**
 * Find the most recent agent associated with a specific Slack thread.
 * No status filter — returns the last agent that touched this thread regardless of task state.
 * This is intentional: follow-up messages should route to the same agent even after task completion.
 * Callers (e.g. assistant.ts) apply their own status checks (e.g. agent.status !== "offline").
 */
export async function getAgentWorkingOnThread(
  channelId: string,
  threadTs: string,
): Promise<Agent | null> {
  const taskRow = await tasksRepo().findLatestSlackIngressTaskInThread(channelId, threadTs);

  if (taskRow?.agentId) return getAgentById(taskRow.agentId);

  return null;
}

/**
 * Find the latest active (in_progress or pending) task in a specific Slack thread.
 * Used for dependency chaining in additive Slack buffer.
 */
export async function getLatestActiveTaskInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask | null> {
  const row = await tasksRepo().findLatestActiveSlackTaskInThread(channelId, threadTs);
  return row ? toTask(row) : null;
}

/**
 * Find the latest task assigned to a lead agent in a specific Slack thread.
 * Source is deliberately restricted to Slack ingress so inherited worker-task
 * metadata cannot become the thread's steering target.
 */
export async function getLatestLeadTaskInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask | null> {
  const row = await tasksRepo().findLatestLeadSlackTaskInThread(channelId, threadTs);
  return row ? toTask(row) : null;
}

/*
 * `source` filter of the contextKey lookups below (the repository's
 * `contextKeySource`). `'chat'` also matches a defer-task wake-up of a chat
 * task: it keeps the chat contextKey with `source = 'schedule'`
 * (src/scheduler/schedule-task.ts) and continues the same ask, so `/cancel`,
 * steering and routing treat it as the chat task.
 */

/**
 * ContextKey twins of the Slack thread lookups above, for channels that key a
 * conversation by `contextKey` only (Chat SDK). `source` narrows to the
 * channel's ingress tasks, as the Slack twins do with `source = 'slack'`:
 * follow-ups and delegated worker tasks inherit the parent's contextKey.
 * All three use `idx_agent_tasks_context_key_status`.
 */
export async function getAgentWorkingOnContextKey(
  contextKey: string,
  source?: string,
  /** ISO time: when set, only tasks still open or finished at or after it count. */
  endedSince?: string,
): Promise<Agent | null> {
  const agentId = await tasksRepo().findLatestAgentIdOnContextKey(
    contextKey,
    source ?? null,
    endedSince ?? null,
    TERMINAL_TASK_STATUSES,
  );

  if (agentId) return getAgentById(agentId);

  return null;
}

/**
 * Latest task whose contextKey starts with `prefix` (a half-open key range, so
 * the contextKey index serves it). The Chat SDK keys a Slack or Discord task by
 * `<channel>:<thread>`, while a slash command only knows the channel: the
 * prefix finds the tasks of every thread in it. `activeOnly` narrows to
 * `in_progress` and `pending`; `source` narrows as in the exact-key twins;
 * `requestedByUserId` keeps only that user's tasks.
 */
export async function getLatestTaskByContextKeyPrefix(
  prefix: string,
  options: { activeOnly?: boolean; source?: string; requestedByUserId?: string } = {},
): Promise<AgentTask | null> {
  if (!prefix) return null;
  const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  const row = await tasksRepo().findLatestTaskInContextKeyRange(prefix, upper, {
    source: options.source ?? null,
    activeOnly: options.activeOnly ?? false,
    requestedByUserId: options.requestedByUserId,
  });
  return row ? toTask(row) : null;
}

/** Latest `in_progress` or `pending` task on a contextKey (dependency chaining). */
export async function getLatestActiveTaskByContextKey(
  contextKey: string,
  source?: string,
  requestedByUserId?: string,
): Promise<AgentTask | null> {
  const row = await tasksRepo().findLatestActiveTaskByContextKey(
    contextKey,
    source ?? null,
    requestedByUserId,
  );
  return row ? toTask(row) : null;
}

/** Latest task assigned to a lead agent on a contextKey (the steering target). */
export async function getLatestLeadTaskByContextKey(
  contextKey: string,
  source?: string,
): Promise<AgentTask | null> {
  const row = await tasksRepo().findLatestLeadTaskByContextKey(contextKey, source ?? null);
  return row ? toTask(row) : null;
}

/**
 * Find the most recent task in a Slack thread, regardless of source or status.
 * Unlike getAgentWorkingOnThread (which filters source='slack'), this finds ALL tasks
 * including worker tasks that inherited Slack metadata via parentTaskId.
 */
/** The oldest task in a Slack thread: who started the swarm's work there. */
export async function getFirstTaskInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask | null> {
  const row = await tasksRepo().findFirstTaskInThread(channelId, threadTs);
  return row ? toTask(row) : null;
}

export async function getMostRecentTaskInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask | null> {
  const row = await tasksRepo().findMostRecentTaskInThread(channelId, threadTs);
  return row ? toTask(row) : null;
}

/**
 * One page of completed tasks in a Slack thread, most recent first. Lead
 * `follow-up` sessions are excluded: they coordinate the work, they are not the
 * work, so they never count as "the request was already handled". The caller
 * matches descriptions in JS, so it pages through the whole window with the
 * `before` keyset cursor (the last row of the previous page) instead of
 * loading every row in one query.
 */
export async function findCompletedTasksInThread(
  channelId: string,
  threadTs: string,
  windowMinutes: number,
  limit = 200,
  before?: { lastUpdatedAt: string; id: string },
): Promise<AgentTask[]> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const rows = await tasksRepo().listCompletedTasksInThread(
    channelId,
    threadTs,
    since,
    limit,
    before,
  );
  return rows.map(toTask);
}

/**
 * Most recent FAILED task in a Slack thread. A failure more recent than a
 * completion means the follow-up re-delegation guard must let a retry through.
 */
export async function findRecentFailedTaskInThread(
  channelId: string,
  threadTs: string,
  windowMinutes: number,
): Promise<AgentTask | null> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const row = await tasksRepo().findRecentFailedTaskInThread(channelId, threadTs, since);
  return row ? toTask(row) : null;
}

/**
 * Count the dispatches one agent made into a Slack thread since the window
 * start: each `send-task` task counts once, and each durable script run counts
 * once however many `ctx.step.agentTask` steps it created (step tasks share the
 * `script-run:<runId>:` contextKey prefix). A run is dated by its first step,
 * the dispatch the guard checked, so a run that started before the window does
 * not count again for steps it adds later. The follow-up re-delegation loop cap
 * reads this.
 */
export async function countAgentDispatchesInThread(
  channelId: string,
  threadTs: string,
  creatorAgentId: string,
  windowMinutes: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  return tasksRepo().countAgentDispatchesInThread(channelId, threadTs, creatorAgentId, since);
}

/**
 * Find the most recent CANCELLED task in a Slack thread. Used by the
 * follow-up re-delegation guard so a cancellation (worker SIGTERM,
 * runner-side abort, swarm-events tool-loop abort) doesn't permanently
 * jam re-dispatch when an earlier sibling task in the same thread also
 * completed.
 *
 * Matches both:
 *   - `status = 'cancelled'` (the canonical terminal state from cancelTask)
 *   - `status = 'failed'` with a failureReason that starts with "cancelled"
 *     or "exit 130" or contains "cancelled" (the codex-adapter abort path
 *     emits `failureReason: "cancelled"` and exits 130).
 */
export async function findRecentCancelledTaskInThread(
  channelId: string,
  threadTs: string,
  windowMinutes: number,
): Promise<AgentTask | null> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const row = await tasksRepo().findRecentCancelledTaskInThread(channelId, threadTs, since);
  return row ? toTask(row) : null;
}
