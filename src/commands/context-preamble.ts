/**
 * Universal context preamble for follow-up task continuity.
 *
 * Builds a bounded text summary of prior task context (parent → ancestor chain)
 * and inserts it after the child task's leading skill invocation. This makes
 * follow-up continuity uniform across ALL harness providers — not just those
 * that support native session resume (claude/codex).
 *
 * Token budget (CONTEXT_PREAMBLE_MAX_TOKENS, default 2000) prevents the
 * SIGTERM-143 context-saturation failure mode seen with unbounded session
 * resumes (see swarm memory sigterm-143-resumed-session-context-saturation-2026-05-13).
 */

import type { TaskAttachment } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { isSteeringEnabled } from "../utils/steering-enabled";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";

/** Keep slash skills on line one so native and adapter resolvers can expand them. */
export function prependContextPreamble(prompt: string, preamble: string): string {
  if (!preamble) return prompt;
  const newline = prompt.indexOf("\n");
  const firstLine = newline === -1 ? prompt : prompt.slice(0, newline);
  if (!/^\/[a-z0-9:_-]+(?:[ \t].*)?$/.test(firstLine.trim())) {
    return preamble + prompt;
  }
  const rest = newline === -1 ? "" : prompt.slice(newline + 1);
  return `${firstLine}\n${preamble}${rest}`;
}

export const CONTEXT_PREAMBLE_MAX_TOKENS = Number(
  process.env.CONTEXT_PREAMBLE_MAX_TOKENS || "2000",
);
// ~4 chars per token (conservative approximation for mixed code/prose)
export const CONTEXT_PREAMBLE_MAX_CHARS = CONTEXT_PREAMBLE_MAX_TOKENS * 4;
export const CONTEXT_PREAMBLE_MAX_ANCESTORS = 5;

/**
 * Token budget for the resume-task preamble. Default 4000 = 2× the regular
 * preamble, since the resume agent needs the original task brief verbatim
 * plus a tool-call summary to avoid redoing completed work.
 */
export const CONTEXT_PREAMBLE_RESUME_MAX_TOKENS = Number(
  process.env.CONTEXT_PREAMBLE_RESUME_MAX_TOKENS || "4000",
);
export const CONTEXT_PREAMBLE_RESUME_MAX_CHARS = CONTEXT_PREAMBLE_RESUME_MAX_TOKENS * 4;
/** How many of the most recent session_logs rows to inspect for tool-call summary. */
export const CONTEXT_PREAMBLE_RESUME_SESSION_LOG_LIMIT = 50;

interface SteeringMessageForPreamble {
  body: string;
  status: "pending" | "promoted";
  createdAt: string;
}

export interface TaskContextForPreamble {
  id: string;
  task: string;
  output?: string;
  progress?: string;
  status?: string;
  taskType?: string;
  parentTaskId?: string;
  attachments?: Array<{
    kind: string;
    name: string;
    url?: string;
    path?: string;
    pageId?: string;
    orgId?: string;
    driveId?: string;
    description?: string;
    intent?: string;
    isPrimary?: boolean;
  }>;
}

/** Fetch minimal task context for preamble generation (worker-side, via HTTP). */
export async function fetchTaskContextForPreamble(
  apiUrl: string,
  apiKey: string,
  taskId: string,
): Promise<TaskContextForPreamble | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, { headers });
    if (!response.ok) return null;
    const data = (await response.json()) as TaskContextForPreamble;
    return {
      id: data.id,
      task: data.task,
      output: data.output,
      progress: data.progress,
      status: data.status,
      taskType: data.taskType,
      parentTaskId: data.parentTaskId,
      attachments: data.attachments,
    };
  } catch {
    return null;
  }
}

function formatAttachmentPointer(
  att: NonNullable<TaskContextForPreamble["attachments"]>[number],
): string {
  // Worker-side: this process gets swarm_config only for RELOADABLE_ENV_KEYS
  // (runner.ts), so COMB_ENABLED and APP_URL may differ from the API's. Keep
  // the live URL here. Agents read the file with the agent-fs CLI anyway.
  const pointer = taskAttachmentDisplayUrl(att as TaskAttachment, { comb: false });
  return pointer || "(no pointer)";
}

/**
 * Build a bounded context preamble for a follow-up task.
 *
 * Walks the ancestor chain (up to CONTEXT_PREAMBLE_MAX_ANCESTORS) via the API
 * and returns a formatted markdown block that is prepended to the child prompt.
 *
 * - Immediate parent: inline detail (subject + output + attachments)
 * - Older ancestors: pointer-only (taskId + one-line subject)
 *
 * Hard-capped at CONTEXT_PREAMBLE_MAX_CHARS (~CONTEXT_PREAMBLE_MAX_TOKENS
 * tokens) to prevent context saturation.
 */
export async function buildContextPreamble(
  apiUrl: string,
  apiKey: string,
  parentTaskId: string,
): Promise<string | null> {
  const ancestors: TaskContextForPreamble[] = [];
  let currentId: string | undefined = parentTaskId;
  while (currentId && ancestors.length < CONTEXT_PREAMBLE_MAX_ANCESTORS) {
    const ctx = await fetchTaskContextForPreamble(apiUrl, apiKey, currentId);
    if (!ctx) break;
    ancestors.push(ctx);
    currentId = ctx.parentTaskId;
  }
  if (ancestors.length === 0) return null;
  // ancestors[0] is guaranteed by the length check above; TypeScript needs the guard.
  const parent = ancestors[0];
  if (!parent) return null;

  const lines: string[] = [
    "\n---",
    "## Prior Conversation Context",
    "",
    "This task is a follow-up in an ongoing thread. Here is a summary of prior work to maintain continuity.",
    "",
  ];

  const subjectPreview = parent.task.slice(0, 600).replace(/\n/g, " ");
  lines.push(`### Immediate Prior Task (ID: \`${parent.id}\`)`);
  lines.push(`**Task:** ${subjectPreview}`);
  lines.push("");

  const rawResult = parent.output || parent.progress;
  if (rawResult) {
    // Reserve ~55% of budget for the output content; rest for structure + older ancestors
    const outputBudget = Math.floor(CONTEXT_PREAMBLE_MAX_CHARS * 0.55);
    const truncated =
      rawResult.length > outputBudget
        ? `${rawResult.slice(0, outputBudget)}\n\n[output truncated — full history via \`get-task-details\` with taskId \`${parent.id}\`]`
        : rawResult;
    lines.push("**Outcome:**");
    lines.push(truncated);
    lines.push("");
  } else {
    lines.push("**Outcome:** (no output recorded yet — task may still be in progress)");
    lines.push("");
  }

  const atts = parent.attachments?.filter((a) => a.name && (a.url || a.path || a.pageId));
  if (atts && atts.length > 0) {
    lines.push("**Artifacts from prior task:**");
    for (const att of atts.slice(0, 10)) {
      const pointer = formatAttachmentPointer(att);
      const note = att.description || att.intent || "";
      lines.push(`  - **${att.name}**: \`${pointer}\`${note ? ` — ${note}` : ""}`);
    }
    lines.push("");
  }

  lines.push(
    `To review the full prior conversation call \`get-task-details\` with taskId \`${parent.id}\`.`,
  );

  if (ancestors.length > 1) {
    lines.push("");
    lines.push(
      "### Older Ancestor Tasks (pointers only — call `get-task-details` for full details)",
    );
    for (const ancestor of ancestors.slice(1)) {
      const brief = ancestor.task.slice(0, 200).replace(/\n/g, " ");
      lines.push(`- \`${ancestor.id}\` — ${brief}`);
    }
  }

  lines.push("", "---", "");

  let preamble = lines.join("\n");

  if (preamble.length > CONTEXT_PREAMBLE_MAX_CHARS) {
    preamble = `${preamble.slice(0, CONTEXT_PREAMBLE_MAX_CHARS)}\n\n[context preamble truncated to ${CONTEXT_PREAMBLE_MAX_TOKENS}-token budget]\n\n---\n`;
  }

  return preamble;
}

// ─── Resume Preamble ───────────────────────────────────────────────────────────

interface SessionLogForPreamble {
  id: string;
  taskId?: string;
  sessionId: string;
  iteration: number;
  cli: string;
  content: string;
  lineNumber: number;
  createdAt: string;
}

async function fetchSessionLogsForResume(
  apiUrl: string,
  apiKey: string,
  taskId: string,
): Promise<SessionLogForPreamble[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    // Bound server-side: long-running parents can accumulate large `session_logs`
    // and the preamble only consumes the tail (see CONTEXT_PREAMBLE_RESUME_SESSION_LOG_LIMIT).
    // Passing `?limit=N` keeps dispatch fast and memory-flat regardless of run length.
    const url = `${apiUrl}/api/tasks/${taskId}/session-logs?limit=${CONTEXT_PREAMBLE_RESUME_SESSION_LOG_LIMIT}`;
    const response = await fetch(url, { headers });
    if (!response.ok) return [];
    const data = (await response.json()) as { logs?: SessionLogForPreamble[] };
    return Array.isArray(data.logs) ? data.logs : [];
  } catch {
    return [];
  }
}

async function fetchSteeringMessagesForResume(
  apiUrl: string,
  apiKey: string,
  taskId: string,
): Promise<SteeringMessageForPreamble[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(
      `${apiUrl}/api/tasks/${taskId}/steering-messages?status=pending,promoted`,
      { headers },
    );
    if (!response.ok) return [];
    const data = (await response.json()) as { messages?: SteeringMessageForPreamble[] };
    return Array.isArray(data.messages)
      ? data.messages.filter(
          (message): message is SteeringMessageForPreamble =>
            (message.status === "pending" || message.status === "promoted") &&
            typeof message.body === "string" &&
            typeof message.createdAt === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * Format a single session_log line as a one-line tool-call summary. Falls back
 * to a truncated content snippet when the line isn't recognizable as a
 * tool call. The returned text is passed through `scrubSecrets` before
 * insertion into the preamble (no secrets in /workspace/logs/*.jsonl).
 */
function summarizeSessionLogLine(line: SessionLogForPreamble): string | null {
  const ts = line.createdAt.slice(11, 19); // HH:MM:SS
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.content);
  } catch {
    const snippet = line.content.replace(/\s+/g, " ").slice(0, 120);
    return snippet ? `[${ts}] ${snippet}` : null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // Anthropic / claude message-style tool calls.
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && typeof b.name === "string") {
        const input = b.input as Record<string, unknown> | undefined;
        const file = input?.file_path ?? input?.path ?? input?.command;
        const fileStr = typeof file === "string" ? ` ${file}` : "";
        return `[${ts}] ${b.name}${fileStr}`;
      }
    }
  }

  // Codex / generic event-style: { type: 'tool_use', name: '...', input: {...} }
  if (obj.type === "tool_use" && typeof obj.name === "string") {
    const input = obj.input as Record<string, unknown> | undefined;
    const file = input?.file_path ?? input?.path ?? input?.command;
    const fileStr = typeof file === "string" ? ` ${file}` : "";
    return `[${ts}] ${obj.name}${fileStr}`;
  }

  // Fallback: short content snippet (still useful for diff/insight)
  const snippet = JSON.stringify(parsed).replace(/\s+/g, " ").slice(0, 120);
  return snippet ? `[${ts}] ${snippet}` : null;
}

/**
 * Tools with no side effect: an unanswered call to one of them is safe to
 * repeat. Compared lowercased, so one entry covers Claude's `Read` and the
 * `read` of pi, opencode, ACP, dsh and cursor.
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "ls",
  "list",
  "find",
  "webfetch",
  "websearch",
  "web_search",
  "toolsearch",
  "tool_search",
  "skill",
  "todowrite",
  "todoread",
  "todo_list",
  "shell_command_status",
]);

type ToolInput = Record<string, unknown> | undefined;

type ToolLogEvent =
  | { kind: "use"; id: string | null; name: string; input: ToolInput }
  | { kind: "input"; id: string; input: ToolInput }
  | { kind: "result"; id: string };

function firstString(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === "string" && v) return v;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Codex item types that are tool calls (mirrors the UI logs-parser codex adapter). */
const CODEX_TOOL_ITEMS = new Set([
  "command_execution",
  "mcp_tool_call",
  "collab_tool_call",
  "web_search",
  "todo_list",
  "file_change",
]);

function codexToolUse(item: Record<string, unknown>): ToolLogEvent {
  const id = firstString(item.id);
  if (item.type === "command_execution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
    return { kind: "use", id, name: "bash", input: { command } };
  }
  if (item.type === "mcp_tool_call") {
    return {
      kind: "use",
      id,
      name: `${item.server ?? "mcp"}.${item.tool ?? "unknown"}`,
      input: asRecord(item.arguments),
    };
  }
  return { kind: "use", id, name: String(item.type), input: undefined };
}

/**
 * Extract tool call / result events from one session_log line, in order.
 * Each harness stores its own shape; every branch pairs on a call id:
 * - claude, pi, amp: `message.content[]` `tool_use.id` / `tool_result.tool_use_id`
 * - codex: `item.started` / `item.completed` on `item.id`
 * - opencode, acp, grok, fx: `tool_start` / `tool_end` on `toolCallId`
 *   (ACP fills the real args in a later raw `tool_call_update.rawInput`)
 * - claude-managed: `agent.{mcp_,}tool_use.id` / `agent.tool_result.tool_use_id`,
 *   `agent.mcp_tool_result.mcp_tool_use_id`
 * - cursor: `tool_call` on `call_id`, `status: "running"` until it completes
 * - dsh: `tool_call` / `tool_result` on `callId`
 * A call without an id gets `id: null` and is never flagged.
 */
function extractToolLogEvents(line: SessionLogForPreamble): ToolLogEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.content);
  } catch {
    return [];
  }
  const obj = asRecord(parsed);
  if (!obj) return [];

  const content = asRecord(obj.message)?.content;
  if (Array.isArray(content)) {
    const events: ToolLogEvent[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (!b) continue;
      if (b.type === "tool_use" && typeof b.name === "string") {
        events.push({ kind: "use", id: firstString(b.id), name: b.name, input: asRecord(b.input) });
      } else if (b.type === "tool_result") {
        const id = firstString(b.tool_use_id);
        if (id) events.push({ kind: "result", id });
      }
    }
    return events;
  }

  const update = asRecord(obj.update);
  if (update?.sessionUpdate === "tool_call_update") {
    const id = firstString(update.toolCallId);
    const input = asRecord(update.rawInput);
    return id && input ? [{ kind: "input", id, input }] : [];
  }

  const item = asRecord(obj.item);
  const result = (...ids: unknown[]): ToolLogEvent[] => {
    const id = firstString(...ids);
    return id ? [{ kind: "result", id }] : [];
  };

  switch (obj.type) {
    case "item.started": {
      return item && CODEX_TOOL_ITEMS.has(String(item.type)) ? [codexToolUse(item)] : [];
    }
    case "item.completed":
      return item && CODEX_TOOL_ITEMS.has(String(item.type)) ? result(item.id) : [];
    case "tool_start":
      return [
        {
          kind: "use",
          id: firstString(obj.toolCallId),
          name: firstString(obj.toolName) ?? "tool",
          input: asRecord(obj.args),
        },
      ];
    case "tool_end":
      return result(obj.toolCallId);
    case "agent.tool_use":
    case "agent.mcp_tool_use": {
      const name = firstString(obj.name) ?? "tool";
      const server = firstString(obj.mcp_server_name);
      return [
        {
          kind: "use",
          id: firstString(obj.id),
          name: obj.type === "agent.mcp_tool_use" && server ? `${server}.${name}` : name,
          input: asRecord(obj.input),
        },
      ];
    }
    case "agent.tool_result":
      return result(obj.tool_use_id);
    case "agent.mcp_tool_result":
      return result(obj.mcp_tool_use_id);
    case "tool_call": {
      // cursor: one `tool_call` row per state change on the same call_id.
      if (typeof obj.status === "string" && obj.call_id !== undefined) {
        if (obj.status !== "running") return result(obj.call_id);
        const args = asRecord(obj.args);
        const mcpTool = obj.name === "mcp" ? firstString(args?.toolName) : null;
        return [
          {
            kind: "use",
            id: firstString(obj.call_id),
            name: mcpTool
              ? `mcp__${firstString(args?.providerIdentifier) ?? "mcp"}__${mcpTool}`
              : (firstString(obj.name) ?? "tool"),
            input: mcpTool ? asRecord(args?.args) : args,
          },
        ];
      }
      // dsh
      return [
        {
          kind: "use",
          id: firstString(obj.callId),
          name: firstString(obj.tool, obj.name) ?? "tool",
          input: asRecord(obj.input),
        },
      ];
    }
    case "tool_use":
      return typeof obj.name === "string"
        ? [
            {
              kind: "use",
              id: firstString(obj.id, obj.tool_use_id, obj.call_id, obj.callId, obj.toolCallId),
              name: obj.name,
              input: asRecord(obj.input),
            },
          ]
        : [];
    case "tool_result":
      return result(obj.tool_use_id, obj.call_id, obj.callId, obj.toolCallId, obj.id);
    default:
      return [];
  }
}

/**
 * Find the tool call the interrupted session was waiting on. Walks back from
 * the most recent tool_use through the trailing run of unanswered calls (a
 * parallel batch) and returns the latest one that is not read-only, as
 * `<tool> <arg summary>`. Returns null when the most recent call got its
 * result or carries no id to pair on. The caller scrubs the result.
 */
function findInterruptedToolCall(logs: SessionLogForPreamble[]): string | null {
  const uses: Extract<ToolLogEvent, { kind: "use" }>[] = [];
  const answered = new Set<string>();
  const lateInput = new Map<string, ToolInput>();
  for (const line of logs) {
    for (const event of extractToolLogEvents(line)) {
      if (event.kind === "use") uses.push(event);
      else if (event.kind === "input") lateInput.set(event.id, event.input);
      else answered.add(event.id);
    }
  }
  for (let i = uses.length - 1; i >= 0; i--) {
    const use = uses[i];
    if (!use?.id || answered.has(use.id)) return null;
    if (READ_ONLY_TOOLS.has(use.name.toLowerCase())) continue;
    const input = { ...use.input, ...lateInput.get(use.id) };
    const primary = firstString(input?.file_path, input?.path, input?.command);
    const raw = primary ?? (input && Object.keys(input).length > 0 ? JSON.stringify(input) : "");
    const args = raw.replace(/\s+/g, " ").trim().slice(0, 200);
    return args ? `${use.name} ${args}` : use.name;
  }
  return null;
}

/**
 * Build a resume-task preamble.
 *
 * Reads the parent task + its recent session_logs over HTTP (never touches
 * `bun:sqlite` worker-side). Allocates the 4000-token budget:
 *
 *   - 40% — full parent task description (never truncated)
 *   - 30% — last-N session_logs summary (tool-call one-liners; scrubbed)
 *   - 10% — artifacts/attachments index (names + pointers only)
 *   - 10% — undelivered steering messages
 *   - 10% — fixed framing (header + continuation instructions)
 *
 * Truncation order: session-log summary (oldest first), then artifacts.
 * The task description is never truncated.
 */
/**
 * Walk up the parentTaskId chain through `taskType === "resume"` ancestors
 * to find the original (non-resume) task. Returns the chain in order
 * [immediateParent, ..., original]. Caps at MAX_RESUME_CHAIN_DEPTH to
 * defend against cycles or runaway chains.
 *
 * PR #594 review: cascading resumes (original → resume1 → resume2) had
 * `buildResumeContextPreamble` fetching only the immediate parent — whose
 * `task` text is the synthetic "Resume interrupted task..." prompt rather
 * than the original work brief. Walking the chain restores the original
 * description and lets us merge session logs from all resume attempts.
 */
const MAX_RESUME_CHAIN_DEPTH = 10;

async function walkResumeChain(
  apiUrl: string,
  apiKey: string,
  immediateParentId: string,
): Promise<TaskContextForPreamble[]> {
  const chain: TaskContextForPreamble[] = [];
  let currentId: string | undefined = immediateParentId;
  for (let depth = 0; depth < MAX_RESUME_CHAIN_DEPTH && currentId; depth++) {
    const ctx: TaskContextForPreamble | null = await fetchTaskContextForPreamble(
      apiUrl,
      apiKey,
      currentId,
    );
    if (!ctx) break;
    chain.push(ctx);
    // Stop once we hit a non-resume ancestor — that's the original work.
    if (ctx.taskType !== "resume") break;
    currentId = ctx.parentTaskId;
  }
  return chain;
}

export async function buildResumeContextPreamble(
  apiUrl: string,
  apiKey: string,
  parentTaskId: string,
): Promise<string | null> {
  const chain = await walkResumeChain(apiUrl, apiKey, parentTaskId);
  if (chain.length === 0) return null;
  // Original = last entry (non-resume ancestor, or the deepest reachable
  // if the chain exceeds the depth cap or hits a fetch failure).
  const original = chain[chain.length - 1] ?? chain[0];
  if (!original) return null;
  // Immediate parent — its attachments are the most recent "in flight" set.
  const parent = chain[0] ?? original;

  // Fetch session logs from EVERY chain member so a re-superseded resume
  // still surfaces tool-call history from earlier attempts. Merge, sort by
  // createdAt ASC, then keep the most recent N.
  const steeringEnabled = isSteeringEnabled();
  const [logsBatches, steeringBatches] = await Promise.all([
    Promise.all(chain.map((c) => fetchSessionLogsForResume(apiUrl, apiKey, c.id))),
    steeringEnabled
      ? Promise.all(chain.map((c) => fetchSteeringMessagesForResume(apiUrl, apiKey, c.id)))
      : Promise.resolve([]),
  ]);
  const merged = logsBatches.flat();
  merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recentLogs = merged.slice(-CONTEXT_PREAMBLE_RESUME_SESSION_LOG_LIMIT);
  const steeringMessages = steeringBatches.flat();
  steeringMessages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const descBudget = Math.floor(CONTEXT_PREAMBLE_RESUME_MAX_CHARS * 0.4);
  let logsBudget = Math.floor(CONTEXT_PREAMBLE_RESUME_MAX_CHARS * 0.3);
  let artBudget = Math.floor(CONTEXT_PREAMBLE_RESUME_MAX_CHARS * 0.1);
  const steeringBudget = Math.floor(CONTEXT_PREAMBLE_RESUME_MAX_CHARS * 0.1);

  // An unanswered side-effecting call may have landed before the cut-off
  // (git push, PR comment, message send). Flag it so the agent checks first.
  const interrupted = findInterruptedToolCall(recentLogs);
  const interruptedLine = interrupted
    ? scrubSecrets(
        `Interrupted: ${interrupted} may have landed. Check its effect before calling it again.`,
      )
    : "";

  const header = [
    "\n---",
    "## Resuming Interrupted Task",
    "",
    "This task is a fresh-session continuation of an interrupted task (graceful",
    "shutdown / context-limit / operator action). The block below summarizes the",
    "original task, what was done so far, and the artifacts in flight.",
    "",
    "**Do not redo work already completed below — extend it.**",
    "",
    `Original task ID: \`${original.id}\``,
    chain.length > 1
      ? `Resume chain depth: ${chain.length} (this is at least the ${
          chain.length === 2 ? "2nd" : chain.length === 3 ? "3rd" : `${chain.length}th`
        } resume attempt).`
      : "",
    interruptedLine,
    "",
    "---",
    "",
    "### Original Task Description",
    "",
  ]
    .filter((s) => s !== "")
    .join("\n");

  // 40% — full description (never truncated). Pulled from the ORIGINAL
  // (non-resume) ancestor so cascading resumes don't read each other's
  // synthetic "Resume interrupted task..." preamble bodies (PR #594 review).
  const descSection = original.task;

  // 35% — session-log summary (tool-call lines)
  const summaryLines: string[] = [];
  for (const line of recentLogs) {
    const summary = summarizeSessionLogLine(line);
    if (!summary) continue;
    summaryLines.push(summary);
  }
  // Scrub secrets BEFORE budget enforcement so secret strings don't get
  // sliced into half-redactions mid-truncate.
  const scrubbedSummary = summaryLines.map((s) => scrubSecrets(s));
  let logsSection = scrubbedSummary.join("\n");
  // FIFO truncate (drop oldest first) until under budget.
  // We use `Math.max(0, descBudget - descSection.length)` slack adjustment so
  // an oversized description doesn't starve the logs section entirely.
  if (descSection.length > descBudget) {
    const overflow = descSection.length - descBudget;
    logsBudget = Math.max(0, logsBudget - Math.ceil(overflow / 2));
    artBudget = Math.max(0, artBudget - Math.floor(overflow / 2));
  }
  while (logsSection.length > logsBudget && scrubbedSummary.length > 0) {
    scrubbedSummary.shift();
    logsSection = scrubbedSummary.join("\n");
  }

  // 10% — steering messages that could not be delivered before the parent
  // stopped. Oldest entries fall away first, matching session-log truncation.
  const steeringLines = steeringEnabled
    ? steeringMessages.map((message) => {
        const ts = message.createdAt.slice(11, 19);
        return `[${ts}] ${scrubSecrets(message.body)}`;
      })
    : [];
  let steeringSection = steeringLines.join("\n");
  while (steeringSection.length > steeringBudget && steeringLines.length > 0) {
    steeringLines.shift();
    steeringSection = steeringLines.join("\n");
  }

  // 10% — artifacts (names + pointers only)
  const atts = parent.attachments?.filter((a) => a.name && (a.url || a.path || a.pageId)) ?? [];
  const artLines: string[] = [];
  for (const att of atts) {
    const pointer = formatAttachmentPointer(att);
    artLines.push(`  - **${att.name}**: \`${pointer}\``);
  }
  let artSection = artLines.join("\n");
  while (artSection.length > artBudget && artLines.length > 0) {
    artLines.pop();
    artSection = artLines.join("\n");
  }

  const sections: string[] = [header, descSection, ""];

  if (logsSection) {
    sections.push("### Recent Tool Calls", "", logsSection, "");
  }

  if (artSection) {
    sections.push("### Artifacts In Flight", "", artSection, "");
  }

  if (steeringEnabled && steeringSection) {
    sections.push("### Undelivered Steering Messages", "", steeringSection, "");
  }

  sections.push(
    "---",
    "",
    `To review the full prior session call \`get-task-details\` with taskId \`${original.id}\`.`,
    "",
    "---",
    "",
  );

  let preamble = sections.join("\n");

  // Final hard cap — should rarely trip given the per-section budgets above,
  // but provides a safety net for very long descriptions.
  if (preamble.length > CONTEXT_PREAMBLE_RESUME_MAX_CHARS) {
    preamble = `${preamble.slice(0, CONTEXT_PREAMBLE_RESUME_MAX_CHARS)}\n\n[resume preamble truncated to ${CONTEXT_PREAMBLE_RESUME_MAX_TOKENS}-token budget]\n\n---\n`;
  }

  return preamble;
}
