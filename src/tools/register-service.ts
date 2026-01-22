import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, upsertService } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ServiceSchema } from "@/types";

const SWARM_URL = process.env.SWARM_URL ?? "localhost";

export const registerRegisterServiceTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "register-service",
    {
      title: "Register Service",
      description:
        "Register a background service (e.g., PM2 process) for discovery by other agents. The service URL is automatically derived from your agent ID (https://{AGENT_ID}.{SWARM_URL}). Each agent can only run one service on port 3000.",
      inputSchema: z.object({
        script: z.string().min(1).describe("Path to the script to run (required for PM2 restart)."),
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
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        service: ServiceSchema.optional(),
      }),
    },
    async (
      { script, description, healthCheckPath, cwd, interpreter, args, env, metadata },
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
        // Look up the agent to get its name
        const agent = getAgentById(requestInfo.agentId);
        if (!agent) {
          return {
            content: [{ type: "text", text: "Agent not found. Join the swarm first." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Agent not found. Join the swarm first.",
            },
          };
        }

        // Service name uses agent ID (stable, URL-safe) for subdomain
        const serviceName = agent.id;
        const servicePort = 3000; // Fixed port - only one service per worker
        const url = `https://${serviceName}.${SWARM_URL}`;

        // Upsert: create or update if exists
        const service = upsertService(requestInfo.agentId, serviceName, {
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
              text: `Registered service "${serviceName}" at ${url}. Status: ${service.status}. Use update-service-status to mark as healthy.`,
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Registered service "${serviceName}" at ${url}.`,
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
