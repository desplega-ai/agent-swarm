/**
 * RBAC permission-audit batched writer + retention GC (DES-445, Phase 6).
 *
 * `enqueueAuditRow` is the concrete `AuditSink` wired into `can()` at server
 * boot (src/http/index.ts, src/stdio.ts). Rows buffer in memory and flush in
 * a single transaction every FLUSH_INTERVAL_MS (2s) or at FLUSH_MAX_ROWS (200),
 * whichever comes first. Every path is try/caught — a failed flush logs a
 * warning and DROPS the batch; auditing must never throw into the request path.
 * Rows are structured ids/verbs only (no payloads, no secret-bearing content).
 *
 * Kill-switch: `RBAC_AUDIT_DISABLED=true` makes the sink a no-op (checked per
 * call so tests and live config reloads can toggle it).
 *
 * Retention: `startAuditGc` (pattern: startMemoryGc in src/http/memory.ts)
 * ticks daily and deletes rows older than RBAC_AUDIT_RETENTION_DAYS
 * (default 30).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AdmissionDecision, RbacCheck, RbacDecision } from "../rbac";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { getDbClient } from "./db";

type AuditRow = {
  principalType: "agent" | "user" | "operator";
  principalId: string | null;
  originatorUserId: string | null;
  verb: string;
  resourceType: string | null;
  resourceId: string | null;
  decision: "allow" | "deny";
  reason: string | null;
  source: "mcp" | "http";
};

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_MAX_ROWS = 200;
const AUDIT_GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const DEFAULT_RETENTION_DAYS = 30;

let buffer: AuditRow[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let auditGcTimer: ReturnType<typeof setInterval> | null = null;
let thresholdFlushScheduled = false;

// A timer inherits the AsyncLocalStorage context of whoever scheduled it, and
// the threshold flush is scheduled from inside `can()` — which can run while
// the request already holds an open DbClient transaction. Inheriting that
// context would nest the flush into that transaction as a SAVEPOINT, so an
// unrelated rollback would erase the deny rows explaining it. This snapshot is
// taken at module load, where no transaction context exists.
const scheduleContextFree = AsyncLocalStorage.snapshot();

function isAuditDisabled(): boolean {
  return isEnvFlagEnabled("RBAC_AUDIT_DISABLED", false);
}

function principalIdOf(principal: RbacCheck["principal"]): string | null {
  switch (principal.kind) {
    case "agent":
      return principal.agentId;
    case "user":
      return principal.userId;
    case "operator":
      return null;
  }
}

function resourceIdOf(resource: RbacCheck["resource"]): string | null {
  if (!resource) return null;
  switch (resource.kind) {
    case "task":
      return resource.taskId;
    case "agent":
      return resource.agentId;
    case "kv-namespace":
      return resource.namespace;
    case "app":
      return resource.appId;
    case "owned":
      return resource.ownerAgentId ?? null;
    case "none":
      return null;
  }
}

function toRow(check: RbacCheck, decision: RbacDecision): AuditRow {
  return {
    principalType: check.principal.kind,
    principalId: principalIdOf(check.principal),
    // Reserved: slice-1 RbacCheck carries no originating-user field yet.
    originatorUserId: null,
    verb: check.verb,
    resourceType: check.resource?.kind ?? null,
    resourceId: resourceIdOf(check.resource),
    decision: decision.allow ? "allow" : "deny",
    reason: decision.allow ? null : decision.reason,
    source: check.source,
  };
}

function enqueueRow(row: AuditRow): void {
  buffer.push(row);
  // The threshold flush is deferred to a zero-delay timeout so the caller
  // that happens to be the 200th never pays for the SQLite transaction itself.
  if (buffer.length >= FLUSH_MAX_ROWS && !thresholdFlushScheduled) {
    thresholdFlushScheduled = true;
    const t = scheduleContextFree(() =>
      setTimeout(() => {
        thresholdFlushScheduled = false;
        void flushAuditBuffer();
      }, 0),
    );
    if (typeof t.unref === "function") t.unref();
  }
}

/**
 * The concrete AuditSink for `can()`. Never throws — `can()` already swallows
 * sink exceptions, but the audit path defends independently.
 */
export function enqueueAuditRow(check: RbacCheck, decision: RbacDecision): void {
  if (isAuditDisabled()) return;
  try {
    enqueueRow(toRow(check, decision));
  } catch (err) {
    console.warn("[rbac-audit] enqueue failed, dropping row:", (err as Error).message);
  }
}

type AdmissionAuditInput = {
  userId: string;
  decision: AdmissionDecision;
} & (
  | {
      source?: "http";
      method: string | undefined;
      route: string;
    }
  | {
      source: "mcp";
      toolName: string;
    }
);

export function enqueueAdmissionRow(input: AdmissionAuditInput): void {
  if (isAuditDisabled()) return;
  try {
    const isMcp = input.source === "mcp";
    const method = isMcp ? undefined : (input.method ?? "UNKNOWN").toUpperCase();
    enqueueRow({
      principalType: "user",
      principalId: input.userId,
      originatorUserId: null,
      verb: input.decision.verb ?? "(admission:no-verb)",
      resourceType: isMcp ? "mcp-tool" : "http-route",
      resourceId: isMcp ? input.toolName : `${method} ${input.route}`,
      decision: input.decision.allow ? "allow" : "deny",
      reason: input.decision.allow ? null : input.decision.reason,
      source: isMcp ? "mcp" : "http",
    });
  } catch (err) {
    console.warn("[rbac-audit] enqueue failed, dropping admission row:", (err as Error).message);
  }
}

/**
 * Drain the buffer into permission_audit in one transaction. Called by the
 * flush interval, the 200-row threshold, and shutdown. A failed flush logs a
 * warning and drops the batch — never throws.
 */
export async function flushAuditBuffer(): Promise<void> {
  if (buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  try {
    await getDbClient().transaction(async (tx) => {
      for (const r of rows) {
        await tx.run(
          `INSERT INTO permission_audit
             (principalType, principalId, originatorUserId, verb, resourceType, resourceId, decision, reason, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            r.principalType,
            r.principalId,
            r.originatorUserId,
            r.verb,
            r.resourceType,
            r.resourceId,
            r.decision,
            r.reason,
            r.source,
          ],
        );
      }
    });
  } catch (err) {
    console.warn(
      `[rbac-audit] flush failed, dropping ${rows.length} row(s):`,
      (err as Error).message,
    );
  }
}

/**
 * Test hook, not a production knob: rbac-lifecycle-e2e.test.ts sets a huge
 * interval so the SIGTERM-drain assertion can prove rows were persisted by
 * the shutdown drain rather than a racing timer tick.
 */
function flushIntervalMs(): number {
  const v = Number(process.env.RBAC_AUDIT_FLUSH_MS);
  return Number.isFinite(v) && v > 0 ? v : FLUSH_INTERVAL_MS;
}

/** Start the periodic flush (2s tick). Idempotent. */
export function startAuditWriter(intervalMs = flushIntervalMs()): void {
  if (flushTimer) return;
  // Context-free like the threshold flush above: today this only starts from
  // boot-path module scope, but a future caller inside a transaction must not
  // hand its context to a long-lived timer.
  flushTimer = scheduleContextFree(() =>
    setInterval(() => {
      void flushAuditBuffer();
    }, intervalMs),
  );
  if (typeof flushTimer?.unref === "function") flushTimer.unref();
}

/** Stop the periodic flush. Does NOT flush — shutdown calls flushAuditBuffer(). */
export function stopAuditWriter(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/** Delete audit rows older than the retention window. Returns rows deleted. */
export async function purgeExpiredAuditRows(): Promise<number> {
  try {
    const days = Number(process.env.RBAC_AUDIT_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS;
    // ts is CURRENT_TIMESTAMP format ("YYYY-MM-DD HH:MM:SS"); compute the
    // cutoff in SQLite so the string formats always match.
    const result = await getDbClient().run(
      "DELETE FROM permission_audit WHERE ts < datetime('now', ?)",
      [`-${days} days`],
    );
    return result.changes;
  } catch (err) {
    console.warn("[rbac-audit] retention purge failed:", (err as Error).message);
    return 0;
  }
}

async function runAuditGcTick(): Promise<void> {
  const n = await purgeExpiredAuditRows();
  if (n > 0) {
    console.log(`[rbac-audit] Retention purge removed ${n} audit row(s)`);
  }
}

/** Start the retention GC (daily tick, immediate first run). Idempotent. */
export async function startAuditGc(intervalMs = AUDIT_GC_INTERVAL_MS): Promise<void> {
  if (auditGcTimer) return;

  const purged = await purgeExpiredAuditRows();
  if (purged > 0) {
    console.log(`[rbac-audit] Initial retention purge removed ${purged} audit row(s)`);
  }

  // Context-free for the same reason as startAuditWriter.
  auditGcTimer = scheduleContextFree(() =>
    setInterval(() => {
      void runAuditGcTick();
    }, intervalMs),
  );
  if (typeof auditGcTimer?.unref === "function") auditGcTimer.unref();
}

export function stopAuditGc(): void {
  if (auditGcTimer) {
    clearInterval(auditGcTimer);
    auditGcTimer = null;
  }
}
