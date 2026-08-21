import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { deletePage, getAgentById, getPage, getPageBySlug } from "@/be/db";
import { can } from "@/rbac";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

const DeletedPageSchema = z.looseObject({
  id: z.string().optional(),
  slug: z.string().optional(),
  title: z.string().optional(),
});

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
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        deletedPage: DeletedPageSchema.optional(),
      }),
    },
    async ({ pageId, slug }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
      }

      if (!pageId && !slug) {
        return toolErr("Either pageId or slug must be provided.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      const caller = await getAgentById(requestInfo.agentId);
      if (!caller) {
        return toolErr("Agent not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      const page = pageId
        ? await getPage(pageId)
        : slug
          ? await getPageBySlug(requestInfo.agentId, slug)
          : null;
      if (!page) {
        return toolErr("Page not found.", { data: { yourAgentId: requestInfo.agentId } });
      }

      const decision = can({
        principal: { kind: "agent", agentId: caller.id, isLead: caller.isLead },
        verb: "page.delete.any",
        resource: { kind: "owned", ownerAgentId: page.agentId },
        source: "mcp",
      });
      if (!decision.allow) {
        return toolErr("Only the lead or page owner can delete pages.", {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      try {
        const deleted = await deletePage(page.id);
        if (!deleted) {
          return toolErr("Failed to delete page.", {
            data: { yourAgentId: requestInfo.agentId },
          });
        }

        const deletedPage = {
          id: page.id,
          slug: page.slug,
          title: page.title,
        };
        return toolOk(`Deleted page "${page.title}".`, {
          data: { yourAgentId: requestInfo.agentId, deletedPage },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return toolErr(`Failed to delete page: ${message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
