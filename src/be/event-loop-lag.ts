/**
 * Event-loop stall attribution.
 *
 * Synchronous SQLite runs on the main thread, and a chain of awaited DB calls
 * resolves in the microtask queue, so the whole chain is one macrotask. A
 * stall over 5 s makes the Slack Socket Mode client miss its pong. The OTel
 * `nodejs.eventloop.delay.max` histogram shows that a stall happened, but not
 * when or which code path ran it.
 *
 * This module adds:
 * - a breadcrumb: `withLoopPath(path, fn)` names the entry point (HTTP route,
 *   MCP tool, timer) on an AsyncLocalStorage that follows `await`;
 * - a bounded ring of the DB statements run since the last probe tick, fed by
 *   the DB client (`recordStatement`);
 * - a `setTimeout` lag probe. A stall of N ms delays its tick by about N ms.
 *   The first tick after the stall sees exactly the statements of the stalled
 *   macrotask and logs one `[event-loop] stall` line.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { scrubSecrets } from "../utils/secret-scrubber";

const pathContext = new AsyncLocalStorage<string>();

/** Run `fn` with `path` as the entry point of everything it starts. */
export function withLoopPath<T>(path: string, fn: () => T): T {
  return pathContext.run(path, fn);
}

/** Entry point of the code that runs now, or `unknown`. */
export function currentLoopPath(): string {
  return pathContext.getStore() ?? "unknown";
}

type RecordedStatement = { path: string; sql: string; ms: number };

/** Statements shorter than this cannot make a stall worth a log line. */
const STATEMENT_RECORD_MIN_MS = 10;
const STATEMENT_RING_MAX = 256;
const ring: RecordedStatement[] = [];

/**
 * Called by the DB client for each driver call. Stores a reference to the SQL
 * string only; the label is built only when a stall line is logged.
 */
export function recordStatement(sql: string, ms: number): void {
  if (ms < STATEMENT_RECORD_MIN_MS) return;
  if (ring.length === STATEMENT_RING_MAX) ring.shift();
  ring.push({ path: currentLoopPath(), sql, ms });
}

const PROBE_MS = 100;
const DEFAULT_STALL_WARN_MS = 1000;
const TOP_STATEMENTS = 3;
const LABEL_MAX_CHARS = 60;

/** Read per tick, so a config reload applies without a restart. */
function stallWarnMs(): number {
  const raw = Number(process.env.EVENT_LOOP_STALL_WARN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_WARN_MS;
}

function statementLabel(sql: string): string {
  return scrubSecrets(sql.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX_CHARS));
}

/**
 * Build the stall line from the statements recorded during the stall.
 * Params are never logged: they can carry secrets and user content.
 */
export function formatStallLine(lagMs: number, statements: readonly RecordedStatement[]): string {
  let dbMs = 0;
  const perPath = new Map<string, number>();
  for (const s of statements) {
    dbMs += s.ms;
    perPath.set(s.path, (perPath.get(s.path) ?? 0) + 1);
  }
  const top = [...statements].sort((a, b) => b.ms - a.ms).slice(0, TOP_STATEMENTS);
  const path = top[0]?.path ?? "unknown";
  const parts = [
    `[event-loop] stall ${Math.round(lagMs)}ms`,
    `path=${path}`,
    `statements=${statements.length}`,
    `db_ms=${Math.round(dbMs)}`,
  ];
  if (top.length > 0) {
    parts.push(`top=${top.map((s) => `${Math.round(s.ms)}ms:${statementLabel(s.sql)}`).join("|")}`);
    parts.push(
      `paths=${[...perPath]
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `${p}:${n}`)
        .join(",")}`,
    );
  }
  return parts.join(" ");
}

let stopProbe: (() => void) | null = null;

/**
 * Start the lag probe. A `setTimeout` chain, not `setInterval`: missed
 * intervals coalesce and lose the lag value. Returns a stop function.
 */
export function startEventLoopLagProbe(probeMs = PROBE_MS): () => void {
  if (stopProbe) return stopProbe;
  let timer: ReturnType<typeof setTimeout>;
  let expected = performance.now() + probeMs;
  const schedule = () => {
    timer = setTimeout(tick, probeMs);
    timer.unref?.();
  };
  const tick = () => {
    const now = performance.now();
    const lag = now - expected;
    if (lag >= stallWarnMs()) console.warn(formatStallLine(lag, ring));
    ring.length = 0;
    expected = now + probeMs;
    schedule();
  };
  // The probe owns no entry point: its own ticks must not inherit the caller's.
  pathContext.exit(schedule);
  const stop = () => {
    clearTimeout(timer);
    ring.length = 0;
    if (stopProbe === stop) stopProbe = null;
  };
  stopProbe = stop;
  return stop;
}

/** Stop the probe started by `startEventLoopLagProbe`, if any. */
export function stopEventLoopLagProbe(): void {
  stopProbe?.();
}
