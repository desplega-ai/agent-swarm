import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { indexMemoryContent } from "@/be/memory/index-content";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { AgentMemoryScopeSchema } from "@/types";

export const registerMemoryStoreTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory-store",
    {
      title: "Store a memory",
      description:
        "Store a learning as a searchable memory: a fix, a pattern, a gotcha, a fact about a repo or a person. Use it when you solve something that will come back. Scope 'agent' is visible only to you. Scope 'swarm' is visible to every agent. Long content is split into chunks and embedded in the background. Search first with memory-search when a similar memory may exist, then edit it with memory-edit instead of storing a duplicate.",
      annotations: { destructiveHint: false },

      inputSchema: z.object({
        content: z
          .string()
          .min(1)
          .describe(
            "The memory body. Markdown is fine. State the fact, the context it applies to, and the evidence.",
          ),
        name: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Short title used in search results and the UI. Defaults to the first non-empty content line (up to 200 characters).",
          ),
        scope: AgentMemoryScopeSchema.default("agent").describe(
          "'agent' (default): only you can recall it. 'swarm': every agent can recall it.",
        ),
        tags: z
          .union([z.array(z.string()), z.string()])
          .optional()
          .describe(
            "Free-form tags as an array or a comma-separated string, for example a repo name or a topic.",
          ),
        taskId: z
          .uuid()
          .optional()
          .describe("The task this learning came from, when there is one."),
        intent: z
          .string()
          .min(1)
          .optional()
          .describe("Why this is worth remembering. Kept in the audit trail."),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        memoryIds: z.array(z.string()).optional(),
        chunks: z.number().int().optional(),
        queued: z.boolean().optional(),
      }),
    },
    async ({ content, name: requestedName, scope, tags, taskId, intent }, requestInfo, _meta) => {
      const name =
        requestedName ??
        content
          .split(/\r?\n/)
          .find((line) => line.trim())
          ?.trim()
          .slice(0, 200) ??
        "Untitled memory";
      const normalizedTags =
        typeof tags === "string"
          ? tags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)
          : tags;
      if (!requestInfo.agentId) {
        return toolErr("Agent ID required. Are you registered in the swarm?");
      }

      try {
        // The caller always owns the row, for both scopes: a swarm memory still
        // records who wrote it (mirrors inject-learning).
        const result = await indexMemoryContent({
          agentId: requestInfo.agentId,
          content,
          name,
          scope,
          source: "manual",
          sourceTaskId: taskId ?? null,
          tags: normalizedTags,
          intent,
        });

        return toolOk(
          `Memory "${name}" stored as ${result.chunks} chunk(s) in ${scope} scope. Embedding runs in the background.`,
          {
            data: {
              yourAgentId: requestInfo.agentId,
              memoryIds: result.memoryIds,
              chunks: result.chunks,
              queued: result.queued,
            },
          },
        );
      } catch (err) {
        return toolErr(`Memory store failed: ${(err as Error).message}`, {
          data: { yourAgentId: requestInfo.agentId },
        });
      }
    },
  );
};
