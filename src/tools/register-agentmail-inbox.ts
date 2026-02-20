import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createAgentMailInboxMapping,
  deleteAgentMailInboxMapping,
  getAgentById,
  getAgentMailInboxMappingsByAgent,
} from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerRegisterAgentMailInboxTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "register-agentmail-inbox",
    {
      title: "Register AgentMail Inbox",
      description:
        "Register an AgentMail inbox ID to route incoming emails to this agent. When emails arrive at this inbox, they will be routed to you as tasks (for workers) or inbox messages (for leads). Use action 'register' to add a mapping, 'unregister' to remove one, or 'list' to see your current mappings.",
      inputSchema: z.object({
        action: z
          .enum(["register", "unregister", "list"])
          .describe("Action to perform: register, unregister, or list inbox mappings."),
        inboxId: z
          .string()
          .optional()
          .describe("The AgentMail inbox ID (e.g., 'inb_xxx'). Required for register/unregister."),
        inboxEmail: z
          .string()
          .optional()
          .describe("Optional email address for this inbox (for reference only)."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        mappings: z
          .array(
            z.object({
              id: z.string(),
              inboxId: z.string(),
              agentId: z.string(),
              inboxEmail: z.string().nullable(),
              createdAt: z.string(),
            }),
          )
          .optional(),
      }),
    },
    async ({ action, inboxId, inboxEmail }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      try {
        const agent = getAgentById(requestInfo.agentId);
        if (!agent) {
          return {
            content: [{ type: "text", text: "Agent not found." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Agent not found.",
            },
          };
        }

        if (action === "list") {
          const mappings = getAgentMailInboxMappingsByAgent(requestInfo.agentId);
          const text =
            mappings.length === 0
              ? "No AgentMail inbox mappings registered."
              : `Found ${mappings.length} mapping(s):\n${mappings.map((m) => `  - ${m.inboxId} (${m.inboxEmail ?? "no email"})`).join("\n")}`;
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: true,
              message: text,
              mappings,
            },
          };
        }

        if (!inboxId) {
          return {
            content: [{ type: "text", text: "inboxId is required for register/unregister." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "inboxId is required for register/unregister.",
            },
          };
        }

        if (action === "register") {
          const mapping = createAgentMailInboxMapping(inboxId, requestInfo.agentId, inboxEmail);
          const text = `Registered inbox ${inboxId} → agent ${agent.name} (${requestInfo.agentId})`;
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: true,
              message: text,
              mappings: [mapping],
            },
          };
        }

        if (action === "unregister") {
          const deleted = deleteAgentMailInboxMapping(inboxId);
          const text = deleted
            ? `Unregistered inbox ${inboxId}`
            : `No mapping found for inbox ${inboxId}`;
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: deleted,
              message: text,
            },
          };
        }

        return {
          content: [{ type: "text", text: `Unknown action: ${action}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Unknown action: ${action}`,
          },
        };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: errorMessage,
          },
        };
      }
    },
  );
};
