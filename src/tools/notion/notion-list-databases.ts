import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { notionFetch } from "@/notion/client";
import { createToolRegistrar } from "@/tools/utils";
import {
  hasNotionToken,
  notConnectedResult,
  notionErrorToResult,
  shapeDatabaseSummary,
} from "./utils";

const DataSourceRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const DatabaseSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  lastEditedTime: z.string().nullable(),
  properties: z.record(z.string(), z.string()),
  dataSources: z.array(DataSourceRefSchema),
});

interface NotionSearchResponse {
  object: "list";
  results: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

export const registerNotionListDatabasesTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "notion-list-databases",
    {
      title: "Notion List Databases",
      description:
        "Discover all Notion databases the integration has access to. Returns id, title, description, a property-name → property-type schema preview, and `dataSources` (an array of `{ id, name }` entries). Pass `dataSources[*].id` — NOT the database id — to `notion-query-database`. Read-only.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        pageSize: z.number().int().min(1).max(100).optional(),
        startCursor: z.string().optional(),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        databases: z.array(DatabaseSummarySchema).optional(),
        nextCursor: z.string().nullable().optional(),
        hasMore: z.boolean().optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      }),
    },
    async (args, _requestInfo, _meta) => {
      if (!hasNotionToken()) return notConnectedResult();

      try {
        const body: Record<string, unknown> = {
          // /v1/search with object filter is the documented way to enumerate
          // accessible databases; the dedicated /databases list endpoint is
          // deprecated.
          filter: { value: "database", property: "object" },
        };
        if (args.pageSize) body.page_size = args.pageSize;
        if (args.startCursor) body.start_cursor = args.startCursor;

        const data = await notionFetch<NotionSearchResponse>("/search", {
          method: "POST",
          body: JSON.stringify(body),
        });

        const databases = (data.results ?? []).map(shapeDatabaseSummary);

        return {
          content: [
            {
              type: "text",
              text: `Found ${databases.length} database${databases.length === 1 ? "" : "s"}${data.has_more ? " (more available)" : ""}.`,
            },
          ],
          structuredContent: {
            success: true,
            databases,
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
