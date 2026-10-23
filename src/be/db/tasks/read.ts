import { normalizeAssetKey } from "../../../assets/key";
import type {
  Agent,
  AgentTask,
  AgentTaskSource,
  AgentTaskStatus,
  AgentTaskSummary,
  AgentTaskTimelineItem,
  FollowUpConfig,
  ProviderName,
  ReasoningEffort,
  RoutingAffinity,
  RoutingReason,
  RoutingSource,
} from "../../../types";
import {
  FollowUpConfigSchema,
  parseModelTier,
  ReasoningEffortSchema,
  RoutingAffinitySchema,
  TERMINAL_TASK_STATUSES,
} from "../../../types";
import { parseProviderMeta } from "../../../utils/provider-metadata";
import { scrubSecrets } from "../../../utils/secret-scrubber";
import { getAgentById } from "../agents";
import { getDbClient } from "../runtime";

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

/** Preview length for a task's `task` text (pool-triage needs to read it). */
const TASK_PREVIEW_LENGTH = 300;

export type AgentTaskRow = {
  id: string;
  key: string;
  agentId: string | null;
  creatorAgentId: string | null;
  task: string;
  title: string | null;
  status: AgentTaskStatus;
  source: AgentTaskSource;
  routing_reason: RoutingReason | null;
  routing_source: RoutingSource | null;
  routing_note: string | null;
  pool_wake_at: string | null;
  taskType: string | null;
  tags: string | null;
  priority: number;
  dependsOn: string | null;
  offeredTo: string | null;
  offeredAt: string | null;
  acceptedAt: string | null;
  rejectionReason: string | null;
  slackChannelId: string | null;
  slackThreadTs: string | null;
  slackTriggerMessageTs: string | null;
  slackUserId: string | null;
  slackReplySent: number;
  slackProgressMessageTs: string | null;
  slackTreeRootMessageTs: string | null;
  vcsProvider: string | null;
  vcsRepo: string | null;
  vcsEventType: string | null;
  vcsNumber: number | null;
  vcsCommentId: number | null;
  vcsAuthor: string | null;
  vcsUrl: string | null;
  vcsInstallationId: number | null;
  vcsNodeId: string | null;
  agentmailInboxId: string | null;
  agentmailMessageId: string | null;
  agentmailThreadId: string | null;
  mentionMessageId: string | null;
  mentionChannelId: string | null;
  dir: string | null;
  parentTaskId: string | null;
  claudeSessionId: string | null;
  model: string | null;
  modelTier: string | null;
  effort: string | null;
  resolvedEffort?: string | null;
  resolvedModel?: string | null;
  modelSource?: string | null;
  modelAlias?: string | null;
  profile?: string | null;
  resolvedProfile?: string | null;
  scheduleId: string | null;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  outputSchema: string | null;
  followUpConfig: string | null;
  contextKey: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAt: string | null;
  notifiedAt: string | null;
  failureReason: string | null;
  output: string | null;
  progress: string | null;
  compactionCount: number | null;
  peakContextPercent: number | null;
  peakContextTokens: number | null;
  contextWindowSize: number | null;
  was_paused: number;
  deferredAt: string | null;
  credentialKeySuffix: string | null;
  credentialKeyType: string | null;
  requestedByUserId: string | null;
  requestedByUserIdInherited: number;
  swarmVersion: string | null;
  provider: string | null;
  providerMeta: string | null;
  harnessVariant: string | null;
  harnessVariantMeta: string | null;
  totalCostUsd?: number | null;
  routingAffinity: string | null;
};

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
  | "provider"
  | "requestedByUserId"
  | "progress"
  | "createdAt"
  | "lastUpdatedAt"
  | "finishedAt"
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
 * SQL column lists for the list projections. `task` is cut to the UTF-8 bytes
 * that can hold one char past the preview length (a UTF-16 unit is at most 4
 * bytes), so the JS side never materializes the full prompt, output or
 * provider blobs. The cut runs on the BLOB: SQLite's text `substr` stops at
 * the first embedded NUL, which the full-text preview keeps. `taskPreview`
 * decodes the bytes and truncates them exactly as it would the full text (the
 * extra char keeps the "…" marker; a code point split at the byte cut lands
 * past it).
 */
const TASK_PREVIEW_BYTES = 4 * (TASK_PREVIEW_LENGTH + 1);
const TASK_PREVIEW_SQL = `substr(CAST(agent_tasks.task AS BLOB), 1, ${TASK_PREVIEW_BYTES}) AS task`;
// ignoreBOM keeps a leading U+FEFF, which the full-text preview keeps too.
const taskPreviewDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

function taskPreview(task: TaskPreviewSource["task"]): string {
  const text = task instanceof Uint8Array ? taskPreviewDecoder.decode(task) : task;
  return dependencies.previewText(text, TASK_PREVIEW_LENGTH);
}

const LIST_COLUMNS = {
  full: "agent_tasks.*",
  slim: `agent_tasks.id, agent_tasks."key", agent_tasks.agentId, agent_tasks.creatorAgentId,
    ${TASK_PREVIEW_SQL}, agent_tasks.title, agent_tasks.status, agent_tasks.source,
    agent_tasks.taskType, agent_tasks.tags, agent_tasks.priority, agent_tasks.dependsOn,
    agent_tasks.offeredTo, agent_tasks.acceptedAt, agent_tasks.parentTaskId,
    agent_tasks.scheduleId, agent_tasks.model, agent_tasks.modelTier,
    agent_tasks.resolvedModel, agent_tasks.modelSource, agent_tasks.modelAlias, agent_tasks.effort,
    agent_tasks.resolvedEffort,
    agent_tasks.provider, agent_tasks.requestedByUserId, agent_tasks.progress,
    agent_tasks.createdAt, agent_tasks.lastUpdatedAt, agent_tasks.finishedAt,
    agent_tasks.peakContextPercent`,
  timeline: `agent_tasks.id, agent_tasks.agentId, agent_tasks.parentTaskId, ${TASK_PREVIEW_SQL},
    agent_tasks.title, agent_tasks.status, agent_tasks.createdAt, agent_tasks.lastUpdatedAt,
    agent_tasks.finishedAt, agent_tasks.peakContextTokens`,
} as const;

type TaskListFields = keyof typeof LIST_COLUMNS;

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
    scheduleId: row.scheduleId ?? undefined,
    workflowRunId: row.workflowRunId ?? undefined,
    workflowRunStepId: row.workflowRunStepId ?? undefined,
    outputSchema: row.outputSchema ? JSON.parse(row.outputSchema) : undefined,
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
    output: row.output ?? undefined,
    progress: row.progress ?? undefined,
    wasPaused: !!row.was_paused,
    deferredAt: row.deferredAt ?? undefined,
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
    provider: (row.provider as ProviderName | null) ?? undefined,
    requestedByUserId: row.requestedByUserId ?? undefined,
    progress: row.progress ?? undefined,
    createdAt: row.createdAt,
    lastUpdatedAt: row.lastUpdatedAt,
    finishedAt: row.finishedAt ?? undefined,
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
  const row = await getDbClient().get<AgentTaskRow>("SELECT * FROM agent_tasks WHERE id = ?", [id]);
  return row ? rowToAgentTask(row) : null;
}

export async function getChildTasks(parentTaskId: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks WHERE parentTaskId = ? ORDER BY createdAt ASC, rowid ASC`,
    [parentTaskId],
  );
  return rows.map(rowToAgentTask);
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

const LINEAGE_COLUMNS = `${LIST_COLUMNS.slim}, agent_tasks.workflowRunId,
  (SELECT SUM(totalCostUsd) FROM session_costs WHERE session_costs.taskId = agent_tasks.id) AS totalCostUsd`;

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
  const db = getDbClient();
  // Hops are counted, so a parentTaskId cycle stops at the cap instead of looping.
  const path = await db.query<{ id: string; parentTaskId: string | null; hops: number }>(
    `WITH RECURSIVE up(id, parentTaskId, hops) AS (
         SELECT id, parentTaskId, 0 FROM agent_tasks WHERE id = ?
         UNION ALL
         SELECT t.id, t.parentTaskId, up.hops + 1 FROM agent_tasks t
         JOIN up ON t.id = up.parentTaskId
         WHERE up.hops < ?
       )
       SELECT id, parentTaskId, hops FROM up ORDER BY hops`,
    [taskId, maxAncestors],
  );
  if (path.length === 0) return null;
  const top = path[path.length - 1]!;
  // A parent that no longer exists ends the walk like a root; a cap does not.
  let truncated = top.hops === maxAncestors && top.parentTaskId !== null;

  // LIMIT inside the recursive CTE stops the walk itself, not just the output.
  const descendants = (startId: string) =>
    db.query<TaskLineageRow>(
      `WITH RECURSIVE down(id, depth) AS (
           SELECT ?, 0
           UNION ALL
           SELECT t.id, down.depth + 1 FROM down
           JOIN agent_tasks t ON t.parentTaskId = down.id
           WHERE down.depth < ?
           ORDER BY 2
           LIMIT ?
         )
         SELECT ${LINEAGE_COLUMNS} FROM down
         CROSS JOIN agent_tasks ON agent_tasks.id = down.id
         ORDER BY down.depth, agent_tasks.createdAt, agent_tasks.rowid`,
      [startId, maxDepth, maxNodes + 1],
    );

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
    add(
      await db.query<TaskLineageRow>(
        `SELECT ${LINEAGE_COLUMNS} FROM agent_tasks WHERE id IN (${missing.map(() => "?").join(", ")})`,
        missing,
      ),
    );
  }

  // The caps cut the walk at many points (depth, node count, either walk), so
  // ask the table directly: is any child of a returned task not returned?
  if (!truncated) {
    const ids = [...byId.keys()];
    const list = ids.map(() => "?").join(", ");
    const omitted = await db.get(
      `SELECT 1 FROM agent_tasks WHERE parentTaskId IN (${list}) AND id NOT IN (${list}) LIMIT 1`,
      [...ids, ...ids],
    );
    truncated = omitted !== undefined && omitted !== null;
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
  const row = await getDbClient().get(
    `SELECT 1 FROM agent_tasks
       WHERE parentTaskId = ?
         AND taskType = 'resume'
         AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       LIMIT 1`,
    [parentId],
  );
  return row !== undefined && row !== null;
}

/** How far back the heartbeat repairs a superseded task that never got a resume. */
export const SUPERSEDED_RESUME_REPAIR_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Superseded tasks that never got a resume child. Both supersede paths
 * (heartbeat remediation and `POST /api/tasks/:id/supersede`) supersede
 * first and create the resume in a later, separate write, so a process
 * crash between the two leaves this state. Workflow steps are failed, not
 * superseded, and are excluded. `finishedBefore` keeps the sweep from racing
 * an in-flight supersede; `finishedAfter` bounds how far back it repairs.
 */
export async function getSupersededTasksWithoutResume(
  finishedBefore: string,
  finishedAfter: string,
): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks t
       WHERE t.status = 'superseded'
         AND t.workflowRunStepId IS NULL
         AND t.finishedAt < ?
         AND t.finishedAt > ?
         AND NOT EXISTS (
           SELECT 1 FROM agent_tasks c WHERE c.parentTaskId = t.id AND c.taskType = 'resume'
         )
       ORDER BY t.finishedAt ASC`,
    [finishedBefore, finishedAfter],
  );
  return rows.map(rowToAgentTask);
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
  const placeholders = NEVER_STARTED_TASK_STATUSES.map(() => "?").join(", ");
  return getDbClient().query<{ taskId: string; resumeTaskId: string }>(
    `SELECT taskId, resumeTaskId FROM (
       SELECT t.id AS taskId, t.finishedAt AS finishedAt,
              (SELECT c.id FROM agent_tasks c
                 WHERE c.parentTaskId = t.id AND c.taskType = 'resume'
                 ORDER BY c.createdAt DESC LIMIT 1) AS resumeTaskId
         FROM agent_tasks t
         WHERE t.status = 'superseded'
           AND t.finishedAt < ?
           AND t.finishedAt > ?
           AND EXISTS (
             SELECT 1 FROM agent_tasks d, json_each(d.dependsOn) AS j
              WHERE j.value = t.id AND d.status IN (${placeholders})
           ))
     WHERE resumeTaskId IS NOT NULL
     ORDER BY finishedAt ASC`,
    [finishedBefore, finishedAfter, ...NEVER_STARTED_TASK_STATUSES],
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
  const row = await getDbClient().get<Record<string, number>>(
    `SELECT 1 FROM agent_tasks
       WHERE parentTaskId = ?
         AND taskType = 'reroute-decision'
         AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       LIMIT 1`,
    [parentId],
  );
  return row !== undefined && row !== null;
}

export async function getTasksByAgentId(
  agentId: string,
  readableBy?: { userId: string | null },
): Promise<AgentTask[]> {
  const readable = readableBy ? readableSessionCondition(readableBy.userId) : undefined;
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks WHERE agentId = ?${readable ? ` AND ${readable.sql}` : ""} ORDER BY createdAt DESC`,
    [agentId, ...(readable?.params ?? [])],
  );
  return rows.map(rowToAgentTask);
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
  const row = await getDbClient().get<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE agentId = ? AND status = 'in_progress' ORDER BY lastUpdatedAt DESC LIMIT 1",
    [agentId],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function getTasksByStatus(status: AgentTaskStatus): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE status = ? ORDER BY createdAt DESC",
    [status],
  );
  return rows.map(rowToAgentTask);
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
  const providerClause =
    vcsProvider === "github" ? "(vcsProvider = ? OR vcsProvider IS NULL)" : "vcsProvider = ?";
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE vcsRepo = ? AND vcsNumber = ? AND ${providerClause}
       AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       ORDER BY createdAt DESC
       LIMIT 1`,
    [vcsRepo, vcsNumber, vcsProvider],
  );
  return row ? rowToAgentTask(row) : null;
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
  const providerClause =
    vcsProvider === "github" ? "(vcsProvider = ? OR vcsProvider IS NULL)" : "vcsProvider = ?";
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE vcsRepo = ? AND vcsNumber = ? AND ${providerClause}
       AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       ORDER BY createdAt DESC`,
    [vcsRepo, vcsNumber, vcsProvider],
  );
  return rows.map(rowToAgentTask);
}

/** @deprecated Use findTaskByVcs instead */
export const findTaskByGitHub = findTaskByVcs;

export interface TaskFilters {
  /** Single status (back-compat) OR array of statuses (multi-status filter). */
  status?: AgentTaskStatus | AgentTaskStatus[];
  agentId?: string;
  search?: string;
  // New filters
  unassigned?: boolean;
  offeredTo?: string;
  readyOnly?: boolean;
  taskType?: string;
  tags?: string[];
  scheduleId?: string;
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
 * an owner other than the user and no active share names the user or
 * everyone. Descending from hidden roots is linear in their tasks at any chain
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
  const otherOwner = userId
    ? "r.requestedByUserId IS NOT NULL AND r.requestedByUserId != ?"
    : "r.requestedByUserId IS NOT NULL";
  const shareMatch = userId ? "(s.userId IS NULL OR s.userId = ?)" : "s.userId IS NULL";
  const notHidden = `${taskIdColumn} NOT IN (
      WITH RECURSIVE hidden(id) AS (
        SELECT r.id FROM agent_tasks r
        WHERE (r.parentTaskId IS NULL
            OR NOT EXISTS (SELECT 1 FROM agent_tasks p WHERE p.id = r.parentTaskId))
          AND ${otherOwner}
          AND NOT EXISTS (SELECT 1 FROM session_shares s
            WHERE s.rootTaskId = r.id AND s.revokedAt IS NULL AND ${shareMatch})
        UNION ALL
        SELECT c.id FROM agent_tasks c JOIN hidden ON c.parentTaskId = hidden.id
      )
      SELECT id FROM hidden
    )`;
  return {
    sql: opts.nullable ? `(${taskIdColumn} IS NULL OR ${notHidden})` : notHidden,
    params: userId ? [userId, userId] : [],
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
  const conditions: string[] = [];
  const params: (string | AgentTaskStatus)[] = [];

  if (filters?.status) {
    if (Array.isArray(filters.status)) {
      if (filters.status.length === 1) {
        conditions.push("status = ?");
        params.push(filters.status[0]!);
      } else if (filters.status.length > 1) {
        const placeholders = filters.status.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        for (const s of filters.status) params.push(s);
      }
    } else {
      conditions.push("status = ?");
      params.push(filters.status);
    }
  }

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }

  if (filters?.search) {
    conditions.push("(task LIKE ? OR id LIKE ?)");
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  // New filters
  if (filters?.unassigned) {
    conditions.push("(agentId IS NULL OR status = 'unassigned')");
  }

  if (filters?.offeredTo) {
    conditions.push("offeredTo = ?");
    params.push(filters.offeredTo);
  }

  if (filters?.taskType) {
    conditions.push("taskType = ?");
    params.push(filters.taskType);
  }

  if (filters?.tags && filters.tags.length > 0) {
    // Match any of the tags
    const tagConditions = filters.tags.map(() => "tags LIKE ?");
    conditions.push(`(${tagConditions.join(" OR ")})`);
    for (const tag of filters.tags) {
      params.push(`%"${tag}"%`);
    }
  }

  if (filters?.scheduleId) {
    conditions.push("scheduleId = ?");
    params.push(filters.scheduleId);
  }

  if (filters?.key) {
    conditions.push('"key" = ?');
    params.push(normalizeAssetKey(filters.key));
  } else if (filters?.keyPrefix) {
    conditions.push(`"key" LIKE ? ESCAPE '\\'`);
    params.push(dependencies.assetKeyPrefixPattern(filters.keyPrefix));
  }

  if (filters?.source && filters.source.length > 0) {
    const placeholders = filters.source.map(() => "?").join(", ");
    conditions.push(`source IN (${placeholders})`);
    for (const s of filters.source) params.push(s);
  }

  if (filters?.createdAfter) {
    conditions.push("createdAt >= ?");
    params.push(filters.createdAfter);
  }

  if (filters?.createdBefore) {
    conditions.push("createdAt < ?");
    params.push(filters.createdBefore);
  }

  if (filters?.requestedByUserIdIsNull) {
    conditions.push("requestedByUserId IS NULL");
  } else if (filters?.requestedByUserId) {
    conditions.push("requestedByUserId = ?");
    params.push(filters.requestedByUserId);
  }

  // Exclude system/heartbeat tasks by default. The flag is still called
  // `includeHeartbeat` for backward compat with existing API callers, but we
  // also gate boot-triage + heartbeat-checklist behind it since those are
  // equally noisy in the dashboard task list.
  if (!filters?.includeHeartbeat) {
    conditions.push(
      "(IFNULL(taskType, '') NOT IN ('heartbeat', 'heartbeat-checklist', 'boot-triage') AND tags NOT LIKE '%\"heartbeat\"%')",
    );
  }

  if (filters?.readableBy) {
    const readable = readableSessionCondition(filters.readableBy.userId);
    conditions.push(readable.sql);
    params.push(...readable.params);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit ?? 25;
  const offset = filters?.offset ?? 0;
  const orderColumns =
    filters?.orderBy === "createdAt"
      ? ["createdAt DESC", "rowid DESC"]
      : ["lastUpdatedAt DESC", "priority DESC"];
  const fields: TaskListFields =
    opts?.fields === "timeline" ? "timeline" : opts?.slim ? "slim" : "full";
  // Page the rowids first, then read the projected columns and the cost
  // subquery for that page only, so no candidate row's prompt/output blobs
  // are materialized unless the row is on the page. The page query keeps the
  // exact ORDER BY: a `rowid` tiebreak there makes SQLite drop the
  // lastUpdatedAt index for a full scan. The outer sort adds it only to fix
  // the order of exact ties inside the page.
  const query = `WITH page AS (
      SELECT rowid AS rid FROM agent_tasks ${whereClause}
      ORDER BY ${orderColumns.join(", ")} LIMIT ${limit} OFFSET ${offset}
    )
    SELECT ${LIST_COLUMNS[fields]},
    (SELECT SUM(totalCostUsd) FROM session_costs WHERE session_costs.taskId = agent_tasks.id) AS totalCostUsd
    FROM page JOIN agent_tasks ON agent_tasks.rowid = page.rid
    ORDER BY ${[...new Set([...orderColumns, "rowid DESC"])].map((column) => `agent_tasks.${column}`).join(", ")}`;

  if (fields === "timeline") {
    const rows = await getDbClient().query<AgentTaskTimelineRow>(query, params);
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

  if (fields === "slim") {
    const rows = await getDbClient().query<AgentTaskSummaryRow>(query, params);
    let tasks = rows.map(rowToAgentTaskSummary);
    if (filters?.readyOnly) tasks = await filterReady(tasks);
    return tasks;
  }

  const rows = await getDbClient().query<AgentTaskRow>(query, params);
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
  const conditions: string[] = [];
  const params: (string | AgentTaskStatus)[] = [];

  if (filters?.status) {
    if (Array.isArray(filters.status)) {
      if (filters.status.length === 1) {
        conditions.push("status = ?");
        params.push(filters.status[0]!);
      } else if (filters.status.length > 1) {
        const placeholders = filters.status.map(() => "?").join(", ");
        conditions.push(`status IN (${placeholders})`);
        for (const s of filters.status) params.push(s);
      }
    } else {
      conditions.push("status = ?");
      params.push(filters.status);
    }
  }

  if (filters?.agentId) {
    conditions.push("agentId = ?");
    params.push(filters.agentId);
  }

  if (filters?.search) {
    conditions.push("(task LIKE ? OR id LIKE ?)");
    params.push(`%${filters.search}%`, `%${filters.search}%`);
  }

  if (filters?.unassigned) {
    conditions.push("(agentId IS NULL OR status = 'unassigned')");
  }

  if (filters?.offeredTo) {
    conditions.push("offeredTo = ?");
    params.push(filters.offeredTo);
  }

  if (filters?.taskType) {
    conditions.push("taskType = ?");
    params.push(filters.taskType);
  }

  if (filters?.tags && filters.tags.length > 0) {
    const tagConditions = filters.tags.map(() => "tags LIKE ?");
    conditions.push(`(${tagConditions.join(" OR ")})`);
    for (const tag of filters.tags) {
      params.push(`%"${tag}"%`);
    }
  }

  if (filters?.scheduleId) {
    conditions.push("scheduleId = ?");
    params.push(filters.scheduleId);
  }

  if (filters?.key) {
    conditions.push('"key" = ?');
    params.push(normalizeAssetKey(filters.key));
  } else if (filters?.keyPrefix) {
    conditions.push(`"key" LIKE ? ESCAPE '\\'`);
    params.push(dependencies.assetKeyPrefixPattern(filters.keyPrefix));
  }

  if (filters?.source && filters.source.length > 0) {
    const placeholders = filters.source.map(() => "?").join(", ");
    conditions.push(`source IN (${placeholders})`);
    for (const s of filters.source) params.push(s);
  }

  if (filters?.createdAfter) {
    conditions.push("createdAt >= ?");
    params.push(filters.createdAfter);
  }

  if (filters?.createdBefore) {
    conditions.push("createdAt < ?");
    params.push(filters.createdBefore);
  }

  if (filters?.requestedByUserIdIsNull) {
    conditions.push("requestedByUserId IS NULL");
  } else if (filters?.requestedByUserId) {
    conditions.push("requestedByUserId = ?");
    params.push(filters.requestedByUserId);
  }

  // Exclude system/heartbeat tasks by default. The flag is still called
  // `includeHeartbeat` for backward compat with existing API callers, but we
  // also gate boot-triage + heartbeat-checklist behind it since those are
  // equally noisy in the dashboard task list.
  if (!filters?.includeHeartbeat) {
    conditions.push(
      "(IFNULL(taskType, '') NOT IN ('heartbeat', 'heartbeat-checklist', 'boot-triage') AND tags NOT LIKE '%\"heartbeat\"%')",
    );
  }

  if (filters?.readableBy) {
    const readable = readableSessionCondition(filters.readableBy.userId);
    conditions.push(readable.sql);
    params.push(...readable.params);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const query = `SELECT COUNT(*) as count FROM agent_tasks ${whereClause}`;

  const result = await getDbClient().get<{ count: number }>(query, params);

  return result?.count ?? 0;
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
  const row = await getDbClient().get<{
    total: number;
    unassigned: number;
    offered: number;
    reviewing: number;
    pending: number;
    in_progress: number;
    paused: number;
    completed: number;
    failed: number;
  }>(
    `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'unassigned' THEN 1 ELSE 0 END) as unassigned,
        SUM(CASE WHEN status = 'offered' THEN 1 ELSE 0 END) as offered,
        SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM agent_tasks`,
  );

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
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId IS NOT NULL
       AND status IN ('completed', 'failed')
       ORDER BY lastUpdatedAt DESC
       LIMIT 200`,
  );
  return rows.map(rowToAgentTask);
}

/**
 * Return terminal Slack-rooted tasks whose durable relay obligation is pending.
 * The obligation is inserted by a DB trigger in the same transaction as the
 * terminal status transition, so a process restart cannot lose the send.
 */
export async function getPendingSlackRelayTasks(): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT task.* FROM slack_relay_obligations obligation
       JOIN agent_tasks task ON task.id = obligation.task_id
       WHERE obligation.delivered_at IS NULL
       AND task.status IN ('completed', 'failed', 'cancelled')
       ORDER BY obligation.last_attempt_at IS NOT NULL,
                obligation.last_attempt_at ASC,
                obligation.created_at ASC
       LIMIT 200`,
  );
  return rows.map(rowToAgentTask);
}

/** Rotate attempted rows behind fresh obligations so poison rows cannot starve the queue. */
export async function markSlackRelayAttempted(taskId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await getDbClient().run(
    `UPDATE slack_relay_obligations
       SET attempt_count = attempt_count + 1,
           last_attempt_at = ?,
           updated_at = ?
       WHERE task_id = ? AND delivered_at IS NULL`,
    [now, now, taskId],
  );
  return result.changes > 0;
}

/** Mark a relay obligation delivered only after Slack accepted the final result. */
export async function markSlackRelayDelivered(taskId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await getDbClient().run(
    `UPDATE slack_relay_obligations
       SET delivered_at = ?, updated_at = ?
       WHERE task_id = ? AND delivered_at IS NULL`,
    [now, now, taskId],
  );
  return result.changes > 0;
}

/** Discharge obligations already fulfilled by renderer v2's durable outcome record. */
export async function markFinalizedSlackRelaysDelivered(): Promise<number> {
  const now = new Date().toISOString();
  const result = await getDbClient().run(
    `UPDATE slack_relay_obligations AS obligation
       SET delivered_at = ?, updated_at = ?
       WHERE obligation.delivered_at IS NULL
       AND EXISTS (
         SELECT 1 FROM slack_messages message
         WHERE message.kind = 'outcome'
         AND message.task_id = obligation.task_id
         AND message.finalized_at IS NOT NULL
       )`,
    [now, now],
  );
  return result.changes;
}

/** Pending Chat SDK relay row: the terminal task plus its obligation bookkeeping. */
export interface PendingChatRelay {
  task: AgentTask;
  createdAt: string;
  lastError: string | null;
}

/**
 * Backoff gate for a chat relay obligation: eligible when never attempted, or
 * when `min(3 s * 2^attempt_count, 10 min)` passed since `last_attempt_at`.
 * `attempt_count >= 8` is already past the cap (3 s * 2^8 = 768 s). The one
 * parameter is the reference time as ISO text.
 */
const CHAT_RELAY_ELIGIBLE_SQL = `(obligation.last_attempt_at IS NULL
         OR (julianday(?) - julianday(obligation.last_attempt_at)) * 86400000.0 >=
            CASE WHEN obligation.attempt_count >= 8 THEN 600000
                 ELSE 3000 * (1 << obligation.attempt_count) END)`;

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
  if (adapters.length === 0) return [];
  for (const adapter of adapters) {
    if (!/^[a-z]+$/.test(adapter)) throw new Error(`invalid chat adapter name: ${adapter}`);
  }
  const adapterFilter = adapters.map(() => "task.contextKey GLOB ?").join(" OR ");
  const rows = await getDbClient().query<
    AgentTaskRow & {
      relay_created_at: string;
      relay_last_error: string | null;
    }
  >(
    `SELECT task.*,
            obligation.created_at AS relay_created_at,
            obligation.last_error AS relay_last_error
       FROM chat_relay_obligations obligation
       JOIN agent_tasks task ON task.id = obligation.task_id
       WHERE obligation.delivered_at IS NULL
       AND obligation.given_up_at IS NULL
       AND task.status IN ('completed', 'failed', 'cancelled')
       AND (${adapterFilter})
       AND ${CHAT_RELAY_ELIGIBLE_SQL}
       ORDER BY obligation.last_attempt_at IS NOT NULL,
                obligation.last_attempt_at ASC,
                obligation.created_at ASC
       LIMIT ?`,
    [
      ...adapters.map((adapter) => `task:chat-sdk:${adapter}:*`),
      new Date(now).toISOString(),
      limit,
    ],
  );
  return rows.map((row) => ({
    task: rowToAgentTask(row),
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
  const result = await getDbClient().run(
    `UPDATE chat_relay_obligations
       SET given_up_at = ?, last_error = 'gave up: older than 24h', updated_at = ?
       WHERE delivered_at IS NULL AND given_up_at IS NULL AND created_at < ?`,
    [at, at, cutoff],
  );
  return result.changes;
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
  const result = await getDbClient().run(
    `UPDATE chat_relay_obligations AS obligation
       SET attempt_count = attempt_count + 1,
           last_attempt_at = ?,
           updated_at = ?
       WHERE task_id = ?
       AND delivered_at IS NULL
       AND given_up_at IS NULL
       AND ${CHAT_RELAY_ELIGIBLE_SQL}`,
    [at, at, taskId, at],
  );
  return result.changes > 0;
}

/** Record why the last chat relay attempt failed. The text is scrubbed before it is stored. */
export async function recordChatRelayError(
  taskId: string,
  error: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await getDbClient().run(
    `UPDATE chat_relay_obligations
       SET last_error = ?, updated_at = ?
       WHERE task_id = ? AND delivered_at IS NULL`,
    [scrubSecrets(error), new Date(now).toISOString(), taskId],
  );
  return result.changes > 0;
}

/** Mark a chat relay obligation delivered after the platform accepted every chunk. Idempotent. */
export async function markChatRelayDelivered(
  taskId: string,
  now: number = Date.now(),
): Promise<boolean> {
  const at = new Date(now).toISOString();
  const result = await getDbClient().run(
    `UPDATE chat_relay_obligations
       SET delivered_at = ?, updated_at = ?
       WHERE task_id = ? AND delivered_at IS NULL`,
    [at, at, taskId],
  );
  return result.changes > 0;
}

/** Stop retrying a chat relay obligation. The reason is scrubbed before it is stored. */
export async function markChatRelayGivenUp(
  taskId: string,
  error: string,
  now: number = Date.now(),
): Promise<boolean> {
  const at = new Date(now).toISOString();
  const result = await getDbClient().run(
    `UPDATE chat_relay_obligations
       SET given_up_at = ?, last_error = ?, updated_at = ?
       WHERE task_id = ? AND delivered_at IS NULL AND given_up_at IS NULL`,
    [at, scrubSecrets(error), at, taskId],
  );
  return result.changes > 0;
}

/**
 * Get tasks that were recently finished (completed/failed) by workers (non-lead agents).
 * Used by leads to know when workers complete tasks.
 */
export async function getRecentlyFinishedWorkerTasks(): Promise<AgentTask[]> {
  // Query for finished tasks that haven't been notified yet
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT t.* FROM agent_tasks t
       LEFT JOIN agents a ON t.agentId = a.id
       WHERE t.status IN ('completed', 'failed')
       AND t.finishedAt IS NOT NULL
       AND t.notifiedAt IS NULL
       AND (a.isLead = 0 OR a.isLead IS NULL)
       ORDER BY t.finishedAt DESC LIMIT 50`,
  );
  return rows.map(rowToAgentTask);
}

/**
 * Atomically mark finished tasks as notified.
 * Sets notifiedAt timestamp to prevent returning them in future polls.
 */
export async function markTasksNotified(taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;

  const now = new Date().toISOString();
  const placeholders = taskIds.map(() => "?").join(",");

  const result = await getDbClient().run(
    `UPDATE agent_tasks SET notifiedAt = ?
     WHERE id IN (${placeholders}) AND notifiedAt IS NULL`,
    [now, ...taskIds],
  );

  return result.changes;
}

/**
 * Reset notifiedAt for tasks, allowing them to be re-delivered on next poll.
 * Used when a trigger was consumed but the session that should process it failed.
 * This prevents permanent notification loss from the mark-before-process race.
 */
export async function resetTasksNotified(taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;

  const placeholders = taskIds.map(() => "?").join(",");

  const result = await getDbClient().run(
    `UPDATE agent_tasks SET notifiedAt = NULL
     WHERE id IN (${placeholders}) AND notifiedAt IS NOT NULL`,
    taskIds,
  );

  return result.changes;
}

export async function getInProgressSlackTasks(): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId IS NOT NULL
       AND status = 'in_progress'
       ORDER BY lastUpdatedAt DESC
       LIMIT 200`,
  );
  return rows.map(rowToAgentTask);
}

export async function getSlackTasksMissingTree(): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT task.* FROM agent_tasks task
       JOIN slack_render_v2_state state ON state.id = 1
       WHERE task.source = 'slack'
       AND task.slackChannelId IS NOT NULL
       AND task.slackThreadTs IS NOT NULL
       AND task.createdAt >= state.activated_at
       AND task.status NOT IN ('backlog', 'unassigned', 'superseded')
       AND NOT EXISTS (
         SELECT 1 FROM agent_tasks earlier
         WHERE earlier.source = 'slack'
         AND earlier.slackChannelId = task.slackChannelId
         AND earlier.slackThreadTs = task.slackThreadTs
         AND earlier.createdAt < state.activated_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM slack_messages tree
         WHERE tree.kind = 'tree'
         AND tree.channel_id = task.slackChannelId
         AND tree.thread_ts = task.slackThreadTs
       )
       ORDER BY task.lastUpdatedAt DESC
       LIMIT 200`,
  );
  return rows.map(rowToAgentTask);
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
  const placeholders = statuses.map(() => "?").join(",");
  const rows = await getDbClient().query<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND status IN (${placeholders})
       ORDER BY lastUpdatedAt DESC
       LIMIT 200`,
    [contextKey, ...statuses],
  );
  return rows.map(rowToAgentTask);
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

  const lineageCte = `WITH RECURSIVE
    ancestors(id, parentTaskId) AS (
      SELECT id, parentTaskId FROM agent_tasks WHERE id = ? AND contextKey = ?
      UNION
      SELECT parent.id, parent.parentTaskId FROM agent_tasks parent
      JOIN ancestors child ON parent.id = child.parentTaskId
      WHERE parent.contextKey = ?
    ),
    lineage(id) AS (
      SELECT id FROM ancestors
      WHERE parentTaskId IS NULL OR parentTaskId NOT IN (SELECT id FROM ancestors)
      UNION
      SELECT child.id FROM agent_tasks child
      JOIN lineage parent ON child.parentTaskId = parent.id
    )`;
  const lineageParams = [delegatingParentTaskId ?? null, contextKey, contextKey];

  const activeRow = await getDbClient().get<AgentTaskRow>(
    `${lineageCte}
     SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND id NOT IN (SELECT id FROM lineage)
       AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    [...lineageParams, contextKey],
  );
  if (activeRow) {
    return { task: rowToAgentTask(activeRow), reason: "active_task" };
  }

  const linkedPrRow = await getDbClient().get<AgentTaskRow>(
    `${lineageCte}
     SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND id NOT IN (SELECT id FROM lineage)
       AND status = 'completed'
       AND vcsProvider IS NOT NULL
       AND vcsRepo IS NOT NULL
       AND vcsNumber IS NOT NULL
       AND vcsUrl IS NOT NULL
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    [...lineageParams, contextKey],
  );
  if (linkedPrRow) {
    return { task: rowToAgentTask(linkedPrRow), reason: "linked_open_pr" };
  }

  return null;
}

export async function getLatestTaskByContextKey(contextKey: string): Promise<AgentTask | null> {
  if (!contextKey) return null;
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    [contextKey],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function getLatestScriptRunStepTaskByContextKey(
  contextKey: string,
): Promise<AgentTask | null> {
  if (!contextKey) return null;
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND taskType = 'script-run-step'
       ORDER BY createdAt DESC, rowid DESC
       LIMIT 1`,
    [contextKey],
  );
  return row ? rowToAgentTask(row) : null;
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
  const taskRow = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId = ?
       AND slackThreadTs = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    [channelId, threadTs],
  );

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
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE source = 'slack'
       AND slackChannelId = ?
       AND slackThreadTs = ?
       AND status IN ('in_progress', 'pending')
       ORDER BY createdAt DESC, rowid DESC
       LIMIT 1`,
    [channelId, threadTs],
  );

  return row ? rowToAgentTask(row) : null;
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
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT t.*
       FROM agent_tasks t
       JOIN agents a ON a.id = t.agentId
       WHERE t.source = 'slack'
         AND t.slackChannelId = ?
         AND t.slackThreadTs = ?
         AND a.isLead = 1
       ORDER BY t.createdAt DESC, t.rowid DESC
       LIMIT 1`,
    [channelId, threadTs],
  );

  return row ? rowToAgentTask(row) : null;
}

/**
 * `source` filter of the contextKey lookups below. `'chat'` also matches a
 * defer-task wake-up of a chat task: it keeps the chat contextKey with
 * `source = 'schedule'` (src/scheduler/schedule-task.ts) and continues the
 * same ask, so `/cancel`, steering and routing treat it as the chat task.
 * Binds `source` three times.
 */
function contextKeySourceSql(alias = ""): string {
  return `(? IS NULL OR ${alias}source = ?
          OR (? = 'chat' AND ${alias}source = 'schedule' AND ${alias}taskType = 'deferred'))`;
}

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
  const taskRow = await getDbClient().get<AgentTaskRow>(
    `SELECT agentId FROM agent_tasks
       WHERE contextKey = ?
       AND ${contextKeySourceSql()}
       AND (? IS NULL
            OR status NOT IN (${TERMINAL_TASK_STATUSES.map(() => "?").join(", ")})
            OR finishedAt >= ?)
       ORDER BY createdAt DESC, rowid DESC
       LIMIT 1`,
    [
      contextKey,
      source ?? null,
      source ?? null,
      source ?? null,
      endedSince ?? null,
      ...TERMINAL_TASK_STATUSES,
      endedSince ?? null,
    ],
  );

  if (taskRow?.agentId) return getAgentById(taskRow.agentId);

  return null;
}

/** Latest `in_progress` or `pending` task on a contextKey (dependency chaining). */
export async function getLatestActiveTaskByContextKey(
  contextKey: string,
  source?: string,
): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND ${contextKeySourceSql()}
       AND status IN ('in_progress', 'pending')
       ORDER BY createdAt DESC, rowid DESC
       LIMIT 1`,
    [contextKey, source ?? null, source ?? null, source ?? null],
  );

  return row ? rowToAgentTask(row) : null;
}

/** Latest task assigned to a lead agent on a contextKey (the steering target). */
export async function getLatestLeadTaskByContextKey(
  contextKey: string,
  source?: string,
): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT t.*
       FROM agent_tasks t
       JOIN agents a ON a.id = t.agentId
       WHERE t.contextKey = ?
         AND ${contextKeySourceSql("t.")}
         AND a.isLead = 1
       ORDER BY t.createdAt DESC, t.rowid DESC
       LIMIT 1`,
    [contextKey, source ?? null, source ?? null, source ?? null],
  );

  return row ? rowToAgentTask(row) : null;
}

/**
 * Find the most recent task in a Slack thread, regardless of source or status.
 * Unlike getAgentWorkingOnThread (which filters source='slack'), this finds ALL tasks
 * including worker tasks that inherited Slack metadata via parentTaskId.
 */
export async function getMostRecentTaskInThread(
  channelId: string,
  threadTs: string,
): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId = ?
       AND slackThreadTs = ?
       ORDER BY createdAt DESC
       LIMIT 1`,
    [channelId, threadTs],
  );
  return row ? rowToAgentTask(row) : null;
}

export async function findCompletedTaskInThread(
  channelId: string,
  threadTs: string,
  windowMinutes: number,
): Promise<AgentTask | null> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId = ?
       AND slackThreadTs = ?
       AND status = 'completed'
       AND lastUpdatedAt > ?
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    [channelId, threadTs, since],
  );
  return row ? rowToAgentTask(row) : null;
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
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE slackChannelId = ?
       AND slackThreadTs = ?
       AND lastUpdatedAt > ?
       AND (
         status = 'cancelled'
         OR (
           status = 'failed'
           AND failureReason IS NOT NULL
           AND (
             failureReason LIKE 'cancelled%'
             OR failureReason LIKE 'exit 130%'
             OR failureReason LIKE '%cancelled%'
           )
         )
       )
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    [channelId, threadTs, since],
  );
  return row ? rowToAgentTask(row) : null;
}
