import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listWorkflows } from "@/be/db";
import { createToolRegistrar } from "@/tools/utils";

export const registerListWorkflowsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "list-workflows",
    {
      title: "List Workflows",
      annotations: { destructiveHint: false },
      description:
        "List all automation workflows, optionally filtered by enabled status. Returns new fields: triggers, cooldown, input.",
      inputSchema: z.object({
        enabled: z.boolean().optional().describe("Filter by enabled status (omit to return all)"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        workflows: z.array(z.unknown()),
      }),
    },
    async ({ enabled }) => {
      try {
        const workflows = listWorkflows(enabled !== undefined ? { enabled } : undefined);
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
