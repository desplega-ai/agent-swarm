import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import {
  createScriptTool,
  deleteScriptTool,
  getScriptToolByName,
  listScriptTools,
  setScriptToolEnabled,
} from "@/be/script-tools-db";
import { getScript } from "@/be/scripts/db";
import { can } from "@/rbac";
import { ALL_TOOLS } from "@/tools/tool-config";
import { createToolRegistrar } from "@/tools/utils";
import { ScriptToolSchema } from "@/types";

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;

export const registerScriptToolsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "script-tools",
    {
      title: "Manage Script-Backed Tools",
      annotations: { destructiveHint: true },
      description:
        "Publish a global catalog script as an agent-visible MCP tool (lead only), unpublish, " +
        "enable/disable, or list. Published tools become callable on the next MCP session; the " +
        "script receives the tool call arguments as its args.",
      inputSchema: z.object({
        action: z.enum(["publish", "unpublish", "enable", "disable", "list"]),
        toolName: z
          .string()
          .optional()
          .describe(
            "Tool name (^[a-z][a-z0-9_-]{2,63}$). Required for all actions except 'list'. " +
              "Must not collide with a built-in tool.",
          ),
        scriptName: z
          .string()
          .optional()
          .describe("Global catalog script to back the tool. Required for 'publish'."),
        description: z
          .string()
          .min(1)
          .max(1024)
          .optional()
          .describe("Tool description shown to agents. Required for 'publish'."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        tools: z.array(ScriptToolSchema).optional(),
      }),
    },
    async (args, requestInfo) => {
      const respond = (success: boolean, message: string, tools?: unknown[]) => ({
        content: [{ type: "text" as const, text: message }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          success,
          message,
          ...(tools ? { tools } : {}),
        },
      });

      if (args.action === "list") {
        const tools = listScriptTools();
        return respond(
          true,
          tools.length === 0
            ? "No script-backed tools published."
            : tools
                .map((t) => `${t.enabled ? "●" : "○"} ${t.toolName} → script:${t.scriptName}`)
                .join("\n"),
          tools,
        );
      }

      const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
      if (!callerAgent) return respond(false, 'Agent not found. Set the "X-Agent-ID" header.');
      const decision = can({
        principal: { kind: "agent", agentId: callerAgent.id, isLead: callerAgent.isLead },
        verb: "tool.publish",
        source: "mcp",
      });
      if (!decision.allow) {
        return respond(false, `Not allowed: ${decision.reason ?? "tool.publish"}`);
      }

      if (!args.toolName) return respond(false, "toolName is required");

      switch (args.action) {
        case "publish": {
          if (!TOOL_NAME_PATTERN.test(args.toolName)) {
            return respond(false, "toolName must match ^[a-z][a-z0-9_-]{2,63}$");
          }
          if (ALL_TOOLS.has(args.toolName)) {
            return respond(false, `'${args.toolName}' collides with a built-in tool`);
          }
          if (getScriptToolByName(args.toolName)) {
            return respond(false, `Tool '${args.toolName}' is already published`);
          }
          if (!args.scriptName) return respond(false, "scriptName is required for publish");
          if (!args.description) return respond(false, "description is required for publish");
          if (!getScript({ name: args.scriptName, scope: "global" })) {
            return respond(false, `Script '${args.scriptName}' not found in global scope`);
          }
          const tool = createScriptTool({
            toolName: args.toolName,
            scriptName: args.scriptName,
            description: args.description,
            createdByAgentId: requestInfo.agentId,
          });
          return respond(
            true,
            `Published tool '${tool.toolName}' → script '${tool.scriptName}'. ` +
              "Available to agents on their next MCP session.",
            [tool],
          );
        }
        case "unpublish": {
          if (!deleteScriptTool(args.toolName)) {
            return respond(false, `Tool '${args.toolName}' not found`);
          }
          return respond(true, `Unpublished tool '${args.toolName}'.`);
        }
        case "enable":
        case "disable": {
          if (!setScriptToolEnabled(args.toolName, args.action === "enable")) {
            return respond(false, `Tool '${args.toolName}' not found`);
          }
          return respond(true, `Tool '${args.toolName}' ${args.action}d.`);
        }
      }
    },
  );
};
