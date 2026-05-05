import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { createToolRegistrar } from "@/tools/utils";

/**
 * Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-5.md §1
 *
 * Worker-facing MCP tool. Posts a single explicit-self `RatingEvent` to the
 * existing `POST /api/memory/rate` endpoint shipped in step-3 and surfaces
 * server status codes as structured `{ success, message }` output instead of
 * throwing — so an agent that mis-uses the tool gets a clear, recoverable
 * answer rather than a tool-call exception.
 *
 * The brainstorm-canonical input is `(id, useful, note?)`. Step-6 will extend
 * the input with an optional `referencesSource` field; do NOT add it here.
 */

const DUPLICATE_MESSAGE =
  "Memory already rated for this task. Use a follow-up memory_rerate tool (coming soon) to override.";

export const registerMemoryRateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "memory_rate",
    {
      title: "Rate a memory",
      description:
        "Rate a memory you used in the current task. Call this when a " +
        "retrieved memory was clearly useful (or actively misleading) so " +
        "the swarm learns to surface better memories next time.",
      annotations: { destructiveHint: false },
      inputSchema: z.object({
        id: z.string().describe("Memory ID returned by memory_search."),
        useful: z
          .boolean()
          .describe("true = this memory helped solve the task; false = misled or wasted time."),
        note: z
          .string()
          .max(280)
          .optional()
          .describe("Short reason. Captured for telemetry; not surfaced to other agents."),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
      }),
    },
    async ({ id, useful, note }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        const msg = "Agent ID required. Are you registered in the swarm?";
        return {
          content: [{ type: "text", text: msg }],
          structuredContent: { success: false, message: msg },
        };
      }
      if (!requestInfo.sourceTaskId) {
        const msg = "memory_rate must be called from within a task — no source task ID was found.";
        return {
          content: [{ type: "text", text: msg }],
          structuredContent: { success: false, message: msg },
        };
      }

      const apiUrl = process.env.MCP_BASE_URL || `http://localhost:${process.env.PORT || "3013"}`;
      const apiKey = process.env.API_KEY || "";

      const event = {
        memoryId: id,
        signal: useful ? 1 : -1,
        weight: 1.0,
        source: "explicit-self" as const,
        reasoning: note ?? "",
        taskId: requestInfo.sourceTaskId,
      };

      try {
        const response = await fetch(`${apiUrl}/api/memory/rate`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            "X-Agent-ID": requestInfo.agentId,
          },
          body: JSON.stringify({ events: [event] }),
        });

        if (response.status === 409) {
          return {
            content: [{ type: "text", text: DUPLICATE_MESSAGE }],
            structuredContent: { success: false, message: DUPLICATE_MESSAGE },
          };
        }

        if (response.status === 400) {
          let serverError = "";
          try {
            const body = (await response.json()) as { error?: string };
            serverError = body?.error ?? "";
          } catch {
            // body wasn't JSON
          }
          const msg = serverError
            ? `Memory rating rejected: ${serverError}. The memory must have been retrieved by this task before it can be rated.`
            : "Memory rating rejected. The memory must have been retrieved by this task before it can be rated.";
          return {
            content: [{ type: "text", text: msg }],
            structuredContent: { success: false, message: msg },
          };
        }

        if (!response.ok) {
          const msg = `Memory rating failed (HTTP ${response.status}).`;
          return {
            content: [{ type: "text", text: msg }],
            structuredContent: { success: false, message: msg },
          };
        }

        const successMsg = `Memory ${id} rated as ${useful ? "useful" : "not useful"}.`;
        return {
          content: [{ type: "text", text: successMsg }],
          structuredContent: { success: true, message: successMsg },
        };
      } catch (err) {
        const msg = `Memory rating failed: ${(err as Error).message}`;
        return {
          content: [{ type: "text", text: msg }],
          structuredContent: { success: false, message: msg },
        };
      }
    },
  );
};
