/**
 * Write-time bounds on `session_logs`.
 *
 * Retention is age-based, so it cannot act on a table that grows inside its own
 * day granularity: one session wrote 7.3 GB in 27 minutes and OOM-killed the
 * API container, with nothing old enough to sweep.
 *
 * Every limit counts UTF-8 bytes, the unit SQLite stores and the disk fills
 * with. `String.length` would undercount by up to 4x on non-ASCII text.
 */

const SESSION_LOG_LINE_MAX_BYTES = 256 * 1024;
const SESSION_LOG_SESSION_MAX_MB_DEFAULT = 256;

const encoder = new TextEncoder();

export function sessionLogByteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * What one row costs against the session budget. Floored, because a row of
 * empty strings still costs a SQLite row and its index entries: charging only
 * `content` would let a flood of blank lines grow the table forever without
 * ever exhausting the budget.
 */
const SESSION_LOG_ROW_OVERHEAD_BYTES = 128;

export function sessionLogRowCost(
  content: string,
  metadata: { sessionId: string; taskId?: string; cli: string },
): number {
  // Session/task ids also occur in their indexes; charging content alone lets
  // repeated metadata amplify short lines without spending the budget.
  return (
    sessionLogByteLength(content) +
    2 * sessionLogByteLength(metadata.sessionId) +
    2 * sessionLogByteLength(metadata.taskId ?? "") +
    sessionLogByteLength(metadata.cli) +
    SESSION_LOG_ROW_OVERHEAD_BYTES
  );
}

/** A client-supplied session id cannot spend another authorized owner's budget. */
export function sessionLogAccountKey(sessionId: string, owner: string): string {
  return JSON.stringify([owner, sessionId]);
}

export function sessionLogBudgetBytes(): number {
  const raw = Number(process.env.SESSION_LOG_SESSION_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : SESSION_LOG_SESSION_MAX_MB_DEFAULT;
  return mb * 1024 * 1024;
}

/**
 * `line`, cut so the stored row stays under the per-row cap including the
 * suffix. The cut lands on a code-point boundary: a streaming decode drops a
 * trailing partial sequence instead of emitting a replacement character.
 */
export function boundSessionLogLine(line: string): string {
  const encoded = encoder.encode(line);
  if (encoded.length <= SESSION_LOG_LINE_MAX_BYTES) return line;
  // Every harness writes JSONL here. Cutting the serialized form would leave
  // the row unparseable, and the dashboard renders it as a parse error instead
  // of the event — so an oversized structured row becomes a valid marker.
  if (line.startsWith("{") || line.startsWith("[")) {
    return JSON.stringify({
      type: "session_log_truncated",
      reason: "event exceeded the session-log row bound",
      bytes: encoded.length,
    });
  }
  // The suffix spends part of the cap, so the count reports what was really
  // dropped from the cut point rather than `length - cap`.
  const suffixWidth = sessionLogByteLength(` [truncated ${encoded.length} bytes by agent-swarm]`);
  const head = new TextDecoder("utf-8").decode(
    encoded.subarray(0, SESSION_LOG_LINE_MAX_BYTES - suffixWidth),
    { stream: true },
  );
  return `${head} [truncated ${encoded.length - sessionLogByteLength(head)} bytes by agent-swarm]`;
}

export function sessionLogBudgetMarker(sessionId: string, maxBytes: number): string {
  return JSON.stringify({ type: "session_log_budget_exhausted", sessionId, maxBytes });
}
