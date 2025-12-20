import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { upsertService } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ServiceSchema } from "@/types";

const SWARM_URL = process.env.SWARM_URL ?? "localhost";

export const registerRegisterServiceTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "register-service",
    {
      title: "Register Service",
      description:
        "Register a background service (e.g., PM2 process) for discovery by other agents and ecosystem-based restart. Use this after starting a service with PM2. If a service with the same name exists, it will be updated.",
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(50)
          .describe("Service name (used in URL subdomain and PM2 process name)."),
        script: z.string().min(1).describe("Path to the script to run (required for PM2 restart)."),
        port: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .default(3000)
          .optional()
          .describe("Port the service runs on (default: 3000)."),
        description: z.string().optional().describe("What this service does."),
        healthCheckPath: z
          .string()
          .optional()
          .describe("Health check endpoint path (default: /health)."),
        cwd: z.string().optional().describe("Working directory for the script."),
        interpreter: z
          .string()
          .optional()
          .describe(
            "Interpreter to use (e.g., 'node', 'bun'). Auto-detected from extension if not set.",
          ),
        args: z.array(z.string()).optional().describe("Command line arguments for the script."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Environment variables for the process."),
        metadata: z.record(z.string(), z.unknown()).optional().describe("Additional metadata."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        service: ServiceSchema.optional(),
      }),
    },
    async (
      { name, script, port, description, healthCheckPath, cwd, interpreter, args, env, metadata },
      requestInfo,
      _meta,
    ) => {
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
        // Compute URL based on swarm configuration
        const servicePort = port ?? 3000;
        const url = `https://${name}.${SWARM_URL}`;

        // Upsert: create or update if exists
        const service = upsertService(requestInfo.agentId, name, {
          script,
          port: servicePort,
          description,
          url,
          healthCheckPath: healthCheckPath ?? "/health",
          cwd,
          interpreter,
          args,
          env,
          metadata,
        });

        return {
          content: [
            {
              type: "text",
              text: `Registered service "${name}" at ${url}. Status: ${service.status}. Use update-service-status to mark as healthy.`,
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
