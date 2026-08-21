/**
 * Post-commit side effects of a task reaching a terminal state.
 *
 * Extracted verbatim from `src/tools/store-progress.ts` so a second writer
 * (`src/tools/defer-task.ts`) fires the identical set. Three blocks, all
 * fire-and-forget: none of them may change the task's status or fail the
 * caller's response.
 *
 *   1. task_completion memory write (+ swarm promotion for shared research)
 *   2. server-side memory raters
 *   3. lead follow-up task
 *
 * Call this AFTER the completion transaction commits. Callers own the
 * "should this run at all" guards (idempotent re-calls, forced overwrites);
 * this function assumes the terminal write really happened.
 */

import { getSessionLogsByTaskId } from "@/be/db";
import { getEmbeddingProvider, getMemoryStore } from "@/be/memory";
import { getRetrievalsForTask } from "@/be/memory/raters/retrieval";
import { runServerRaters } from "@/be/memory/raters/run-server-raters";
import { shouldPersistTaskCompletionMemory } from "@/memory/automatic-task-gate";
import { createWorkerTaskFollowUp } from "@/tasks/worker-follow-up";
import type { AgentTask } from "@/types";
import { scrubSecrets } from "@/utils/secret-scrubber";

export function runTaskTerminalEffects(args: {
  task: AgentTask;
  status: "completed" | "failed";
  output?: string;
  failureReason?: string;
  agentId?: string;
  persistMemory?: boolean;
}): void {
  const { task, status, output, failureReason, agentId, persistMemory } = args;
  const taskId = task.id;

  // Index completed and failed tasks as memory (async, non-blocking).
  // Automatic/recurring tasks are noisy by default; require explicit opt-in.
  if (shouldPersistTaskCompletionMemory(task, persistMemory)) {
    (async () => {
      try {
        const taskContent =
          status === "completed"
            ? `Task: ${task.task}\n\nOutput:\n${output || "(no output)"}`
            : `Task: ${task.task}\n\nFailure reason:\n${failureReason || "No reason provided"}\n\nThis task failed. Learn from this to avoid repeating the mistake.`;

        // Skip indexing if there's truly no content
        if (taskContent.length < 30) return;

        const store = getMemoryStore();
        const provider = getEmbeddingProvider();

        const memory = store.store({
          agentId: agentId ?? null,
          content: taskContent,
          name: `Task: ${task.task.slice(0, 80)}`,
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
          (task.taskType === "research" ||
            task.tags?.includes("knowledge") ||
            task.tags?.includes("shared"));

        if (shouldShareWithSwarm) {
          try {
            const swarmMemory = store.store({
              agentId: agentId ?? null,
              scope: "swarm",
              name: `Shared: ${task.task.slice(0, 80)}`,
              content: `Task completed by agent ${agentId}:\n\n${taskContent}`,
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
    })().catch((err) =>
      console.error(
        "[task-terminal-effects] task completion memory write failed:",
        scrubSecrets(err instanceof Error ? err.message : String(err)),
      ),
    );
  }

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
        agentId: agentId ?? "",
        retrievedMemoryIds,
        evidence,
      });
    } catch (err) {
      console.error(
        "[task-terminal-effects] server-rater fire failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  })().catch((err) =>
    console.error(
      "[task-terminal-effects] server rater run failed:",
      scrubSecrets(err instanceof Error ? err.message : String(err)),
    ),
  );

  // Create follow-up task for the lead when a worker task finishes.
  // This replaces the old poll-based tasks_finished trigger which was unreliable.
  // Skip for workflow-managed tasks — the workflow engine handles sequencing via resume.ts.
  if (!task.workflowRunId) {
    try {
      const followUp = createWorkerTaskFollowUp({ task, status, output, failureReason });
      if (followUp) {
        console.log(
          `[task-terminal-effects] Created follow-up task ${followUp.id.slice(0, 8)} for ${status} task ${taskId.slice(0, 8)}`,
        );
      }
    } catch (err) {
      // Non-blocking — follow-up task creation failure should not affect the caller's response
      console.warn(`[task-terminal-effects] Failed to create follow-up task: ${err}`);
    }
  }
}
