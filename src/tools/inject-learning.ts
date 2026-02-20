import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createMemory, getAgentById, updateMemoryEmbedding } from "@/be/db";
import { getEmbedding, serializeEmbedding } from "@/be/embedding";
import { createToolRegistrar } from "@/tools/utils";

const LearningCategoryEnum = z.enum([
  "mistake-pattern",
  "best-practice",
  "codebase-knowledge",
  "preference",
]);

export const registerInjectLearningTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "inject-learning",
    {
      title: "Inject learning into worker memory",
      description:
        "Allows the lead agent to push learnings into a worker's memory. The learning will be stored as a searchable memory entry that the worker can recall in future sessions.",
      inputSchema: z.object({
        agentId: z.uuid().describe("Target worker agent ID"),
        learning: z.string().min(1).describe("The learning content to inject"),
        category: LearningCategoryEnum.describe(
          "Category of the learning: mistake-pattern, best-practice, codebase-knowledge, or preference",
        ),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        memoryId: z.string().optional(),
      }),
    },
    async ({ agentId: targetAgentId, learning, category }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [{ type: "text", text: "Agent ID not found." }],
          structuredContent: {
            success: false,
            message: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
          },
        };
      }

      // Validate caller is the lead agent
      const callerAgent = getAgentById(requestInfo.agentId);
      if (!callerAgent || !callerAgent.isLead) {
        return {
          content: [{ type: "text", text: "Only the lead agent can inject learnings." }],
          structuredContent: {
            success: false,
            message: "Only the lead agent can inject learnings into worker memory.",
          },
        };
      }

      // Validate target agent exists
      const targetAgent = getAgentById(targetAgentId);
      if (!targetAgent) {
        return {
          content: [{ type: "text", text: `Agent "${targetAgentId}" not found.` }],
          structuredContent: {
            success: false,
            message: `Agent with ID "${targetAgentId}" not found in the swarm.`,
          },
        };
      }

      // Create agent-scoped memory for the target worker
      const content = `[Lead Feedback — ${category}]\n\n${learning}`;
      const memory = createMemory({
        agentId: targetAgentId,
        scope: "agent",
        name: `Lead feedback: ${category} — ${learning.slice(0, 60)}`,
        content,
        source: "manual",
      });

      // Generate and store embedding (async, best-effort)
      try {
        const embedding = await getEmbedding(content);
        if (embedding) {
          updateMemoryEmbedding(memory.id, serializeEmbedding(embedding));
        }
      } catch {
        // Non-blocking — memory was created, embedding is optional
      }

      const targetName = targetAgent.name || targetAgentId.slice(0, 8);
      return {
        content: [
          {
            type: "text",
            text: `Learning injected into ${targetName}'s memory (category: ${category}).`,
          },
        ],
        structuredContent: {
          success: true,
          message: `Learning injected into ${targetName}'s memory (category: ${category}).`,
          memoryId: memory.id,
        },
      };
    },
  );
};
