import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSwarmMetrics } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

const CountByStatusSchema = z.record(z.string(), z.number());

export const registerGetMetricsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "get-metrics",
    {
      title: "Get swarm metrics",
      description:
        "Returns lightweight swarm-wide counts in a single object — tasks (total + by status), agents (total + by status), workflows (total + enabled), pages, active sessions, skills. Use this instead of fetching full list payloads just to count things. Pure COUNT queries; cheap.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
      outputSchema: z.object({
        tasks: z.object({ total: z.number(), by_status: CountByStatusSchema }),
        agents: z.object({ total: z.number(), by_status: CountByStatusSchema }),
        workflows: z.object({ total: z.number(), enabled: z.number() }),
        pages: z.object({ total: z.number() }),
        sessions: z.object({ active: z.number() }),
        skills: z.object({ total: z.number() }),
      }),
    },
    async () => {
      const metrics = getSwarmMetrics();
      return {
        content: [
          {
            type: "text",
            text: `Swarm metrics: ${metrics.tasks.total} tasks, ${metrics.agents.total} agents, ${metrics.workflows.total} workflows (${metrics.workflows.enabled} enabled), ${metrics.pages.total} pages, ${metrics.sessions.active} active sessions, ${metrics.skills.total} skills.`,
          },
        ],
        structuredContent: {
          tasks: metrics.tasks,
          agents: metrics.agents,
          workflows: metrics.workflows,
          pages: metrics.pages,
          sessions: metrics.sessions,
          skills: metrics.skills,
        },
      };
    },
  );
};
