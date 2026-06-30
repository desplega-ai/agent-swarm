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
  isLowCardinality?: boolean;
}

interface LoopDetectionResult {
  blocked: boolean;
  reason?: string;
  severity?: "warning" | "critical";
}

const HISTORY_DIR = "/tmp/agent-swarm-tool-history";
const MAX_HISTORY = 40; // Sliding window — must exceed LOW_CARDINALITY_PINGPONG_CRITICAL_THRESHOLD (24)
const REPEAT_WARNING_THRESHOLD = 8;
const REPEAT_CRITICAL_THRESHOLD = 15;
const LOW_CARDINALITY_FILE_CHANGE_CRITICAL_THRESHOLD = 24;
const PINGPONG_WARNING_THRESHOLD = 6;
const PINGPONG_CRITICAL_THRESHOLD = 12;
const LOW_CARDINALITY_PINGPONG_WARNING_THRESHOLD = 12;
const LOW_CARDINALITY_PINGPONG_CRITICAL_THRESHOLD = 24;

/**
 * Recursively sort object keys so serialization is deterministic regardless
 * of insertion order. Array elements are preserved in order (positional).
 */
function deepSortKeys(val: unknown): unknown {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map(deepSortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(val as Record<string, unknown>).sort()) {
    sorted[key] = deepSortKeys((val as Record<string, unknown>)[key]);
  }
  return sorted;
}

/**
 * Simple hash of tool arguments for comparison.
 * Uses deep-sorted JSON.stringify + a basic hash to avoid storing full args.
 *
 * NOTE: the previous implementation used `JSON.stringify(args, Object.keys(args).sort())`
 * which passed the top-level keys as a replacer array. This inadvertently stripped
 * nested keys whose names didn't appear in the top-level key list — e.g. for
 * `{server, tool, arguments: {name, source}}`, the replacer `["arguments","server","tool"]`
 * would drop "name" and "source" at the nested level, making ALL MCP calls to the
 * same tool hash identically regardless of their actual arguments.
 */
function hashArgs(args: Record<string, unknown>): string {
  const str = JSON.stringify(deepSortKeys(args));
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
  const lowCardinality = isCodexFileChangeArgs(toolName, toolInput);
  const history = await loadHistory(sessionKey);

  // Add current call to history
  history.push({
    toolName,
    argsHash,
    timestamp: Date.now(),
    isLowCardinality: lowCardinality || undefined,
  });
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

  // Stash repeat warning — a ping-pong critical result takes priority
  let pendingWarning: LoopDetectionResult | undefined;
  if (repeatCount >= REPEAT_WARNING_THRESHOLD) {
    pendingWarning = {
      blocked: false,
      severity: "warning",
      reason: `Tool "${toolName}" has been called ${repeatCount} times with identical arguments. Consider trying a different approach.`,
    };
  }

  // Strategy 2: Ping-pong between two tool call patterns
  // Use higher thresholds when either dominant pattern involves low-cardinality
  // args (e.g. codex file_change where edits to the same file hash identically
  // because the args carry {path, kind} but no content/diff).
  if (history.length >= PINGPONG_WARNING_THRESHOLD) {
    const hasLowCardinality = history.some((r) => r.isLowCardinality);
    const ppCritical = hasLowCardinality
      ? LOW_CARDINALITY_PINGPONG_CRITICAL_THRESHOLD
      : PINGPONG_CRITICAL_THRESHOLD;
    const ppWarning = hasLowCardinality
      ? LOW_CARDINALITY_PINGPONG_WARNING_THRESHOLD
      : PINGPONG_WARNING_THRESHOLD;

    const recent = history.slice(-ppCritical);
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
          if (totalPingPong >= ppCritical) {
            return {
              blocked: true,
              severity: "critical",
              reason: `Detected ping-pong loop: alternating between "${first[0].split(":")[0]}" and "${second[0].split(":")[0]}" for ${totalPingPong} calls. Break out of this pattern.`,
            };
          }
          if (totalPingPong >= ppWarning) {
            pendingWarning ??= {
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
