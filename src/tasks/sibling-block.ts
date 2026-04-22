/**
 * Pure rendering + selection helpers for cross-ingress sibling-task awareness.
 *
 * Phase 2 of the cross-ingress sibling-task awareness initiative. The reader
 * side: when an ingress is about to create a task and other tasks already
 * share the same `contextKey`, we (a) prepend a `<sibling_tasks_in_progress>`
 * block to the new task's description so the worker knows about the
 * concurrent work, and (b) optionally wire `parentTaskId` to the most
 * relevant sibling so Claude-Code session resume kicks in.
 *
 * This module is intentionally dependency-free — no DB calls, no I/O — so it
 * is trivial to unit-test and safe to call from any ingress.
 */

export type SiblingTaskInfo = {
  id: string;
  status: string;
  agentId: string | null;
  agentName: string | null;
  description: string;
  // Most recent change timestamp (ISO string). Used for relative-time render
  // and for picking the "best" sibling to wire as parent.
  updatedAt: string;
};

const DESCRIPTION_TRUNCATE = 200;

// Status priority for picking the resume parent. Higher number wins.
// in_progress > pending > offered > paused (per task spec, research §3.2).
const STATUS_PRIORITY: Record<string, number> = {
  in_progress: 4,
  pending: 3,
  offered: 2,
  paused: 1,
};

/**
 * Remove a previously-prepended sibling block (if any) from a task
 * description. Called before rendering a sibling into a *new* block so we
 * don't end up nesting blocks recursively — siblings show their ORIGINAL
 * user-facing intent, not the inherited sibling-awareness preamble from when
 * they were created.
 */
export function stripSiblingBlock(description: string): string {
  if (typeof description !== "string") return "";
  const start = description.indexOf("<sibling_tasks_in_progress>");
  if (start === -1) return description;
  const closeTag = "</sibling_tasks_in_progress>";
  const end = description.indexOf(closeTag, start);
  if (end === -1) return description;
  // Drop block + any immediately following whitespace (blank line separator).
  const after = description.slice(end + closeTag.length).replace(/^\s+/, "");
  const before = description.slice(0, start).replace(/\s+$/, "");
  return before ? `${before}\n\n${after}` : after;
}

export function truncateForBlock(s: string, max: number = DESCRIPTION_TRUNCATE): string {
  if (typeof s !== "string") return "";
  // Collapse any embedded newlines so each sibling stays on one rendered line
  // (the description follows the bullet on its own continuation line).
  const flattened = s.replace(/\s+/g, " ").trim();
  if (flattened.length <= max) return flattened;
  return `${flattened.slice(0, max).trimEnd()}…`;
}

export function formatRelativeTime(then: string | number | Date, now: number = Date.now()): string {
  const t = then instanceof Date ? then.getTime() : new Date(then).getTime();
  if (!Number.isFinite(t)) return "unknown time";
  const diffMs = Math.max(0, now - t);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

/**
 * Render the sibling-tasks block. Returns "" when there are no siblings so
 * callers can unconditionally prepend the result.
 */
export function renderSiblingBlock(
  contextKey: string,
  siblings: SiblingTaskInfo[],
  now: number = Date.now(),
): string {
  if (!siblings || siblings.length === 0) return "";

  const lines: string[] = [];
  lines.push("<sibling_tasks_in_progress>");
  lines.push(
    `The following tasks are already running in the same context (contextKey: ${contextKey}). The user has submitted new input while they were in flight — coordinate with them, do not duplicate:`,
  );
  lines.push("");
  for (const s of siblings) {
    const agentLabel = s.agentName
      ? `agent:${s.agentName}`
      : s.agentId
        ? `agent:${s.agentId}`
        : "agent:unassigned";
    const rel = formatRelativeTime(s.updatedAt, now);
    lines.push(`- [${s.status}] task:${s.id} — ${agentLabel} — started ${rel} ago`);
    lines.push(`  "${truncateForBlock(s.description)}"`);
  }
  lines.push("</sibling_tasks_in_progress>");
  return lines.join("\n");
}

/**
 * Pick the sibling that should be wired as `parentTaskId` so Claude-Code
 * session resume picks up the conversation. Returns `null` when no sibling
 * is eligible.
 *
 * Eligibility rules (research §3.2 + task spec):
 *   - Sibling must be assigned to the same agent as the incoming task.
 *     Cross-agent resume doesn't make sense — different worker, different
 *     filesystem, different session state.
 *   - Among eligible siblings, prefer higher status priority
 *     (in_progress > pending > offered > paused), then most-recently-updated.
 *
 * If `currentAgentId` is null/undefined, no wiring happens — we don't know
 * which worker will pick up the task, so resume semantics are undefined.
 */
export function pickResumeParent<
  T extends Pick<SiblingTaskInfo, "id" | "status" | "agentId" | "updatedAt">,
>(siblings: T[], currentAgentId: string | null | undefined): T | null {
  if (!currentAgentId) return null;
  if (!siblings || siblings.length === 0) return null;

  const eligible = siblings.filter((s) => s.agentId && s.agentId === currentAgentId);
  if (eligible.length === 0) return null;

  let best: T | null = null;
  let bestPriority = -1;
  let bestTime = -1;
  for (const s of eligible) {
    const priority = STATUS_PRIORITY[s.status] ?? 0;
    const time = new Date(s.updatedAt).getTime();
    const timeFinite = Number.isFinite(time) ? time : 0;
    if (priority > bestPriority || (priority === bestPriority && timeFinite > bestTime)) {
      best = s;
      bestPriority = priority;
      bestTime = timeFinite;
    }
  }
  return best;
}

/**
 * Convenience: prepend the sibling block to a task description, with a blank
 * line separator. Returns `description` unchanged when there are no siblings.
 */
export function prependSiblingBlock(
  description: string,
  contextKey: string,
  siblings: SiblingTaskInfo[],
  now: number = Date.now(),
): string {
  const block = renderSiblingBlock(contextKey, siblings, now);
  if (!block) return description;
  return `${block}\n\n${description}`;
}
