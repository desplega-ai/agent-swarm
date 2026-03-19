import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { executeReadOnlyQuery } from "@/http/db-query";
import { createToolRegistrar } from "@/tools/utils";

const MCP_MAX_ROWS = 100;

export const registerDbQueryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "db-query",
    {
      title: "Execute database query",
      description:
        "Execute a read-only SQL query against the swarm database. Lead-only. Results capped at 100 rows.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        sql: z.string().describe("SQL query (read-only only — writes are rejected)"),
        params: z.array(z.any()).optional().default([]).describe("Query parameters"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        columns: z.array(z.string()),
        rows: z.array(z.array(z.any())),
        elapsed: z.number(),
        total: z.number(),
        truncated: z.boolean(),
      }),
    },
    async ({ sql, params }, requestInfo, _meta) => {
      const callerAgent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : null;
      if (!callerAgent?.isLead) {
        return {
          content: [{ type: "text" as const, text: "Only the lead agent can use this tool." }],
          structuredContent: {
            success: false,
            columns: [],
            rows: [],
            elapsed: 0,
            total: 0,
            truncated: false,
          },
        };
      }

      try {
        const result = executeReadOnlyQuery(sql, params, MCP_MAX_ROWS);
        const truncated = result.total > MCP_MAX_ROWS;

        // Build a simple text table for Claude
        const header = result.columns.join(" | ");
        const separator = result.columns.map(() => "---").join(" | ");
        const dataRows = result.rows.map((row) => row.map((v) => String(v ?? "NULL")).join(" | "));
        const table = [header, separator, ...dataRows].join("\n");
        const suffix = truncated ? `\n(Showing ${MCP_MAX_ROWS} of ${result.total} rows)` : "";
        const text = `${table}${suffix}\n\n${result.total} rows in ${result.elapsed}ms`;

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: { success: true, ...result, truncated },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Query error: ${message}` }],
          structuredContent: {
            success: false,
            columns: [],
            rows: [],
            elapsed: 0,
            total: 0,
            truncated: false,
          },
        };
      }
    },
  );
};
