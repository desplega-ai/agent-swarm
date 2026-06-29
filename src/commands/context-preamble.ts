/**
 * Universal context preamble for follow-up task continuity.
 *
 * Builds a bounded text summary of prior task context (parent → ancestor chain)
 * and prepends it to the child task's prompt. This makes follow-up continuity
 * uniform across ALL harness providers — not just those that support native
 * session resume (claude/codex).
 *
 * Token budget (CONTEXT_PREAMBLE_MAX_TOKENS, default 2000) prevents the
 * SIGTERM-143 context-saturation failure mode seen with unbounded session
 * resumes (see swarm memory sigterm-143-resumed-session-context-saturation-2026-05-13).
 */

import type { TaskAttachment } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { taskAttachmentDisplayUrl } from "../utils/task-attachment-links";

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
  const pointer = taskAttachmentDisplayUrl(att as TaskAttachment);
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
 * Build a resume-task preamble.
 *
 * Reads the parent task + its recent session_logs over HTTP (never touches
 * `bun:sqlite` worker-side). Allocates the 4000-token budget:
 *
 *   - 40% — full parent task description (never truncated)
 *   - 35% — last-N session_logs summary (tool-call one-liners; scrubbed)
 *   - 15% — artifacts/attachments index (names + pointers only)
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
  const logsBatches = await Promise.all(
    chain.map((c) => fetchSessionLogsForResume(apiUrl, apiKey, c.id)),
  );
  const merged = logsBatches.flat();
  merged.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recentLogs = merged.slice(-CONTEXT_PREAMBLE_RESUME_SESSION_LOG_LIMIT);

  const descBudget = Math.floor(CONTEXT_PREAMBLE_RESUME_MAX_CHARS * 0.4);
  let logsBudget = Math.floor(CONTEXT_PREAMBLE_RESUME_MAX_CHARS * 0.35);
  let artBudget = Math.floor(CONTEXT_PREAMBLE_RESUME_MAX_CHARS * 0.15);

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

  // 15% — artifacts (names + pointers only)
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
