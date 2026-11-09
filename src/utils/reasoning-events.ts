// Pure per-line reasoning extractor for `session_logs`. No DB import: the API
// write path and the UI logs-parser share it. Text lengths match the reasoning
// items the UI parser (apps/ui/src/logs-parser) builds from the same line.

export type ReasoningKind = "reasoning" | "update";

export interface LineReasoning {
  /** `null` when the line has no reasoning block (both columns stay NULL). */
  reasoning: { chars: number; blocks: number; messageId?: string } | null;
  /** Set when a Claude line carries a `tool_use` block. */
  toolUseMessageId?: string;
}

// Claude Code stream-json shape: pi and amp logs reuse it.
const ANTHROPIC_CLIS = new Set(["claude", "pi", "amp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function joinStrings(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").join("\n")
    : str(value);
}

export function extractReasoning(cli: string, line: string): LineReasoning {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    // Some stored lines are not JSON (stderr, truncated writes).
    return { reasoning: null };
  }
  if (!isRecord(ev)) return { reasoning: null };

  if (ANTHROPIC_CLIS.has(cli)) {
    const message = isRecord(ev.message) ? ev.message : undefined;
    if (!message || !Array.isArray(message.content)) return { reasoning: null };
    const messageId = typeof message.id === "string" ? message.id : undefined;
    let chars = 0;
    let blocks = 0;
    let hasToolUse = false;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      if (block.type === "thinking") {
        blocks++;
        chars += String(block.thinking ?? block.text ?? "").length;
      } else if (block.type === "tool_use") {
        hasToolUse = true;
      }
    }
    return {
      reasoning: blocks > 0 ? { chars, blocks, messageId } : null,
      ...(cli === "claude" && hasToolUse && messageId ? { toolUseMessageId: messageId } : {}),
    };
  }

  switch (cli) {
    case "codex": {
      const item = isRecord(ev.item) ? ev.item : undefined;
      if (ev.type !== "item.completed" || item?.type !== "reasoning") break;
      const text = str(item.text) || joinStrings(item.summary) || joinStrings(item.content);
      return { reasoning: { chars: text.length, blocks: 1 } };
    }
    case "opencode": {
      // shortcut: v2 `session.reasoning.ended` only. v1 reasoning arrives as
      // deltas spread over lines, which a per-line read cannot sum; add it if
      // v1 sessions come back.
      if (ev.type !== "session.reasoning.ended") break;
      const data = isRecord(ev.data) ? ev.data : {};
      return { reasoning: { chars: str(data.text).length, blocks: 1 } };
    }
    case "cursor":
    case "dsh": {
      if (ev.type !== "thinking") break;
      return { reasoning: { chars: str(ev.text).length, blocks: 1 } };
    }
  }
  // acp and every other cli: untracked.
  return { reasoning: null };
}

/**
 * Classifies one Claude `message.id`'s ordered blocks. Returns one kind per
 * thinking block, in order. Rule (t3code): when two or more consecutive
 * thinking blocks directly precede a `tool_use`, the last one is a pre-tool
 * `update`; every other thinking block is `reasoning`.
 */
export function classifyClaudeThinking(blocks: Array<{ type: string }>): ReasoningKind[] {
  const kinds: ReasoningKind[] = [];
  let run = 0;
  for (const block of blocks) {
    if (block.type === "thinking") {
      kinds.push("reasoning");
      run++;
      continue;
    }
    if (block.type === "tool_use" && run >= 2) kinds[kinds.length - 1] = "update";
    run = 0;
  }
  return kinds;
}
