/**
 * Write-time bounds on `session_logs`.
 *
 * Retention is age-based, so it cannot act on a table that grows inside its own
 * day granularity: one session wrote 7.3 GB in 27 minutes and OOM-killed the
 * API container, with nothing old enough to sweep.
 */

const SESSION_LOG_LINE_MAX_CHARS = 256 * 1024;
const SESSION_LOG_SESSION_MAX_MB_DEFAULT = 256;
/** Approximate bytes written per session this boot. Bounded by its own eviction. */
const sessionLogBytes = new Map<string, number>();
const SESSION_LOG_TRACKED_SESSIONS_MAX = 10_000;

export function sessionLogBudgetBytes(): number {
  const raw = Number(process.env.SESSION_LOG_SESSION_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : SESSION_LOG_SESSION_MAX_MB_DEFAULT;
  return mb * 1024 * 1024;
}

export function sessionLogBytesWritten(sessionId: string): number {
  return sessionLogBytes.get(sessionId) ?? 0;
}

export function trackSessionLogBytes(sessionId: string, written: number): void {
  // Oldest-first eviction: a forgotten session restarts at zero, which costs
  // another budget at worst and never blocks a live session's logs.
  if (!sessionLogBytes.has(sessionId) && sessionLogBytes.size >= SESSION_LOG_TRACKED_SESSIONS_MAX) {
    const oldest = sessionLogBytes.keys().next();
    if (!oldest.done) sessionLogBytes.delete(oldest.value);
  }
  sessionLogBytes.set(sessionId, written);
}

export function boundSessionLogLine(line: string): string {
  return line.length > SESSION_LOG_LINE_MAX_CHARS
    ? `${line.slice(0, SESSION_LOG_LINE_MAX_CHARS)}… [truncated ${line.length - SESSION_LOG_LINE_MAX_CHARS} chars by agent-swarm]`
    : line;
}

export function sessionLogBudgetMarker(sessionId: string, maxBytes: number): string {
  return JSON.stringify({ type: "session_log_budget_exhausted", sessionId, maxBytes });
}
