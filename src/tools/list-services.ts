import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getAllServices } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { ServiceStatusSchema } from "@/types";

// Loose mirror of ServiceSchema (+ denormalized agentName) for tool output:
// every field optional, no url/uuid/datetime format pins.
const serviceWithAgentNameOutputShape = z.looseObject({
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
  agentName: z.string().optional(),
});

export const registerListServicesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-services",
    {
      title: "List Services",
      description:
        "Query services registered by agents in the swarm. Use this to discover services exposed by other agents.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        agentId: z.string().optional().describe("Filter by specific agent ID."),
        name: z.string().optional().describe("Filter by service name (partial match)."),
        status: ServiceStatusSchema.optional().describe("Filter by health status."),
        includeOwn: z
          .boolean()
          .default(true)
          .optional()
          .describe("Include services registered by calling agent (default: true)."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        services: z.array(serviceWithAgentNameOutputShape).optional(),
        count: z.number().optional(),
      }),
    },
    async ({ agentId, name, status, includeOwn }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.', {
          data: { services: [], count: 0 },
        });
      }

      try {
        let services = await getAllServices({
          agentId,
          name,
          status,
        });

        // Filter out own services if requested
        if (includeOwn === false) {
          services = services.filter((s) => s.agentId !== requestInfo.agentId);
        }

        // Denormalize agent names
        const servicesWithAgentNames = await Promise.all(
          services.map(async (service) => {
            const agent = await getAgentById(service.agentId);
            return {
              ...service,
              agentName: agent?.name,
            };
          }),
        );

        const count = servicesWithAgentNames.length;
        const statusSummary =
          count === 0 ? "No services found." : `Found ${count} service${count === 1 ? "" : "s"}.`;

        // Format for text output
        const serviceList = servicesWithAgentNames
          .map(
            (s) => `- ${s.name} (${s.status}) by ${s.agentName ?? "unknown"}: ${s.url ?? "no URL"}`,
          )
          .join("\n");

        return toolOk(statusSummary, {
          details: count === 0 ? undefined : serviceList,
          data: { yourAgentId: requestInfo.agentId, services: servicesWithAgentNames, count },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to list services: ${message}`, {
          data: { yourAgentId: requestInfo.agentId, services: [], count: 0 },
        });
      }
    },
  );
};
