import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { appDefinitionOutline, readDefinitionPath } from "@/apps/definition-edit";
import { type AppRow, listAppRows } from "@/apps/row-store";
import { appSourcesPath, listAppSources } from "@/apps/sources";
import { appDefinitionNeedsRepair, getApp } from "@/apps/store";
import { collectAppSyncStatus } from "@/apps/sync";
import { getAgentById } from "@/be/db";
import { AppQueryParamsError, applyQuery } from "@/http/apps";
import { can } from "@/rbac";
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
        "Get an app by ID, including its models, named queries, actions, and json-render pages definition. To edit, read less: outline: true returns the tree without props (pages with params and {nodeId: [type, childIds]}, model columns, queries, actions); path returns one subtree (dot path pages.main.elements.title or JSON pointer /pages/main/elements/title). Then change it with app-patch-node. A whole read also returns sourcesPath, the app's agent-fs folder for generators, backing-script drafts and NOTES.md (sourceFiles lists it when agent-fs is set up); read NOTES.md there first on a follow-up edit. For valid components, props and bindings, call app-catalog.",
      annotations: { readOnlyHint: true },
      rbac: { permission: "app.use" },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID to retrieve."),
        path: z
          .string()
          .min(1)
          .optional()
          .describe("Return only this definition subtree: a dot path or a JSON pointer."),
        outline: z
          .boolean()
          .optional()
          .describe("Return the definition outline without props instead of the whole app."),
      }),
      outputSchema: swarmToolOutputSchema({
        app: z.unknown().optional(),
        appId: z.string().optional(),
        updatedAt: z.string().optional(),
        path: z.string().optional(),
        value: z.unknown().optional(),
        outline: z.unknown().optional(),
        closest: z.array(z.string()).optional(),
        sourcesPath: z.string().optional(),
        sourceFiles: z.array(z.string()).optional(),
        warnings: z.array(z.string()).optional(),
      }),
    },
    async ({ appId, path, outline }, requestInfo) => {
      if (!requestInfo.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const agent = await getAgentById(requestInfo.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: requestInfo.agentId, isLead: agent?.isLead ?? false },
        verb: "app.use",
        resource: { kind: "app", appId },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);
      const app = await getApp(appId);
      if (!app) return toolErr(`App ${appId} not found.`);
      if (path !== undefined && outline) return toolErr("Give path or outline, not both.");
      if (path !== undefined) {
        const read = readDefinitionPath(app.definition, path);
        if (!read.ok) {
          return toolErr(`Path ${read.at} not found in app ${app.id}.`, {
            data: { appId: app.id, path, closest: read.closest },
          });
        }
        const data = { appId: app.id, updatedAt: app.updatedAt, path, value: read.value };
        return toolOk(`App "${app.name}" at ${path}.`, { details: JSON.stringify(data), data });
      }
      if (outline) {
        if (appDefinitionNeedsRepair(app)) {
          return toolErr("Definition needs repair; read it whole without outline.", {
            data: { appId: app.id },
          });
        }
        const data = {
          appId: app.id,
          updatedAt: app.updatedAt,
          outline: { name: app.name, ...appDefinitionOutline(app.definition) },
        };
        return toolOk(`App "${app.name}" outline.`, { details: JSON.stringify(data), data });
      }

      const syncStatus = await collectAppSyncStatus(app.id);
      const hasSyncStatus = Object.keys(syncStatus).length > 0;
      const sourcesPath = await appSourcesPath(app.id);
      const sources = await listAppSources(sourcesPath, requestInfo.agentId);
      const sourcesData = {
        sourcesPath,
        ...(sources.files ? { sourceFiles: sources.files } : {}),
        ...(sources.warning ? { warnings: [sources.warning] } : {}),
      };
      const sourcesLine = `Sources: ${sourcesPath}${sources.files ? ` (${sources.files.length > 0 ? sources.files.join(", ") : "empty"})` : ""}`;
      // Supplying `details` suppresses the registrar's JSON-data fallback, so
      // text-only harnesses must get the sync freshness surface here too.
      const details = hasSyncStatus
        ? `${JSON.stringify(app, null, 2)}\n\nSync status (model:source):\n${JSON.stringify(syncStatus, null, 2)}\n\n${sourcesLine}`
        : `${JSON.stringify(app, null, 2)}\n\n${sourcesLine}`;
      return toolOk(`App "${app.name}" (${app.id}).`, {
        details,
        data: { app, ...(hasSyncStatus ? { syncStatus } : {}), ...sourcesData },
      });
    },
  );
};

// app-query.ts re-exports this symbol to preserve its public wiring.
export const registerAppQueryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "app-query",
    {
      title: "Run an app query",
      description:
        "Run one declared named app query with optional $param values and return its rows.",
      annotations: { readOnlyHint: true },
      rbac: { permission: "app.use" },
      inputSchema: z.object({
        appId: z.string().min(1).describe("App ID containing the named query."),
        query: z.string().min(1).describe("Declared query name."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Values for any $param filters declared by the named query."),
      }),
      outputSchema: swarmToolOutputSchema({
        rows: z.array(z.looseObject({})).optional(),
        count: z.number().optional(),
        issues: z
          .array(z.looseObject({ path: z.string().optional(), message: z.string().optional() }))
          .optional(),
        missingParams: z.array(z.string()).optional(),
      }),
    },
    async ({ appId, query: queryName, params }, requestInfo) => {
      if (!requestInfo.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      const agent = await getAgentById(requestInfo.agentId);
      const decision = can({
        principal: { kind: "agent", agentId: requestInfo.agentId, isLead: agent?.isLead ?? false },
        verb: "app.use",
        resource: { kind: "app", appId },
        source: "mcp",
      });
      if (!decision.allow) return toolErr(decision.reason);
      const app = await getApp(appId);
      const query = app?.definition.queries?.[queryName];
      if (!app || !query) return toolErr(`App ${appId} or query "${queryName}" not found.`);
      const model = app.definition.models[query.model];
      if (!model) return toolErr(`Model "${query.model}" not found.`);
      let rows: AppRow[];
      try {
        rows = applyQuery(await listAppRows(app.id, query.model), query, model, params, queryName);
      } catch (error) {
        if (!(error instanceof AppQueryParamsError)) throw error;
        return toolErr(error.message, {
          details: error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
          data: { issues: error.issues, missingParams: error.missingNames },
        });
      }
      return toolOk(`Query "${queryName}" returned ${rows.length} row(s).`, {
        details: renderRows(rows),
        data: { rows, count: rows.length },
      });
    },
  );
};
