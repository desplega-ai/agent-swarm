import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById, upsertService } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";
import { ServiceSchema } from "@/types";

const SWARM_URL = process.env.SWARM_URL ?? "localhost";
const ALLOWED_SCRIPT_ROOTS = ["/workspace", "/home/worker"];
const ALLOWED_INTERPRETERS = new Set(["node", "bun", "python3"]);
const BLOCKED_SCRIPT_BASENAMES = new Set(["bash", "sh", "dash", "zsh", "fish", "ksh"]);
const BLOCKED_SYSTEM_EXECUTABLE_DIRS = [
  "/bin/",
  "/usr/bin/",
  "/usr/local/bin/",
  "/sbin/",
  "/usr/sbin/",
];
const ARG_SHELL_METACHARACTER_PATTERN = /[;&|`\n\r]|\$\(/;

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validatePathInsideAllowedRoots(value: string, fieldName: "script" | "cwd"): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${fieldName} must be an absolute path under /workspace/ or /home/worker/`);
  }

  const resolved = path.resolve(value);
  if (BLOCKED_SYSTEM_EXECUTABLE_DIRS.some((dir) => resolved.startsWith(dir))) {
    throw new Error(
      `${fieldName} must point to a project file under /workspace/ or /home/worker/, not a system executable`,
    );
  }

  if (fieldName === "script" && BLOCKED_SCRIPT_BASENAMES.has(path.basename(resolved))) {
    throw new Error(`${fieldName} must not point to a shell executable`);
  }

  if (!ALLOWED_SCRIPT_ROOTS.some((root) => isPathWithinRoot(resolved, root))) {
    throw new Error(`${fieldName} must resolve under /workspace/ or /home/worker/`);
  }

  return resolved;
}

function validateInterpreter(interpreter: string | undefined): string | undefined {
  if (interpreter === undefined) return undefined;
  if (!ALLOWED_INTERPRETERS.has(interpreter)) {
    throw new Error("interpreter must be one of: node, bun, python3");
  }
  return interpreter;
}

function validateArgs(args: string[] | undefined): string[] | undefined {
  if (!args) return undefined;
  const unsafeArg = args.find((arg) => ARG_SHELL_METACHARACTER_PATTERN.test(arg));
  if (unsafeArg !== undefined) {
    throw new Error(
      `args must not contain shell metacharacters (;, &, |, $(...), backticks, or newlines): ${unsafeArg}`,
    );
  }
  return args;
}

export const registerRegisterServiceTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "register-service",
    {
      title: "Register Service",
      description:
        "Register a background service (e.g., PM2 process) for discovery by other agents. The service URL is automatically derived from your agent ID (https://{AGENT_ID}.{SWARM_URL}). Each agent can only run one service on port 3000.",
      annotations: { idempotentHint: true },

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
        const safeScript = validatePathInsideAllowedRoots(script, "script");
        const safeCwd = cwd ? validatePathInsideAllowedRoots(cwd, "cwd") : undefined;
        const safeInterpreter = validateInterpreter(interpreter);
        const safeArgs = validateArgs(args);

        // Upsert: create or update if exists
        const service = upsertService(requestInfo.agentId, serviceName, {
          script: safeScript,
          port: servicePort,
          description,
          url,
          healthCheckPath: healthCheckPath ?? "/health",
          cwd: safeCwd,
          interpreter: safeInterpreter,
          args: safeArgs,
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
          isError: true,
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
