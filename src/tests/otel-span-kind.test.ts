/**
 * Tests that `startSpan` maps the backend-agnostic `SwarmSpanKind` onto the
 * real OTel `SpanKind` before handing it to the tracer. Datadog's APM
 * resource-name derivation only appends `http.route` for `SpanKindServer`
 * spans — an inbound HTTP span created without an explicit kind defaults to
 * `INTERNAL` and collapses every endpoint into one resource per method.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { SpanKind, type Tracer } from "@opentelemetry/api";
import { _injectTracerForTests, startSpan } from "../otel-impl";

function fakeTracer() {
  const calls: { name: string; kind: SpanKind | undefined }[] = [];
  const tracer = {
    startSpan(name: string, options?: { kind?: SpanKind }) {
      calls.push({ name, kind: options?.kind });
      return {
        setAttribute: () => {},
        setAttributes: () => {},
        addEvent: () => {},
        recordException: () => {},
        setStatus: () => {},
        end: () => {},
      };
    },
  };
  return { calls, tracer: tracer as unknown as Tracer };
}

describe("startSpan span-kind mapping", () => {
  afterEach(() => {
    _injectTracerForTests(undefined);
  });

  test("forwards SpanKind.SERVER when kind: 'server' is requested", () => {
    const { calls, tracer } = fakeTracer();
    _injectTracerForTests(tracer);

    startSpan(
      "GET /api/attribution/by-person",
      { "http.request.method": "GET" },
      { kind: "server" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe(SpanKind.SERVER);
  });

  test("leaves kind undefined when no options are passed", () => {
    const { calls, tracer } = fakeTracer();
    _injectTracerForTests(tracer);

    startSpan("mcp.tool kv-get", { "mcp.tool.name": "kv-get" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBeUndefined();
  });
});
