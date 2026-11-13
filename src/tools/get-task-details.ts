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

/** Parts of the response the compact default leaves out; `include` brings them back. */
export const GET_TASK_DETAILS_INCLUDE = ["logs", "fullText", "requester"] as const;
type GetTaskDetailsInclude = (typeof GET_TASK_DETAILS_INCLUDE)[number];

export const getTaskDetailsInputSchema = z.object({
  taskId: z.uuid().describe("The ID of the task to get details for."),
  include: z
    .array(z.enum(GET_TASK_DETAILS_INCLUDE))
    .optional()
    .describe(
      'Optional extras on top of the compact default. "logs": every log entry with all fields (default: lifecycle events plus the last 3 progress lines, values cut to 240 chars). "fullText": task, output, failureReason, progress and follow-up instructions uncut. "requester": the requester\'s notes and communication preferences (default: name, email and role).',
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
  omitted: z
    .looseObject({
      textChars: z.record(z.string(), z.number()).optional(),
      logs: z.number().optional(),
      requesterProfile: z.boolean().optional(),
      include: z.array(z.string()).optional(),
    })
    .optional()
    .describe(
      "What the compact default left out: original lengths of cut text fields, the count of log entries not shown, whether the requester profile was reduced, and the include values that return them.",
    ),
  attachments: z
    .array(looseTaskAttachmentSchema)
    .optional()
    .describe(
      "Pointer-based artifacts attached to this task via store-progress, ordered by created_at.",
    ),
});

type GetTaskDetailsArgs = z.infer<typeof getTaskDetailsInputSchema>;

// Compact default. On real tasks the full row, every progress log line and the requester's
// profile pass the 10 KB MCP wire limit on most calls, so the response spills to KV and the
// caller needs a second call to read a task's state. The facts agents act on (status, output,
// failureReason, attachments, parentTaskId) stay inline; bulky text is bounded and `include`
// returns the rest. The requester profile already reaches the worker through its task prompt.
const TEXT_LIMITS = { task: 2000, output: 4000, failureReason: 1500, progress: 500 } as const;
// Follow-up instructions are written for the lead's next turn, not for the reader of this task.
const FOLLOW_UP_TEXT_LIMIT = 400;
const LOG_VALUE_LIMIT = 240;
const RECENT_PROGRESS_LOGS = 3;
const MAX_COMPACT_LOGS = 12;

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

/** An attachment without fields that repeat the task id or another field of the same row. */
function compactAttachment(attachment: TaskAttachment): Partial<TaskAttachment> {
  const { taskId: _taskId, ...rest } = attachment;
  const shown: Partial<TaskAttachment> = withoutEmpty(rest);
  if (shown.providerId === shown.kind) delete shown.providerId;
  if (shown.providerKey && (shown.providerKey === shown.path || shown.providerKey === shown.url)) {
    delete shown.providerKey;
  }
  return shown;
}

/** Lifecycle events plus the latest progress lines, without ids already implied by the task. */
function compactLogs(logs: AgentLog[]): Partial<AgentLog>[] {
  const recentProgress = new Set(
    logs.filter((log) => log.eventType === "task_progress").slice(-RECENT_PROGRESS_LOGS),
  );
  let kept = logs.filter((log) => log.eventType !== "task_progress" || recentProgress.has(log));
  if (kept.length > MAX_COMPACT_LOGS) {
    const [first, ...rest] = kept;
    kept = first ? [first, ...rest.slice(-(MAX_COMPACT_LOGS - 1))] : [];
  }
  return kept.map((log) =>
    withoutEmpty({
      eventType: log.eventType,
      oldValue: log.oldValue ? cutText(log.oldValue, LOG_VALUE_LIMIT) : undefined,
      newValue: log.newValue ? cutText(log.newValue, LOG_VALUE_LIMIT) : undefined,
      createdAt: log.createdAt,
    }),
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

  // Script SDK and extension calls never reach a model context and have their own response
  // guard, so they keep the complete shape.
  const origin = ctx.kind === "owner" ? ctx.requestInfo?.callOrigin : undefined;
  const complete = origin === "script-sdk" || origin === "extension";
  const wants = (part: GetTaskDetailsInclude) => complete || (include?.includes(part) ?? false);

  const textChars: Record<string, number> = {};
  // A fresh object either way, so the cuts below never touch the row returned by the DB layer.
  const shownTask: Partial<AgentTask> = complete ? { ...task } : withoutEmpty(task);
  if (!wants("fullText")) {
    for (const [field, limit] of Object.entries(TEXT_LIMITS) as Array<
      [keyof typeof TEXT_LIMITS, number]
    >) {
      const value = shownTask[field];
      if (typeof value === "string" && value.length > limit) {
        textChars[field] = value.length;
        shownTask[field] = cutText(value, limit);
      }
    }
    const followUp = shownTask.followUpConfig;
    if (followUp) {
      const cutFollowUp = { ...followUp };
      for (const key of ["onCompleted", "onFailed"] as const) {
        const value = followUp[key];
        if (typeof value === "string" && value.length > FOLLOW_UP_TEXT_LIMIT) {
          textChars[`followUpConfig.${key}`] = value.length;
          cutFollowUp[key] = cutText(value, FOLLOW_UP_TEXT_LIMIT);
        }
      }
      shownTask.followUpConfig = cutFollowUp;
    }
  }

  const shownLogs = wants("logs") ? logs : compactLogs(logs);
  const profileReduced =
    !wants("requester") && Boolean(requesterProfile?.notes || requesterProfile?.comms);
  const requestedBy =
    requesterProfile && profileReduced
      ? { name: requesterProfile.name, email: requesterProfile.email, role: requesterProfile.role }
      : requesterProfile;

  const omittedLogs = logs.length - shownLogs.length;
  const logsTrimmed = !wants("logs") && logs.length > 0;
  const missing: GetTaskDetailsInclude[] = [];
  if (Object.keys(textChars).length > 0) missing.push("fullText");
  if (logsTrimmed) missing.push("logs");
  if (profileReduced) missing.push("requester");
  const omitted =
    missing.length > 0
      ? withoutEmpty({
          textChars,
          logs: omittedLogs > 0 ? omittedLogs : undefined,
          requesterProfile: profileReduced || undefined,
          include: missing,
        })
      : undefined;

  const data = {
    yourAgentId: agentId,
    task: shownTask,
    requestedBy,
    logs: shownLogs,
    attachments: complete ? attachments : attachments.map(compactAttachment),
    ...(omitted ? { omitted } : {}),
  };

  const message = omitted
    ? `Task "${taskId}" (${task.status}) details retrieved. Compact view; include ${JSON.stringify(missing)} for the rest.`
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
        'Returns detailed information about a specific task, including output, failure reason, attachments and log history. The default view is compact: long text is cut, the log history is trimmed to lifecycle events and the latest progress, and the requester is name, email and role. Pass include ["fullText", "logs", "requester"] for the rest.',
      annotations: { readOnlyHint: true },
      inputSchema: getTaskDetailsInputSchema,
      outputSchema: getTaskDetailsOutputSchema,
    },
    async (args, info, _meta) => getTaskDetailsHandler(ownerCtx(info), args),
  );
};
