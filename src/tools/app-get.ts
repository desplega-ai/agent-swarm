import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { type AppRow, listAppRows } from "@/apps/row-store";
import { getApp } from "@/apps/store";
import { applyQuery } from "@/http/apps";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

function escapeTableCell(value: unknown): string {
  const rendered = typeof value === "object" && value !== null ? JSON.stringify(value) : value;
  return String(rendered ?? "—")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/\r\n|\r|\n/g, "<br>");
}

function renderRows(rows: AppRow[]): string {
  if (rows.length === 0) return "No rows found.";
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const header = `| ${columns.map(escapeTableCell).join(" | ")} |`;
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${columns.map((column) => escapeTableCell(row[column])).join(" | ")} |`,
  );
  return [header, separator, ...body].join("\n");
}

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

// Keep ungated app reads together in this explicitly allowlisted registration
// module. app-query.ts re-exports this symbol to preserve its public wiring.
export const registerAppQueryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-query",
    {
      title: "Run an app query",
      description: "Run one declared named app query and return its rows.",
      annotations: { readOnlyHint: true },
      rbac: { ungated: "read-only app query mirrors the ungated HTTP app query route" },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID containing the named query."),
        query: z.string().min(1).describe("Declared query name."),
      }),
      outputSchema: swarmToolOutputSchema({
        rows: z.array(z.looseObject({})).optional(),
        count: z.number().optional(),
      }),
    },
    async ({ appId, query: queryName }) => {
      const app = getApp(appId);
      const query = app?.definition.queries?.[queryName];
      if (!app || !query) return toolErr(`App ${appId} or query "${queryName}" not found.`);
      const model = app.definition.models[query.model];
      if (!model) return toolErr(`Model "${query.model}" not found.`);
      const rows = applyQuery(listAppRows(app.id, query.model), query, model);
      return toolOk(`Query "${queryName}" returned ${rows.length} row(s).`, {
        details: renderRows(rows),
        data: { rows, count: rows.length },
      });
    },
  );
};
