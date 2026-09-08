/**
 * Tests for harness-OTEL `TRACEPARENT` injection in the Codex adapter.
 *
 * The adapter supplies an explicit environment to the app-server.
 * The injected thread factory captures that environment without spawning Codex.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

/** Complete a session without a model request. */
function makeFakeThread() {
  return {
    id: null as string | null,
    async runStreamed() {
      async function* generate() {
        yield { type: "turn.completed" as const };
      }
      return { events: generate() };
    },
    async steer() {},
    async interrupt() {},
    async close() {},
  };
}

function testConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "hello",
    systemPrompt: "",
    model: "gpt-5.4",
    role: "worker",
    agentId: "11111111-1111-4111-8111-111111111111",
    apiUrl: "http://swarm.test",
    apiKey: "test",
    cwd: "/tmp",
    logFile: `/tmp/codex-adapter-otel-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    ...overrides,
  };
}

describe("CodexAdapter spawn env: harness OTEL gate", () => {
  let capturedEnv: Record<string, string> | undefined;
  let getActiveSpanSpy: ReturnType<typeof spyOn>;

  async function captureEnvironment(overrides: Partial<ProviderSessionConfig>) {
    const config = testConfig(overrides);
    const adapter = new CodexAdapter({
      bypassSubprocess: true,
      threadFactory: ({ env }) => {
        capturedEnv = env;
        return makeFakeThread();
      },
    });
    const session = await adapter.createSession(config);
    await session.waitForCompletion();
    await Bun.file(config.logFile).delete();
  }

  beforeEach(() => {
    capturedEnv = undefined;
    getActiveSpanSpy = spyOn(trace, "getActiveSpan").mockReturnValue(makeSpan());
  });

  afterEach(() => {
    getActiveSpanSpy.mockRestore();
  });

  test("gate on (SWARM_ENABLE_HARNESS_OTEL) → spawn env carries TRACEPARENT", async () => {
    await captureEnvironment({ env: { SWARM_ENABLE_HARNESS_OTEL: "1" } });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  test("gate on via deprecated SWARM_ENABLE_CLAUDE_CODE_OTEL alias → TRACEPARENT injected", async () => {
    await captureEnvironment({ env: { SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" } });

    expect(capturedEnv?.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
  });

  test("gate off → no TRACEPARENT, existing env wiring intact", async () => {
    await captureEnvironment({ env: {} });

    expect(capturedEnv).toBeDefined();
    expect(capturedEnv?.TRACEPARENT).toBeUndefined();
    // The minimal explicit env the adapter always builds is untouched.
    expect(capturedEnv?.PATH).toBeDefined();
    expect(capturedEnv?.HOME).toBeDefined();
    expect(capturedEnv?.SWARM_CODEX_APP_SERVER).toBe("1");
  });

  test("gate on but unsampled active span → no TRACEPARENT", async () => {
    getActiveSpanSpy.mockReturnValue(makeSpan({ sampled: false }));
    await captureEnvironment({ env: { SWARM_ENABLE_HARNESS_OTEL: "1" } });

    expect(capturedEnv?.TRACEPARENT).toBeUndefined();
  });
});
