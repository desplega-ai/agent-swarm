import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  getLogsByTaskIdChronological,
  getTaskAttachments,
  getTaskById,
  getUserById,
} from "@/be/db";
import { assertOwnsTask, ownerCtx, type ToolCtx } from "@/tools/task-tool-ctx";
import {
  createToolRegistrar,
  type SwarmToolResult,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "@/tools/utils";
import { type AgentLog, type AgentTask, AgentTaskStatusSchema, type TaskAttachment } from "@/types";
import { getUserCommsPrefs } from "@/utils/requester-comms";

/** Extras a caller can add on top of the compact default response. */
export const GET_TASK_DETAILS_INCLUDE = ["logs", "fullText", "requester"] as const;
type GetTaskDetailsInclude = (typeof GET_TASK_DETAILS_INCLUDE)[number];

export const getTaskDetailsInputSchema = z.object({
  taskId: z.uuid().describe("The ID of the task to get details for."),
  include: z
    .array(z.enum(GET_TASK_DETAILS_INCLUDE))
    .optional()
    .describe(
      'Optional extras beyond the compact default. "logs": every log entry with all its fields (default: lifecycle events plus the last 5 progress lines, values cut to 300 chars). "fullText": task, output, failureReason and progress uncut (default cuts long ones). "requester": the requester\'s notes and communication preferences.',
    ),
});

// Loosened, output-only mirror of FollowUpConfigSchema / RoutingAffinitySchema
// (both plain z.object) and AgentTaskSchema / AgentLogSchema / TaskAttachmentSchema
// (which pin id/timestamp fields to z.uuid()/z.iso.datetime()). Output schemas
// must be all-optional z.looseObject with plain z.string() for those fields —
// a UUID/datetime constraint here fails MCP output validation after the write
// already applied (the -32602-after-write trap for slug-ID agents). The
// strict schemas in src/types.ts stay untouched: they're shared with runtime
// parsing (AgentTaskSchema.parse) elsewhere and covered by their own tests.
const looseFollowUpConfigSchema = z.looseObject({
  disabled: z.boolean().optional(),
  onCompleted: z.string().optional(),
  onFailed: z.string().optional(),
});

const looseRoutingAffinitySchema = z.looseObject({
  sourceAgentId: z.string().optional(),
  role: z.string().optional(),
  harnessProvider: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  leadOnly: z.boolean().optional(),
});

export const looseAgentTaskOutputSchema = z.looseObject({
  id: z.string().optional(),
  key: z.string().optional(),
  agentId: z.string().nullable().optional(),
  creatorAgentId: z.string().optional(),
  task: z.string().optional(),
  title: z.string().optional(),
  status: AgentTaskStatusSchema.optional(),
  source: z.string().optional(),
  taskType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  priority: z.number().optional(),
  dependsOn: z.array(z.string()).optional(),
  offeredTo: z.string().optional(),
  offeredAt: z.string().optional(),
  acceptedAt: z.string().optional(),
  rejectionReason: z.string().optional(),
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  notifiedAt: z.string().optional(),
  failureReason: z.string().optional(),
  output: z.string().optional(),
  progress: z.string().optional(),
  slackChannelId: z.string().optional(),
  slackThreadTs: z.string().optional(),
  slackUserId: z.string().optional(),
  slackReplySent: z.boolean().optional(),
  slackProgressMessageTs: z.string().optional(),
  slackTreeRootMessageTs: z.string().optional(),
  vcsProvider: z.string().optional(),
  vcsRepo: z.string().optional(),
  vcsEventType: z.string().optional(),
  vcsNumber: z.number().optional(),
  vcsCommentId: z.number().optional(),
  vcsAuthor: z.string().optional(),
  vcsUrl: z.string().optional(),
  vcsInstallationId: z.number().optional(),
  vcsNodeId: z.string().optional(),
  agentmailInboxId: z.string().optional(),
  agentmailMessageId: z.string().optional(),
  agentmailThreadId: z.string().optional(),
  mentionMessageId: z.string().optional(),
  mentionChannelId: z.string().optional(),
  dir: z.string().optional(),
  parentTaskId: z.string().optional(),
  claudeSessionId: z.string().optional(),
  model: z.string().optional(),
  modelTier: z.string().optional(),
  effort: z.string().optional(),
  scheduleId: z.string().optional(),
  workflowRunId: z.string().nullable().optional(),
  workflowRunStepId: z.string().nullable().optional(),
  contextKey: z.string().optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  followUpConfig: looseFollowUpConfigSchema.optional(),
  wasPaused: z.boolean().optional(),
  compactionCount: z.number().optional(),
  peakContextPercent: z.number().optional(),
  peakContextTokens: z.number().optional(),
  contextWindowSize: z.number().optional(),
  credentialKeySuffix: z.string().optional(),
  credentialKeyType: z.string().optional(),
  requestedByUserId: z.string().optional(),
  swarmVersion: z.string().optional(),
  provider: z.string().optional(),
  providerMeta: z.record(z.string(), z.unknown()).optional(),
  harnessVariant: z.string().optional(),
  harnessVariantMeta: z.record(z.string(), z.unknown()).optional(),
  totalCostUsd: z.number().optional(),
  routingAffinity: looseRoutingAffinitySchema.optional(),
});

const looseAgentLogSchema = z.looseObject({
  id: z.string().optional(),
  eventType: z.string().optional(),
  agentId: z.string().optional(),
  taskId: z.string().optional(),
  oldValue: z.string().optional(),
  newValue: z.string().optional(),
  metadata: z.string().optional(),
  createdAt: z.string().optional(),
});

const looseTaskAttachmentSchema = z.looseObject({
  id: z.string().optional(),
  taskId: z.string().optional(),
  agentId: z.string().nullable().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  pageId: z.string().optional(),
  providerId: z.string().optional(),
  providerKey: z.string().optional(),
  capabilities: z.record(z.string(), z.unknown()).optional(),
  orgId: z.string().optional(),
  driveId: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().optional(),
  sha256: z.string().optional(),
  intent: z.string().optional(),
  description: z.string().optional(),
  isPrimary: z.boolean().optional(),
  createdAt: z.string().optional(),
  createdBy: z.string().optional(),
  updatedBy: z.string().optional(),
});

export const getTaskDetailsOutputSchema = swarmToolOutputSchema({
  // Plain string, NOT .uuid(): agents may join with custom IDs (AGENT_ID env /
  // join-swarm agentId), and a UUID constraint here makes the response fail MCP
  // output validation after the handler already ran.
  yourAgentId: z.string().optional(),
  task: looseAgentTaskOutputSchema.optional(),
  requestedBy: z
    .looseObject({
      name: z.string().optional(),
      email: z.string().optional(),
      role: z.string().optional(),
      notes: z.string().optional(),
      comms: z
        .looseObject({
          tone: z.string().optional(),
          language: z.string().optional(),
          verbosity: z.string().optional(),
        })
        .optional(),
    })
    .optional()
    .describe(
      "Resolved user who requested this task, with role/notes and structured communication preferences (users.metadata.comms) when set",
    ),
  logs: z
    .array(looseAgentLogSchema)
    .optional()
    .describe(
      'Log history. Compact by default (lifecycle events plus the last progress lines); include "logs" for every entry.',
    ),
  slimmed: z
    .looseObject({
      cutText: z.record(z.string(), z.number()).optional(),
      omittedLogs: z.number().optional(),
      requesterOmitted: z.boolean().optional(),
      include: z.string().optional(),
    })
    .optional()
    .describe(
      "What the compact default left out: original char counts of cut text fields, the number of log entries not shown, and the include values that return them.",
    ),
  attachments: z
    .array(looseTaskAttachmentSchema)
    .optional()
    .describe(
      "Pointer-based artifacts attached to this task via store-progress, ordered by created_at.",
    ),
});

type GetTaskDetailsArgs = z.infer<typeof getTaskDetailsInputSchema>;

// Compact default. Most get-task-details calls come from a model checking a task's state, and
// the full row plus every log entry and the requester profile passes the 10 KB wire limit on
// most real tasks, which spills the whole response to KV and costs the caller a second call.
// The default keeps every field agents act on (status, output, failureReason, attachments,
// parentTaskId), cuts long text, and trims the log history; `include` returns the rest.
const TEXT_LIMITS = { task: 3000, output: 3000, failureReason: 1500, progress: 600 } as const;
const LOG_VALUE_LIMIT = 300;
const RECENT_PROGRESS_LOGS = 5;
const MAX_COMPACT_LOGS = 15;

function cutText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}… [cut at ${limit} of ${value.length} chars; include "fullText" for all]`;
}

/** Drop null, undefined, empty-string, empty-array and empty-object values. */
function withoutEmpty<T extends object>(record: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) {
      continue;
    }
    out[key] = value;
  }
  return out as Partial<T>;
}

function compactLogs(logs: AgentLog[]): AgentLog[] {
  const lastProgress = new Set(
    logs.filter((log) => log.eventType === "task_progress").slice(-RECENT_PROGRESS_LOGS),
  );
  let kept = logs.filter((log) => log.eventType !== "task_progress" || lastProgress.has(log));
  if (kept.length > MAX_COMPACT_LOGS) {
    const [first, ...rest] = kept;
    kept = first ? [first, ...rest.slice(-(MAX_COMPACT_LOGS - 1))] : [];
  }
  return kept.map(
    (log) =>
      withoutEmpty({
        eventType: log.eventType,
        oldValue: log.oldValue ? cutText(log.oldValue, LOG_VALUE_LIMIT) : undefined,
        newValue: log.newValue ? cutText(log.newValue, LOG_VALUE_LIMIT) : undefined,
        createdAt: log.createdAt,
      }) as AgentLog,
  );
}

export async function getTaskDetailsHandler(
  ctx: ToolCtx,
  { taskId, include }: GetTaskDetailsArgs,
): Promise<SwarmToolResult> {
  const task = await getTaskById(taskId);
  const agentId = ctx.kind === "owner" ? ctx.agentId : undefined;

  if (!task) {
    return toolErr(`Task with ID "${taskId}" not found.`, { data: { yourAgentId: agentId } });
  }

  const ownershipError = assertOwnsTask(ctx, task, "task.read.own");
  if (ownershipError) return ownershipError;

  const logs = await getLogsByTaskIdChronological(taskId);
  const attachments = await getTaskAttachments(taskId);

  // Resolve requesting user details if available
  const requestedByUser = task.requestedByUserId
    ? await getUserById(task.requestedByUserId)
    : undefined;
  const requesterProfile = requestedByUser
    ? {
        name: requestedByUser.name,
        email: requestedByUser.email,
        role: requestedByUser.role,
        notes: requestedByUser.notes,
        comms: getUserCommsPrefs(requestedByUser),
      }
    : undefined;

  // Script and extension calls never reach a model context and get their own response guard,
  // so they keep the complete shape.
  const origin = ctx.kind === "owner" ? ctx.requestInfo?.callOrigin : undefined;
  const full = origin === "script-sdk" || origin === "extension";
  const wants = (value: GetTaskDetailsInclude) => full || (include?.includes(value) ?? false);

  const cut: Record<string, number> = {};
  let shownTask: Partial<AgentTask> = task;
  if (!full) {
    shownTask = withoutEmpty(task);
    if (!wants("fullText")) {
      for (const [field, limit] of Object.entries(TEXT_LIMITS) as Array<
        [keyof typeof TEXT_LIMITS, number]
      >) {
        const value = shownTask[field];
        if (typeof value === "string" && value.length > limit) {
          cut[field] = value.length;
          shownTask = { ...shownTask, [field]: cutText(value, limit) };
        }
      }
    }
  }

  const shownLogs = wants("logs") ? logs : compactLogs(logs);
  const requesterOmitted =
    !wants("requester") && Boolean(requesterProfile?.notes || requesterProfile?.comms);
  const requestedBy =
    requesterProfile && requesterOmitted
      ? { name: requesterProfile.name, email: requesterProfile.email, role: requesterProfile.role }
      : requesterProfile;

  const omittedLogs = logs.length - shownLogs.length;
  const wanted = [
    Object.keys(cut).length > 0 ? "fullText" : undefined,
    logs.length > 0 && !wants("logs") ? "logs" : undefined,
    requesterOmitted ? "requester" : undefined,
  ].filter((value): value is GetTaskDetailsInclude => Boolean(value));
  const slimmed =
    !full && wanted.length > 0
      ? withoutEmpty({
          cutText: cut,
          omittedLogs: omittedLogs > 0 ? omittedLogs : undefined,
          requesterOmitted: requesterOmitted || undefined,
          include: JSON.stringify(wanted),
        })
      : undefined;

  const data = {
    yourAgentId: agentId,
    task: shownTask,
    requestedBy,
    logs: shownLogs,
    attachments: full
      ? attachments
      : attachments.map((attachment) => withoutEmpty(attachment) as TaskAttachment),
    ...(slimmed ? { slimmed } : {}),
  };

  const message = slimmed
    ? `Task "${taskId}" (${task.status}) details retrieved. Compact view; include ${slimmed.include} for the rest.`
    : `Task "${taskId}" (${task.status}) details retrieved.`;
  return toolOk(message, {
    details: JSON.stringify(data),
    data,
  });
}

export const registerGetTaskDetailsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-task-details",
    {
      title: "Get task details",
      description:
        'Returns detailed information about a specific task, including output, failure reason, and log history. The default view is compact: long text is cut, the log history is trimmed, and the requester profile is reduced to name, email and role. Pass include ["fullText", "logs", "requester"] for the rest.',
      annotations: { readOnlyHint: true },
      inputSchema: getTaskDetailsInputSchema,
      outputSchema: getTaskDetailsOutputSchema,
    },
    async (args, info, _meta) => getTaskDetailsHandler(ownerCtx(info), args),
  );
};
