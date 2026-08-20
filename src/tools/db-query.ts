import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { DbQueryInputShape, executeReadOnlyQueryGated, resolveDbQuerySql } from "@/http/db-query";
import { getDbQueryMcpBudgetMs, getDbQueryMcpMaxRows } from "@/http/db-query-shared";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

const DbQueryToolInputSchema = z
  .object({
    ...DbQueryInputShape,
    sql: z
      .string()
      .optional()
      .describe(
        "Read-only SQL query (writes are rejected). Runs with a wall-clock budget in a bounded child process by default, and results are capped at a default row count (operator-configurable via `DB_QUERY_MCP_MAX_ROWS`) — a query is safe to try even against a huge table. session_logs, agent_log, events, and task_context_snapshots are too large to read whole: filter on an indexed column (session_logs: taskId/sessionId; agent_log: agentId/taskId/eventType/createdAt) and add a LIMIT, don't COUNT(*)/SUM(...)/typeof() across the table, and don't split a large read into rowid chunks — each chunk still reads every row in its range. See the db-query-guidance skill for the operator config knobs (timeout, row cap, concurrency cap) if a query keeps timing out or getting rejected.",
      ),
    query: z.string().optional().describe("Deprecated runtime alias for sql."),
    params: z.array(z.any()).optional().default([]).describe("Query parameters"),
  })
  .refine((body) => body.sql !== undefined || body.query !== undefined, {
    message: "Either sql or query is required",
  });

export const registerDbQueryTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "db-query",
    {
      title: "Execute database query",
      description:
        "Execute a read-only SQL query against the swarm database (SQLite). Available to all authenticated agents — be aware results may include secrets (oauth_tokens, configs). Runs in a short-lived child process with a wall-clock budget by default (fails gracefully with a timeout or a 429-style concurrency error rather than freezing); results capped at a default row count (operator-configurable via `DB_QUERY_MCP_MAX_ROWS`) regardless of how many the query matched. See the sql parameter's description for which tables are unsafe to read whole, and the db-query-guidance skill for config knobs.",
      annotations: { readOnlyHint: true },
      inputSchema: DbQueryToolInputSchema,
      outputSchema: swarmToolOutputSchema({
        columns: z.array(z.string()).optional(),
        rows: z.array(z.array(z.any())).optional(),
        elapsed: z.number().optional(),
        total: z.number().optional(),
        truncated: z.boolean().optional(),
      }),
    },
    async (input, _requestInfo, _meta) => {
      try {
        const sql = resolveDbQuerySql(input);
        const params = input.params ?? [];
        const maxRows = getDbQueryMcpMaxRows();
        const result = await executeReadOnlyQueryGated(
          sql,
          params,
          getDbQueryMcpBudgetMs(),
          maxRows,
        );
        const truncated = result.total > maxRows;

        // Build a simple text table for Claude
        const header = result.columns.join(" | ");
        const separator = result.columns.map(() => "---").join(" | ");
        const dataRows = result.rows.map((row) => row.map((v) => String(v ?? "NULL")).join(" | "));
        const table = [header, separator, ...dataRows].join("\n");
        const suffix = truncated ? `\n(Showing ${maxRows} of ${result.total} rows)` : "";
        const details = `${table}${suffix}\n\n${result.total} rows in ${result.elapsed}ms`;

        return toolOk(`${result.total} row(s) in ${result.elapsed}ms`, {
          details,
          data: { ...result, truncated },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return toolErr(`Query error: ${message}`);
      }
    },
  );
};
