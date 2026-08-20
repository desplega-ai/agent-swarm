import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getSwarmMetrics } from "@/be/db";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";

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
      outputSchema: swarmToolOutputSchema({
        tasks: z.looseObject({ total: z.number(), by_status: CountByStatusSchema }).optional(),
        agents: z.looseObject({ total: z.number(), by_status: CountByStatusSchema }).optional(),
        workflows: z.looseObject({ total: z.number(), enabled: z.number() }).optional(),
        pages: z.looseObject({ total: z.number() }).optional(),
        sessions: z.looseObject({ active: z.number() }).optional(),
        skills: z.looseObject({ total: z.number() }).optional(),
      }),
    },
    async () => {
      const metrics = await getSwarmMetrics();
      const details = [
        `tasks: ${JSON.stringify(metrics.tasks)}`,
        `agents: ${JSON.stringify(metrics.agents)}`,
        `workflows: ${JSON.stringify(metrics.workflows)}`,
        `pages: ${JSON.stringify(metrics.pages)}`,
        `sessions: ${JSON.stringify(metrics.sessions)}`,
        `skills: ${JSON.stringify(metrics.skills)}`,
      ].join("\n");

      return toolOk(
        `Swarm metrics: ${metrics.tasks.total} tasks, ${metrics.agents.total} agents, ${metrics.workflows.total} workflows (${metrics.workflows.enabled} enabled), ${metrics.pages.total} pages, ${metrics.sessions.active} active sessions, ${metrics.skills.total} skills.`,
        {
          details,
          data: {
            tasks: metrics.tasks,
            agents: metrics.agents,
            workflows: metrics.workflows,
            pages: metrics.pages,
            sessions: metrics.sessions,
            skills: metrics.skills,
          },
        },
      );
    },
  );
};
