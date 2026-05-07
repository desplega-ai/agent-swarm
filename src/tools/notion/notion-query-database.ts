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

export const registerNotionQueryDatabaseTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "notion-query-database",
    {
      title: "Notion Query Database",
      description:
        "Query a Notion database with filters and sorts. Read-only. The `filter` and `sorts` shapes match Notion's API exactly — see https://developers.notion.com/reference/post-database-query.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        databaseId: z.string().describe("Notion database UUID."),
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
        reason: z.string().optional(),
        message: z.string().optional(),
      }),
    },
    async (args, _requestInfo, _meta) => {
      if (!hasNotionToken()) return notConnectedResult();

      try {
        const body: Record<string, unknown> = {};
        if (args.filter !== undefined) body.filter = args.filter;
        if (args.sorts !== undefined) body.sorts = args.sorts;
        if (args.pageSize) body.page_size = args.pageSize;
        if (args.startCursor) body.start_cursor = args.startCursor;

        const data = await notionFetch<NotionQueryResponse>(`/databases/${args.databaseId}/query`, {
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
          },
        };
      } catch (err) {
        return notionErrorToResult(err);
      }
    },
  );
};
