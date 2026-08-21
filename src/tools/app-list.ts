import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { listApps } from "@/apps/store";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";

function escapeTableCell(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function renderApps(apps: Awaited<ReturnType<typeof listApps>>): string {
  if (apps.length === 0) return "No apps found.";
  const header = "| ID | Name | Description | Updated |";
  const separator = "| --- | --- | --- | --- |";
  const rows = apps.map(
    (app) =>
      `| ${[app.id, app.name, app.description, app.updatedAt].map(escapeTableCell).join(" | ")} |`,
  );
  return [header, separator, ...rows].join("\n");
}

export const registerAppListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-list",
    {
      title: "List apps",
      description:
        "List app summaries without their definitions. Use app-get to inspect one app in full.",
      annotations: { readOnlyHint: true },
      // List-level summaries remain ungated until a future policy can filter them per app.
      rbac: { ungated: "app summaries are list-level; per-app filtering is future work" },
      inputSchema: z.object({}),
      outputSchema: swarmToolOutputSchema({
        apps: z.array(z.unknown()).optional(),
      }),
    },
    async () => {
      const apps = await listApps();
      return toolOk(`Found ${apps.length} app(s).`, {
        details: renderApps(apps),
        data: { apps },
      });
    },
  );
};
