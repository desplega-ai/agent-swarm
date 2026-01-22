import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteService, getServiceByAgentAndName, getServiceById } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerUnregisterServiceTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "unregister-service",
    {
      title: "Unregister Service",
      description:
        "Remove a service from the registry. Use this after stopping a PM2 process. You can only unregister your own services.",
      inputSchema: z.object({
        serviceId: z.uuid().optional().describe("Service ID to unregister."),
        name: z
          .string()
          .optional()
          .describe("Service name to unregister (alternative to serviceId)."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ serviceId, name }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      if (!serviceId && !name) {
        return {
          content: [{ type: "text", text: "Either serviceId or name is required." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Either serviceId or name is required.",
          },
        };
      }

      try {
        // Find the service
        let service = serviceId ? getServiceById(serviceId) : null;
        if (!service && name) {
          service = getServiceByAgentAndName(requestInfo.agentId, name);
        }

        if (!service) {
          return {
            content: [{ type: "text", text: "Service not found." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Service not found.",
            },
          };
        }

        // Check ownership
        if (service.agentId !== requestInfo.agentId) {
          return {
            content: [{ type: "text", text: "You can only unregister your own services." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "You can only unregister your own services.",
            },
          };
        }

        const deleted = deleteService(service.id);
        if (!deleted) {
          return {
            content: [{ type: "text", text: "Failed to unregister service." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Failed to unregister service.",
            },
          };
        }

        return {
          content: [{ type: "text", text: `Unregistered service "${service.name}".` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Unregistered service "${service.name}".`,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to unregister service: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to unregister service: ${message}`,
          },
        };
      }
    },
  );
};
