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

/** The host's registered tools (MCP tools included), keyed by effective name. */
export type OpencodeToolLister = () => Promise<ReadonlyArray<{ readonly id: string }>>;

export interface OpencodeSwarmPluginOptions {
  /** Receives the tool lister once OpenCode sets the plugin up. */
  onToolRegistry?: (listTools: OpencodeToolLister) => void;
  /** Receives every OpenRouter model response, for the billed cost. */
  onOpenRouterResponse?: (response: Response) => void;
  /**
   * Receives each primary model request's final context (system, messages,
   * tools), after this plugin's own edits. OpenCode fires `context` once per
   * agent-loop step, so this sees every primary call.
   */
  onContext?: (event: OpencodeRequestContext) => void;
}

/** The parts of OpenCode's `context` hook event the request measurement reads. */
export interface OpencodeRequestContext {
  readonly sessionID: string;
  readonly system: ReadonlyArray<{ readonly text?: string }>;
  readonly messages: ReadonlyArray<unknown>;
  readonly tools: Readonly<
    Record<string, { readonly description: string; readonly input: unknown }>
  >;
}

/** Keys OpenCode sets on each shell call, on top of its base env. */
const OPENCODE_SHELL_ENV_KEYS = ["TERM", "OPENCODE_TERMINAL"] as const;

/**
 * Rewrites one OpenCode shell call's env, in place, to the session's own env
 * plus the keys OpenCode set for the call. Nothing else from the process env
 * gets through.
 */
function applyOpencodeShellEnv(
  callEnv: Record<string, string | undefined>,
  sessionEnv: Record<string, string | undefined>,
): void {
  const keep = new Set<string>(OPENCODE_SHELL_ENV_KEYS);
  for (const key of Object.keys(callEnv)) {
    if (!keep.has(key)) delete callEnv[key];
  }
  for (const [key, value] of Object.entries(sessionEnv)) {
    if (value !== undefined && !keep.has(key)) callEnv[key] = value;
  }
}

export function createOpencodeSwarmPlugin(
  config: SwarmHooksConfig,
  options: OpencodeSwarmPluginOptions = {},
): Plugin.Plugin {
  return {
    id: "agent-swarm",
    async setup(ctx) {
      options.onToolRegistry?.(() => ctx.tool.list());

      // OpenCode runs in-process, so its shell tool spawns with process.env,
      // which every concurrent session shares and which never sees this
      // task's env (rows admitted or withheld by fetchResolvedEnv after boot).
      const sessionEnv = config.env;
      if (sessionEnv) {
        await ctx.shell.hook("create.before", (event) => {
          applyOpencodeShellEnv(event.env, sessionEnv);
        });
      }

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
      // Then hand the final request to the composition measurement.
      await ctx.session.hook("context", async (event) => {
        if (config.isLead) {
          const concurrent = await fetchConcurrentContext(config);
          if (concurrent) event.system.push({ type: "text", text: concurrent });
        }
        options.onContext?.(event);
      });

      // Nobody reads a headless session's title. Generating one is a second
      // model call, on OpenCode's small model, that the session usage folds
      // into the main model's tokens.
      await ctx.session.hook("title", (event) => {
        event.result = config.taskId ? `swarm task ${config.taskId}` : "swarm session";
      });

      const onOpenRouterResponse = options.onOpenRouterResponse;
      if (onOpenRouterResponse) {
        await ctx.session.hook(
          "http.response",
          (event) => {
            onOpenRouterResponse(event.response);
          },
          { providerID: "openrouter" },
        );
      }

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
