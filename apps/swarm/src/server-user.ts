import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import pkg from "../../../package.json";
import {
  cancelTaskHandler,
  cancelTaskInputSchema,
  cancelTaskOutputSchema,
} from "./tools/cancel-task";
import {
  getTaskDetailsHandler,
  getTaskDetailsInputSchema,
  getTaskDetailsOutputSchema,
} from "./tools/get-task-details";
import { getTasksHandler, getTasksInputSchema, getTasksOutputSchema } from "./tools/get-tasks";
import { sendTaskHandler, sendTaskOutputSchema } from "./tools/send-task";
import {
  taskActionHandler,
  taskActionInputSchema,
  taskActionOutputSchema,
} from "./tools/task-action";
import { userCtx } from "./tools/task-tool-ctx";
import { createToolRegistrar } from "./tools/utils";
import { ModelTierSchema, type User } from "./types";

const userSendTaskInputSchema = z.object({
  task: z.string().min(1).describe("The task description to send."),
  taskType: z.string().max(50).optional().describe("Task type (e.g., 'bug', 'feature', 'review')."),
  tags: z.array(z.string()).optional().describe("Tags for filtering (e.g., ['urgent'])."),
  priority: z.number().int().min(0).max(100).optional().describe("Priority 0-100 (default: 50)."),
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Concrete model override interpreted by the assignee's harness/provider."),
  modelTier: ModelTierSchema.optional().describe(
    "Portable model tier: 'smol', 'regular', 'smart', or 'ultra'. Resolved by the assignee's harness/provider.",
  ),
});

export function createUserServer(user: User): McpServer {
  const server = new McpServer(
    {
      name: `${pkg.name}-user`,
      version: pkg.version,
      description: "End-user task MCP surface for Agent Swarm.",
    },
    {
      capabilities: {
        logging: {},
      },
    },
  );

  const registerTool = createToolRegistrar(server);

  registerTool(
    "send-task",
    {
      title: "Send a task",
      annotations: { destructiveHint: false },
      description: "Creates an unassigned task requested by the authenticated user.",
      inputSchema: userSendTaskInputSchema,
      outputSchema: sendTaskOutputSchema,
    },
    async (args, info, _meta) =>
      sendTaskHandler(userCtx(user, info.sessionId), {
        offerMode: false,
        allowDuplicate: false,
        ...args,
      }),
  );

  registerTool(
    "get-tasks",
    {
      title: "Get tasks",
      description: "Returns tasks requested by the authenticated user.",
      annotations: { readOnlyHint: true },
      inputSchema: getTasksInputSchema,
      outputSchema: getTasksOutputSchema,
    },
    async (args, info, _meta) => getTasksHandler(userCtx(user, info.sessionId), args),
  );

  registerTool(
    "get-task-details",
    {
      title: "Get task details",
      description: "Returns detailed information about one of your tasks.",
      annotations: { readOnlyHint: true },
      inputSchema: getTaskDetailsInputSchema,
      outputSchema: getTaskDetailsOutputSchema,
    },
    async (args, info, _meta) => getTaskDetailsHandler(userCtx(user, info.sessionId), args),
  );

  registerTool(
    "cancel-task",
    {
      title: "Cancel Task",
      description: "Cancel one of your pending or in-progress tasks.",
      annotations: { destructiveHint: true },
      inputSchema: cancelTaskInputSchema,
      outputSchema: cancelTaskOutputSchema,
    },
    async (args, info, _meta) => cancelTaskHandler(userCtx(user, info.sessionId), args),
  );

  registerTool(
    "task-action",
    {
      title: "Task Pool Action",
      description: "Move one of your tasks to or from backlog.",
      inputSchema: taskActionInputSchema,
      outputSchema: taskActionOutputSchema,
    },
    async (args, info, _meta) => taskActionHandler(userCtx(user, info.sessionId), args),
  );

  return server;
}
