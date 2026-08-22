import { ensure } from "@desplega.ai/business-use";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  completeTask,
  failTask,
  getAgentById,
  getDbClient,
  getResolvedConfig,
  getSessionLogsByTaskId,
  getTaskById,
  insertTaskAttachment,
  updateAgentStatusFromCapacity,
  updateTaskProgress,
} from "@/be/db";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { getRetrievalsForTask } from "@/be/memory/raters/retrieval";
import { runServerRaters } from "@/be/memory/raters/run-server-raters";
import { AgentFsProvider } from "@/fs/agent-fs-provider";
import { shouldPersistTaskCompletionMemory } from "@/memory/automatic-task-gate";
import {
  getTaskOutputValidationError,
  guardTerminalTaskResultWrite,
} from "@/tasks/terminal-result-guard";
import { createWorkerTaskFollowUp } from "@/tasks/worker-follow-up";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { AgentTaskStatusSchema, AttachmentInputSchema, isTerminalTaskStatus } from "@/types";
import { scrubSecrets } from "../utils/secret-scrubber";

// Phase 11: the `cost` / `costData` field was removed from this tool's input
// schema. Adapters (claude/codex/pi/opencode/devin/claude-managed) are the
// sole writers of `session_costs` rows via `POST /api/session-costs`. Agents
// calling `store-progress` rarely knew the real numbers and historically
// echoed the schema example, producing noise rows keyed `mcp-<taskId>-<ts>`
// that double-counted alongside the harness's authoritative entry.

export const storeProgressOutputSchema = swarmToolOutputSchema({
  // Bounded confirmation only. The handler keeps the full task row internally
  // for completion memory, raters, and follow-up creation, but never echoes it
  // across the MCP boundary.
  task: z
    .looseObject({
      id: z.string(),
      status: AgentTaskStatusSchema,
      finishedAt: z.string().optional(),
    })
    .optional(),
  // Plain string, NOT .uuid(): agents may join with custom IDs (AGENT_ID env /
  // join-swarm agentId), and a UUID constraint here makes the response fail MCP
  // output validation after the handler already ran.
  yourAgentId: z.string().optional(),
  wasNoOp: z
    .boolean()
    .optional()
    .describe(
      "True when the call was a no-op because the task was already in a terminal state (completed/failed/cancelled). First-call-wins.",
    ),
  wasForcedOverwrite: z
    .boolean()
    .optional()
    .describe(
      "True when force: true replaced output and/or failureReason on an already-terminal task without replaying completion side effects.",
    ),
});

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
        output: z
          .string()
          .optional()
          .describe(
            "The task result (used when completing). For Slack-originated tasks, this is published verbatim in the thread's outcome card: provide a concrete summary scaled to what was asked, including only the outcome and any links or IDs the human needs—not process narration, a transcript, or a restatement of the brief.",
          ),
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
        persistMemory: z
          .boolean()
          .optional()
          .describe(
            "Opt in to task_completion memory persistence for automatic/recurring tasks. Manual tasks are persisted by default; scheduled, system, heartbeat/boot-triage, monitor, and digest tasks are skipped unless this is true.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "On an already-terminal task, overwrite explicitly provided output and/or failureReason text while preserving status and finishedAt and without replaying events, memory writes, follow-up creation, business-use ensure, or capacity updates. Differing terminal text is otherwise discarded and reported as a failure.",
          ),
        // Phase 11: `costData` removed. The harness adapter is the sole
        // writer of `session_costs` (see POST /api/session-costs in the
        // runner). If a payload still includes the field, Zod's
        // `unknownKeys` default drops it silently.
      }),
      outputSchema: storeProgressOutputSchema,
    },
    async (
      { taskId, progress, status, output, failureReason, attachments, persistMemory, force },
      requestInfo,
      _meta,
    ) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. The MCP client should define the "X-Agent-ID" header.');
      }

      // Verify agent-fs pointers before opening the write transaction. The
      // registering agent's resolved config selects both credentials and the
      // exact org/drive; never let the provider fall back to a personal drive.
      // Keeping the resolved scope per input also guarantees the verified pair
      // is the pair persisted below.
      const agentFsScopes = new Map<object, { orgId: string; driveId: string }>();
      const agentFsAttachments = attachments?.filter((a) => a.kind === "agent-fs") ?? [];
      if (agentFsAttachments.length > 0) {
        // Validate the caller and target before an agent-fs lookup. Otherwise a
        // forged X-Agent-ID or unknown task could use this tool as a file-existence
        // oracle through the API-owned agent-fs credential fallback.
        if (!(await getAgentById(requestInfo.agentId))) {
          return toolErr(
            `Agent with ID "${requestInfo.agentId}" not found in the swarm, register before storing task progress.`,
          );
        }
        if (!(await getTaskById(taskId))) {
          return toolErr(`Task with ID "${taskId}" not found.`);
        }

        const configs = await getResolvedConfig(requestInfo.agentId ?? undefined);
        const configValue = (key: string) => configs.find((c) => c.key === key)?.value?.trim();
        const defaultOrgId = configValue("AGENT_FS_DEFAULT_ORG_ID");
        const defaultDriveId = configValue("AGENT_FS_DEFAULT_DRIVE_ID");
        const apiUrl = configValue("AGENT_FS_API_URL") || process.env.AGENT_FS_API_URL?.trim();
        const apiKey =
          configValue("AGENT_FS_API_KEY") ||
          configValue("API_AGENT_FS_API_KEY") ||
          process.env.AGENT_FS_API_KEY?.trim() ||
          process.env.API_AGENT_FS_API_KEY?.trim();

        for (const attachment of agentFsAttachments) {
          const hasExplicitScope = Boolean(attachment.orgId || attachment.driveId);
          const orgId = (hasExplicitScope ? attachment.orgId : defaultOrgId)?.trim();
          const driveId = (hasExplicitScope ? attachment.driveId : defaultDriveId)?.trim();
          if (!orgId || !driveId) {
            return toolErr(
              `Agent-fs attachment "${attachment.name}" cannot be verified: both orgId and driveId must resolve from the attachment or the registering agent's config. No attachment was registered and task state was unchanged.`,
            );
          }
          agentFsScopes.set(attachment, { orgId, driveId });
        }

        if (!apiUrl || !apiKey) {
          return toolErr(
            "Agent-fs attachments cannot be verified because the registering agent's agent-fs API URL or credential is unavailable. No attachment was registered and task state was unchanged.",
          );
        }

        const firstScope = agentFsScopes.get(agentFsAttachments[0]!);
        if (!firstScope) {
          return toolErr("Agent-fs attachment scope resolution failed.");
        }
        const provider = new AgentFsProvider({ apiUrl, apiKey, ...firstScope });
        const verificationErrors = await Promise.all(
          agentFsAttachments.map(async (attachment) => {
            const scope = agentFsScopes.get(attachment);
            if (!scope) return "Agent-fs attachment scope resolution failed.";
            try {
              await provider.head({
                taskId,
                name: attachment.name,
                key: attachment.path,
                ...scope,
              });
              return undefined;
            } catch (error) {
              const detail = scrubSecrets(error instanceof Error ? error.message : String(error));
              return `Agent-fs attachment "${attachment.name}" does not resolve at orgId=${scope.orgId}, driveId=${scope.driveId}, path=${attachment.path}: ${detail}.`;
            }
          }),
        );
        const verificationError = verificationErrors.find((error) => error !== undefined);
        if (verificationError) {
          return toolErr(
            `${verificationError} No attachment was registered and task state was unchanged.`,
          );
        }
      }

      const result = await getDbClient().transaction(async () => {
        const agent = await getAgentById(requestInfo.agentId ?? "");

        if (!agent) {
          return {
            success: false,
            message: `Agent with ID "${requestInfo.agentId}" not found in the swarm, register before storing task progress.`,
          };
        }

        const existingTask = await getTaskById(taskId);

        if (!existingTask) {
          return {
            success: false,
            message: `Task with ID "${taskId}" not found.`,
          };
        }

        let updatedTask = existingTask;
        const isTerminal = isTerminalTaskStatus(existingTask.status);

        // Attachments — pointer-based, append-only. Insert each row inside
        // this transaction; the helper dedups by sha256 (when present) or by
        // (kind, pointer, name), so idempotent re-calls don't fan out
        // duplicates. Run BEFORE the terminal-status short-circuit: smoke
        // tests and post-completion artifact uploads target already-completed
        // tasks, and the schema explicitly documents that attachments "may be
        // sent on any call (progress or completion) and accumulate across
        // calls." Status writes still no-op on terminal tasks (see below);
        // attachment writes don't change task state, so they're safe to
        // accept on any status.
        if (attachments && attachments.length > 0) {
          for (const a of attachments) {
            let orgId = a.kind === "agent-fs" ? a.orgId : undefined;
            let driveId = a.kind === "agent-fs" ? a.driveId : undefined;
            if (a.kind === "agent-fs") {
              const verifiedScope = agentFsScopes.get(a);
              orgId = verifiedScope?.orgId;
              driveId = verifiedScope?.driveId;
            }

            await insertTaskAttachment({
              taskId,
              agentId: requestInfo.agentId ?? null,
              name: a.name,
              kind: a.kind,
              url: a.kind === "url" ? a.url : undefined,
              path: a.kind === "agent-fs" || a.kind === "shared-fs" ? a.path : undefined,
              pageId: a.kind === "page" ? a.pageId : undefined,
              providerId: a.providerId ?? (a.kind === "agent-fs" ? "agent-fs" : undefined),
              providerKey: a.providerKey ?? (a.kind === "agent-fs" ? a.path : undefined),
              capabilities: a.capabilities,
              orgId,
              driveId,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              sha256: a.sha256,
              intent: a.intent,
              description: a.description,
              isPrimary: a.isPrimary,
            });
          }
        }

        // Idempotency guard: short-circuit terminal-status writes (completed/failed)
        // BEFORE any side-effects fire (event emission, memory write, follow-up task,
        // business-use ensure). Without this, a multi-session race causes duplicate
        // follow-up tasks to lead, vector index pollution, and spurious BU events.
        // First-call-wins by default: existing result text / finishedAt are preserved.
        // A caller may explicitly force a text-only correction; that path returns
        // before every terminal side effect and deliberately leaves all lifecycle
        // fields untouched.
        const terminalResultGuard = await guardTerminalTaskResultWrite(existingTask, {
          status,
          output,
          failureReason,
          force,
        });
        if (terminalResultGuard.handled) {
          return terminalResultGuard;
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
            const result = await updateTaskProgress(taskId, progress);
            if (result) updatedTask = result;
          }
        }

        // Validate structured output against outputSchema if present
        if (status === "completed") {
          const outputValidationError = getTaskOutputValidationError(
            existingTask.outputSchema,
            output,
          );
          if (outputValidationError) {
            return { success: false, message: outputValidationError };
          }
        }

        // Handle status change
        if (status === "completed") {
          const result = await completeTask(taskId, output);
          if (result) {
            updatedTask = result;

            // afterCommit: the transaction can still roll back (e.g. a later
            // capacity update throws) — business-use must not be told the
            // task completed for a write that never landed.
            getDbClient().afterCommit(() => {
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
            });

            if (existingTask.agentId) {
              // Derive status from capacity instead of always setting idle
              await updateAgentStatusFromCapacity(existingTask.agentId);
            }
          }
        } else if (status === "failed") {
          const result = await failTask(taskId, failureReason ?? "Unknown failure");
          if (result) {
            updatedTask = result;

            // afterCommit: mirrors the "completed" branch above — dropped if
            // this transaction rolls back.
            getDbClient().afterCommit(() => {
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
            });

            if (existingTask.agentId) {
              // Derive status from capacity instead of always setting idle
              await updateAgentStatusFromCapacity(existingTask.agentId);
            }
          }
        } else {
          // Progress update - ensure status reflects current load
          if (existingTask.agentId) {
            await updateAgentStatusFromCapacity(existingTask.agentId);
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

      const shouldRunTerminalSideEffects =
        (status === "completed" || status === "failed") &&
        result.success &&
        result.task &&
        !("wasNoOp" in result && result.wasNoOp) &&
        !("wasForcedOverwrite" in result && result.wasForcedOverwrite);

      // Index completed and failed tasks as memory (async, non-blocking).
      // Skip on no-op (idempotent re-call on terminal task) to avoid duplicate
      // memory entries / vector index pollution.
      // Automatic/recurring tasks are noisy by default; require explicit opt-in.
      if (
        shouldRunTerminalSideEffects &&
        shouldPersistTaskCompletionMemory(result.task, persistMemory)
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

            const memory = await store.store({
              agentId: requestInfo.agentId ?? null,
              content: taskContent,
              name: `Task: ${result.task!.task.slice(0, 80)}`,
              scope: "agent",
              source: "task_completion",
              sourceTaskId: taskId,
            });
            const embedding = await provider.embed(taskContent);
            if (embedding) {
              await store.updateEmbedding(memory.id, embedding, provider.name);
            }

            // Auto-promote high-value completions to swarm memory (P3)
            const shouldShareWithSwarm =
              status === "completed" &&
              (result.task!.taskType === "research" ||
                result.task!.tags?.includes("knowledge") ||
                result.task!.tags?.includes("shared"));

            if (shouldShareWithSwarm) {
              try {
                const swarmMemory = await store.store({
                  agentId: requestInfo.agentId ?? null,
                  scope: "swarm",
                  name: `Shared: ${result.task!.task.slice(0, 80)}`,
                  content: `Task completed by agent ${requestInfo.agentId}:\n\n${taskContent}`,
                  source: "task_completion",
                  sourceTaskId: taskId,
                });
                const swarmEmbedding = await provider.embed(taskContent);
                if (swarmEmbedding) {
                  await store.updateEmbedding(swarmMemory.id, swarmEmbedding, provider.name);
                }
              } catch {
                // Non-blocking — swarm memory promotion failure is not critical
              }
            }
          } catch {
            // Non-blocking — task completion memory failure should not affect task status
          }
        })().catch((err) =>
          console.error(
            "[store-progress] task completion memory write failed:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
      }

      if (shouldRunTerminalSideEffects) {
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
            const retrievals = await getRetrievalsForTask(taskId);
            if (retrievals.length === 0) return;

            const retrievedMemoryIds = retrievals.map((r) => r.memoryId);
            const logs = await getSessionLogsByTaskId(taskId);
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
        })().catch((err) =>
          console.error(
            "[store-progress] server rater run failed:",
            scrubSecrets(err instanceof Error ? err.message : String(err)),
          ),
        );
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
        !("wasNoOp" in result && result.wasNoOp) &&
        !("wasForcedOverwrite" in result && result.wasForcedOverwrite)
      ) {
        try {
          const followUp = await createWorkerTaskFollowUp({
            task: result.task,
            status,
            output,
            failureReason,
          });
          if (followUp) {
            console.log(
              `[store-progress] Created follow-up task ${followUp.id.slice(0, 8)} for ${status} task ${taskId.slice(0, 8)}`,
            );
          }
        } catch (err) {
          // Non-blocking — follow-up task creation failure should not affect the store-progress response
          console.warn(`[store-progress] Failed to create follow-up task: ${err}`);
        }
      }

      const { success, message } = result;
      const task = result.task
        ? {
            id: result.task.id,
            status: result.task.status,
            ...(result.task.finishedAt ? { finishedAt: result.task.finishedAt } : {}),
          }
        : undefined;
      const data = {
        yourAgentId: requestInfo.agentId,
        ...(task ? { task } : {}),
        ...("wasNoOp" in result && result.wasNoOp ? { wasNoOp: true } : {}),
        ...("wasForcedOverwrite" in result && result.wasForcedOverwrite
          ? { wasForcedOverwrite: true }
          : {}),
      };
      return success ? toolOk(message, { data }) : toolErr(message, { data });
    },
  );
};
