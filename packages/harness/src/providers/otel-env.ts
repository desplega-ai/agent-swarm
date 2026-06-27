import { type Span, TraceFlags, trace } from "@opentelemetry/api";

/**
 * Shared OpenTelemetry env wiring for harness subprocesses (claude, codex, ...).
 *
 * Harnesses that emit their own OTEL spans (Claude Code, Codex) start a fresh
 * root span unless they are handed a W3C trace context at spawn. Injecting
 * `TRACEPARENT` / `TRACESTATE` env vars makes the harness parent its spans to
 * the worker's `worker.session` trace — one end-to-end trace in the backend.
 */

/** Truthy-string check. Mirrors `isPollTracingEnabled` in src/otel.ts. */
function isTruthy(value: string | undefined): boolean {
  const v = (value ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Whether harness-subprocess OTEL trace-context injection is enabled.
 *
 * Canonical gate: `SWARM_ENABLE_HARNESS_OTEL`. `SWARM_ENABLE_CLAUDE_CODE_OTEL`
 * is kept as a deprecated alias — a truthy value of *either* turns injection
 * on for every harness. Read per-spawn from the resolved swarm-config env so a
 * config flip takes effect on the next session without a container restart.
 */
export function isHarnessOtelEnabled(sourceEnv: Record<string, string | undefined>): boolean {
  return (
    isTruthy(sourceEnv.SWARM_ENABLE_HARNESS_OTEL) ||
    isTruthy(sourceEnv.SWARM_ENABLE_CLAUDE_CODE_OTEL)
  );
}

/**
 * Build W3C trace-context env additions (`TRACEPARENT`, optional `TRACESTATE`)
 * for a spawned harness subprocess, derived from the active worker span.
 *
 * Returns `{}` when the gate is off, there is no active span, or the active
 * span is not sampled (nothing meaningful to propagate). Spread the result
 * into the spawn env *after* the inherited env so the freshly-computed
 * `TRACEPARENT` wins over any stale value the container env might carry.
 */
export function buildOtelTraceparentEnv(
  sourceEnv: Record<string, string | undefined>,
  activeSpan: Span | undefined = trace.getActiveSpan(),
): Record<string, string> {
  if (!isHarnessOtelEnabled(sourceEnv)) {
    return {};
  }

  const spanContext = activeSpan?.spanContext();
  if (!spanContext || (spanContext.traceFlags & TraceFlags.SAMPLED) === 0) {
    return {};
  }

  const env: Record<string, string> = {
    TRACEPARENT: `00-${spanContext.traceId}-${spanContext.spanId}-01`,
  };
  const tracestate = spanContext.traceState?.serialize();
  if (tracestate) {
    env.TRACESTATE = tracestate;
  }
  return env;
}
