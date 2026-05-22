/**
 * Tests for the shared harness-OTEL env helper (`src/providers/otel-env.ts`).
 *
 * `buildOtelTraceparentEnv` is the W3C trace-context builder that both the
 * claude and codex adapters call to nest a harness subprocess's spans inside
 * the worker's `worker.session` trace. `isHarnessOtelEnabled` is the gate:
 * canonical `SWARM_ENABLE_HARNESS_OTEL` + deprecated `SWARM_ENABLE_CLAUDE_CODE_OTEL`.
 *
 * No real OpenTelemetry SDK is started — the active span is a hand-built stub.
 */

import { describe, expect, test } from "bun:test";
import type { Span } from "@opentelemetry/api";
import { buildOtelTraceparentEnv, isHarnessOtelEnabled } from "../providers/otel-env";

const TRACE_ID = "af2c8371b1f4dcafc9ac8e2fae1ed712";
const SPAN_ID = "adff4f24ca4f3c26";

/** Minimal stub of an OTel `Span` — only `spanContext()` is read. */
function makeSpan(opts: { sampled?: boolean; traceState?: string } = {}): Span {
  const traceState =
    opts.traceState !== undefined
      ? ({ serialize: () => opts.traceState } as unknown as ReturnType<
          Span["spanContext"]
        >["traceState"])
      : undefined;
  return {
    spanContext: () => ({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      // TraceFlags.SAMPLED === 0x1; 0x0 is unsampled.
      traceFlags: opts.sampled === false ? 0 : 1,
      traceState,
    }),
  } as unknown as Span;
}

describe("isHarnessOtelEnabled", () => {
  test("false when neither gate is set", () => {
    expect(isHarnessOtelEnabled({})).toBe(false);
  });

  test("true for SWARM_ENABLE_HARNESS_OTEL truthy values (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", "On"]) {
      expect(isHarnessOtelEnabled({ SWARM_ENABLE_HARNESS_OTEL: v })).toBe(true);
    }
  });

  test("true for the deprecated SWARM_ENABLE_CLAUDE_CODE_OTEL alias", () => {
    expect(isHarnessOtelEnabled({ SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" })).toBe(true);
    expect(isHarnessOtelEnabled({ SWARM_ENABLE_CLAUDE_CODE_OTEL: "true" })).toBe(true);
  });

  test("false for falsy values on either gate", () => {
    for (const v of ["0", "false", "no", "off", ""]) {
      expect(isHarnessOtelEnabled({ SWARM_ENABLE_HARNESS_OTEL: v })).toBe(false);
      expect(isHarnessOtelEnabled({ SWARM_ENABLE_CLAUDE_CODE_OTEL: v })).toBe(false);
    }
  });
});

describe("buildOtelTraceparentEnv — gate off", () => {
  test("returns {} when no gate is set, even with an active sampled span", () => {
    expect(buildOtelTraceparentEnv({}, makeSpan())).toEqual({});
  });
});

describe("buildOtelTraceparentEnv — gate on", () => {
  test("injects W3C TRACEPARENT from a sampled span (canonical gate)", () => {
    const env = buildOtelTraceparentEnv({ SWARM_ENABLE_HARNESS_OTEL: "1" }, makeSpan());
    expect(env.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    // version(2)-traceId(32)-spanId(16)-flags(2)
    expect(env.TRACEPARENT).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  test("works via the deprecated SWARM_ENABLE_CLAUDE_CODE_OTEL alias", () => {
    const env = buildOtelTraceparentEnv({ SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" }, makeSpan());
    expect(env.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  test("propagates TRACESTATE when the span context carries one", () => {
    const env = buildOtelTraceparentEnv(
      { SWARM_ENABLE_HARNESS_OTEL: "1" },
      makeSpan({ traceState: "vendor=abc123" }),
    );
    expect(env.TRACESTATE).toBe("vendor=abc123");
  });

  test("omits TRACESTATE when the span context has none", () => {
    const env = buildOtelTraceparentEnv({ SWARM_ENABLE_HARNESS_OTEL: "1" }, makeSpan());
    expect(env.TRACESTATE).toBeUndefined();
  });

  test("returns {} for an unsampled span", () => {
    expect(
      buildOtelTraceparentEnv({ SWARM_ENABLE_HARNESS_OTEL: "1" }, makeSpan({ sampled: false })),
    ).toEqual({});
  });

  test("returns {} when there is no active span", () => {
    expect(buildOtelTraceparentEnv({ SWARM_ENABLE_HARNESS_OTEL: "1" }, undefined)).toEqual({});
  });
});
