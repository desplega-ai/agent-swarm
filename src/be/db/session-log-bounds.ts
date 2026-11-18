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
  const suffix = ` [truncated ${encoded.length - SESSION_LOG_LINE_MAX_BYTES} bytes by agent-swarm]`;
  const room = SESSION_LOG_LINE_MAX_BYTES - sessionLogByteLength(suffix);
  const head = new TextDecoder("utf-8").decode(encoded.subarray(0, room), { stream: true });
  return `${head}${suffix}`;
}

export function sessionLogBudgetMarker(sessionId: string, maxBytes: number): string {
  return JSON.stringify({ type: "session_log_budget_exhausted", sessionId, maxBytes });
}
