/**
 * Tests for harness-OTEL `TRACEPARENT` injection in the Codex adapter.
 *
 * The Codex SDK does NOT inherit `process.env` — `CodexAdapter.createSession`
 * builds a minimal explicit env and hands it to `new Codex({ env })`. This
 * suite verifies that, when the harness-OTEL gate is on and a sampled worker
 * span is active, that env carries a W3C `TRACEPARENT`.
 *
 * The SDK stores the constructor `env` on `codex.exec.envOverride`, so we
 * intercept `Codex.prototype.startThread` (same prototype-patch trick the
 * existing codex-adapter tests use) and read it off `this`. `trace.getActiveSpan`
 * is stubbed — no real OpenTelemetry SDK is started.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as codexSdk from "@openai/codex-sdk";
import { type Span, trace } from "@opentelemetry/api";
import { CodexAdapter } from "../providers/codex-adapter";
import type { ProviderSessionConfig } from "../providers/types";

const TRACE_ID = "af2c8371b1f4dcafc9ac8e2fae1ed712";
const SPAN_ID = "adff4f24ca4f3c26";

/** Minimal stub of an OTel `Span` — only `spanContext()` is read. */
function makeSpan(opts: { sampled?: boolean } = {}): Span {
  return {
    spanContext: () => ({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: opts.sampled === false ? 0 : 1,
    }),
  } as unknown as Span;
}

/** Fake `Thread` — `createSession` stores it; this suite never drives it. */
function makeFakeThread() {
  return {
    id: null as string | null,
    async runStreamed() {
      async function* generate() {}
      return { events: generate() };
    },
  };
}

function testConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "hello",
    systemPrompt: "",
    model: "gpt-5.4",
    role: "worker",
    agentId: "agent-test",
    taskId: "task-test",
    apiUrl: "http://localhost:0",
    apiKey: "test",
    cwd: "/tmp",
    logFile: `/tmp/codex-adapter-otel-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    ...overrides,
  };
}

type CodexProto = { startThread: (...args: unknown[]) => unknown };
type CodexInstance = { exec?: { envOverride?: Record<string, string> } };

describe("CodexAdapter spawn env — harness OTEL gate", () => {
  let capturedEnv: Record<string, string> | undefined;
  let originalStartThread: (...args: unknown[]) => unknown;
  let getActiveSpanSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    capturedEnv = undefined;
    const proto = codexSdk.Codex.prototype as unknown as CodexProto;
    originalStartThread = proto.startThread;
    proto.startThread = function startThread(this: CodexInstance): unknown {
      // The SDK keeps the constructor `env` on `this.exec.envOverride`.
      capturedEnv = this.exec?.envOverride;
      return makeFakeThread();
    };
    getActiveSpanSpy = spyOn(trace, "getActiveSpan").mockReturnValue(makeSpan());
  });

  afterEach(() => {
    (codexSdk.Codex.prototype as unknown as CodexProto).startThread = originalStartThread;
    getActiveSpanSpy.mockRestore();
  });

  test("gate on (SWARM_ENABLE_HARNESS_OTEL) → spawn env carries TRACEPARENT", async () => {
    const adapter = new CodexAdapter({ bypassSubprocess: true });
    await adapter.createSession(testConfig({ env: { SWARM_ENABLE_HARNESS_OTEL: "1" } }));

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  test("gate on via deprecated SWARM_ENABLE_CLAUDE_CODE_OTEL alias → TRACEPARENT injected", async () => {
    const adapter = new CodexAdapter({ bypassSubprocess: true });
    await adapter.createSession(testConfig({ env: { SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" } }));

    expect(capturedEnv?.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  test("gate off → no TRACEPARENT, existing env wiring intact", async () => {
    const adapter = new CodexAdapter({ bypassSubprocess: true });
    await adapter.createSession(testConfig({ env: {} }));

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.TRACEPARENT).toBeUndefined();
    // The minimal explicit env the adapter always builds is untouched.
    expect(capturedEnv?.PATH).toBeDefined();
    expect(capturedEnv?.HOME).toBeDefined();
  });

  test("gate on but unsampled active span → no TRACEPARENT", async () => {
    getActiveSpanSpy.mockReturnValue(makeSpan({ sampled: false }));
    const adapter = new CodexAdapter({ bypassSubprocess: true });
    await adapter.createSession(testConfig({ env: { SWARM_ENABLE_HARNESS_OTEL: "1" } }));

    expect(capturedEnv?.TRACEPARENT).toBeUndefined();
  });
});
