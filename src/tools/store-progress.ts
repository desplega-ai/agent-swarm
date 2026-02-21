import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  completeTask,
  createMemory,
  createSessionCost,
  createTaskExtended,
  failTask,
  getAgentById,
  getDb,
  getLeadAgent,
  getTaskById,
  updateAgentStatusFromCapacity,
  updateMemoryEmbedding,
  updateTaskProgress,
} from "@/be/db";
import { getEmbedding, serializeEmbedding } from "@/be/embedding";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

// Schema for optional cost data that agents can self-report
const CostDataSchema = z
  .object({
    totalCostUsd: z.number().min(0).describe("Total cost in USD"),
    inputTokens: z.number().int().min(0).optional().describe("Input tokens used"),
    outputTokens: z.number().int().min(0).optional().describe("Output tokens used"),
    cacheReadTokens: z.number().int().min(0).optional().describe("Cache read tokens"),
    cacheWriteTokens: z.number().int().min(0).optional().describe("Cache write tokens"),
    durationMs: z.number().int().min(0).optional().describe("Duration in milliseconds"),
    numTurns: z.number().int().min(1).optional().describe("Number of turns/iterations"),
    model: z.string().optional().describe("Model used (e.g., 'opus', 'sonnet')"),
  })
  .describe("Optional cost data for tracking session costs");

export const registerStoreProgressTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "store-progress",
    {
      title: "Store task progress",
      description:
        "Stores the progress of a specific task. Can also mark task as completed or failed, which will set the agent back to idle.",
      inputSchema: z.object({
        taskId: z.uuid().describe("The ID of the task to update progress for."),
        progress: z.string().optional().describe("The progress update to store."),
        status: z
          .enum(["completed", "failed"])
          .optional()
          .describe("Set to 'completed' or 'failed' to finish the task."),
        output: z.string().optional().describe("The output of the task (used when completing)."),
        failureReason: z
          .string()
          .optional()
          .describe("The reason for failure (used when failing)."),
        costData: CostDataSchema.optional().describe(
          "Optional cost data for tracking session costs. When provided, a session cost record will be created linked to this task.",
        ),
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
      }),
    },
    async ({ taskId, progress, status, output, failureReason, costData }, requestInfo, _meta) => {
      if (!requestInfo.agentId) {
        return {
          content: [
            {
              type: "text",
              text: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: 'Agent ID not found. The MCP client should define the "X-Agent-ID" header.',
          },
        };
      }

      const txn = getDb().transaction(() => {
        const agent = getAgentById(requestInfo.agentId ?? "");

        if (!agent) {
          return {
            success: false,
            message: `Agent with ID "${requestInfo.agentId}" not found in the swarm, register before storing task progress.`,
          };
        }

        const existingTask = getTaskById(taskId);

        if (!existingTask) {
          return {
            success: false,
            message: `Task with ID "${taskId}" not found.`,
          };
        }

        let updatedTask = existingTask;

        // Update progress if provided
        if (progress) {
          const result = updateTaskProgress(taskId, progress);
          if (result) updatedTask = result;
        }

        // Handle status change
        if (status === "completed") {
          const result = completeTask(taskId, output);
          if (result) {
            updatedTask = result;
            if (existingTask.agentId) {
              // Derive status from capacity instead of always setting idle
              updateAgentStatusFromCapacity(existingTask.agentId);
            }
          }
        } else if (status === "failed") {
          const result = failTask(taskId, failureReason ?? "Unknown failure");
          if (result) {
            updatedTask = result;
            if (existingTask.agentId) {
              // Derive status from capacity instead of always setting idle
              updateAgentStatusFromCapacity(existingTask.agentId);
            }
          }
        } else {
          // Progress update - ensure status reflects current load
          if (existingTask.agentId) {
            updateAgentStatusFromCapacity(existingTask.agentId);
          }
        }

        // Store cost data if provided (agents can self-report costs)
        if (costData && requestInfo.agentId) {
          createSessionCost({
            sessionId: `mcp-${taskId}-${Date.now()}`, // Generate unique session ID for MCP-based tasks
            taskId,
            agentId: requestInfo.agentId,
            totalCostUsd: costData.totalCostUsd,
            inputTokens: costData.inputTokens ?? 0,
            outputTokens: costData.outputTokens ?? 0,
            cacheReadTokens: costData.cacheReadTokens ?? 0,
            cacheWriteTokens: costData.cacheWriteTokens ?? 0,
            durationMs: costData.durationMs ?? 0,
            numTurns: costData.numTurns ?? 1,
            model: costData.model ?? "unknown",
            isError: status === "failed",
          });
        }

        return {
          success: true,
          message: status
            ? `Task "${taskId}" marked as ${status}.`
            : `Progress stored for task "${taskId}".`,
          task: updatedTask,
        };
      });

      const result = txn();

      // Index completed and failed tasks as memory (async, non-blocking)
      if ((status === "completed" || status === "failed") && result.success && result.task) {
        (async () => {
          try {
            const taskContent =
              status === "completed"
                ? `Task: ${result.task!.task}\n\nOutput:\n${output || "(no output)"}`
                : `Task: ${result.task!.task}\n\nFailure reason:\n${failureReason || "No reason provided"}\n\nThis task failed. Learn from this to avoid repeating the mistake.`;

            // Skip indexing if there's truly no content
            if (taskContent.length < 30) return;

            const memory = createMemory({
              agentId: requestInfo.agentId,
              content: taskContent,
              name: `Task: ${result.task!.task.slice(0, 80)}`,
              scope: "agent",
              source: "task_completion",
              sourceTaskId: taskId,
            });
            const embedding = await getEmbedding(taskContent);
            if (embedding) {
              updateMemoryEmbedding(memory.id, serializeEmbedding(embedding));
            }

            // Auto-promote high-value completions to swarm memory (P3)
            const shouldShareWithSwarm =
              status === "completed" &&
              (result.task!.taskType === "research" ||
                result.task!.tags?.includes("knowledge") ||
                result.task!.tags?.includes("shared"));

            if (shouldShareWithSwarm) {
              try {
                const swarmMemory = createMemory({
                  agentId: requestInfo.agentId,
                  scope: "swarm",
                  name: `Shared: ${result.task!.task.slice(0, 80)}`,
                  content: `Task completed by agent ${requestInfo.agentId}:\n\n${taskContent}`,
                  source: "task_completion",
                  sourceTaskId: taskId,
                });
                const swarmEmbedding = await getEmbedding(taskContent);
                if (swarmEmbedding) {
                  updateMemoryEmbedding(swarmMemory.id, serializeEmbedding(swarmEmbedding));
                }
              } catch {
                // Non-blocking — swarm memory promotion failure is not critical
              }
            }
          } catch {
            // Non-blocking — task completion memory failure should not affect task status
          }
        })();
      }

      // Create follow-up task for the lead when a worker task finishes.
      // This replaces the old poll-based tasks_finished trigger which was unreliable.
      if (status && result.success && result.task) {
        try {
          const taskAgent = getAgentById(result.task.agentId ?? "");
          // Only create follow-ups for worker tasks (not lead's own tasks)
          if (taskAgent && !taskAgent.isLead) {
            const leadAgent = getLeadAgent();
            if (leadAgent) {
              const agentName = taskAgent.name || result.task.agentId?.slice(0, 8) || "Unknown";
              const taskDesc = result.task.task.slice(0, 200);

              let followUpDescription: string;
              if (status === "completed") {
                const outputSummary = output ? output.slice(0, 500) : "(no output)";
                followUpDescription = `Worker task completed — review needed.\n\nAgent: ${agentName}\nTask: "${taskDesc}"\n\nOutput:\n${outputSummary}${output && output.length > 500 ? "..." : ""}\n\nUse \`get-task-details\` with taskId "${taskId}" for full details.`;
              } else {
                const reason = failureReason || "(no reason given)";
                followUpDescription = `Worker task failed — action needed.\n\nAgent: ${agentName}\nTask: "${taskDesc}"\n\nFailure reason: ${reason}\n\nDecide whether to reassign, retry, or handle the failure. Use \`get-task-details\` with taskId "${taskId}" for full details.`;
              }

              // If the original task came from Slack, forward context so lead can reply
              createTaskExtended(followUpDescription, {
                agentId: leadAgent.id,
                source: "system",
                taskType: "follow-up",
                parentTaskId: taskId,
                slackChannelId: result.task.slackChannelId,
                slackThreadTs: result.task.slackThreadTs,
                slackUserId: result.task.slackUserId,
              });

              console.log(
                `[store-progress] Created follow-up task for lead (${leadAgent.name}) — ${status} task ${taskId.slice(0, 8)} by ${agentName}`,
              );
            }
          }
        } catch (err) {
          // Non-blocking — follow-up task creation failure should not affect the store-progress response
          console.warn(`[store-progress] Failed to create follow-up task: ${err}`);
        }
      }

      return {
        content: [{ type: "text", text: result.message }],
        structuredContent: {
          yourAgentId: requestInfo.agentId,
          ...result,
        },
      };
    },
  );
};
