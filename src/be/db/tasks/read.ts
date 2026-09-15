import { normalizeAssetKey } from "../../../assets/key";
import type {
  Agent,
  AgentTask,
  AgentTaskSource,
  AgentTaskStatus,
  AgentTaskSummary,
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
} from "../../../types";
import { parseProviderMeta } from "../../../utils/provider-metadata";
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
    vcsProvider: (row.vcsProvider as "github" | "gitlab" | null) ?? undefined,
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
    effort: ReasoningEffortSchema.safeParse(row.effort).success
      ? (row.effort as ReasoningEffort)
      : undefined,
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
export function rowToAgentTaskSummary(row: AgentTaskRow): AgentTaskSummary {
  const t = rowToAgentTask(row);
  return {
    id: t.id,
    key: t.key,
    agentId: t.agentId,
    creatorAgentId: t.creatorAgentId,
    task: dependencies.previewText(t.task, TASK_PREVIEW_LENGTH),
    title: t.title,
    status: t.status,
    source: t.source,
    taskType: t.taskType,
    tags: t.tags,
    priority: t.priority,
    dependsOn: t.dependsOn,
    offeredTo: t.offeredTo,
    acceptedAt: t.acceptedAt,
    parentTaskId: t.parentTaskId,
    scheduleId: t.scheduleId,
    model: t.model,
    modelTier: t.modelTier,
    effort: t.effort,
    provider: t.provider,
    requestedByUserId: t.requestedByUserId,
    progress: t.progress,
    createdAt: t.createdAt,
    lastUpdatedAt: t.lastUpdatedAt,
    finishedAt: t.finishedAt,
    peakContextPercent: t.peakContextPercent,
    totalCostUsd: t.totalCostUsd,
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

export async function getTasksByAgentId(agentId: string): Promise<AgentTask[]> {
  const rows = await getDbClient().query<AgentTaskRow>(
    "SELECT * FROM agent_tasks WHERE agentId = ? ORDER BY createdAt DESC",
    [agentId],
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
export async function findTaskByVcs(vcsRepo: string, vcsNumber: number): Promise<AgentTask | null> {
  const row = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE vcsRepo = ? AND vcsNumber = ?
       AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       ORDER BY createdAt DESC
       LIMIT 1`,
    [vcsRepo, vcsNumber],
  );
  return row ? rowToAgentTask(row) : null;
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
}

export function getAllTasks(filters?: TaskFilters): Promise<AgentTask[]>;
export function getAllTasks(
  filters: TaskFilters | undefined,
  opts: { slim: true },
): Promise<AgentTaskSummary[]>;
export async function getAllTasks(
  filters?: TaskFilters,
  opts?: { slim?: boolean },
): Promise<AgentTask[] | AgentTaskSummary[]> {
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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit ?? 25;
  const offset = filters?.offset ?? 0;
  const orderBy =
    filters?.orderBy === "createdAt"
      ? "createdAt DESC, rowid DESC"
      : "lastUpdatedAt DESC, priority DESC";
  const query = `SELECT agent_tasks.*,
    (SELECT SUM(totalCostUsd) FROM session_costs WHERE session_costs.taskId = agent_tasks.id) AS totalCostUsd
    FROM agent_tasks ${whereClause}
    ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`;

  const rows = await getDbClient().query<AgentTaskRow>(query, params);

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
    let tasks = rows.map(rowToAgentTaskSummary);
    if (filters?.readyOnly) tasks = await filterReady(tasks);
    return tasks;
  }

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

function isLinearTrackerContextKey(contextKey: string | null | undefined): contextKey is string {
  return !!contextKey && contextKey.startsWith(LINEAR_TRACKER_CONTEXT_KEY_PREFIX);
}

/**
 * Return existing work for a Linear tracker key before creating another task.
 *
 * Active means any non-terminal task. A completed task with persisted VCS PR/MR
 * metadata is also treated as existing work because the task can be complete
 * while the PR is still awaiting review/merge.
 */
export async function findExistingLinearTrackerContextWork(
  contextKey: string | null | undefined,
): Promise<ExistingTrackerContextWork | null> {
  if (!isLinearTrackerContextKey(contextKey)) return null;

  const activeRow = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND status NOT IN ('completed', 'failed', 'cancelled', 'superseded')
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    [contextKey],
  );
  if (activeRow) {
    return { task: rowToAgentTask(activeRow), reason: "active_task" };
  }

  const linkedPrRow = await getDbClient().get<AgentTaskRow>(
    `SELECT * FROM agent_tasks
       WHERE contextKey = ?
       AND status = 'completed'
       AND vcsProvider IS NOT NULL
       AND vcsRepo IS NOT NULL
       AND vcsNumber IS NOT NULL
       AND vcsUrl IS NOT NULL
       ORDER BY lastUpdatedAt DESC
       LIMIT 1`,
    [contextKey],
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
