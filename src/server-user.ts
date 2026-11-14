import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";
import pkg from "../package.json";
import { isMcpUserEventsEnabled } from "./be/mcp-events/catalog";
import { registerUserEvents } from "./be/mcp-events/protocol";
import { enqueueAdmissionRow } from "./be/rbac-audit";
import { getUserGrant } from "./be/rbac-roles";
import {
  runScriptForUser,
  scriptTypesForUser,
  searchScriptsForUser,
  type UserCodeModeResponse,
} from "./be/scripts/user-code-mode";
import { MCP_MAX_TOOL_INPUT_ELEMENTS } from "./mcp-limits";
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
import {
  scriptNameSchema,
  scriptsApiToolResult,
  scriptToolOutputSchema,
} from "./tools/script-common";
import { renderTypeBlobs } from "./tools/script-query-types";
import { renderRunOutput } from "./tools/script-run";
import { renderSearchResults, searchSuccessMessage } from "./tools/script-search";
import { checkOutputSchemaShape, sendTaskHandler, sendTaskOutputSchema } from "./tools/send-task";
import {
  steerTaskHandler,
  steerTaskOutputSchema,
  steerTaskUserInputSchema,
} from "./tools/steer-task";
import { userCtx } from "./tools/task-tool-ctx";
import { createToolRegistrar, type SwarmToolResult, toolErr } from "./tools/utils";
import { ModelTierSchema, type User } from "./types";
import { isSteeringEnabled } from "./utils/steering-enabled";

type UserToolAdmissionConfig = {
  annotations?: ToolAnnotations;
  rbac?: AdmissionRbac;
};

export const userSendTaskInputSchema = z
  .object({
    task: z.string().min(1).describe("The task description to send."),
    taskType: z
      .string()
      .max(50)
      .optional()
      .describe("Task type (e.g., 'bug', 'feature', 'review')."),
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
    outputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Optional JSON Schema the assignee's final output must satisfy. store-progress rejects a completion that does not match. Supported keywords: type, required, properties, enum, const, items. An empty object {} means no schema.",
      ),
  })
  .superRefine((data, ctx) => checkOutputSchemaShape(data.outputSchema, ctx));

const USER_CODE_MODE_SCOPE =
  "Runs as you: the script's swarm calls carry your permissions, no agent's credentials or connections, and no task is created. Only global scripts are visible.";

function codeModeResult(
  response: UserCodeModeResponse,
  rendering: Parameters<typeof scriptsApiToolResult>[2],
): SwarmToolResult {
  const ok = response.status >= 200 && response.status < 300;
  return scriptsApiToolResult(response.body, { ok, status: response.status }, rendering);
}

function permission(verb: PermissionVerb): AdmissionRbac {
  return { permission: verb };
}

async function maybeDenyUserToolAdmission(
  user: User,
  toolName: string,
  config: UserToolAdmissionConfig,
): Promise<SwarmToolResult | undefined> {
  if (!isRbacEnabled()) return undefined;

  const grant = await getUserGrant(user.id);
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

  return toolErr(`Forbidden: ${decision.reason}`);
}

/**
 * `tokenId` is the aswt_ token that opened the session. Without it the session
 * offers no MCP Events: a subscription must be bound to a revocable token.
 */
export function createUserServer(user: User, tokenId?: string): McpServer {
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
      maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS,
    },
  );

  const registerTool = createToolRegistrar(server);

  if (tokenId && isMcpUserEventsEnabled()) {
    // Subscribing is a read on the user's own tasks.
    const eventsAdmission = { annotations: { readOnlyHint: true } };
    registerUserEvents(server, user, tokenId, async (method) => {
      const denied = await maybeDenyUserToolAdmission(user, method, eventsAdmission);
      return denied === undefined;
    });
  }

  const sendTaskConfig = {
    title: "Send a task",
    annotations: { destructiveHint: false },
    rbac: permission("task.create.own"),
    description: "Sends a task from the authenticated user to the online Lead.",
    inputSchema: userSendTaskInputSchema,
    outputSchema: sendTaskOutputSchema,
  };
  registerTool("send-task", sendTaskConfig, async (args, info, _meta) => {
    const denied = await maybeDenyUserToolAdmission(user, "send-task", sendTaskConfig);
    if (denied) return denied;
    return sendTaskHandler(userCtx(user, info.sessionId), {
      ...args,
      offerMode: false,
      leadOnly: false,
      allowDuplicate: false,
      allowRedelegation: false,
      overrideSlackContext: false,
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

  // Code mode: the agent-side script-search / script-query-types / script-run,
  // scoped to the user (see src/be/scripts/user-code-mode.ts).
  const scriptSearchConfig = {
    title: "Script Search",
    description: `Search the swarm's reusable TypeScript scripts by intent. ${USER_CODE_MODE_SCOPE}`,
    annotations: { readOnlyHint: true, openWorldHint: false },
    rbac: permission("script.search"),
    inputSchema: z.object({
      query: z.string().default("").describe("What the script should do."),
      limit: z.number().int().min(1).max(100).default(10).describe("Maximum results."),
    }),
    outputSchema: scriptToolOutputSchema,
  };
  registerTool("script-search", scriptSearchConfig, async (args) => {
    const denied = await maybeDenyUserToolAdmission(user, "script-search", scriptSearchConfig);
    if (denied) return denied;
    return codeModeResult(await searchScriptsForUser(args), {
      successMessage: searchSuccessMessage,
      successDetails: renderSearchResults,
    });
  });

  // Not `script-query-types`: this name is exempt from the result-size spill
  // (CTX_CONTROL_EXEMPT_TOOLS), since a user has no kv to read a spill back from.
  const scriptGetTypesConfig = {
    title: "Script Get Types",
    description: `Get the TypeScript declarations a script is written against: the \`swarm-sdk\` module (\`ScriptContext\`, \`ctx.swarm\`) and the \`stdlib\` module, about 12k tokens. Pass \`name\` to also get that script's signature and args schema. ${USER_CODE_MODE_SCOPE}`,
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({
      name: scriptNameSchema.optional().describe("Optional global script name."),
    }),
    outputSchema: scriptToolOutputSchema,
  };
  registerTool("script-get-types", scriptGetTypesConfig, async ({ name }) => {
    const denied = await maybeDenyUserToolAdmission(user, "script-get-types", scriptGetTypesConfig);
    if (denied) return denied;
    const response = await scriptTypesForUser(name);
    const { stdlibTypes: _types, ...small } = response.body as Record<string, unknown>;
    return codeModeResult(
      // The declarations go out once, in details; data keeps only the small fields.
      { status: response.status, body: small },
      {
        successMessage: () =>
          name
            ? `Type definitions for script \`${name}\` fetched.`
            : "Script type definitions fetched.",
        successDetails: () => renderTypeBlobs(response.body),
        uncappedDetails: true,
      },
    );
  });

  const scriptRunConfig = {
    title: "Script Run",
    description: `Run a global script by \`name\`, or inline TypeScript \`source\` that does \`export default async function (args, ctx)\`. Inline source is not typechecked or saved. ${USER_CODE_MODE_SCOPE}`,
    annotations: { openWorldHint: true },
    rbac: permission("script.run"),
    inputSchema: z.object({
      name: scriptNameSchema.optional().describe("Global script to run."),
      source: z.string().min(1).optional().describe("Inline TypeScript source to run."),
      args: z.unknown().optional().describe("JSON-serializable script arguments."),
    }),
    outputSchema: scriptToolOutputSchema,
  };
  registerTool("script-run", scriptRunConfig, async (args) => {
    const denied = await maybeDenyUserToolAdmission(user, "script-run", scriptRunConfig);
    if (denied) return denied;
    return codeModeResult(await runScriptForUser({ userId: user.id, ...args }), {
      successMessage: () => "Script run completed.",
      successDetails: renderRunOutput,
    });
  });

  if (isSteeringEnabled()) {
    const steerTaskConfig = {
      title: "Steer Task",
      description: "Send a message to a task that is already running.",
      annotations: { destructiveHint: true },
      rbac: permission("task.steer.own"),
      inputSchema: steerTaskUserInputSchema,
      outputSchema: steerTaskOutputSchema,
    };
    registerTool("steer-task", steerTaskConfig, async (args, info, _meta) => {
      const denied = await maybeDenyUserToolAdmission(user, "steer-task", steerTaskConfig);
      if (denied) return denied;
      return steerTaskHandler(userCtx(user, info.sessionId), args);
    });
  }

  return server;
}
