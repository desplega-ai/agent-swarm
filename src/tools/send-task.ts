import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createTaskExtended,
  getActiveTaskCount,
  getAgentById,
  getDb,
  getEpicById,
  getTaskById,
  hasCapacity,
} from "@/be/db";
import { findDuplicateTask } from "@/tools/task-dedup";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema } from "@/types";

export const registerSendTaskTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "send-task",
    {
      title: "Send a task",
      description:
        "Sends a task to a specific agent, creates an unassigned task for the pool, or offers a task for acceptance.",
      inputSchema: z.object({
        agentId: z
          .uuid()
          .optional()
          .describe("The agent to assign/offer task to. Omit to create unassigned task for pool."),
        task: z.string().min(1).describe("The task description to send."),
        offerMode: z
          .boolean()
          .default(false)
          .describe("If true, offer the task instead of direct assign (agent must accept/reject)."),
        taskType: z
          .string()
          .max(50)
          .optional()
          .describe("Task type (e.g., 'bug', 'feature', 'review')."),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tags for filtering (e.g., ['urgent', 'frontend'])."),
        priority: z
          .number()
          .int()
          .min(0)
          .max(100)
          .optional()
          .describe("Priority 0-100 (default: 50)."),
        dependsOn: z.array(z.uuid()).optional().describe("Task IDs this task depends on."),
        epicId: z.string().uuid().optional().describe("Epic to associate this task with."),
        parentTaskId: z
          .uuid()
          .optional()
          .describe(
            "Parent task ID for session continuity. Child task will resume the parent's Claude session. Auto-routes to the same worker unless agentId is explicitly provided.",
          ),
        githubRepo: z
          .string()
          .optional()
          .describe(
            "GitHub repo identifier (e.g., 'desplega-ai/agent-swarm'). Links the task to a registered repo for workspace context.",
          ),
        allowDuplicate: z
          .boolean()
          .default(false)
          .describe(
            "If true, skip duplicate detection and create the task even if a similar one exists.",
          ),
      }),
      outputSchema: z.object({
        yourAgentId: z.string().uuid().optional(),
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
      }),
    },
    async (
      {
        agentId,
        task,
        offerMode,
        taskType,
        tags,
        priority,
        dependsOn,
        epicId,
        parentTaskId,
        githubRepo,
        allowDuplicate,
      },
      requestInfo,
      _meta,
    ) => {
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

      if (agentId === requestInfo.agentId) {
        return {
          content: [
            {
              type: "text",
              text: "Cannot send a task to yourself, are you drunk?",
            },
          ],
          structuredContent: {
            yourAgentId: requestInfo.agentId,
            success: false,
            message: "Cannot send a task to yourself, are you drunk?",
          },
        };
      }

      // Validate epicId and auto-inherit githubRepo from epic if not explicitly provided
      let effectiveGithubRepo = githubRepo;
      if (epicId) {
        const epic = getEpicById(epicId);
        if (!epic) {
          return {
            content: [{ type: "text", text: `Epic not found: ${epicId}` }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: `Epic not found: ${epicId}`,
            },
          };
        }
        if (!githubRepo && epic.githubRepo) {
          effectiveGithubRepo = epic.githubRepo;
        }
      }

      // Auto-route to parent's worker if parentTaskId is set and no explicit agentId
      let effectiveAgentId = agentId;
      if (parentTaskId && !agentId) {
        const parentTask = getTaskById(parentTaskId);
        if (parentTask?.agentId) {
          effectiveAgentId = parentTask.agentId;
        }
      }

      // Dedup guard: check for similar recent tasks
      if (!allowDuplicate && requestInfo.agentId) {
        const duplicate = findDuplicateTask({
          taskDescription: task,
          creatorAgentId: requestInfo.agentId,
          targetAgentId: effectiveAgentId ?? undefined,
        });
        if (duplicate) {
          const msg = `Duplicate task detected (matches task ${duplicate.task.id.slice(0, 8)}, ${duplicate.reason}). Skipping. Use allowDuplicate: true to override.`;
          return {
            content: [{ type: "text", text: msg }],
            structuredContent: {
              yourAgentId: requestInfo.agentId,
              success: false,
              message: msg,
            },
          };
        }
      }

      const txn = getDb().transaction(() => {
        // Build tags with epic tag if epicId is provided
        const finalTags = epicId ? [...(tags || []), `epic:${getEpicById(epicId)?.name}`] : tags;

        // If no agentId (and no auto-routed agentId), create an unassigned task for the pool
        if (!effectiveAgentId) {
          const newTask = createTaskExtended(task, {
            creatorAgentId: requestInfo.agentId,
            taskType,
            tags: finalTags,
            priority,
            dependsOn,
            epicId,
            parentTaskId,
            githubRepo: effectiveGithubRepo,
          });

          return {
            success: true,
            message: `Created unassigned task "${newTask.id}" in the pool.`,
            task: newTask,
          };
        }

        const agent = getAgentById(effectiveAgentId);

        if (!agent) {
          return {
            success: false,
            message: `Agent with ID "${effectiveAgentId}" not found.`,
          };
        }

        if (agent.isLead) {
          return {
            success: false,
            message: `Cannot assign tasks to the lead agent "${agent.name}", wtf?`,
          };
        }

        // For direct assignment (not offer), check if agent has capacity
        if (!offerMode && !hasCapacity(effectiveAgentId)) {
          const activeCount = getActiveTaskCount(effectiveAgentId);
          return {
            success: false,
            message: `Agent "${agent.name}" is at capacity (${activeCount}/${agent.maxTasks ?? 1} tasks). Use offerMode: true to offer the task instead, or wait for a task to complete.`,
          };
        }

        if (offerMode) {
          // Offer the task to the agent (they must accept/reject)
          const newTask = createTaskExtended(task, {
            offeredTo: effectiveAgentId,
            creatorAgentId: requestInfo.agentId,
            taskType,
            tags: finalTags,
            priority,
            dependsOn,
            epicId,
            parentTaskId,
            githubRepo: effectiveGithubRepo,
          });

          return {
            success: true,
            message: `Task "${newTask.id}" offered to agent "${agent.name}". They must accept or reject it.`,
            task: newTask,
          };
        }

        // Direct assignment
        const newTask = createTaskExtended(task, {
          agentId: effectiveAgentId,
          creatorAgentId: requestInfo.agentId,
          taskType,
          tags: finalTags,
          priority,
          dependsOn,
          epicId,
          parentTaskId,
          githubRepo: effectiveGithubRepo,
        });

        return {
          success: true,
          message: `Task "${newTask.id}" sent to agent "${agent.name}".`,
          task: newTask,
        };
      });

      const result = txn();

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
