/**
 * Tests for the `SWARM_ENABLE_CLAUDE_CODE_OTEL` gate in `claude-adapter.ts`.
 *
 * Behaviors under test:
 *   1. `buildClaudeCodeOtelEnv` — pure env-builder. Gate off → `{}`; gate on →
 *      privacy-safe defaults + a W3C `TRACEPARENT` (and `TRACESTATE`) derived
 *      from the active span when that span is sampled.
 *   2. Spawn integration — `ClaudeSession` (via `ClaudeAdapter.createSession`)
 *      injects the computed env into the spawned subprocess. Verified by
 *      stubbing `Bun.spawn` and reading the `env` option off the call args.
 *
 * No real OpenTelemetry SDK is started: the active span is a hand-built stub
 * and `trace.getActiveSpan` is spied where the spawn path reads it implicitly.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { type Span, trace } from "@opentelemetry/api";
import {
  buildClaudeCodeOtelEnv,
  buildClaudeCodeRuntimeEnv,
  ClaudeAdapter,
} from "../providers/claude-adapter";
import type { ProviderSessionConfig } from "../providers/types";

// Example IDs from the task — trace af2c8371…, span adff4f24… (the orphaned
// `claude_code.interaction` root this gate is meant to re-parent).
const TRACE_ID = "af2c8371b1f4dcafc9ac8e2fae1ed712";
const SPAN_ID = "adff4f24ca4f3c26";

/** Minimal stub of an OTel `Span` — `buildClaudeCodeOtelEnv` only reads `spanContext()`. */
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

describe("buildClaudeCodeOtelEnv — gate off", () => {
  test("returns {} when SWARM_ENABLE_CLAUDE_CODE_OTEL is unset", () => {
    expect(buildClaudeCodeOtelEnv({}, makeSpan())).toEqual({});
  });

  test("returns {} for falsy gate values", () => {
    for (const v of ["0", "false", "no", "off", ""]) {
      expect(buildClaudeCodeOtelEnv({ SWARM_ENABLE_CLAUDE_CODE_OTEL: v }, makeSpan())).toEqual({});
    }
  });

  test("no TRACEPARENT is produced even when an active span exists", () => {
    const env = buildClaudeCodeOtelEnv({}, makeSpan());
    expect(env.TRACEPARENT).toBeUndefined();
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
  });
});

describe("buildClaudeCodeOtelEnv — gate on", () => {
  test("accepts 1/true/yes/on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", "On"]) {
      const env = buildClaudeCodeOtelEnv({ SWARM_ENABLE_CLAUDE_CODE_OTEL: v }, makeSpan());
      expect(env.TRACEPARENT).toBeDefined();
    }
  });

  test("activates via the canonical SWARM_ENABLE_HARNESS_OTEL gate", () => {
    const env = buildClaudeCodeOtelEnv({ SWARM_ENABLE_HARNESS_OTEL: "1" }, makeSpan());
    expect(env.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(env.OTEL_LOG_USER_PROMPTS).toBe("0");
  });

  test("injects TRACEPARENT in W3C format from a sampled active span", () => {
    const env = buildClaudeCodeOtelEnv({ SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" }, makeSpan());
    expect(env.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    // version(2)-traceId(32)-spanId(16)-flags(2)
    expect(env.TRACEPARENT).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  test("pins privacy-safe defaults", () => {
    const env = buildClaudeCodeOtelEnv({ SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" }, makeSpan());
    expect(env.OTEL_LOG_USER_PROMPTS).toBe("0");
    expect(env.OTEL_LOG_TOOL_DETAILS).toBe("0");
    expect(env.OTEL_LOG_TOOL_CONTENT).toBe("0");
    expect(env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID).toBe("false");
  });

  test("privacy defaults are idempotent — operator overrides win", () => {
    const env = buildClaudeCodeOtelEnv(
      {
        SWARM_ENABLE_CLAUDE_CODE_OTEL: "1",
        OTEL_LOG_USER_PROMPTS: "1",
        OTEL_LOG_TOOL_DETAILS: "1",
      },
      makeSpan(),
    );
    // Already-set keys are left out of the additions so the operator value
    // (carried via `...sourceEnv`) is not clobbered.
    expect(env.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    expect(env.OTEL_LOG_TOOL_DETAILS).toBeUndefined();
    // Unset ones still get the safe default.
    expect(env.OTEL_LOG_TOOL_CONTENT).toBe("0");
    expect(env.OTEL_METRICS_INCLUDE_ACCOUNT_UUID).toBe("false");
  });

  test("propagates TRACESTATE when the span context carries one", () => {
    const env = buildClaudeCodeOtelEnv(
      { SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" },
      makeSpan({ traceState: "vendor=abc123" }),
    );
    expect(env.TRACESTATE).toBe("vendor=abc123");
  });

  test("omits TRACESTATE when the span context has none", () => {
    const env = buildClaudeCodeOtelEnv({ SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" }, makeSpan());
    expect(env.TRACESTATE).toBeUndefined();
  });

  test("no TRACEPARENT for an unsampled span, but privacy defaults still apply", () => {
    const env = buildClaudeCodeOtelEnv(
      { SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" },
      makeSpan({ sampled: false }),
    );
    expect(env.TRACEPARENT).toBeUndefined();
    expect(env.OTEL_LOG_USER_PROMPTS).toBe("0");
  });

  test("no TRACEPARENT when there is no active span, but privacy defaults still apply", () => {
    const env = buildClaudeCodeOtelEnv({ SWARM_ENABLE_CLAUDE_CODE_OTEL: "1" }, undefined);
    expect(env.TRACEPARENT).toBeUndefined();
    expect(env.OTEL_LOG_USER_PROMPTS).toBe("0");
  });
});

describe("buildClaudeCodeRuntimeEnv", () => {
  test("sets memory/privacy defaults for ephemeral Claude Code sessions", () => {
    const env = buildClaudeCodeRuntimeEnv({});

    expect(env.ENABLE_TOOL_SEARCH).toBe("true");
    expect(env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING).toBe("1");
    expect(env.CLAUDE_CODE_SKIP_PROMPT_HISTORY).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBe("1");
    expect(env.DISABLE_FEEDBACK_COMMAND).toBe("1");
    expect(env.DISABLE_BUG_COMMAND).toBe("1");
  });

  test("always disables Claude Code Statsig/DNT telemetry", () => {
    const env = buildClaudeCodeRuntimeEnv({});

    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.DO_NOT_TRACK).toBe("1");
  });

  test("keeps Claude Code Statsig/DNT opt-out separate from OTel config", () => {
    for (const sourceEnv of [
      { CLAUDE_CODE_ENABLE_TELEMETRY: "1" },
      { CLAUDE_CODE_ENABLE_TELEMETRY: "true" },
      { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test" },
      { OTEL_TRACES_EXPORTER: "otlp" },
      { OTEL_METRICS_EXPORTER: "otlp" },
      { OTEL_LOGS_EXPORTER: "otlp" },
    ]) {
      const env = buildClaudeCodeRuntimeEnv(sourceEnv);
      expect(env.DISABLE_TELEMETRY).toBe("1");
      expect(env.DO_NOT_TRACK).toBe("1");
    }
  });

  test("ignores empty OTel env values for runtime defaults", () => {
    const env = buildClaudeCodeRuntimeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      CLAUDE_CODE_ENABLE_TELEMETRY: "0",
    });

    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.DO_NOT_TRACK).toBe("1");
  });
});

// ─── Spawn integration through ClaudeAdapter.createSession ────────────────────

/** Fake Bun.Subprocess — exits cleanly with no output. */
function makeFakeProc(): ReturnType<typeof Bun.spawn> {
  return {
    stdout: null,
    stderr: null,
    stdin: null,
    exited: Promise.resolve(0),
    exitCode: 0,
    kill: () => {},
    pid: 0,
    killed: false,
    ref: () => {},
    unref: () => {},
  } as unknown as ReturnType<typeof Bun.spawn>;
}

/** Empty apiUrl/apiKey/agentId skips the MCP-server fetch. */
function makeConfig(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "Say hello",
    systemPrompt: "",
    model: "sonnet",
    role: "worker",
    agentId: "",
    taskId: "test-task-otel",
    apiUrl: "",
    apiKey: "",
    cwd: "/tmp",
    logFile: "/tmp/test-claude-adapter-otel.jsonl",
    ...overrides,
  };
}

describe("ClaudeSession spawn env — SWARM_ENABLE_CLAUDE_CODE_OTEL", () => {
  let spawnSpy: ReturnType<typeof spyOn>;
  let getActiveSpanSpy: ReturnType<typeof spyOn>;
  let spawnedEnvs: Array<Record<string, string> | undefined>;

  beforeEach(() => {
    spawnedEnvs = [];
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
      _cmd: readonly string[],
      opts?: { env?: Record<string, string> },
    ) => {
      spawnedEnvs.push(opts?.env);
      return makeFakeProc();
    }) as typeof Bun.spawn);
    getActiveSpanSpy = spyOn(trace, "getActiveSpan").mockReturnValue(makeSpan());
  });

  afterEach(() => {
    spawnSpy.mockRestore();
    getActiveSpanSpy.mockRestore();
  });

  test("gate on → spawn env carries TRACEPARENT and privacy defaults", async () => {
    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: { SWARM_ENABLE_CLAUDE_CODE_OTEL: "1", CLAUDE_CODE_OAUTH_TOKEN: "test-token" },
      }),
    );

    expect(spawnedEnvs).toHaveLength(1);
    const env = spawnedEnvs[0];
    expect(env?.TRACEPARENT).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
    expect(env?.OTEL_LOG_USER_PROMPTS).toBe("0");
    expect(env?.OTEL_LOG_TOOL_DETAILS).toBe("0");
    expect(env?.OTEL_LOG_TOOL_CONTENT).toBe("0");
    expect(env?.OTEL_METRICS_INCLUDE_ACCOUNT_UUID).toBe("false");
  });

  test("gate unset → spawn env carries NO TRACEPARENT (behavior unchanged)", async () => {
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }));

    expect(spawnedEnvs).toHaveLength(1);
    const env = spawnedEnvs[0];
    expect(env?.TRACEPARENT).toBeUndefined();
    expect(env?.OTEL_LOG_USER_PROMPTS).toBeUndefined();
    // Existing env wiring is untouched.
    expect(env?.ENABLE_PROMPT_CACHING_1H).toBe("1");
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("test-token");
  });

  test("spawn env carries Claude Code runtime guardrails", async () => {
    const adapter = new ClaudeAdapter();
    await adapter.createSession(makeConfig({ env: { CLAUDE_CODE_OAUTH_TOKEN: "test-token" } }));

    expect(spawnedEnvs).toHaveLength(1);
    const env = spawnedEnvs[0];
    expect(env?.ENABLE_TOOL_SEARCH).toBe("true");
    expect(env?.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING).toBe("1");
    expect(env?.CLAUDE_CODE_SKIP_PROMPT_HISTORY).toBe("1");
    expect(env?.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBe("1");
    expect(env?.DISABLE_FEEDBACK_COMMAND).toBe("1");
    expect(env?.DISABLE_BUG_COMMAND).toBe("1");
    expect(env?.DISABLE_TELEMETRY).toBe("1");
    expect(env?.DO_NOT_TRACK).toBe("1");
    expect(env?.CLAUDE_CODE_DISABLE_THINKING).toBeUndefined();
  });

  test("spawn env keeps Statsig/DNT opt-out even when OTel is configured", async () => {
    const adapter = new ClaudeAdapter();
    await adapter.createSession(
      makeConfig({
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: "test-token",
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test",
        },
      }),
    );

    expect(spawnedEnvs).toHaveLength(1);
    const env = spawnedEnvs[0];
    expect(env?.DISABLE_TELEMETRY).toBe("1");
    expect(env?.DO_NOT_TRACK).toBe("1");
  });
});
