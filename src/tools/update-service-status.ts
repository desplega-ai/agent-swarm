import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getServiceByAgentAndName, getServiceById, updateServiceStatus } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { ServiceStatusSchema } from "@/types";

// Loose mirror of ServiceSchema for tool output: every field optional, no
// url/uuid/datetime format pins.
const serviceOutputShape = z.looseObject({
  id: z.string().optional(),
  agentId: z.string().optional(),
  name: z.string().optional(),
  port: z.number().optional(),
  description: z.string().optional(),
  url: z.string().optional(),
  healthCheckPath: z.string().optional(),
  status: ServiceStatusSchema.optional(),
  script: z.string().optional(),
  cwd: z.string().optional(),
  interpreter: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().optional(),
  lastUpdatedAt: z.string().optional(),
});

export const registerUpdateServiceStatusTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "update-service-status",
    {
      title: "Update Service Status",
      description:
        "Update the health status of a registered service. Use this after a service becomes healthy or needs to be marked as stopped/unhealthy.",
      annotations: { idempotentHint: true },

      inputSchema: z.object({
        serviceId: z.uuid().optional().describe("Service ID to update."),
        name: z.string().optional().describe("Service name to update (alternative to serviceId)."),
        status: ServiceStatusSchema.describe(
          "New status: 'starting', 'healthy', 'unhealthy', or 'stopped'.",
        ),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        service: serviceOutputShape.optional(),
      }),
    },
    async ({ serviceId, name, status }, requestInfo, _meta) => {
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
        let service = serviceId ? await getServiceById(serviceId) : null;
        if (!service && name) {
          service = await getServiceByAgentAndName(requestInfo.agentId, name);
        }

        if (!service) {
          return toolErr("Service not found.", { data: { yourAgentId: requestInfo.agentId } });
        }

        // Check ownership
        if (service.agentId !== requestInfo.agentId) {
          return toolErr("You can only update status of your own services.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        const updated = await updateServiceStatus(service.id, status);
        if (!updated) {
          return toolErr("Failed to update service status.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        return toolOk(`Updated service "${service.name}" status to "${status}".`, {
          data: { yourAgentId: requestInfo.agentId, service: updated },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to update service status: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
