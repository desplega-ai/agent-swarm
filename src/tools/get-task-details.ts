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
import { AgentTaskStatusSchema } from "@/types";
import { getUserCommsPrefs } from "@/utils/requester-comms";

export const getTaskDetailsInputSchema = z.object({
  taskId: z.uuid().describe("The ID of the task to get details for."),
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
  logs: z.array(looseAgentLogSchema).optional(),
  attachments: z
    .array(looseTaskAttachmentSchema)
    .optional()
    .describe(
      "Pointer-based artifacts attached to this task via store-progress, ordered by created_at.",
    ),
});

type GetTaskDetailsArgs = z.infer<typeof getTaskDetailsInputSchema>;

export async function getTaskDetailsHandler(
  ctx: ToolCtx,
  { taskId }: GetTaskDetailsArgs,
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
  const requestedBy = requestedByUser
    ? {
        name: requestedByUser.name,
        email: requestedByUser.email,
        role: requestedByUser.role,
        notes: requestedByUser.notes,
        comms: getUserCommsPrefs(requestedByUser),
      }
    : undefined;

  const data = {
    yourAgentId: agentId,
    task,
    requestedBy,
    logs,
    attachments,
  };

  return toolOk(`Task "${taskId}" (${task.status}) details retrieved.`, {
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
        "Returns detailed information about a specific task, including output, failure reason, and log history.",
      annotations: { readOnlyHint: true },
      inputSchema: getTaskDetailsInputSchema,
      outputSchema: getTaskDetailsOutputSchema,
    },
    async (args, info, _meta) => getTaskDetailsHandler(ownerCtx(info), args),
  );
};
