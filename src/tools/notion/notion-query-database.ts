import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { notionFetch } from "@/notion/client";
import { createToolRegistrar } from "@/tools/utils";
import {
  hasNotionToken,
  notConnectedResult,
  notionErrorToResult,
  shapePageProperties,
  shapePageSummary,
} from "./utils";

const PropertySummarySchema = z.object({ type: z.string(), preview: z.string() });

const RowSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(["page", "database", "unknown"]),
  url: z.string().nullable(),
  lastEditedTime: z.string().nullable(),
  createdTime: z.string().nullable(),
  parent: z.object({ type: z.string(), id: z.string().optional() }).nullable(),
  properties: z.record(z.string(), PropertySummarySchema),
});

interface NotionQueryResponse {
  object: "list";
  results: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionDatabaseRetrieveResponse {
  data_sources?: Array<{ id?: string; name?: string | null }>;
}

/**
 * Resolve a `database_id` to its primary `data_source_id` via
 * `GET /v1/databases/{database_id}` (which returns the `data_sources` array
 * under Notion API version 2025-09-03+). Throws if the database has no data
 * sources, or if it has multiple — multi-source databases require the caller
 * to pick one explicitly via `dataSourceId`.
 */
async function resolvePrimaryDataSourceId(databaseId: string): Promise<string> {
  const db = await notionFetch<NotionDatabaseRetrieveResponse>(`/databases/${databaseId}`);
  const sources = (db.data_sources ?? []).filter(
    (ds): ds is { id: string; name?: string | null } =>
      typeof ds.id === "string" && ds.id.length > 0,
  );
  if (sources.length === 0) {
    throw new Error(
      `Database ${databaseId} has no data sources. Either the integration lacks access, or Notion's response omitted the data_sources field — pin Notion-Version 2025-09-03 or newer.`,
    );
  }
  if (sources.length > 1) {
    const names = sources.map((s) => `${s.id}${s.name ? ` (${s.name})` : ""}`).join(", ");
    throw new Error(
      `Database ${databaseId} has multiple data sources — pass \`dataSourceId\` explicitly. Available: ${names}`,
    );
  }
  const primary = sources[0];
  if (!primary) {
    throw new Error(`Database ${databaseId} has no data sources after filtering.`);
  }
  return primary.id;
}

export const registerNotionQueryDatabaseTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "notion-query-database",
    {
      title: "Notion Query Database",
      description:
        "Query a Notion data source with filters and sorts. Read-only. Pass `dataSourceId` (preferred — get it from `notion-list-databases` `dataSources[*].id`); or pass `databaseId` to auto-resolve a single-source database's primary data source. The `filter` and `sorts` shapes match Notion's API exactly — see https://developers.notion.com/reference/query-a-data-source.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        dataSourceId: z
          .string()
          .optional()
          .describe(
            "Notion data source UUID (from `notion-list-databases`'s `dataSources[*].id`). Preferred. Required for multi-source databases.",
          ),
        databaseId: z
          .string()
          .optional()
          .describe(
            "Notion database UUID. Single-source databases only — multi-source databases must pass `dataSourceId`. NOTE: under Notion-Version 2025-09-03+, the database id is NOT directly queryable; this tool resolves it to the primary data source via `GET /v1/databases/{id}`.",
          ),
        filter: z
          .any()
          .optional()
          .describe(
            "Filter object as documented in the Notion API. Pass-through (no validation beyond the wire).",
          ),
        sorts: z
          .array(z.any())
          .optional()
          .describe("Sort descriptors as documented in the Notion API."),
        pageSize: z.number().int().min(1).max(100).optional(),
        startCursor: z.string().optional(),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        rows: z.array(RowSchema).optional(),
        nextCursor: z.string().nullable().optional(),
        hasMore: z.boolean().optional(),
        /** The data source the query actually ran against (resolved from `databaseId` when needed). */
        dataSourceId: z.string().optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      }),
    },
    async (args, _requestInfo, _meta) => {
      if (!hasNotionToken()) return notConnectedResult();

      try {
        let dataSourceId = args.dataSourceId;
        if (!dataSourceId) {
          if (!args.databaseId) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "notion-query-database: pass either `dataSourceId` (preferred) or `databaseId`.",
                },
              ],
              structuredContent: {
                success: false,
                reason: "invalid_args",
                message: "Either `dataSourceId` or `databaseId` is required.",
              },
            };
          }
          dataSourceId = await resolvePrimaryDataSourceId(args.databaseId);
        }

        const body: Record<string, unknown> = {};
        if (args.filter !== undefined) body.filter = args.filter;
        if (args.sorts !== undefined) body.sorts = args.sorts;
        if (args.pageSize) body.page_size = args.pageSize;
        if (args.startCursor) body.start_cursor = args.startCursor;

        const data = await notionFetch<NotionQueryResponse>(`/data_sources/${dataSourceId}/query`, {
          method: "POST",
          body: JSON.stringify(body),
        });

        const rows = (data.results ?? []).map((raw) => {
          const summary = shapePageSummary(raw);
          const properties = shapePageProperties(raw as Parameters<typeof shapePageProperties>[0]);
          return { ...summary, properties };
        });

        return {
          content: [
            {
              type: "text",
              text: `Query returned ${rows.length} row${rows.length === 1 ? "" : "s"}${data.has_more ? " (more available)" : ""}.`,
            },
          ],
          structuredContent: {
            success: true,
            rows,
            nextCursor: data.next_cursor ?? null,
            hasMore: !!data.has_more,
            dataSourceId,
          },
        };
      } catch (err) {
        return notionErrorToResult(err);
      }
    },
  );
};
