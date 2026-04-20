import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createTaskExtended,
  findCompletedTaskInThread,
  getActiveTaskCount,
  getAgentById,
  getDb,
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
      annotations: { destructiveHint: false },
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
        parentTaskId: z
          .uuid()
          .optional()
          .describe(
            "Parent task ID for session continuity. Child task will resume the parent's Claude session. Auto-routes to the same worker unless agentId is explicitly provided.",
          ),
        dir: z
          .string()
          .min(1)
          .startsWith("/")
          .optional()
          .describe(
            "Working directory (absolute path) for the agent to start in. If the directory doesn't exist, falls back to the default working directory.",
          ),
        vcsRepo: z
          .string()
          .optional()
          .describe(
            "VCS repo identifier (e.g., 'desplega-ai/agent-swarm' for GitHub or 'group/project' for GitLab). Links the task to a registered repo for workspace context.",
          ),
        model: z
          .enum(["haiku", "sonnet", "opus"])
          .optional()
          .describe(
            "Model to use for this task ('haiku', 'sonnet', or 'opus'). If not set, uses agent/global config MODEL_OVERRIDE or defaults to 'opus'.",
          ),
        allowDuplicate: z
          .boolean()
          .default(false)
          .describe(
            "If true, skip duplicate detection and create the task even if a similar one exists.",
          ),
        slackChannelId: z
          .string()
          .optional()
          .describe(
            "Slack channel ID to post progress updates to. Use this to propagate Slack context when delegating from a Slack thread.",
          ),
        slackThreadTs: z
          .string()
          .optional()
          .describe(
            "Slack thread timestamp. Required with slackChannelId for thread-level updates.",
          ),
        slackUserId: z.string().optional().describe("Slack user ID of the original requester."),
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
        dir,
        parentTaskId,
        vcsRepo,
        model,
        allowDuplicate,
        slackChannelId,
        slackThreadTs,
        slackUserId,
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

      const effectiveVcsRepo = vcsRepo;

      // Auto-default parentTaskId to caller's current task for tree tracking
      const effectiveParentTaskId = parentTaskId ?? requestInfo.sourceTaskId;

      // Auto-route to parent's worker if parentTaskId is set and no explicit agentId
      let effectiveAgentId = agentId;
      if (effectiveParentTaskId && !agentId) {
        const parentTask = getTaskById(effectiveParentTaskId);
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

      // Guard: prevent re-delegation from follow-up tasks
      // When the source task is a "follow-up" (worker completed/failed notification),
      // check if there are completed tasks in the same Slack thread recently.
      // This prevents the cycle: worker completes → follow-up → Lead re-delegates → repeat.
      if (requestInfo.sourceTaskId) {
        const sourceTask = getTaskById(requestInfo.sourceTaskId);
        if (
          sourceTask?.taskType === "follow-up" &&
          sourceTask.slackThreadTs &&
          sourceTask.slackChannelId
        ) {
          const recentCompleted = findCompletedTaskInThread(
            sourceTask.slackChannelId,
            sourceTask.slackThreadTs,
            2880, // 48 hours in minutes
          );
          if (recentCompleted) {
            const msg = `Blocked: re-delegation from follow-up task in a thread that already has completed work (task ${recentCompleted.id.slice(0, 8)}). The original request was already handled.`;
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
      }

      const txn = getDb().transaction(() => {
        const finalTags = tags;

        // If no agentId (and no auto-routed agentId), create an unassigned task for the pool
        if (!effectiveAgentId) {
          const newTask = createTaskExtended(task, {
            creatorAgentId: requestInfo.agentId,
            sourceTaskId: requestInfo.sourceTaskId,
            taskType,
            tags: finalTags,
            priority,
            dependsOn,
            dir,
            parentTaskId: effectiveParentTaskId,
            vcsRepo: effectiveVcsRepo,
            model,
            slackChannelId,
            slackThreadTs,
            slackUserId,
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
            sourceTaskId: requestInfo.sourceTaskId,
            taskType,
            tags: finalTags,
            priority,
            dependsOn,
            dir,
            parentTaskId: effectiveParentTaskId,
            vcsRepo: effectiveVcsRepo,
            model,
            slackChannelId,
            slackThreadTs,
            slackUserId,
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
          sourceTaskId: requestInfo.sourceTaskId,
          taskType,
          tags: finalTags,
          priority,
          dependsOn,
          dir,
          parentTaskId: effectiveParentTaskId,
          vcsRepo: effectiveVcsRepo,
          model,
          slackChannelId,
          slackThreadTs,
          slackUserId,
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
