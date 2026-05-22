import { ensure } from "@desplega.ai/business-use";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  completeTask,
  createTaskExtended,
  failTask,
  getAgentById,
  getDb,
  getLeadAgent,
  getSessionLogsByTaskId,
  getTaskAttachments,
  getTaskById,
  insertTaskAttachment,
  updateAgentStatusFromCapacity,
  updateTaskProgress,
} from "@/be/db";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { getRetrievalsForTask } from "@/be/memory/raters/retrieval";
import { runServerRaters } from "@/be/memory/raters/run-server-raters";
import { resolveTemplate } from "@/prompts/resolver";
import { createToolRegistrar } from "@/tools/utils";
import { AgentTaskSchema, AttachmentInputSchema, type TaskAttachment } from "@/types";
// Side-effect import: registers task lifecycle templates in the in-memory registry
import "./templates";
import { validateJsonSchema } from "@/workflows/json-schema-validator";

// Phase 11: the `cost` / `costData` field was removed from this tool's input
// schema. Adapters (claude/codex/pi/opencode/devin/claude-managed) are the
// sole writers of `session_costs` rows via `POST /api/session-costs`. Agents
// calling `store-progress` rarely knew the real numbers and historically
// echoed the schema example, producing noise rows keyed `mcp-<taskId>-<ts>`
// that double-counted alongside the harness's authoritative entry.

function attachmentPointer(a: TaskAttachment): string {
  switch (a.kind) {
    case "url":
      return a.url ?? "";
    case "page":
      return `page:${a.pageId ?? ""}`;
    case "agent-fs":
      return `agent-fs:${a.path ?? ""}`;
    case "shared-fs":
      return `shared-fs:${a.path ?? ""}`;
  }
}

function formatAttachmentsBlock(attachments: TaskAttachment[]): string {
  if (attachments.length === 0) return "";
  const lines = attachments.map((a) => {
    const tag = a.isPrimary ? "[primary] " : "";
    const intent = a.intent ? ` (intent: ${a.intent})` : "";
    return `- ${tag}${a.name} — ${attachmentPointer(a)}${intent}`;
  });
  return `\n\nAttachments (${attachments.length}):\n${lines.join("\n")}`;
}

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
        attachments: z
          .array(AttachmentInputSchema)
          .max(20)
          .optional()
          .describe(
            "Pointer-based artifacts produced by this step — agent-fs path, URL, shared-fs path, or swarm Page. No inline file data; upload to agent-fs first and attach by path. May be sent on any call (progress or completion) and accumulates across calls; duplicates are de-duped by sha256 (when present) or by (kind, pointer, name).",
          ),
        // Phase 11: `costData` removed. The harness adapter is the sole
        // writer of `session_costs` (see POST /api/session-costs in the
        // runner). If a payload still includes the field, Zod's
        // `unknownKeys` default drops it silently.
      }),
      outputSchema: z.object({
        success: z.boolean(),
        message: z.string(),
        task: AgentTaskSchema.optional(),
        yourAgentId: z.string().optional(),
        wasNoOp: z
          .boolean()
          .optional()
          .describe(
            "True when the call was a no-op because the task was already in a terminal state (completed/failed/cancelled). First-call-wins.",
          ),
      }),
    },
    async (
      { taskId, progress, status, output, failureReason, attachments },
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

        // Idempotency guard: short-circuit terminal-status writes (completed/failed)
        // BEFORE any side-effects fire (event emission, memory write, follow-up task,
        // business-use ensure). Without this, a multi-session race causes duplicate
        // follow-up tasks to lead, vector index pollution, and spurious BU events.
        // First-call-wins: existing output / finishedAt are preserved.
        if (status && isTerminal) {
          return {
            success: true,
            message:
              `Task "${taskId}" is already ${existingTask.status}; treating as no-op. ` +
              `Existing output preserved (first-call-wins).`,
            task: existingTask,
            wasNoOp: true,
          };
        }

        // Attachments — pointer-based, append-only. Insert each row inside
        // this transaction; the helper dedups by sha256 (when present) or by
        // (kind, pointer, name), so idempotent re-calls don't fan out
        // duplicates. Intentionally NOT reached on the terminal-status no-op
        // short-circuit above (per Phase 1 spec).
        if (attachments && attachments.length > 0 && !isTerminal) {
          for (const a of attachments) {
            insertTaskAttachment({
              taskId,
              agentId: requestInfo.agentId ?? null,
              name: a.name,
              kind: a.kind,
              url: a.kind === "url" ? a.url : undefined,
              path: a.kind === "agent-fs" || a.kind === "shared-fs" ? a.path : undefined,
              pageId: a.kind === "page" ? a.pageId : undefined,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              sha256: a.sha256,
              intent: a.intent,
              description: a.description,
              isPrimary: a.isPrimary,
            });
          }
        }

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

            ensure({
              id: "completed",
              flow: "task",
              runId: taskId,
              depIds: existingTask.wasPaused ? ["started", "resumed"] : ["started"],
              data: {
                taskId,
                agentId: existingTask.agentId,
                previousStatus: existingTask.status,
                hasOutput: !!output,
              },
              validator: (data) => data.previousStatus === "in_progress",
              // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
              filter: ({}, ctx) => ctx.deps.length > 0,
              conditions: [{ timeout_ms: 3_600_000 }], // 1 hour
            });

            if (existingTask.agentId) {
              // Derive status from capacity instead of always setting idle
              updateAgentStatusFromCapacity(existingTask.agentId);
            }
          }
        } else if (status === "failed") {
          const result = failTask(taskId, failureReason ?? "Unknown failure");
          if (result) {
            updatedTask = result;

            ensure({
              id: "failed",
              flow: "task",
              runId: taskId,
              depIds: existingTask.wasPaused ? ["started", "resumed"] : ["started"],
              data: {
                taskId,
                agentId: existingTask.agentId,
                previousStatus: existingTask.status,
                failureReason: failureReason ?? "Unknown failure",
              },
              validator: (data) => data.previousStatus === "in_progress",
              // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
              filter: ({}, ctx) => ctx.deps.length > 0,
              conditions: [{ timeout_ms: 3_600_000 }], // 1 hour
            });

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

        // Phase 11: removed the per-call `session_costs` insert. The harness
        // adapter is the sole writer of cost rows now (via the runner's
        // `POST /api/session-costs`); store-progress historically wrote a
        // duplicate row keyed `mcp-<taskId>-<ts>` whenever an agent
        // hallucinated a `costData` payload.

        return {
          success: true,
          message: status
            ? `Task "${taskId}" marked as ${status}.`
            : `Progress stored for task "${taskId}".`,
          task: updatedTask,
        };
      });

      const result = txn();

      // Index completed and failed tasks as memory (async, non-blocking).
      // Skip on no-op (idempotent re-call on terminal task) to avoid duplicate
      // memory entries / vector index pollution.
      if (
        (status === "completed" || status === "failed") &&
        result.success &&
        result.task &&
        !("wasNoOp" in result && result.wasNoOp)
      ) {
        (async () => {
          try {
            const taskContent =
              status === "completed"
                ? `Task: ${result.task!.task}\n\nOutput:\n${output || "(no output)"}`
                : `Task: ${result.task!.task}\n\nFailure reason:\n${failureReason || "No reason provided"}\n\nThis task failed. Learn from this to avoid repeating the mistake.`;

            // Skip indexing if there's truly no content
            if (taskContent.length < 30) return;

            const store = getMemoryStore();
            const provider = getEmbeddingProvider();

            const memory = store.store({
              agentId: requestInfo.agentId ?? null,
              content: taskContent,
              name: `Task: ${result.task!.task.slice(0, 80)}`,
              scope: "agent",
              source: "task_completion",
              sourceTaskId: taskId,
            });
            const embedding = await provider.embed(taskContent);
            if (embedding) {
              store.updateEmbedding(memory.id, embedding, provider.name);
            }

            // Auto-promote high-value completions to swarm memory (P3)
            const shouldShareWithSwarm =
              status === "completed" &&
              (result.task!.taskType === "research" ||
                result.task!.tags?.includes("knowledge") ||
                result.task!.tags?.includes("shared"));

            if (shouldShareWithSwarm) {
              try {
                const swarmMemory = store.store({
                  agentId: requestInfo.agentId ?? null,
                  scope: "swarm",
                  name: `Shared: ${result.task!.task.slice(0, 80)}`,
                  content: `Task completed by agent ${requestInfo.agentId}:\n\n${taskContent}`,
                  source: "task_completion",
                  sourceTaskId: taskId,
                });
                const swarmEmbedding = await provider.embed(taskContent);
                if (swarmEmbedding) {
                  store.updateEmbedding(swarmMemory.id, swarmEmbedding, provider.name);
                }
              } catch {
                // Non-blocking — swarm memory promotion failure is not critical
              }
            }
          } catch {
            // Non-blocking — task completion memory failure should not affect task status
          }
        })();

        // Memory rater v1.5 — fire server-side raters on task completion.
        // Plan: thoughts/taras/plans/2026-05-05-memory-rater-v1.5/step-2.md §5
        //
        // Read `memory_retrieval` rows for this task + concatenated session_logs
        // and hand both to `runServerRaters`, which iterates the allow-listed
        // server raters (currently just `implicit-citation`), stamps source,
        // applies the configured weight multiplier, and persists via
        // `applyRating`. The orchestration is extracted so it can be unit-tested
        // with stub raters (see `src/tests/run-server-raters.test.ts`).
        //
        // Fire-and-forget: rater failure must NEVER affect task status.
        (async () => {
          try {
            const retrievals = getRetrievalsForTask(taskId);
            if (retrievals.length === 0) return;

            const retrievedMemoryIds = retrievals.map((r) => r.memoryId);
            const logs = getSessionLogsByTaskId(taskId);
            const evidence = logs.map((l) => l.content).join("\n");

            await runServerRaters({
              taskId,
              agentId: requestInfo.agentId ?? "",
              retrievedMemoryIds,
              evidence,
            });
          } catch (err) {
            console.error(
              "[store-progress] server-rater fire failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
        })();
      }

      // Create follow-up task for the lead when a worker task finishes.
      // This replaces the old poll-based tasks_finished trigger which was unreliable.
      // Skip for workflow-managed tasks — the workflow engine handles sequencing via resume.ts.
      // Skip on no-op (idempotent re-call on terminal task) to avoid duplicate follow-ups.
      if (
        status &&
        result.success &&
        result.task &&
        !result.task.workflowRunId &&
        !("wasNoOp" in result && result.wasNoOp)
      ) {
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
                const attachmentsBlock = formatAttachmentsBlock(getTaskAttachments(taskId));
                const outputSummary = output
                  ? `${output.slice(0, 500)}${output.length > 500 ? "..." : ""}${attachmentsBlock}`
                  : `(no output)${attachmentsBlock}`;
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
