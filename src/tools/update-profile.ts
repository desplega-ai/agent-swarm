import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { updateAgentProfile } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { AgentSchema } from "@/types";

export const registerUpdateProfileTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-profile",
    {
      title: "Update Profile",
      description:
        "Updates the calling agent's profile information (description, role, capabilities).",
      inputSchema: z.object({
        description: z.string().max(500).optional().describe("Agent description (max 500 chars)."),
        role: z
          .string()
          .max(100)
          .optional()
          .describe("Agent role (free-form, e.g., 'frontend dev', 'code reviewer')."),
        capabilities: z
          .array(z.string())
          .optional()
          .describe("List of capabilities (e.g., ['typescript', 'react', 'testing'])."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        agent: AgentSchema.optional(),
      }),
    },
    async ({ description, role, capabilities }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      // At least one field must be provided
      if (description === undefined && role === undefined && capabilities === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "At least one field (description, role, or capabilities) must be provided.",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "At least one field (description, role, or capabilities) must be provided.",
          },
        };
      }

      try {
        const agent = updateAgentProfile(requestInfo.agentId, {
          description,
          role,
          capabilities,
        });

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

        const updatedFields: string[] = [];
        if (description !== undefined) updatedFields.push("description");
        if (role !== undefined) updatedFields.push("role");
        if (capabilities !== undefined) updatedFields.push("capabilities");

        return {
          content: [{ type: "text", text: `Updated profile: ${updatedFields.join(", ")}.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Updated profile: ${updatedFields.join(", ")}.`,
            agent,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to update profile: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to update profile: ${message}`,
          },
        };
      }
    },
  );
};
