import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getApp } from "@/apps/store";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerAppGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-get",
    {
      title: "Get an app",
      description:
        "Get an app by ID, including its models, named queries, actions, and json-render page definition.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID to retrieve."),
      }),
      outputSchema: swarmToolOutputSchema({
        app: z.unknown().optional(),
      }),
    },
    async ({ appId }) => {
      const app = getApp(appId);
      if (!app) return toolErr(`App ${appId} not found.`);

      return toolOk(`App "${app.name}" (${app.id}).`, {
        details: JSON.stringify(app, null, 2),
        data: { app },
      });
    },
  );
};
