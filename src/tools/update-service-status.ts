import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getServiceByAgentAndName, getServiceById, updateServiceStatus } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ServiceSchema, ServiceStatusSchema } from "@/types";

export const registerUpdateServiceStatusTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-service-status",
    {
      title: "Update Service Status",
      description:
        "Update the health status of a registered service. Use this after a service becomes healthy or needs to be marked as stopped/unhealthy.",
      inputSchema: z.object({
        serviceId: z.uuid().optional().describe("Service ID to update."),
        name: z.string().optional().describe("Service name to update (alternative to serviceId)."),
        status: ServiceStatusSchema.describe(
          "New status: 'starting', 'healthy', 'unhealthy', or 'stopped'.",
        ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        service: ServiceSchema.optional(),
      }),
    },
    async ({ serviceId, name, status }, requestInfo, _meta) => {
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
            content: [{ type: "text", text: "You can only update status of your own services." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "You can only update status of your own services.",
            },
          };
        }

        const updated = updateServiceStatus(service.id, status);
        if (!updated) {
          return {
            content: [{ type: "text", text: "Failed to update service status." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Failed to update service status.",
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Updated service "${service.name}" status to "${status}".`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Updated service "${service.name}" status to "${status}".`,
            service: updated,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to update service status: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to update service status: ${message}`,
          },
        };
      }
    },
  );
};
