import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createToolRegistrar } from "@swarm/mcp-tool";
import { listWorkflows } from "@swarm/storage";
import { z } from "zod";

export const registerListWorkflowsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-workflows",
    {
      title: "List Workflows",
      annotations: { destructiveHint: false },
      description:
        "List all automation workflows, optionally filtered by enabled status. Returns SLIM rows WITHOUT the full `definition` (DAG) — each row carries a `nodeCount` instead. To inspect or patch a workflow's nodes/triggers, call `get-workflow` by id, or pass `includeFull: true` here.",
      inputSchema: z.object({
        enabled: z.boolean().optional().describe("Filter by enabled status (omit to return all)"),
        includeFull: z
          .boolean()
          .optional()
          .describe(
            "Return the full workflow `definition` + trigger config instead of slim rows. Default false — prefer `get-workflow` to fetch a single workflow in full.",
          ),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        workflows: z.array(z.unknown()),
      }),
    },
    async ({ enabled, includeFull }) => {
      try {
        const filters = enabled !== undefined ? { enabled } : undefined;
        const workflows = includeFull
          ? listWorkflows(filters)
          : listWorkflows(filters, { slim: true });
        return {
          content: [{ type: "text" as const, text: `Found ${workflows.length} workflow(s).` }],
          structuredContent: {
            success: true,
            message: `Found ${workflows.length} workflow(s).`,
            workflows,
          },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed: ${err}` }],
          structuredContent: { success: false, message: String(err), workflows: [] },
        };
      }
    },
  );
};
