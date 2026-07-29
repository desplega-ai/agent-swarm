import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createAgentMailInboxMapping,
  deleteAgentMailInboxMapping,
  getAgentById,
  getAgentMailInboxMapping,
  getAgentMailInboxMappingsByAgent,
} from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerRegisterAgentmailInboxTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "register-agentmail-inbox",
    {
      title: "Register AgentMail Inbox",
      annotations: { idempotentHint: true },
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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        mappings: z
          .array(
            z.looseObject({
              id: z.string().optional(),
              inboxId: z.string().optional(),
              agentId: z.string().optional(),
              inboxEmail: z.string().nullable().optional(),
              createdAt: z.string().optional(),
            }),
          )
          .optional(),
      }),
    },
    async ({ action, inboxId, inboxEmail }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      try {
        const agent = getAgentById(requestInfo.agentId);
        if (!agent) {
          return toolErr("Agent not found.", { data: { yourAgentId: requestInfo.agentId } });
        }

        if (action === "list") {
          const mappings = getAgentMailInboxMappingsByAgent(requestInfo.agentId);
          const text =
            mappings.length === 0
              ? "No AgentMail inbox mappings registered."
              : `Found ${mappings.length} mapping(s):\n${mappings.map((m) => `  - ${m.inboxId} (${m.inboxEmail ?? "no email"})`).join("\n")}`;
          return toolOk(`Found ${mappings.length} mapping(s).`, {
            details: text,
            data: { yourAgentId: requestInfo.agentId, mappings },
          });
        }

        if (!inboxId) {
          return toolErr("inboxId is required for register/unregister.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        if (action === "register") {
          const mapping = createAgentMailInboxMapping(inboxId, requestInfo.agentId, inboxEmail);
          const text = `Registered inbox ${inboxId} → agent ${agent.name} (${requestInfo.agentId})`;
          return toolOk(text, {
            data: { yourAgentId: requestInfo.agentId, mappings: [mapping] },
          });
        }

        if (action === "unregister") {
          // Check ownership before allowing unregister
          const existing = getAgentMailInboxMapping(inboxId);
          if (existing && existing.agentId !== requestInfo.agentId) {
            return toolErr(`Cannot unregister inbox ${inboxId}: owned by another agent`, {
              data: { yourAgentId: requestInfo.agentId },
            });
          }

          const deleted = deleteAgentMailInboxMapping(inboxId);
          const text = deleted
            ? `Unregistered inbox ${inboxId}`
            : `No mapping found for inbox ${inboxId}`;
          return deleted
            ? toolOk(text, { data: { yourAgentId: requestInfo.agentId } })
            : toolErr(text, { data: { yourAgentId: requestInfo.agentId } });
        }

        return toolErr(`Unknown action: ${action}`, { data: { yourAgentId: requestInfo.agentId } });
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return toolErr(errorMessage, { data: { yourAgentId: requestInfo.agentId } });
      }
    },
  );
};
