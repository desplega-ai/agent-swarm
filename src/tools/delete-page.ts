import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deletePage, getAgentById, getPage, getPageBySlug } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar } from "@/tools/utils";

export const registerDeletePageTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "delete-page",
    {
      title: "Delete Page",
      description:
        "Permanently delete one page by pageId, or by slug in the caller's page namespace. Only the lead or the page owner can delete a page.",
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        pageId: z.string().min(1).optional().describe("Page ID to delete."),
        slug: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Page slug to delete from the caller's own (agentId, slug) namespace. Alternative to pageId.",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().optional(),
        success: z.boolean(),
        message: z.string(),
        deletedPage: z
          .object({
            id: z.string(),
            slug: z.string(),
            title: z.string(),
          })
          .optional(),
      }),
    },
    async ({ pageId, slug }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: 'Agent ID not found. Set the "X-Agent-ID" header.' }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. Set the "X-Agent-ID" header.',
          },
        };
      }

      if (!pageId && !slug) {
        return {
          content: [{ type: "text", text: "Either pageId or slug must be provided." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Either pageId or slug must be provided.",
          },
        };
      }

      const caller = getAgentById(requestInfo.agentId);
      if (!caller) {
        return {
          content: [{ type: "text", text: "Agent not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Agent not found.",
          },
        };
      }

      const page = pageId
        ? getPage(pageId)
        : slug
          ? getPageBySlug(requestInfo.agentId, slug)
          : null;
      if (!page) {
        return {
          content: [{ type: "text", text: "Page not found." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Page not found.",
          },
        };
      }

      const decision = can({
        principal: { kind: "agent", agentId: caller.id, isLead: caller.isLead },
        verb: "page.delete.any",
        resource: { kind: "owned", ownerAgentId: page.agentId },
        source: "mcp",
      });
      if (!decision.allow) {
        return {
          content: [{ type: "text", text: "Only the lead or page owner can delete pages." }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Only the lead or page owner can delete pages.",
          },
        };
      }

      try {
        const deleted = deletePage(page.id);
        if (!deleted) {
          return {
            content: [{ type: "text", text: "Failed to delete page." }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: "Failed to delete page.",
            },
          };
        }

        const deletedPage = {
          id: page.id,
          slug: page.slug,
          title: page.title,
        };
        return {
          content: [{ type: "text", text: `Deleted page "${page.title}".` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: true,
            message: `Deleted page "${page.title}".`,
            deletedPage,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to delete page: ${message}` }],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: `Failed to delete page: ${message}`,
          },
        };
      }
    },
  );
};
