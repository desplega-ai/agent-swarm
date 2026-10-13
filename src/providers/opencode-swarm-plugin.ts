/**
 * Agent Swarm plugin for OpenCode 2.
 *
 * OpenCode 2 runs in-process (`@opencode/sdk`), so this plugin is a plain
 * object passed to `OpenCode.create({ plugins })`. It closes over the task's
 * swarm config and reuses the pi extension's swarm-hook helpers; no env vars,
 * no plugin file on disk, no vendored copies.
 *
 * Session-end work (identity sync, session summary, session close) runs from
 * the adapter's event loop, not from here.
 */

import type { Plugin } from "@opencode/plugin";
import { renderGoalReminder } from "../prompts/goal-reminder";
import {
  apiHeaders,
  checkShouldBlockPolling,
  fetchConcurrentContext,
  fetchTaskDetails,
  fireAndForget,
  isTaskCancelled,
  type SwarmHooksConfig,
} from "./pi-mono-extension";

export function createOpencodeSwarmPlugin(config: SwarmHooksConfig): Plugin.Plugin {
  return {
    id: "agent-swarm",
    async setup(ctx) {
      // A throw blocks the tool; OpenCode hands the message back to the model.
      await ctx.tool.hook("execute.before", async (event) => {
        if (!config.isLead && config.taskId) {
          const { cancelled, reason } = await isTaskCancelled(config);
          if (cancelled) {
            const cancelReason = reason || "Task cancelled by lead or creator";
            throw new Error(
              `🛑 TASK CANCELLED: Your current task (${config.taskId.slice(0, 8)}) has been cancelled. Reason: "${cancelReason}". ` +
                "Stop working on this task immediately. Do NOT continue making tool calls. " +
                "Use store-progress to acknowledge the cancellation and mark the task as failed, then wait for new tasks.",
            );
          }
        }
        if (event.tool.includes("poll-task") && (await checkShouldBlockPolling(config))) {
          throw new Error(
            "🛑 POLLING LIMIT REACHED: You have exceeded the maximum empty poll attempts. " +
              "EXIT NOW - do not make any more tool calls.",
          );
        }
      });

      await ctx.tool.hook("execute.after", () => {
        if (config.isLead || !config.taskId) return;
        fireAndForget(`${config.apiUrl}/api/agents/${config.agentId}/activity`, {
          method: "PUT",
          headers: apiHeaders(config),
        });
      });

      // Lead only: tell the model what other sessions are already handling.
      await ctx.session.hook("context", async (event) => {
        if (!config.isLead) return;
        const concurrent = await fetchConcurrentContext(config);
        if (concurrent) event.system.push({ type: "text", text: concurrent });
      });

      // PreCompact parity: keep the task goal in the checkpoint summary.
      await ctx.session.hook("compaction", async (event) => {
        if (!config.taskId) return;
        const task = await fetchTaskDetails(config);
        if (!task) return;
        const reminder = await renderGoalReminder(task);
        if (reminder) event.system.push({ type: "text", text: reminder });
      });
    },
  };
}
