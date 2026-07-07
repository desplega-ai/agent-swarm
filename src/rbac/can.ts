/**
 * Central authorization engine (DES-445, slice 1).
 *
 * `can()` is pure and synchronous: no DB imports, no caching (correctness >
 * performance — every call evaluates directly). It centralizes the DECISION;
 * call sites keep their existing denial presentation (MCP soft failures,
 * HTTP 403 bodies).
 *
 * Audit seam: `setAuditSink()` installs a fire-and-forget observer invoked
 * (sync, exceptions swallowed) on every `can()` call — allow AND deny. The
 * real batched writer is wired at server boot in increment 2 (Phase 6);
 * until then the sink stays unset and `can()` still decides correctly.
 */
import { LEGACY_POLICY } from "./legacy-policy";
import type { RbacCheck, RbacDecision } from "./types";

export type AuditSink = (check: RbacCheck, decision: RbacDecision) => void;

let auditSink: AuditSink | null = null;

export function setAuditSink(fn: AuditSink): void {
  auditSink = fn;
}

export function clearAuditSink(): void {
  auditSink = null;
}

export function can(check: RbacCheck): RbacDecision {
  const rule = LEGACY_POLICY[check.verb];
  const decision: RbacDecision = rule.evaluate(check.principal, check.resource)
    ? { allow: true }
    : { allow: false, reason: rule.denyReason, missing: check.verb };

  if (auditSink) {
    try {
      auditSink(check, decision);
    } catch {
      // The audit sink must never break or slow the request path.
    }
  }

  return decision;
}
