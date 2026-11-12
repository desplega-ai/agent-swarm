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
import {
  canonicalArgs,
  canonicalToolName,
  rawArgsFromCanonical,
  runNativePost,
  runNativePre,
} from "../hooks/native-tool-hooks";
import { renderGoalReminder } from "../prompts/goal-reminder";
import {
  apiHeaders,
  checkShouldBlockPolling,
  fetchConcurrentContext,
  fetchTaskDetails,
  fireAndForget,
  isTaskCancelled,
  nativeHookTarget,
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
  /**
   * Names of the MCP servers in the session's config. OpenCode keys their tools
   * `<server>_<tool>`; any other tool is a built-in and goes to native-tool extensions.
   */
  mcpServers?: readonly string[];
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

/** True for an OpenCode built-in tool: not keyed `<server>_<tool>` for any configured MCP server. */
export function isOpencodeBuiltinTool(name: string, mcpServers: readonly string[]): boolean {
  return !mcpServers.some((server) => name.startsWith(`${server}_`));
}

export function createOpencodeSwarmPlugin(
  config: SwarmHooksConfig,
  options: OpencodeSwarmPluginOptions = {},
): Plugin.Plugin {
  const mcpServers = options.mcpServers ?? [];
  /** Built-in calls in flight, so the post report carries a real duration. */
  const nativeStartedAt = new Map<string, number>();
  const nativeCall = (event: { tool: string; id: string; input: unknown }) => ({
    harness: "opencode" as const,
    tool: canonicalToolName(event.tool),
    nativeTool: event.tool,
    args: canonicalArgs(event.input),
    rawArgs: event.input,
    toolCallId: event.id,
  });
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

        // Extensions with toolSources "native": last, so the guards above win. `event.input` is
        // writable, which is how a rewrite lands; a throw is how a block lands.
        if (isOpencodeBuiltinTool(event.tool, mcpServers)) {
          const decision = await runNativePre(nativeHookTarget(config), nativeCall(event));
          if (decision.action === "block") throw new Error(decision.reason);
          if (decision.action === "modify") {
            event.input = rawArgsFromCanonical(decision.args, event.input);
          }
          nativeStartedAt.set(event.id, Date.now());
        }
      });

      await ctx.tool.hook("execute.after", (event) => {
        if (isOpencodeBuiltinTool(event.tool, mcpServers)) {
          const startedAt = nativeStartedAt.get(event.id);
          nativeStartedAt.delete(event.id);
          void runNativePost(nativeHookTarget(config), nativeCall(event), {
            result: event.status === "completed" ? event.result : event.error,
            isError: event.status === "error",
            durationMs: startedAt === undefined ? 0 : Date.now() - startedAt,
          });
        }
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
