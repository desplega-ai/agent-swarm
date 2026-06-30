/**
 * Tool loop detection for agent-swarm hooks.
 *
 * Tracks recent tool calls per session and detects repetitive patterns.
 * Uses a file-based history to persist across hook invocations (hooks are
 * separate Bun processes, not long-running).
 */

interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  timestamp: number;
  codexEnvelope?: boolean;
}

interface LoopDetectionResult {
  blocked: boolean;
  reason?: string;
  severity?: "warning" | "critical";
}

const HISTORY_DIR = "/tmp/agent-swarm-tool-history";
const MAX_HISTORY = 50; // Sliding window size
const REPEAT_WARNING_THRESHOLD = 8;
const REPEAT_CRITICAL_THRESHOLD = 15;
const LOW_CARDINALITY_FILE_CHANGE_CRITICAL_THRESHOLD = 24;
const PINGPONG_WARNING_THRESHOLD = 6;
const PINGPONG_CRITICAL_THRESHOLD = 12;
const CODEX_PINGPONG_CRITICAL_THRESHOLD = 24;

/**
 * Simple hash of tool arguments for comparison.
 * Uses JSON.stringify + a basic hash to avoid storing full args.
 */
function hashArgs(args: Record<string, unknown>): string {
  const str = JSON.stringify(args, Object.keys(args).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString(36);
}

function isCodexFileChangeArgs(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "Edit" && toolName !== "Write" && toolName !== "Delete") {
    return false;
  }

  const topLevelKeys = Object.keys(toolInput);
  if (topLevelKeys.length !== 1 || topLevelKeys[0] !== "changes") {
    return false;
  }

  const changes = toolInput.changes;
  if (!Array.isArray(changes) || changes.length === 0) {
    return false;
  }

  return changes.every((change) => {
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      return false;
    }

    const entry = change as Record<string, unknown>;
    const keys = Object.keys(entry).sort();
    return (
      keys.length === 2 &&
      keys[0] === "kind" &&
      keys[1] === "path" &&
      typeof entry.path === "string" &&
      (entry.kind === "add" || entry.kind === "update" || entry.kind === "delete")
    );
  });
}

function isCodexEnvelopeArgs(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (isCodexFileChangeArgs(toolName, toolInput)) return true;

  // Codex MCP tool call envelope: the codex adapter wraps MCP tool args
  // in {server, tool, arguments}. This shape only appears on the codex
  // harness — claude hooks see raw MCP tool input instead. The arguments
  // field may be absent/empty at item.started, making all calls to the
  // same tool hash identically (same root cause as file_change).
  if ("server" in toolInput && "tool" in toolInput) return true;

  return false;
}

/**
 * Load tool call history for a session.
 */
async function loadHistory(sessionKey: string): Promise<ToolCallRecord[]> {
  try {
    const file = Bun.file(`${HISTORY_DIR}/${sessionKey}.json`);
    if (await file.exists()) {
      return await file.json();
    }
  } catch {
    // Corrupted or missing file — start fresh
  }
  return [];
}

/**
 * Save tool call history for a session.
 */
async function saveHistory(sessionKey: string, history: ToolCallRecord[]): Promise<void> {
  try {
    await Bun.$`mkdir -p ${HISTORY_DIR}`.quiet();
    await Bun.write(
      `${HISTORY_DIR}/${sessionKey}.json`,
      JSON.stringify(history.slice(-MAX_HISTORY)),
    );
  } catch {
    // Non-critical — best effort persistence
  }
}

/**
 * Detect if the current tool call is part of a repetitive loop.
 */
export async function checkToolLoop(
  sessionKey: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<LoopDetectionResult> {
  const argsHash = hashArgs(toolInput);
  const history = await loadHistory(sessionKey);

  // Add current call to history
  const codexEnvelope = isCodexEnvelopeArgs(toolName, toolInput) || undefined;
  history.push({ toolName, argsHash, timestamp: Date.now(), codexEnvelope });
  await saveHistory(sessionKey, history);

  // Only check if we have enough history
  if (history.length < REPEAT_WARNING_THRESHOLD) {
    return { blocked: false };
  }

  // Strategy 1: Same tool + same args repeated
  const key = `${toolName}:${argsHash}`;
  const repeatCriticalThreshold = isCodexFileChangeArgs(toolName, toolInput)
    ? LOW_CARDINALITY_FILE_CHANGE_CRITICAL_THRESHOLD
    : REPEAT_CRITICAL_THRESHOLD;
  let repeatCount = 0;
  for (const record of history) {
    if (`${record.toolName}:${record.argsHash}` === key) {
      repeatCount++;
    }
  }

  if (repeatCount >= repeatCriticalThreshold) {
    return {
      blocked: true,
      severity: "critical",
      reason: `Tool "${toolName}" has been called ${repeatCount} times with identical arguments in the last ${MAX_HISTORY} calls. You are stuck in a loop. Try a completely different approach.`,
    };
  }

  // Defer repeat warnings — let the ping-pong detector run first since it
  // may produce a higher-severity critical result.
  let pendingWarning: LoopDetectionResult | undefined;
  if (repeatCount >= REPEAT_WARNING_THRESHOLD) {
    pendingWarning = {
      blocked: false,
      severity: "warning",
      reason: `Tool "${toolName}" has been called ${repeatCount} times with identical arguments. Consider trying a different approach.`,
    };
  }

  // Strategy 2: Ping-pong between two tool call patterns
  if (history.length >= PINGPONG_WARNING_THRESHOLD) {
    // On codex, tool args are low-cardinality (file_change has only path+kind,
    // MCP calls are wrapped in a {server,tool,arguments} envelope). Genuinely
    // different edits/runs hash identically, so a productive edit→test cycle
    // looks like a stuck loop. Use a higher threshold for codex sessions.
    const isCodexSession = history.some((r) => r.codexEnvelope === true);
    const effectiveCriticalThreshold = isCodexSession
      ? CODEX_PINGPONG_CRITICAL_THRESHOLD
      : PINGPONG_CRITICAL_THRESHOLD;

    const recent = history.slice(-effectiveCriticalThreshold);
    const patterns = new Map<string, number>();
    for (const r of recent) {
      const p = `${r.toolName}:${r.argsHash}`;
      patterns.set(p, (patterns.get(p) || 0) + 1);
    }

    // Check if exactly 2 patterns dominate
    const sorted = [...patterns.entries()].sort((a, b) => b[1] - a[1]);
    if (sorted.length >= 2) {
      const [first, second] = sorted;
      if (first && second) {
        const dominance = first[1] + second[1];
        if (dominance >= recent.length * 0.8) {
          const totalPingPong = first[1] + second[1];
          if (totalPingPong >= effectiveCriticalThreshold) {
            return {
              blocked: true,
              severity: "critical",
              reason: `Detected ping-pong loop: alternating between "${first[0].split(":")[0]}" and "${second[0].split(":")[0]}" for ${totalPingPong} calls. Break out of this pattern.`,
            };
          }
          if (totalPingPong >= PINGPONG_WARNING_THRESHOLD) {
            return {
              blocked: false,
              severity: "warning",
              reason:
                "Possible ping-pong pattern detected between two tool calls. Consider a different approach.",
            };
          }
        }
      }
    }
  }

  return pendingWarning ?? { blocked: false };
}

/**
 * Clear tool call history for a session (call on session end).
 */
export async function clearToolHistory(sessionKey: string): Promise<void> {
  try {
    await Bun.$`rm -f ${HISTORY_DIR}/${sessionKey}.json`.quiet();
  } catch {
    // Non-critical
  }
}
