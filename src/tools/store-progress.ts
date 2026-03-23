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
  getEpicWithProgress,
  getLeadAgent,
  getTaskById,
  markEpicsProgressNotified,
  updateAgentStatusFromCapacity,
  updateMemoryEmbedding,
  updateTaskProgress,
} from "@/be/db";
import { getEmbedding, serializeEmbedding } from "@/be/embedding";
import { resolveTemplate } from "@/prompts/resolver";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";
// Side-effect import: registers task lifecycle templates in the in-memory registry
import "./templates";
import { validateJsonSchema } from "@/workflows/json-schema-validator";

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
      annotations: { idempotentHint: true },

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
        const isTerminal = ["completed", "failed", "cancelled"].includes(existingTask.status);

        // Update progress if provided (with deduplication)
        // Skip for tasks already in a terminal state to prevent zombie revival
        if (progress && !isTerminal) {
          // Skip if same progress text was set within the last 5 minutes
          const isDuplicate =
            existingTask.progress === progress &&
            existingTask.lastUpdatedAt &&
            Date.now() - new Date(existingTask.lastUpdatedAt).getTime() < 5 * 60 * 1000;

          if (!isDuplicate) {
            const result = updateTaskProgress(taskId, progress);
            if (result) updatedTask = result;
          }
        }

        // Validate structured output against outputSchema if present
        if (
          status === "completed" &&
          existingTask.outputSchema &&
          typeof existingTask.outputSchema === "object"
        ) {
          const schema = existingTask.outputSchema as Record<string, unknown>;
          if (!output) {
            return {
              success: false,
              message: `Task has an outputSchema but no output was provided. You must call store-progress with a valid JSON output matching this schema:\n${JSON.stringify(schema, null, 2)}`,
            };
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(output);
          } catch {
            return {
              success: false,
              message: `Task output must be valid JSON matching the outputSchema. Got invalid JSON. Schema:\n${JSON.stringify(schema, null, 2)}`,
            };
          }

          const validationErrors = validateJsonSchema(schema, parsed);
          if (validationErrors.length > 0) {
            return {
              success: false,
              message: `Task output does not match the outputSchema. Errors:\n${validationErrors.join("\n")}\n\nExpected schema:\n${JSON.stringify(schema, null, 2)}\n\nPlease fix your output and retry.`,
            };
          }
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
            // Epic-linked tasks are also promoted so workers on the same epic can see each other's learnings
            const shouldShareWithSwarm =
              status === "completed" &&
              (result.task!.taskType === "research" ||
                result.task!.tags?.includes("knowledge") ||
                result.task!.tags?.includes("shared") ||
                result.task!.epicId != null);

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
      // Skip for workflow-managed tasks — the workflow engine handles sequencing via resume.ts.
      if (status && result.success && result.task && !result.task.workflowRunId) {
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
                const outputSummary = output
                  ? `${output.slice(0, 500)}${output.length > 500 ? "..." : ""}`
                  : "(no output)";
                const completedResult = resolveTemplate("task.worker.completed", {
                  agent_name: agentName,
                  task_desc: taskDesc,
                  output_summary: outputSummary,
                  task_id: taskId,
                });
                followUpDescription = completedResult.text;
              } else {
                const reason = failureReason || "(no reason given)";
                const failedResult = resolveTemplate("task.worker.failed", {
                  agent_name: agentName,
                  task_desc: taskDesc,
                  failure_reason: reason,
                  task_id: taskId,
                });
                followUpDescription = failedResult.text;
              }

              // Enrich follow-up with epic context if task belongs to an epic
              let epicContext = "";
              if (result.task.epicId) {
                const epic = getEpicWithProgress(result.task.epicId);
                if (epic) {
                  epicContext = `\n\n## Epic Context\n`;
                  epicContext += `**Epic:** ${epic.name}\n`;
                  epicContext += `**Goal:** ${epic.goal}\n`;
                  epicContext += `**Progress:** ${epic.progress}% (${epic.taskStats.completed}/${epic.taskStats.total} tasks)\n`;
                  if (epic.plan) {
                    epicContext += `**Plan:**\n${epic.plan.slice(0, 1000)}\n`;
                  }
                  if (epic.nextSteps) {
                    epicContext += `**Next Steps:**\n${epic.nextSteps}\n`;
                  }
                  epicContext += `\n**Action Required:** Review the output above in the context of this epic. `;
                  epicContext += `If the epic goal is not yet met, create the next task(s) with epicId="${result.task.epicId}". `;
                  epicContext += `If blocked or unclear, notify the stakeholder. `;
                  epicContext += `If the goal is met, update the epic status to completed.`;
                }
              }

              // If the original task came from Slack, forward context so lead can reply
              createTaskExtended(followUpDescription + epicContext, {
                agentId: leadAgent.id,
                source: "system",
                taskType: "follow-up",
                parentTaskId: taskId,
                epicId: result.task.epicId || undefined,
                slackChannelId: result.task.slackChannelId,
                slackThreadTs: result.task.slackThreadTs,
                slackUserId: result.task.slackUserId,
              });

              // Deduplicate: mark epic progress as notified so epic_progress_changed
              // doesn't re-fire for this same task completion
              if (result.task.epicId) {
                markEpicsProgressNotified([result.task.epicId]);
              }

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
