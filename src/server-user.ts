import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import pkg from "../package.json";
import { enqueueAdmissionRow } from "./be/rbac-audit";
import { getUserGrant } from "./be/rbac-roles";
import {
  type AdmissionRbac,
  decideToolAdmission,
  isRbacEnabled,
  type PermissionVerb,
} from "./rbac";
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

type UserToolAdmissionConfig = {
  annotations?: ToolAnnotations;
  rbac?: AdmissionRbac;
};

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

function permission(verb: PermissionVerb): AdmissionRbac {
  return { permission: verb };
}

async function maybeDenyUserToolAdmission(
  user: User,
  toolName: string,
  config: UserToolAdmissionConfig,
): Promise<CallToolResult | undefined> {
  if (!isRbacEnabled()) return undefined;

  const grant = getUserGrant(user.id);
  if (grant.grantsAll) return undefined;

  const decision = decideToolAdmission({
    rbac: config.rbac,
    readOnly: config.annotations?.readOnlyHint ?? false,
    grant,
  });
  enqueueAdmissionRow({
    userId: user.id,
    decision,
    source: "mcp",
    toolName,
  });

  if (decision.allow) return undefined;

  return {
    isError: true,
    content: [{ type: "text", text: `Forbidden: ${decision.reason}` }],
  };
}

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

  const sendTaskConfig = {
    title: "Send a task",
    annotations: { destructiveHint: false },
    rbac: permission("task.create.own"),
    description: "Creates an unassigned task requested by the authenticated user.",
    inputSchema: userSendTaskInputSchema,
    outputSchema: sendTaskOutputSchema,
  };
  registerTool("send-task", sendTaskConfig, async (args, info, _meta) => {
    const denied = await maybeDenyUserToolAdmission(user, "send-task", sendTaskConfig);
    if (denied) return denied;
    return sendTaskHandler(userCtx(user, info.sessionId), {
      offerMode: false,
      allowDuplicate: false,
      overrideSlackContext: false,
      ...args,
    });
  });

  const getTasksConfig = {
    title: "Get tasks",
    description: "Returns tasks requested by the authenticated user.",
    annotations: { readOnlyHint: true },
    inputSchema: getTasksInputSchema,
    outputSchema: getTasksOutputSchema,
  };
  registerTool("get-tasks", getTasksConfig, async (args, info, _meta) => {
    const denied = await maybeDenyUserToolAdmission(user, "get-tasks", getTasksConfig);
    if (denied) return denied;
    return getTasksHandler(userCtx(user, info.sessionId), args);
  });

  const getTaskDetailsConfig = {
    title: "Get task details",
    description: "Returns detailed information about one of your tasks.",
    annotations: { readOnlyHint: true },
    inputSchema: getTaskDetailsInputSchema,
    outputSchema: getTaskDetailsOutputSchema,
  };
  registerTool("get-task-details", getTaskDetailsConfig, async (args, info, _meta) => {
    const denied = await maybeDenyUserToolAdmission(user, "get-task-details", getTaskDetailsConfig);
    if (denied) return denied;
    return getTaskDetailsHandler(userCtx(user, info.sessionId), args);
  });

  const cancelTaskConfig = {
    title: "Cancel Task",
    description: "Cancel one of your pending or in-progress tasks.",
    annotations: { destructiveHint: true },
    rbac: permission("task.cancel.own"),
    inputSchema: cancelTaskInputSchema,
    outputSchema: cancelTaskOutputSchema,
  };
  registerTool("cancel-task", cancelTaskConfig, async (args, info, _meta) => {
    const denied = await maybeDenyUserToolAdmission(user, "cancel-task", cancelTaskConfig);
    if (denied) return denied;
    return cancelTaskHandler(userCtx(user, info.sessionId), args);
  });

  const taskActionConfig = {
    title: "Task Pool Action",
    description: "Move one of your tasks to or from backlog.",
    rbac: permission("task.action.own"),
    inputSchema: taskActionInputSchema,
    outputSchema: taskActionOutputSchema,
  };
  registerTool("task-action", taskActionConfig, async (args, info, _meta) => {
    const denied = await maybeDenyUserToolAdmission(user, "task-action", taskActionConfig);
    if (denied) return denied;
    return taskActionHandler(userCtx(user, info.sessionId), args);
  });

  return server;
}
