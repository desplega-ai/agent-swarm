// Phase 5: lead-facing notification rail for budget refusals.
//
// Centralizes the after-commit side effects shared by all three refusal
// sites (`/api/poll` pre-assigned-pending, `/api/poll` unassigned-pool,
// MCP `task-action` `accept`). The dedup row (`budget_refusal_notifications`)
// is recorded INSIDE the same transaction as the refusal — this module owns
// only the post-commit work: resolving the template body, creating the
// lead-facing follow-up task, writing the follow-up id back to the dedup
// row, and emitting `task.budget_refused` to the workflow bus.
//
// Crash window between txn commit and follow-up creation is accepted in V1
// (see plan §5.1). Operators audit via
// `SELECT ... FROM budget_refusal_notifications WHERE follow_up_task_id IS NULL`.

import { resolveTemplate } from "../prompts/resolver";
import type { AgentTask } from "../types";
import {
  createTaskExtended,
  getAgentById,
  getLeadAgent,
  setBudgetRefusalFollowUpTaskId,
} from "./db";

export interface BudgetRefusalContext {
  /** The task that was refused (provides Slack context, description). */
  task: Pick<AgentTask, "id" | "task" | "slackChannelId" | "slackThreadTs" | "slackUserId">;
  /** Refusing agent id. */
  agentId: string;
  /** UTC date `YYYY-MM-DD` used as the dedup key alongside `task.id`. */
  date: string;
  /** Refusal cause. */
  cause: "agent" | "global";
  agentSpendUsd?: number;
  agentBudgetUsd?: number;
  globalSpendUsd?: number;
  globalBudgetUsd?: number;
  /** ISO 8601 of the next UTC midnight (when the daily budget resets). */
  resetAt: string;
}

/**
 * Format the human-readable "$X / $Y" pair shown in the lead's follow-up
 * task body. Uses fixed 2-decimal formatting; falls back to `?` for
 * undefined fields (shouldn't happen if `cause` is correctly populated, but
 * defensive).
 */
function formatSpendSummary(ctx: BudgetRefusalContext): string {
  const fmt = (n: number | undefined): string => (n === undefined ? "?" : `$${n.toFixed(2)}`);
  if (ctx.cause === "agent") {
    return `${fmt(ctx.agentSpendUsd)} / ${fmt(ctx.agentBudgetUsd)}`;
  }
  return `${fmt(ctx.globalSpendUsd)} / ${fmt(ctx.globalBudgetUsd)}`;
}

/**
 * After-commit side effects for a budget refusal:
 *
 * 1. If `inserted` (i.e. this is the first refusal of `(task.id, date)`)
 *    AND a lead exists, resolve the `task.budget.refused` template and
 *    create a follow-up task assigned to the lead. Inherit Slack context
 *    from the refused task so the lead can reply in-thread.
 * 2. Write the new follow-up's id back into
 *    `budget_refusal_notifications.follow_up_task_id` for audit.
 * 3. Always emit `task.budget_refused` to the workflow bus — DAG sequencing
 *    must react on every refusal (not just the first per day). The dedup is
 *    a separate concern (lead notification cadence, not workflow plumbing).
 *
 * Safe to invoke synchronously after the refusal transaction commits. Errors
 * here are logged but do NOT propagate — the refusal envelope has already
 * been returned to the worker, and a missed lead notification is recoverable
 * (operator query against the dedup table) but a thrown error here would be
 * useless noise on the API server.
 */
export function emitBudgetRefusalSideEffects(ctx: BudgetRefusalContext, inserted: boolean): void {
  // 1. Lead-facing follow-up task (first refusal of the day only).
  if (inserted) {
    try {
      const leadAgent = getLeadAgent();
      if (leadAgent) {
        const refusingAgent = getAgentById(ctx.agentId);
        const agentName = refusingAgent?.name || ctx.agentId.slice(0, 8);
        const taskDesc = ctx.task.task.slice(0, 200);
        const spendSummary = formatSpendSummary(ctx);

        const resolved = resolveTemplate(
          "task.budget.refused",
          {
            cause: ctx.cause,
            agent_name: agentName,
            task_desc: taskDesc,
            spend_summary: spendSummary,
            reset_at: ctx.resetAt,
            task_id: ctx.task.id,
          },
          { agentId: ctx.agentId },
        );

        const followUp = createTaskExtended(resolved.text, {
          agentId: leadAgent.id,
          source: "system",
          taskType: "follow-up",
          parentTaskId: ctx.task.id,
          slackChannelId: ctx.task.slackChannelId,
          slackThreadTs: ctx.task.slackThreadTs,
          slackUserId: ctx.task.slackUserId,
        });

        try {
          setBudgetRefusalFollowUpTaskId(ctx.task.id, ctx.date, followUp.id);
        } catch (err) {
          console.warn(
            `[budget-refusal-notify] Failed to write back follow_up_task_id for task ${ctx.task.id.slice(0, 8)} (${ctx.date}): ${err}`,
          );
        }

        console.log(
          `[budget-refusal-notify] Notified lead (${leadAgent.name}) of budget refusal — task=${ctx.task.id.slice(0, 8)} cause=${ctx.cause} agent=${agentName}`,
        );
      }
    } catch (err) {
      console.warn(
        `[budget-refusal-notify] Failed to create follow-up task for budget refusal (task=${ctx.task.id.slice(0, 8)}): ${err}`,
      );
    }
  }

  // 2. Workflow event bus emit — every refusal, not just the first per day.
  try {
    import("../workflows/event-bus").then(({ workflowEventBus }) => {
      workflowEventBus.emit("task.budget_refused", {
        taskId: ctx.task.id,
        agentId: ctx.agentId,
        cause: ctx.cause,
        agentSpendUsd: ctx.agentSpendUsd,
        agentBudgetUsd: ctx.agentBudgetUsd,
        globalSpendUsd: ctx.globalSpendUsd,
        globalBudgetUsd: ctx.globalBudgetUsd,
        resetAt: ctx.resetAt,
      });
    });
  } catch {
    // Mirror the existing emit-pattern in db.ts:1561-1571 — any failure here
    // (e.g. event bus module load error) must not break the refusal path.
  }
}
