import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import {
  getLogsByTaskIdChronological,
  getTaskAttachments,
  getTaskById,
  getUserById,
} from "@/be/db";
import { assertOwnsTask, ownerCtx, type ToolCtx } from "@/tools/task-tool-ctx";
import { createToolRegistrar } from "@/tools/utils";
import { AgentLogSchema, AgentTaskSchema, TaskAttachmentSchema } from "@/types";

export const getTaskDetailsInputSchema = z.object({
  taskId: z.uuid().describe("The ID of the task to get details for."),
});

export const getTaskDetailsOutputSchema = z.object({
  yourAgentId: z.string().uuid().optional(),
  success: z.boolean(),
  message: z.string(),
  task: AgentTaskSchema.optional(),
  requestedBy: z
    .object({ name: z.string(), email: z.string().optional() })
    .optional()
    .describe("Resolved user who requested this task"),
  logs: z.array(AgentLogSchema).optional(),
  attachments: z
    .array(TaskAttachmentSchema)
    .optional()
    .describe(
      "Pointer-based artifacts attached to this task via store-progress, ordered by created_at.",
    ),
});

type GetTaskDetailsArgs = z.infer<typeof getTaskDetailsInputSchema>;

export async function getTaskDetailsHandler(
  ctx: ToolCtx,
  { taskId }: GetTaskDetailsArgs,
): Promise<CallToolResult> {
  const task = getTaskById(taskId);
  const agentId = ctx.kind === "owner" ? ctx.agentId : undefined;

  if (!task) {
    return {
      content: [{ type: "text", text: `Task with ID "${taskId}" not found.` }],
      structuredContent: {
        yourAgentId: agentId,
        success: false,
        message: `Task with ID "${taskId}" not found.`,
      },
    };
  }

  const ownershipError = assertOwnsTask(ctx, task);
  if (ownershipError) return ownershipError;

  const logs = getLogsByTaskIdChronological(taskId);
  const attachments = getTaskAttachments(taskId);

  // Resolve requesting user details if available
  const requestedByUser = task.requestedByUserId ? getUserById(task.requestedByUserId) : undefined;
  const requestedBy = requestedByUser
    ? { name: requestedByUser.name, email: requestedByUser.email }
    : undefined;

  const structuredContent = {
    yourAgentId: agentId,
    success: true,
    message: `Task "${taskId}" details retrieved.`,
    task,
    requestedBy,
    logs,
    attachments,
  };

  return {
    content: [
      { type: "text", text: `Task "${taskId}" details retrieved.` },
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
  };
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
