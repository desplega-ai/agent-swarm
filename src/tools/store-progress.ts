import { ensure } from "@desplega.ai/business-use";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  completeTask,
  createLogEntry,
  failTask,
  getAgentById,
  getDbClient,
  getResolvedConfig,
  getTaskById,
  insertTaskAttachment,
  updateAgentStatusFromCapacity,
  updateTaskProgress,
} from "@/be/db";
import {
  CitationInputSchema,
  getTaskCitations,
  hasTaskCitationCheckRefusal,
  MAX_TASK_CITATIONS,
  upsertTaskCitations,
} from "@/be/task-citations";
import { AgentFsProvider } from "@/fs/agent-fs-provider";
import { runTaskTerminalEffects } from "@/tasks/task-terminal-effects";
import {
  getTaskOutputValidationError,
  guardTerminalTaskResultWrite,
} from "@/tasks/terminal-result-guard";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";
import { AgentTaskStatusSchema, AttachmentInputSchema, isTerminalTaskStatus } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { taskCitationIssues, taskCitationWarnings } from "@/utils/task-citations";

// Phase 11: the `cost` / `costData` field was removed from this tool's input
// schema. Adapters (claude/codex/pi/opencode/devin/claude-managed) are the
// sole writers of `session_costs` rows via `POST /api/session-costs`. Agents
// calling `store-progress` rarely knew the real numbers and historically
// echoed the schema example, producing noise rows keyed `mcp-<taskId>-<ts>`
// that double-counted alongside the harness's authoritative entry.

// Deliberately narrow and phrase-based (not a bare "wait"/"block" substring
// match) to under-fire rather than over-fire: measured against 196 real
// progress rows across all statuses, this matched 0 — see PR body for the
// full false-positive measurement methodology.
const BLOCKED_WAITING_PATTERN =
  /\b(waiting (for|on)|blocked (on|until|by)|still waiting|awaiting)\b/i;

// Below this, two check-ins are close enough together that "blocked" reads as
// noise and calling defer-task buys nothing over checking in again shortly.
const BLOCKED_WAITING_MIN_ELAPSED_MS = 3 * 60 * 1000;

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
  blockedWaitingElapsedMs: z
    .number()
    .optional()
    .describe(
      "Present only when this progress text reads as blocked-waiting: milliseconds since the task's prior update. Drives the store-progress nudge toward defer-task.",
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
        taskId: z
          .uuid()
          .optional()
          .describe(
            "Full task UUID. Defaults to the caller-owned task in X-Source-Task-Id; required outside task context.",
          ),
        progress: z.string().optional().describe("The progress update to store."),
        status: z
          .enum(["completed", "failed", "in_progress", "pending"])
          .optional()
          .describe(
            "Set to 'completed' or 'failed' to finish the task. 'in_progress' and 'pending' store progress only and do not change task status.",
          ),
        output: z
          .string()
          .optional()
          .describe(
            "The task result (used when completing). For Slack-originated tasks, this is published verbatim in the thread's outcome card. Keep free-text output under 120 words by default. Name the result and every artifact link, plus any IDs the human needs. Link documents instead of inlining them; omit process narration, transcripts, and restatements of the brief. Exceed the target only when requested depth, enumerated results, essential evidence, caveats, or instructions require it, or when the task's outputSchema requires longer output. When the task carries an outputSchema, output must be JSON matching it.",
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
            "Pointer-based artifacts produced by this step — agent-fs path, URL, shared-fs path, or swarm Page. No inline file data; upload to agent-fs first and attach by path. Agent-fs pointers are verified before task state changes, using the explicit org/drive pair or the registering agent's configured defaults. May be sent on any call (progress or completion) and accumulates across calls; duplicates are de-duped by sha256 (when present) or by (kind, pointer, name).",
          ),
        citations: z
          .array(CitationInputSchema)
          .max(MAX_TASK_CITATIONS)
          // Keep invalid or oversized citation batches from rejecting task updates.
          .catch([])
          .optional()
          .describe(
            'Claim sources, upserted by index across calls. Reference each one in output with [citation:N], or set general: true for a source that backs the whole answer (it renders under "General sources"). ref per kind: task = task UUID; memory = memory UUID (optional quote must appear verbatim in it); github = owner/repo#N, owner/repo@<sha>, or a github.com pull, issues, or commit URL; slack = permalink or channel/ts; agent-fs = file path; page = page id; script-run = script run id; url = http(s) URL. The first completing call is refused, and the task stays in progress, if a marker has no entry, a citation fails validation, or a non-general citation is unreferenced; the response lists each problem. After one refusal, completion proceeds and those markers and sources are dropped from rendered output. At most 50 citations per call/task, refs up to 2048 characters, labels up to 200. Invalid or oversized batches are ignored; existing indices can still be updated at capacity.',
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
      {
        taskId: requestedTaskId,
        progress,
        status: requestedStatus,
        output,
        failureReason,
        attachments,
        citations,
        persistMemory,
        force,
      },
      requestInfo,
      _meta,
    ) => {
      if (!requestInfo.agentId) {
        return toolErr('Agent ID not found. The MCP client should define the "X-Agent-ID" header.');
      }

      const taskId = requestedTaskId ?? requestInfo.sourceTaskId;
      if (!taskId || !z.uuid().safeParse(taskId).success) {
        return toolErr("Supply taskId as the full task UUID; no valid task context is available.");
      }
      if (!requestedTaskId) {
        const contextTask = await getTaskById(taskId);
        if (!contextTask || contextTask.agentId !== requestInfo.agentId) {
          return toolErr("Omitted taskId requires a source task assigned to the calling agent.");
        }
      }
      const status =
        requestedStatus === "completed" || requestedStatus === "failed"
          ? requestedStatus
          : undefined;

      // Stock Claude occasionally puts the next tool parameter inside output.
      // Strip the leaked tail before validation/persistence; recovered pointers
      // must still pass the ordinary attachment schema and verification below.
      const leakedParameter = output?.match(
        /(?:<\/(?:output|parameter)>\s*)?<parameter name="([a-zA-Z_]+)">\s*([\s\S]*)$/,
      );
      if (leakedParameter) {
        output = output?.slice(0, leakedParameter.index);
        let recovered = false;
        if (leakedParameter[1] === "attachments") {
          try {
            const parsed = z
              .array(AttachmentInputSchema)
              .max(20)
              .safeParse(JSON.parse(leakedParameter[2]!.replace(/\s*<\/parameter>\s*$/, "")));
            if (parsed.success && (attachments?.length ?? 0) + parsed.data.length <= 20) {
              attachments = [...(attachments ?? []), ...parsed.data];
              recovered = true;
            }
          } catch {
            // Malformed JSON must not prevent saving the cleaned task result.
          }
        }
        if (!recovered) {
          console.warn(
            `[store-progress] Stripped malformed output tail for task ${taskId}; parameter ${leakedParameter[1]} was not recovered.`,
          );
        }
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
        // This call's own status can finish the task even though existingTask
        // (its state before this call) is not yet terminal — gate on both so a
        // completing call carrying blocked-waiting-shaped text (e.g. "awaiting
        // review") never nudges toward defer-task.
        const goingTerminal = status !== undefined && isTerminalTaskStatus(status);

        // Computed against the task's state as of BEFORE this call's update,
        // so "elapsed" reads as time since the prior check-in, not zero.
        let blockedWaitingElapsedMs: number | undefined;
        if (progress && !isTerminal && !goingTerminal && BLOCKED_WAITING_PATTERN.test(progress)) {
          const referenceIso = existingTask.lastUpdatedAt ?? existingTask.createdAt;
          if (referenceIso) {
            const elapsed = Date.now() - new Date(referenceIso).getTime();
            // Below the floor, a sub-minute check-in reads as "blocked" purely
            // from noise, and defer-task buys nothing over just checking in
            // again shortly — so treat it as not blocked-waiting yet.
            if (elapsed >= BLOCKED_WAITING_MIN_ELAPSED_MS) {
              blockedWaitingElapsedMs = elapsed;
            }
          }
        }

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

        // Explicit task IDs retain the existing progress-update policy, but
        // only the assigned agent may author sources. Check under the same
        // transaction as the upsert, including for terminal tasks. Ignore an
        // unauthorized batch so citations never block the task update itself.
        if (citations?.length && existingTask.agentId === agent.id) {
          await upsertTaskCitations(taskId, citations);
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

        // Citation accuracy: refuse the first inaccurate completion so the
        // author fixes it while the context is fresh. Refuse at most once per
        // task, so a citation the author cannot repair never strands the task.
        // Progress, attachments, and citations from this call still commit.
        if (status === "completed" && existingTask.agentId === agent.id) {
          const taskCitations = await getTaskCitations(taskId);
          const issues = taskCitations.length
            ? taskCitationIssues(output ?? existingTask.output ?? "", taskCitations)
            : undefined;
          const problems = issues
            ? [
                ...issues.missingEntries.map(
                  (index) => `[citation:${index}] is in the output but has no citation entry.`,
                ),
                ...issues.invalid.map(
                  ({ index, reason }) => `Citation ${index} fails validation: ${reason}.`,
                ),
                ...issues.unreferenced.map(
                  (index) =>
                    `Citation ${index} is not referenced in the output; add [citation:${index}] where it supports a claim, or set general: true if it backs the whole answer.`,
                ),
              ]
            : [];
          if (problems.length && !(await hasTaskCitationCheckRefusal(taskId))) {
            await createLogEntry({
              eventType: "task_citation_check_refused",
              agentId: agent.id,
              taskId,
              newValue: problems.join("\n"),
            });
            return {
              success: false,
              task: existingTask,
              message: `Completion refused: citations do not match the output. The task stays ${existingTask.status}. Fix these, then call store-progress with status "completed" again (resend citations by index to correct them):\n- ${problems.join("\n- ")}\nThis check refuses once per task; the next completion is accepted and unfixed citations are dropped or listed under "General sources".`,
            };
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
          blockedWaitingElapsedMs,
        };
      });

      const shouldRunTerminalSideEffects =
        (status === "completed" || status === "failed") &&
        result.success &&
        result.task &&
        !("wasNoOp" in result && result.wasNoOp) &&
        !("wasForcedOverwrite" in result && result.wasForcedOverwrite);

      // Post-commit terminal side effects (completion memory, server raters,
      // lead follow-up). Shared with `defer-task` — see
      // src/tasks/task-terminal-effects.ts. Skipped on no-op (idempotent
      // re-call on a terminal task) and on forced text-only overwrites, so a
      // replay never duplicates memories or follow-up tasks.
      if (shouldRunTerminalSideEffects && status) {
        await runTaskTerminalEffects({
          task: result.task!,
          status,
          output,
          failureReason,
          agentId: requestInfo.agentId,
          persistMemory,
        });
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
        ...("blockedWaitingElapsedMs" in result &&
        typeof result.blockedWaitingElapsedMs === "number"
          ? { blockedWaitingElapsedMs: result.blockedWaitingElapsedMs }
          : {}),
      };
      const warnings =
        success && status === "completed"
          ? taskCitationWarnings(
              result.task?.output ?? output ?? "",
              await getTaskCitations(taskId),
            )
          : [];
      return success
        ? toolOk(message, { data, details: warnings.length ? warnings.join("\n") : undefined })
        : toolErr(message, { data });
    },
  );
};
