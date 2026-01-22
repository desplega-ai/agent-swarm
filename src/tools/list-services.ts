import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, getAllServices } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ServiceSchema, ServiceStatusSchema } from "@/types";

export const registerListServicesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-services",
    {
      title: "List Services",
      description:
        "Query services registered by agents in the swarm. Use this to discover services exposed by other agents.",
      inputSchema: z.object({
        agentId: z.uuid().optional().describe("Filter by specific agent ID."),
        name: z.string().optional().describe("Filter by service name (partial match)."),
        status: ServiceStatusSchema.optional().describe("Filter by health status."),
        includeOwn: z
          .boolean()
          .default(true)
          .optional()
          .describe("Include services registered by calling agent (default: true)."),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        services: z.array(
          ServiceSchema.extend({
            agentName: z.string().optional(),
          }),
        ),
        count: z.number(),
      }),
    },
    async ({ agentId, name, status, includeOwn }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
            services: [],
            count: 0,
          },
        };
      }

      try {
        let services = getAllServices({
          agentId,
          name,
          status,
        });

        // Filter out own services if requested
        if (includeOwn === false) {
          services = services.filter((s) => s.agentId !== requestInfo.agentId);
        }

        // Denormalize agent names
        const servicesWithAgentNames = services.map((service) => {
          const agent = getAgentById(service.agentId);
          return {
            ...service,
            agentName: agent?.name,
          };
        });

        const count = servicesWithAgentNames.length;
        const statusSummary =
          count === 0 ? "No services found." : `Found ${count} service${count === 1 ? "" : "s"}.`;

        // Format for text output
        const serviceList = servicesWithAgentNames
          .map(
            (s) => `- ${s.name} (${s.status}) by ${s.agentName ?? "unknown"}: ${s.url ?? "no URL"}`,
          )
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: count === 0 ? statusSummary : `${statusSummary}\n\n${serviceList}`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: statusSummary,
            services: servicesWithAgentNames,
            count,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to list services: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to list services: ${message}`,
            services: [],
            count: 0,
          },
        };
      }
    },
  );
};
