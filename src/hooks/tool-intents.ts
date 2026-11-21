/**
 * Intent before effect for side-effecting tool calls.
 *
 * session_logs flush on a 5 s timer, so a hard kill inside that window loses the
 * `tool_use` line of the call that was in flight, and the resume preamble cannot
 * flag it. For the few calls whose effect a resume must not repeat blindly (a Slack
 * or chat post, a task sent, a PR opened), the pre-call hook awaits
 * `POST /api/tasks/{taskId}/tool-intents` first and the post-call hook deletes the row.
 * A row that survives is a call that started and never reported back.
 *
 * Fail open: a short timeout, every error swallowed. An API hiccup never blocks
 * the tool; it only loses the intent row. Talk HTTP only. Never import the DB layer.
 */

import { scrubSecrets } from "../utils/secret-scrubber";
import type { NativeHookTarget } from "./native-tool-hooks";
import { parseGhPrCommands, shellCommandOf } from "./pr-body-guard";

const INTENT_TIMEOUT_MS = 1_000;
const MAX_ARGS_SUMMARY_CHARS = 500;

/** Swarm MCP tools whose effect lands outside the session. Readers and idempotent lookups stay out. */
const SIDE_EFFECTING_SWARM_TOOLS = [
  "slack-post",
  "slack-reply",
  "slack-update",
  "slack-delete",
  "slack-upload-file",
  "slack-start-thread",
  "slack-create-channel",
  "slack-archive-channel",
  "slack-invite-to-channel",
  "chat-post",
  "chat-reply",
  "send-task",
];

const SHELL_TOOLS = new Set(["bash", "shell", "exec_command", "local_shell"]);

/**
 * The swarm tool a harness tool name refers to. Each harness prefixes MCP tools its own way:
 * claude and codex `mcp__agent-swarm__slack-reply`, opencode `agent-swarm_slack-reply`,
 * pi and dsh `agent-swarm.slack-reply` or the bare name.
 */
function swarmToolOf(toolName: string): string | undefined {
  const name = toolName.toLowerCase();
  return SIDE_EFFECTING_SWARM_TOOLS.find(
    (tool) =>
      name === tool ||
      name.endsWith(`__${tool}`) ||
      name.endsWith(`_${tool}`) ||
      name.endsWith(`.${tool}`),
  );
}

/** Whether a call is on the intent allowlist: a swarm writer, or a shell call that opens a PR. */
export function isSideEffectingToolCall(
  toolName: string,
  toolInput: unknown,
  cwd: string,
): boolean {
  if (swarmToolOf(toolName)) return true;
  if (!SHELL_TOOLS.has(toolName.toLowerCase())) return false;
  const command = shellCommandOf(toolInput);
  if (!command || !command.includes("gh")) return false;
  try {
    return parseGhPrCommands(command, cwd).some((call) => call.action === "create");
  } catch {
    return /\bgh\s+pr\s+create\b/.test(command);
  }
}

/** The one-line argument summary the preamble shows: the command, a path, else the JSON. */
function argsSummaryOf(toolInput: unknown): string {
  const command = shellCommandOf(toolInput);
  const raw = command ?? (toolInput === undefined ? "" : JSON.stringify(toolInput));
  return scrubSecrets(raw.replace(/\s+/g, " ").trim()).slice(0, MAX_ARGS_SUMMARY_CHARS);
}

export interface ToolIntentCall {
  toolName: string;
  toolInput: unknown;
  /** The harness's call id. A call without one cannot be cleared, so it is never recorded. */
  toolCallId?: string;
  cwd: string;
}

function intentsUrl(target: NativeHookTarget, taskId: string): string {
  return `${target.apiUrl}/api/tasks/${encodeURIComponent(taskId)}/tool-intents`;
}

/**
 * Awaited before the call runs. Returns whether a row was written; any failure is false
 * and the call goes ahead.
 */
export async function recordToolIntent(
  target: NativeHookTarget,
  call: ToolIntentCall,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!target.taskId || !call.toolCallId) return false;
  if (!isSideEffectingToolCall(call.toolName, call.toolInput, call.cwd)) return false;
  try {
    const response = await fetchImpl(intentsUrl(target, target.taskId), {
      method: "POST",
      headers: { ...target.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        argsSummary: argsSummaryOf(call.toolInput),
      }),
      signal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** After the call returned. A failed delete leaves the row; the preamble also pairs on session_logs. */
export async function clearToolIntent(
  target: NativeHookTarget,
  call: ToolIntentCall,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!target.taskId || !call.toolCallId) return;
  if (!isSideEffectingToolCall(call.toolName, call.toolInput, call.cwd)) return;
  try {
    await fetchImpl(`${intentsUrl(target, target.taskId)}/${encodeURIComponent(call.toolCallId)}`, {
      method: "DELETE",
      headers: target.headers,
      signal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
    });
  } catch {
    // Fail open.
  }
}
