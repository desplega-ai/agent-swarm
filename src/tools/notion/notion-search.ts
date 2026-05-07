import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { notionFetch } from "@/notion/client";
import { createToolRegistrar } from "@/tools/utils";
import { hasNotionToken, notConnectedResult, notionErrorToResult, shapePageSummary } from "./utils";

const PageSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(["page", "database", "unknown"]),
  url: z.string().nullable(),
  lastEditedTime: z.string().nullable(),
  createdTime: z.string().nullable(),
  parent: z.object({ type: z.string(), id: z.string().optional() }).nullable(),
});

interface NotionSearchResponse {
  object: "list";
  results: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export const registerNotionSearchTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "notion-search",
    {
      title: "Notion Search",
      description:
        "Full-text search across pages and databases the integration has access to. Read-only. Notion ranks by edit recency. Pass `filter` to restrict to pages or databases.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        query: z.string().describe("Free-text search query (matches titles + content)."),
        filter: z
          .enum(["page", "database"])
          .optional()
          .describe("Restrict results to a single object type."),
        pageSize: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results per page (Notion default 100)."),
        startCursor: z
          .string()
          .optional()
          .describe("Cursor from a previous response's nextCursor."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        results: z.array(PageSummarySchema).optional(),
        nextCursor: z.string().nullable().optional(),
        hasMore: z.boolean().optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      }),
    },
    async (args, _requestInfo, _meta) => {
      if (!hasNotionToken()) return notConnectedResult();

      try {
        const body: Record<string, unknown> = { query: args.query };
        if (args.filter) {
          body.filter = { value: args.filter, property: "object" };
        }
        if (args.pageSize) body.page_size = args.pageSize;
        if (args.startCursor) body.start_cursor = args.startCursor;

        const data = await notionFetch<NotionSearchResponse>("/search", {
          method: "POST",
          body: JSON.stringify(body),
        });

        const results = (data.results ?? []).map(shapePageSummary);
        const summary = `Found ${results.length} result${results.length === 1 ? "" : "s"}${data.has_more ? " (more available)" : ""}.`;

        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            success: true,
            results,
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
