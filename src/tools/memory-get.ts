import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentById } from "@/be/db";
import { getMemoryStore } from "@/be/memory";
import { canReadMemory } from "@/be/memory/access";
import { getLinksForMemory, type MemoryLinksResult } from "@/be/memory/links-store";
import { recordRetrievals } from "@/be/memory/raters/retrieval";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import type { AgentMemorySource } from "@/types";
import { AgentMemoryScopeSchema, AgentMemorySourceSchema } from "@/types";

const NUDGE_ELIGIBLE_SOURCES: ReadonlySet<AgentMemorySource> = new Set(["manual", "file_index"]);

// Loose, format-pin-free mirror of AgentMemorySchema for MCP output validation.
const agentMemoryOutputSchema = z.looseObject({
  id: z.string().optional(),
  agentId: z.string().nullable().optional(),
  scope: AgentMemoryScopeSchema.optional(),
  key: z.string().nullable().optional(),
  name: z.string().optional(),
  content: z.string().optional(),
  summary: z.string().nullable().optional(),
  source: AgentMemorySourceSchema.optional(),
  sourceTaskId: z.string().nullable().optional(),
  sourcePath: z.string().nullable().optional(),
  chunkIndex: z.number().int().optional(),
  totalChunks: z.number().int().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().nullable().optional(),
  accessedAt: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
  accessCount: z.number().int().optional(),
  embeddingModel: z.string().nullable().optional(),
  contentHash: z.string().nullable().optional(),
  version: z.number().int().optional(),
});

const LinkedMemoryRefSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  scope: z.string(),
});

const MemoryLinkSchema = z.looseObject({
  id: z.string(),
  linkType: z.string(),
  targetKind: z.string(),
  targetId: z.string(),
  strength: z.number(),
  resolver: z.string(),
  sourceText: z.string().nullable(),
  createdAt: z.string(),
  resolved: z
    .boolean()
    .describe(
      "For memory-kind targets: whether targetId points at a live memory you may read. Non-memory kinds (pr, agent-fs-file, …) are always resolved.",
    ),
  target: LinkedMemoryRefSchema.optional().describe(
    "Linked memory metadata — present only for resolved memory-kind links.",
  ),
});

const MemoryBacklinkSchema = z.looseObject({
  id: z.string(),
  linkType: z.string(),
  strength: z.number(),
  sourceText: z.string().nullable(),
  createdAt: z.string(),
  from: LinkedMemoryRefSchema.describe("The memory whose content links here."),
});

export const registerMemoryGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-get",
    {
      title: "Get memory details",
      description:
        "Retrieve the full content of a specific memory by its ID. Use memory-search to find memory IDs first.",
      annotations: { readOnlyHint: true },

      inputSchema: z.object({
        memoryId: z.uuid().describe("The ID of the memory to retrieve."),
        intent: z
          .string()
          .min(1)
          .describe(
            "Why you are retrieving this memory. Required. E.g. 'need full details of the auth fix pattern'.",
          ),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        memory: agentMemoryOutputSchema.optional(),
        links: z
          .array(MemoryLinkSchema)
          .optional()
          .describe("Outgoing memory_link rows resolved from this memory's content."),
        backlinks: z
          .array(MemoryBacklinkSchema)
          .optional()
          .describe("Other memories whose content links to this one (ACL-filtered)."),
        rateHint: z.string().optional(),
      }),
    },
    async ({ memoryId, intent }, requestInfo, _meta) => {
      const store = getMemoryStore();
      const memoryForAuth = store.peek(memoryId);

      if (!memoryForAuth) {
        return toolErr(`Memory "${memoryId}" not found.`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }

      if (!canReadMemory(memoryForAuth, requestInfo.agentId)) {
        return toolErr("Not authorized", { data: { yourAgentId: requestInfo.agentId } });
      }

      const memory = store.get(memoryId)!;

      if (requestInfo.sourceTaskId && requestInfo.agentId) {
        try {
          recordRetrievals(
            requestInfo.sourceTaskId,
            requestInfo.agentId,
            [{ memoryId: memory.id, similarity: 1.0 }],
            requestInfo.sessionId,
            { intent, contextKey: requestInfo.contextKey, eventType: "get" },
          );
        } catch (err) {
          console.error("[memory-get] recordRetrievals failed:", (err as Error).message);
        }
      }

      const inTaskContext = !!requestInfo.sourceTaskId;
      const rateHint =
        inTaskContext && NUDGE_ELIGIBLE_SOURCES.has(memory.source as AgentMemorySource)
          ? `memory_rate(id="${memory.id}", useful=true|false)`
          : undefined;

      // Link traversal (DES-639b) — best-effort: a graph read failure must
      // never break memory-get. Leads see all linked-memory metadata, same
      // as the memory-search visibility rules.
      let linkBlocks: MemoryLinksResult = { links: [], backlinks: [] };
      try {
        const agent = requestInfo.agentId ? getAgentById(requestInfo.agentId) : undefined;
        linkBlocks = getLinksForMemory(memory.id, {
          viewerAgentId: requestInfo.agentId,
          isLead: agent?.isLead ?? false,
        });
      } catch (err) {
        console.error("[memory-get] link traversal failed:", (err as Error).message);
      }

      const linksSummary =
        linkBlocks.links.length > 0 || linkBlocks.backlinks.length > 0
          ? `\n\n[${linkBlocks.links.length} outgoing link(s), ${linkBlocks.backlinks.length} backlink(s) — see structured output]`
          : "";

      return toolOk(`Memory "${memory.name}" retrieved.`, {
        details: `${memory.content}${linksSummary}`,
        data: {
          yourAgentId: requestInfo.agentId,
          memory,
          links: linkBlocks.links,
          backlinks: linkBlocks.backlinks,
          rateHint,
        },
      });
    },
  );
};
