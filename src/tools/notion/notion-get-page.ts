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

const PageDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.enum(["page", "database", "unknown"]),
  url: z.string().nullable(),
  lastEditedTime: z.string().nullable(),
  createdTime: z.string().nullable(),
  parent: z.object({ type: z.string(), id: z.string().optional() }).nullable(),
  properties: z.record(z.string(), PropertySummarySchema),
  content: z.string().optional(),
  blocksWalked: z.number().optional(),
});

interface NotionPageResponse {
  id: string;
  object: "page";
  url: string | null;
  last_edited_time: string;
  created_time: string;
  parent?: { type?: string; database_id?: string; page_id?: string };
  properties?: Record<string, { type?: string }>;
}

interface NotionBlocksResponse {
  object: "list";
  results: unknown[];
  has_more?: boolean;
  next_cursor?: string | null;
}

const MAX_BLOCKS_DEFAULT = 200;
const MAX_BLOCKS_HARD_CAP = 500;

export const registerNotionGetPageTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "notion-get-page",
    {
      title: "Notion Get Page",
      description:
        "Fetch a Notion page by ID. Returns metadata + property previews. Set includeContent=true to also walk the block tree and return a plaintext rendering. Block walk is capped to keep responses agent-friendly — use `maxBlocks` to tune.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        pageId: z.string().describe("Notion page UUID (with or without dashes)."),
        includeContent: z
          .boolean()
          .optional()
          .describe("If true, walk page block children and return plaintext content."),
        maxBlocks: z
          .number()
          .int()
          .min(1)
          .max(MAX_BLOCKS_HARD_CAP)
          .optional()
          .describe(
            `Block walk cap (default ${MAX_BLOCKS_DEFAULT}, hard cap ${MAX_BLOCKS_HARD_CAP}).`,
          ),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        page: PageDetailSchema.optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      }),
    },
    async (args, _requestInfo, _meta) => {
      if (!hasNotionToken()) return notConnectedResult();

      try {
        const page = await notionFetch<NotionPageResponse>(`/pages/${args.pageId}`);
        const summary = shapePageSummary(page);
        const properties = shapePageProperties(page);

        let content: string | undefined;
        let blocksWalked: number | undefined;
        if (args.includeContent) {
          const cap = args.maxBlocks ?? MAX_BLOCKS_DEFAULT;
          const { text, count } = await walkBlocksToPlaintext(args.pageId, cap);
          content = text;
          blocksWalked = count;
        }

        return {
          content: [
            {
              type: "text",
              text: `Page "${summary.title}" — ${Object.keys(properties).length} properties${
                blocksWalked != null ? `, ${blocksWalked} blocks` : ""
              }.`,
            },
          ],
          structuredContent: {
            success: true,
            page: { ...summary, properties, content, blocksWalked },
          },
        };
      } catch (err) {
        return notionErrorToResult(err);
      }
    },
  );
};

interface NotionBlock {
  id: string;
  type?: string;
  has_children?: boolean;
  paragraph?: { rich_text?: Array<{ plain_text?: string }> };
  heading_1?: { rich_text?: Array<{ plain_text?: string }> };
  heading_2?: { rich_text?: Array<{ plain_text?: string }> };
  heading_3?: { rich_text?: Array<{ plain_text?: string }> };
  bulleted_list_item?: { rich_text?: Array<{ plain_text?: string }> };
  numbered_list_item?: { rich_text?: Array<{ plain_text?: string }> };
  to_do?: { rich_text?: Array<{ plain_text?: string }>; checked?: boolean };
  toggle?: { rich_text?: Array<{ plain_text?: string }> };
  quote?: { rich_text?: Array<{ plain_text?: string }> };
  code?: { rich_text?: Array<{ plain_text?: string }>; language?: string };
  callout?: { rich_text?: Array<{ plain_text?: string }> };
}

function joinRT(rt?: Array<{ plain_text?: string }>): string {
  return (rt ?? []).map((s) => s.plain_text ?? "").join("");
}

function blockToText(b: NotionBlock): string {
  switch (b.type) {
    case "paragraph":
      return joinRT(b.paragraph?.rich_text);
    case "heading_1":
      return `# ${joinRT(b.heading_1?.rich_text)}`;
    case "heading_2":
      return `## ${joinRT(b.heading_2?.rich_text)}`;
    case "heading_3":
      return `### ${joinRT(b.heading_3?.rich_text)}`;
    case "bulleted_list_item":
      return `- ${joinRT(b.bulleted_list_item?.rich_text)}`;
    case "numbered_list_item":
      return `1. ${joinRT(b.numbered_list_item?.rich_text)}`;
    case "to_do":
      return `${b.to_do?.checked ? "[x]" : "[ ]"} ${joinRT(b.to_do?.rich_text)}`;
    case "toggle":
      return `> ${joinRT(b.toggle?.rich_text)}`;
    case "quote":
      return `> ${joinRT(b.quote?.rich_text)}`;
    case "code":
      return "```" + (b.code?.language ?? "") + "\n" + joinRT(b.code?.rich_text) + "\n```";
    case "callout":
      return `[!] ${joinRT(b.callout?.rich_text)}`;
    default:
      return "";
  }
}

/** Walk the block tree rooted at `pageId`, flattening to plaintext. Honors `cap`. */
async function walkBlocksToPlaintext(
  pageId: string,
  cap: number,
): Promise<{ text: string; count: number }> {
  const out: string[] = [];
  let count = 0;

  async function walk(blockId: string): Promise<void> {
    if (count >= cap) return;
    let cursor: string | undefined;
    do {
      const path = `/blocks/${blockId}/children${cursor ? `?start_cursor=${encodeURIComponent(cursor)}` : ""}`;
      const data = await notionFetch<NotionBlocksResponse>(path);
      for (const raw of data.results ?? []) {
        if (count >= cap) return;
        const b = raw as NotionBlock;
        const line = blockToText(b);
        if (line) out.push(line);
        count += 1;
        if (b.has_children && count < cap) {
          await walk(b.id);
        }
      }
      cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
    } while (cursor && count < cap);
  }

  await walk(pageId);
  return { text: out.join("\n"), count };
}
