import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deleteService, getServiceByAgentAndName, getServiceById } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerUnregisterServiceTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "unregister-service",
    {
      title: "Unregister Service",
      description:
        "Remove a service from the registry. Use this after stopping a PM2 process. You can only unregister your own services.",
      annotations: { destructiveHint: true },

      inputSchema: z.object({
        serviceId: z.uuid().optional().describe("Service ID to unregister."),
        name: z
          .string()
          .optional()
          .describe("Service name to unregister (alternative to serviceId)."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
      }),
    },
    async ({ serviceId, name }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      if (!serviceId && !name) {
        return toolErr("Either serviceId or name is required.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      try {
        // Find the service
        let service = serviceId ? getServiceById(serviceId) : null;
        if (!service && name) {
          service = getServiceByAgentAndName(requestInfo.agentId, name);
        }

        if (!service) {
          return toolErr("Service not found.", { data: { yourAgentId: requestInfo.agentId } });
        }

        // Check ownership
        if (service.agentId !== requestInfo.agentId) {
          return toolErr("You can only unregister your own services.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        const deleted = deleteService(service.id);
        if (!deleted) {
          return toolErr("Failed to unregister service.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        return toolOk(`Unregistered service "${service.name}".`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to unregister service: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
