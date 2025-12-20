import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createService, getServiceByAgentAndName } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ServiceSchema } from "@/types";

const SWARM_URL = process.env.SWARM_URL ?? "localhost";

export const registerRegisterServiceTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "register-service",
    {
      title: "Register Service",
      description:
        "Register a background service (e.g., PM2 process) for discovery by other agents. Use this after starting a service with PM2.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(50)
          .describe("Service name (used in URL subdomain and PM2 process name)."),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .default(3000)
          .optional()
          .describe("Port the service runs on (default: 3000)."),
        description: z.string().max(500).optional().describe("What this service does."),
        healthCheckPath: z
          .string()
          .optional()
          .describe("Health check endpoint path (default: /health)."),
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Additional metadata (e.g., PM2 process name, version)."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        service: ServiceSchema.optional(),
      }),
    },
    async ({ name, port, description, healthCheckPath, metadata }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      // Check if service already exists for this agent
      const existing = getServiceByAgentAndName(requestInfo.agentId, name);
      if (existing) {
        return {
          content: [{ type: "text", text: `Service "${name}" is already registered.` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Service "${name}" is already registered.`,
            service: existing,
          },
        };
      }

      try {
        // Compute URL based on swarm configuration
        const servicePort = port ?? 3000;
        const url = `https://${name}.${SWARM_URL}`;

        const service = createService(requestInfo.agentId, name, {
          port: servicePort,
          description,
          url,
          healthCheckPath: healthCheckPath ?? "/health",
          metadata,
        });

        return {
          content: [
            {
              type: "text",
              text: `Registered service "${name}" at ${url}. Status: starting. Use update-service-status to mark as healthy.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Registered service "${name}" at ${url}.`,
            service,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to register service: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to register service: ${message}`,
          },
        };
      }
    },
  );
};
