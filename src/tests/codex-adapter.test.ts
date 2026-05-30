/**
 * Phase 2 unit tests for CodexAdapter / CodexSession.
 *
 * We stub the Codex SDK via a tiny fake `Thread` object whose `runStreamed`
 * returns a pre-built async iterable of `ThreadEvent`s. This exercises the
 * adapter's event normalization loop without pulling in the real SDK.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentMessageItem,
  CommandExecutionItem,
  ThreadEvent,
  ThreadItem,
} from "@openai/codex-sdk";
import type { SummarizeSessionForCodexDeps } from "../providers/codex-adapter";
import { buildCodexConfig, CodexAdapter } from "../providers/codex-adapter";
import { writeCodexAgentsMd } from "../providers/codex-agents-md";
import {
  CODEX_DEFAULT_MODEL,
  computeCodexCostUsd,
  getCodexContextWindow,
  resolveCodexModel,
} from "../providers/codex-models";
import type { ProviderEvent, ProviderResult, ProviderSessionConfig } from "../providers/types";

/**
 * Build a tiny fake `Thread` whose `runStreamed` returns a fixed sequence of
 * `ThreadEvent`s. The SDK's `StreamedTurn.events` is typed as an
 * `AsyncGenerator`, so we return an async generator that yields each event
 * and then completes.
 */
function makeFakeThread(events: ThreadEvent[]): {
  id: string | null;
  runStreamed: (
    _input: string,
    _opts?: { signal?: AbortSignal },
  ) => Promise<{ events: AsyncGenerator<ThreadEvent> }>;
} {
  return {
    id: null,
    async runStreamed(_input, _opts) {
      async function* generate(): AsyncGenerator<ThreadEvent> {
        for (const event of events) {
          yield event;
        }
      }
      return { events: generate() };
    },
  };
}

/**
 * Like `makeFakeThread` but throws the given error after all events have been
 * yielded. Simulates the SDK's "Codex Exec exited with code 1: Reading prompt
 * from stdin" throw that fires after the event stream closes.
 */
function makeFakeThreadWithThrow(
  events: ThreadEvent[],
  throwAfterStream: Error,
): ReturnType<typeof makeFakeThread> {
  return {
    id: null,
    async runStreamed(_input, _opts) {
      async function* generate(): AsyncGenerator<ThreadEvent> {
        for (const event of events) {
          yield event;
        }
        throw throwAfterStream;
      }
      return { events: generate() };
    },
  };
}

/**
 * Like `runSessionWithFakeThread` but injects a thread that throws after its
 * event stream ends (simulating the SDK exit-code throw).
 */
async function runSessionWithThrowingThread(
  events: ThreadEvent[],
  throwAfterStream: Error,
  config: ProviderSessionConfig,
): Promise<{ emitted: ProviderEvent[]; result: ProviderResult }> {
  const sdk = await import("@openai/codex-sdk");
  const originalStartThread = (
    sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
  ).startThread;

  const fakeThread = makeFakeThreadWithThrow(events, throwAfterStream);
  (sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }).startThread =
    function startThread(): unknown {
      return fakeThread as unknown;
    };

  try {
    const adapter = new CodexAdapter({ bypassSubprocess: true });
    const session = await adapter.createSession(config);
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    const result = await session.waitForCompletion();
    return { emitted, result };
  } finally {
    (
      sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
    ).startThread = originalStartThread;
  }
}

/**
 * Drive a CodexSession manually by constructing the private class via the
 * adapter's own factory path. We can't import the class directly because it
 * is not exported, so we use a runtime trick: import the module object and
 * look up the constructor via its prototype chain.
 *
 * Simpler: reimplement the tiny bit of the adapter that calls the session
 * constructor, but the session class is module-private. The cleanest path is
 * to require the compiled source and pluck the class off the module exports.
 *
 * Since CodexSession is not exported, we take the pragmatic route: instead
 * of testing the internal class directly, we test its behavior end-to-end by
 * driving a minimal subclass of `CodexAdapter` that overrides `createSession`
 * to inject a fake Thread. This keeps all reflection in one place.
 */

// Build a ProviderSessionConfig for tests.
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
    logFile: `/tmp/codex-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    ...overrides,
  };
}

/**
 * Because `CodexSession` is not exported, we load the module source and
 * instantiate it via `eval` of a small helper module. This is brittle but
 * keeps the test focused on behavior, not structure.
 *
 * NOTE: If/when CodexSession gains an exported test helper, replace this with
 * a direct import.
 */
async function runSessionWithFakeThread(
  events: ThreadEvent[],
  config: ProviderSessionConfig,
): Promise<{ emitted: ProviderEvent[]; result: ProviderResult }> {
  // Patch `Codex.prototype.startThread` on the fly so `createSession` receives
  // our fake thread. The adapter calls `new Codex({ env })` and then
  // `codex.startThread(...)` — we intercept the latter.
  const sdk = await import("@openai/codex-sdk");

  const originalStartThread = (
    sdk.Codex.prototype as unknown as {
      startThread: (...args: unknown[]) => unknown;
    }
  ).startThread;

  const fakeThread = makeFakeThread(events);
  (
    sdk.Codex.prototype as unknown as {
      startThread: (...args: unknown[]) => unknown;
    }
  ).startThread = function startThread(): unknown {
    return fakeThread as unknown;
  };

  try {
    const adapter = new CodexAdapter({ bypassSubprocess: true });
    const session = await adapter.createSession(config);

    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    const result = await session.waitForCompletion();
    return { emitted, result };
  } finally {
    (
      sdk.Codex.prototype as unknown as {
        startThread: (...args: unknown[]) => unknown;
      }
    ).startThread = originalStartThread;
  }
}

describe("CodexSession event mapping", () => {
  const tmpLogDir = `/tmp/codex-adapter-test-${Date.now()}`;
  let prevSkipEnv: string | undefined;

  beforeAll(() => {
    mkdirSync(tmpLogDir, { recursive: true });
    // Prevent the new Phase 3 session-end summarization path from firing real
    // LLM/HTTP calls during the legacy event-mapping tests. The summarization
    // tests below explicitly unset this within their own scope.
    prevSkipEnv = process.env.SKIP_SESSION_SUMMARY;
    process.env.SKIP_SESSION_SUMMARY = "1";
  });

  afterAll(() => {
    rmSync(tmpLogDir, { recursive: true, force: true });
    if (prevSkipEnv === undefined) delete process.env.SKIP_SESSION_SUMMARY;
    else process.env.SKIP_SESSION_SUMMARY = prevSkipEnv;
  });

  test("happy path: session_init → message → result", async () => {
    const agentMsg: AgentMessageItem = {
      id: "msg-1",
      type: "agent_message",
      text: "Hello from codex",
    };
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-abc" },
      { type: "turn.started" },
      { type: "item.completed", item: agentMsg as ThreadItem },
      {
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 50 },
      },
    ];

    const config = testConfig({
      logFile: join(tmpLogDir, "happy.log"),
      cwd: "", // disable AGENTS.md writing
    });

    const { emitted, result } = await runSessionWithFakeThread(events, config);

    // session_init MUST be present
    const sessionInit = emitted.find((e) => e.type === "session_init");
    expect(sessionInit).toBeDefined();
    if (sessionInit && sessionInit.type === "session_init") {
      expect(sessionInit.sessionId).toBe("thread-abc");
    }

    // at least one message
    const messages = emitted.filter((e) => e.type === "message");
    expect(messages.length).toBeGreaterThanOrEqual(1);
    if (messages[0] && messages[0].type === "message") {
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].content).toBe("Hello from codex");
    }

    // Phase 9: unified `input + output` formula (Codex `input_tokens` already
    // includes cached input, so we don't add cache_read separately).
    // input=100 + output=50 → contextUsed=150.
    const contextUsage = emitted.find((e) => e.type === "context_usage");
    expect(contextUsage).toBeDefined();
    if (contextUsage && contextUsage.type === "context_usage") {
      expect(contextUsage.contextUsedTokens).toBe(150);
      expect(contextUsage.contextTotalTokens).toBe(200_000);
      expect(contextUsage.contextPercent).toBeCloseTo((150 / 200_000) * 100, 6);
      expect(contextUsage.contextFormula).toBe("input-cache-output");
    }

    // result event is final and non-error, with cost computed from token counts
    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === "result") {
      expect(resultEvent.isError).toBe(false);
      expect(resultEvent.cost.inputTokens).toBe(100);
      expect(resultEvent.cost.outputTokens).toBe(50);
      expect(resultEvent.cost.cacheReadTokens).toBe(25);
      expect(resultEvent.cost.numTurns).toBe(1);
      expect(resultEvent.cost.model).toBe("gpt-5.4");
      // gpt-5.4 priced at $2.50 / $0.25 / $15.00 per million.
      // (75 uncached × $2.50 + 25 cached × $0.25 + 50 output × $15) / 1M
      // = (187.5 + 6.25 + 750) / 1e6 = 943.75e-6 ≈ $0.0009438
      expect(resultEvent.cost.totalCostUsd).toBeCloseTo(0.00094375, 8);
    }

    // ProviderResult
    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("thread-abc");
  });

  test("Phase 9: chatty turn clamps contextPercent to 100% under the unified formula", async () => {
    // Phase 9 deliberately swapped Codex's per-adapter peak-proxy formula
    // (`(input - cached) + output`) for the unified `input + output` formula
    // shared with every other provider. The trade-off: a chatty Codex turn
    // — where `input_tokens` is the SUM across every model call in the turn
    // — over-reports compared to the peak-proxy variant. The clamp at 100%
    // keeps the gauge sensible; downstream consumers reading the new
    // `contextFormula='input-cache-output'` tag know it's apples-to-apples
    // across providers. Numbers below are from the verify-plan transcript.
    const agentMsg: AgentMessageItem = {
      id: "msg-1",
      type: "agent_message",
      text: "DONE",
    };
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-chatty" },
      { type: "turn.started" },
      { type: "item.completed", item: agentMsg as ThreadItem },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 357142, // total > 200k window — would clamp pre-fix
          cached_input_tokens: 278912, // most of input is cache reuse
          output_tokens: 2156,
        },
      },
    ];

    const config = testConfig({
      logFile: join(tmpLogDir, "chatty.log"),
      cwd: "",
    });

    const { emitted } = await runSessionWithFakeThread(events, config);

    const contextUsage = emitted.find((e) => e.type === "context_usage");
    expect(contextUsage).toBeDefined();
    if (contextUsage && contextUsage.type === "context_usage") {
      // Phase 9 unified: input + output = 357142 + 2156 = 359298 (above 200k).
      expect(contextUsage.contextUsedTokens).toBe(359298);
      expect(contextUsage.contextTotalTokens).toBe(200_000);
      // Above 100% raw → clamped to exactly 100.
      expect(contextUsage.contextPercent).toBe(100);
      expect(contextUsage.contextFormula).toBe("input-cache-output");
    }

    // Cost still uses the full input_tokens — billing semantics are
    // preserved (cached portion gets the cached rate, uncached gets full).
    const resultEvent = emitted.findLast((e) => e.type === "result");
    if (resultEvent && resultEvent.type === "result") {
      expect(resultEvent.cost.inputTokens).toBe(357142);
      expect(resultEvent.cost.cacheReadTokens).toBe(278912);
      expect(resultEvent.cost.totalCostUsd).toBeGreaterThan(0);
    }
  });

  test("tool_start/tool_end pair for command execution", async () => {
    const cmdItem: CommandExecutionItem = {
      id: "cmd-1",
      type: "command_execution",
      command: "ls -la",
      aggregated_output: "total 0",
      exit_code: 0,
      status: "completed",
    };
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-tool" },
      { type: "turn.started" },
      { type: "item.started", item: cmdItem as ThreadItem },
      { type: "item.completed", item: cmdItem as ThreadItem },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];

    const config = testConfig({
      logFile: join(tmpLogDir, "tool.log"),
      cwd: "",
    });

    const { emitted } = await runSessionWithFakeThread(events, config);

    const toolStart = emitted.find((e) => e.type === "tool_start");
    expect(toolStart).toBeDefined();
    if (toolStart && toolStart.type === "tool_start") {
      expect(toolStart.toolName).toBe("bash");
      expect(toolStart.toolCallId).toBe("cmd-1");
      expect((toolStart.args as { command: string }).command).toBe("ls -la");
    }

    const toolEnd = emitted.find((e) => e.type === "tool_end");
    expect(toolEnd).toBeDefined();
    if (toolEnd && toolEnd.type === "tool_end") {
      expect(toolEnd.toolCallId).toBe("cmd-1");
      expect(toolEnd.toolName).toBe("bash");
    }
  });

  test("turn.failed produces error + result(isError: true)", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-fail" },
      { type: "turn.started" },
      { type: "turn.failed", error: { message: "model unavailable" } },
    ];

    const config = testConfig({
      logFile: join(tmpLogDir, "fail.log"),
      cwd: "",
    });

    const { emitted, result } = await runSessionWithFakeThread(events, config);

    const errorEvent = emitted.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.message).toBe("model unavailable");
    }

    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === "result") {
      expect(resultEvent.isError).toBe(true);
    }

    expect(result.isError).toBe(true);
    expect(result.failureReason).toBe("model unavailable");
  });

  test("turn.failed with context-overflow message rewrites to [context-overflow]", async () => {
    // The Codex CLI surfaces context-window-exceeded errors with patterns
    // like "context length exceeded" or "maximum context length". The
    // adapter detects them and rewrites with a clearer prefix that the
    // dashboard can flag and that points users at Linear DES-143 for the
    // long-term auto-compaction follow-up.
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-overflow" },
      { type: "turn.started" },
      {
        type: "turn.failed",
        error: { message: "Request failed: context length exceeded for gpt-5.4" },
      },
    ];

    const config = testConfig({
      logFile: join(tmpLogDir, "overflow.log"),
      cwd: "",
    });

    const { emitted, result } = await runSessionWithFakeThread(events, config);

    const errorEvent = emitted.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent && errorEvent.type === "error") {
      expect(errorEvent.message).toContain("[context-overflow]");
      expect(errorEvent.message).toContain("gpt-5.4");
      expect(errorEvent.message).toContain("200,000 tokens");
      // original error preserved at the end
      expect(errorEvent.message).toContain("context length exceeded");
    }

    expect(result.isError).toBe(true);
    expect(result.failureReason).toContain("[context-overflow]");
  });

  test("turn.failed with usage-limit message rewrites + sets errorCategory=usage_limit", async () => {
    // Codex Pro-quota exhausted: codexErrorInfo: "UsageLimitExceeded".
    // Adapter must prefix `[usage-limit]` so runner.ts marks the credential
    // as rate-limited in the rotation pool.
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-usage" },
      { type: "turn.started" },
      {
        type: "turn.failed",
        error: {
          message: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/pricing).",
        },
      },
    ];

    const { emitted, result } = await runSessionWithFakeThread(
      events,
      testConfig({ logFile: join(tmpLogDir, "usage.log"), cwd: "" }),
    );

    const errorEvent = emitted.find((e) => e.type === "error");
    expect(errorEvent?.type === "error" && errorEvent.message).toContain("[usage-limit]");

    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent?.type === "result" && resultEvent.errorCategory).toBe("usage_limit");

    expect(result.isError).toBe(true);
    expect(result.failureReason).toContain("[usage-limit]");
  });

  test("turn.failed with rate-limit message rewrites + sets errorCategory=rate_limit", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-rate" },
      { type: "turn.started" },
      {
        type: "turn.failed",
        error: { message: "Request failed: 429 Too Many Requests — rate_limit_exceeded." },
      },
    ];

    const { emitted, result } = await runSessionWithFakeThread(
      events,
      testConfig({ logFile: join(tmpLogDir, "rate.log"), cwd: "" }),
    );

    const errorEvent = emitted.find((e) => e.type === "error");
    expect(errorEvent?.type === "error" && errorEvent.message).toContain("[rate-limit]");

    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent?.type === "result" && resultEvent.errorCategory).toBe("rate_limit");

    expect(result.isError).toBe(true);
    expect(result.failureReason).toContain("[rate-limit]");
  });

  test("turn.failed with auth error rewrites + sets errorCategory=authentication_failed", async () => {
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-auth" },
      { type: "turn.started" },
      {
        type: "turn.failed",
        error: { message: "Request failed: HTTP 401 Unauthorized — Invalid API key provided." },
      },
    ];

    const { emitted, result } = await runSessionWithFakeThread(
      events,
      testConfig({ logFile: join(tmpLogDir, "auth.log"), cwd: "" }),
    );

    const errorEvent = emitted.find((e) => e.type === "error");
    expect(errorEvent?.type === "error" && errorEvent.message).toContain("[auth-error]");

    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent?.type === "result" && resultEvent.errorCategory).toBe(
      "authentication_failed",
    );

    expect(result.isError).toBe(true);
    expect(result.failureReason).toContain("[auth-error]");
  });

  test("abort() resolves the session with cancelled result", async () => {
    // Patch startThread with a fake whose runStreamed yields a long stream
    // that respects the AbortSignal — yields one event, awaits, and only
    // continues if the signal isn't aborted.
    const sdk = await import("@openai/codex-sdk");
    const originalStartThread = (
      sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
    ).startThread;

    const fakeThread = {
      id: null,
      runStreamed: async (_input: string, opts?: { signal?: AbortSignal }) => {
        async function* generate(): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: "thread-abort" };
          yield { type: "turn.started" };
          // Wait until the signal aborts or 5s elapses (test safety net).
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              opts?.signal?.removeEventListener("abort", onAbort);
              resolve();
            };
            if (opts?.signal?.aborted) {
              resolve();
              return;
            }
            opts?.signal?.addEventListener("abort", onAbort);
            setTimeout(resolve, 5000);
          });
          // Simulate the SDK throwing AbortError when the signal fires.
          if (opts?.signal?.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
        }
        return { events: generate() };
      },
    };

    (
      sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
    ).startThread = function startThread(): unknown {
      return fakeThread as unknown;
    };

    try {
      const adapter = new CodexAdapter({ bypassSubprocess: true });
      const config = testConfig({
        logFile: join(tmpLogDir, "abort.log"),
        cwd: "",
        taskId: "", // skip swarm event handler so we don't fire fetches
        apiUrl: "",
        apiKey: "",
      });
      const session = await adapter.createSession(config);
      const emitted: ProviderEvent[] = [];
      session.onEvent((e) => emitted.push(e));

      // Give the session a tick to start streaming, then abort.
      await new Promise((resolve) => setTimeout(resolve, 30));
      await session.abort();
      const result = await session.waitForCompletion();

      expect(result.isError).toBe(true);
      expect(result.failureReason).toBe("cancelled");
      expect(result.exitCode).toBe(130);

      const cancelledResult = emitted.findLast((e) => e.type === "result");
      expect(cancelledResult).toBeDefined();
      if (cancelledResult && cancelledResult.type === "result") {
        expect(cancelledResult.isError).toBe(true);
        expect(cancelledResult.errorCategory).toBe("cancelled");
      }
    } finally {
      (
        sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
      ).startThread = originalStartThread;
    }
  });
});

describe("CodexAdapter.canResume", () => {
  // Native resume is deprecated. The runner no longer threads resumeSessionId
  // to adapters; canResume returns false unconditionally so any stray caller
  // gets a fresh-session start. Follow-up continuity flows via the context
  // preamble (see src/commands/context-preamble.ts).
  test("always returns false now that native resume is deprecated", async () => {
    const adapter = new CodexAdapter({ bypassSubprocess: true });
    expect(await adapter.canResume("")).toBe(false);
    expect(await adapter.canResume("thread-anything")).toBe(false);
    // @ts-expect-error: deliberate runtime check for non-string input
    expect(await adapter.canResume(undefined)).toBe(false);
  });
});

describe("writeCodexAgentsMd round-trip", () => {
  const tmpDir = `/tmp/codex-agents-md-test-${Date.now()}`;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    // Clean any stray files between tests.
    await Bun.$`rm -f ${tmpDir}/*`.quiet().nothrow();
  });

  test("no-op when systemPrompt is empty", async () => {
    const handle = await writeCodexAgentsMd(tmpDir, "");
    expect(await Bun.file(join(tmpDir, "AGENTS.md")).exists()).toBe(false);
    await handle.cleanup();
    expect(await Bun.file(join(tmpDir, "AGENTS.md")).exists()).toBe(false);
  });

  test("no-op when cwd is falsy", async () => {
    const handle = await writeCodexAgentsMd(undefined, "test prompt");
    await handle.cleanup();
    // Nothing to assert on fs — just make sure no throw happens.
    expect(true).toBe(true);
  });

  test("creates fresh file when AGENTS.md and CLAUDE.md are absent", async () => {
    const dir = join(tmpDir, "fresh-no-claude");
    mkdirSync(dir, { recursive: true });
    const handle = await writeCodexAgentsMd(dir, "my prompt");
    const agentsMd = join(dir, "AGENTS.md");

    expect(await Bun.file(agentsMd).exists()).toBe(true);
    const content = await Bun.file(agentsMd).text();
    expect(content).toContain("<swarm_system_prompt>");
    expect(content).toContain("my prompt");
    expect(content).toContain("</swarm_system_prompt>");

    await handle.cleanup();
    expect(await Bun.file(agentsMd).exists()).toBe(false);
  });

  test("prepends block above CLAUDE.md content when only CLAUDE.md exists", async () => {
    const dir = join(tmpDir, "fresh-with-claude");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "CLAUDE.md"), "# My Project\n\nInstructions.");

    const handle = await writeCodexAgentsMd(dir, "swarm prompt");
    const agentsMd = join(dir, "AGENTS.md");

    const content = await Bun.file(agentsMd).text();
    expect(content.indexOf("<swarm_system_prompt>")).toBeLessThan(content.indexOf("# My Project"));
    expect(content).toContain("swarm prompt");
    expect(content).toContain("# My Project");

    await handle.cleanup();
    // Fresh creation → cleanup removes the file entirely (even though CLAUDE.md remains).
    expect(await Bun.file(agentsMd).exists()).toBe(false);
    expect(await Bun.file(join(dir, "CLAUDE.md")).exists()).toBe(true);
  });

  test("replaces existing managed block in place", async () => {
    const dir = join(tmpDir, "replace-block");
    mkdirSync(dir, { recursive: true });
    const original = `<swarm_system_prompt>
stale
</swarm_system_prompt>

# Keep me`;
    await Bun.write(join(dir, "AGENTS.md"), original);

    const handle = await writeCodexAgentsMd(dir, "fresh prompt");
    const agentsMd = join(dir, "AGENTS.md");

    const updated = await Bun.file(agentsMd).text();
    expect(updated).toContain("fresh prompt");
    expect(updated).not.toContain("stale");
    expect(updated).toContain("# Keep me");

    await handle.cleanup();
    // Not a fresh file — cleanup strips the block but leaves the rest intact.
    expect(await Bun.file(agentsMd).exists()).toBe(true);
    const after = await Bun.file(agentsMd).text();
    expect(after).not.toContain("<swarm_system_prompt>");
    expect(after).toContain("# Keep me");
  });

  test("prepends block when existing AGENTS.md has no block", async () => {
    const dir = join(tmpDir, "prepend-block");
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, "AGENTS.md"), "# Project instructions");

    const handle = await writeCodexAgentsMd(dir, "swarm prompt");
    const agentsMd = join(dir, "AGENTS.md");

    const updated = await Bun.file(agentsMd).text();
    expect(updated).toContain("swarm prompt");
    expect(updated).toContain("# Project instructions");
    expect(updated.indexOf("<swarm_system_prompt>")).toBeLessThan(
      updated.indexOf("# Project instructions"),
    );

    await handle.cleanup();
    const after = await Bun.file(agentsMd).text();
    expect(after).not.toContain("<swarm_system_prompt>");
    expect(after).toContain("# Project instructions");
  });
});

// ─── Phase 3: model catalogue ────────────────────────────────────────────────

describe("resolveCodexModel", () => {
  test("undefined → CODEX_DEFAULT_MODEL", () => {
    expect(resolveCodexModel(undefined)).toBe(CODEX_DEFAULT_MODEL);
  });

  test("empty string → CODEX_DEFAULT_MODEL", () => {
    expect(resolveCodexModel("")).toBe(CODEX_DEFAULT_MODEL);
  });

  test("claude shortname 'opus' → gpt-5.4", () => {
    expect(resolveCodexModel("opus")).toBe("gpt-5.4");
  });

  test("claude shortname 'sonnet' → gpt-5.4", () => {
    expect(resolveCodexModel("sonnet")).toBe("gpt-5.4");
  });

  test("claude shortname 'haiku' → gpt-5.4-mini", () => {
    expect(resolveCodexModel("haiku")).toBe("gpt-5.4-mini");
  });

  test("passthrough 'gpt-5.4-mini' → gpt-5.4-mini", () => {
    expect(resolveCodexModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
  });

  test("passthrough 'gpt-5.5' → gpt-5.5", () => {
    expect(resolveCodexModel("gpt-5.5")).toBe("gpt-5.5");
  });

  test("passthrough 'gpt-5.3-codex' → gpt-5.3-codex", () => {
    expect(resolveCodexModel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  test("passthrough 'gpt-5.2-codex' → gpt-5.2-codex", () => {
    expect(resolveCodexModel("gpt-5.2-codex")).toBe("gpt-5.2-codex");
  });

  test("case-insensitive: GPT-5.4 → gpt-5.4", () => {
    expect(resolveCodexModel("GPT-5.4")).toBe("gpt-5.4");
  });

  test("unknown model passes through verbatim (lowercased)", () => {
    expect(resolveCodexModel("gpt-5.5-experimental")).toBe("gpt-5.5-experimental");
    expect(resolveCodexModel("GPT-9-FUTURE")).toBe("gpt-9-future");
  });
});

describe("getCodexContextWindow", () => {
  test("gpt-5.4 → 200_000", () => {
    expect(getCodexContextWindow("gpt-5.4")).toBe(200_000);
  });

  test("gpt-5.4-mini → 200_000", () => {
    expect(getCodexContextWindow("gpt-5.4-mini")).toBe(200_000);
  });

  test("gpt-5.5 → 1_050_000", () => {
    expect(getCodexContextWindow("gpt-5.5")).toBe(1_050_000);
  });

  test("gpt-5.3-codex → 1_000_000 (1M context)", () => {
    expect(getCodexContextWindow("gpt-5.3-codex")).toBe(1_000_000);
  });

  test("gpt-5.2-codex → 200_000", () => {
    expect(getCodexContextWindow("gpt-5.2-codex")).toBe(200_000);
  });
});

describe("computeCodexCostUsd", () => {
  test("gpt-5.4 with 1M uncached input + 1M output = $2.50 + $15 = $17.50", () => {
    // 1_000_000 input - 0 cached = 1_000_000 uncached × $2.50/M = $2.50
    // 1_000_000 output × $15.00/M = $15.00
    const cost = computeCodexCostUsd("gpt-5.4", 1_000_000, 0, 1_000_000);
    expect(cost).toBeCloseTo(17.5, 4);
  });

  test("gpt-5.5 with 1M uncached input + 1M output = $5 + $30 = $35", () => {
    const cost = computeCodexCostUsd("gpt-5.5", 1_000_000, 0, 1_000_000);
    expect(cost).toBeCloseTo(35, 4);
  });

  test("gpt-5.4 with cached input applies the cached discount", () => {
    // 1M input, 800k cached → 200k uncached.
    // 200_000 × $2.50/M = $0.50
    // 800_000 × $0.25/M = $0.20
    // 100_000 output × $15/M = $1.50
    // total = $2.20
    const cost = computeCodexCostUsd("gpt-5.4", 1_000_000, 800_000, 100_000);
    expect(cost).toBeCloseTo(2.2, 4);
  });

  test("gpt-5.4-mini is roughly 3x cheaper than gpt-5.4 at the same usage", () => {
    const fullCost = computeCodexCostUsd("gpt-5.4", 1_000_000, 0, 100_000);
    const miniCost = computeCodexCostUsd("gpt-5.4-mini", 1_000_000, 0, 100_000);
    // gpt-5.4: 1M × $2.50 + 100k × $15 = $2.50 + $1.50 = $4.00
    // gpt-5.4-mini: 1M × $0.75 + 100k × $4.50 = $0.75 + $0.45 = $1.20
    expect(fullCost).toBeCloseTo(4.0, 4);
    expect(miniCost).toBeCloseTo(1.2, 4);
    expect(miniCost).toBeLessThan(fullCost);
  });

  test("gpt-5.3-codex inherits its own pricing tier", () => {
    // 1M input × $1.75 + 100k output × $14.00 = $1.75 + $1.40 = $3.15
    const cost = computeCodexCostUsd("gpt-5.3-codex", 1_000_000, 0, 100_000);
    expect(cost).toBeCloseTo(3.15, 4);
  });

  test("legacy gpt-5.2-codex falls back to gpt-5.3-codex pricing (best-effort)", () => {
    // Same as gpt-5.3-codex calc above so legacy tasks still report a non-zero cost.
    const cost = computeCodexCostUsd("gpt-5.2-codex", 1_000_000, 0, 100_000);
    expect(cost).toBeCloseTo(3.15, 4);
  });

  test("zero usage → zero cost", () => {
    expect(computeCodexCostUsd("gpt-5.4", 0, 0, 0)).toBe(0);
  });

  test("cached_input_tokens > input_tokens cannot drive uncached negative", () => {
    // Defensive: if cached somehow exceeds input we clamp uncached at 0.
    const cost = computeCodexCostUsd("gpt-5.4", 100, 200, 100);
    // cached billed at $0.25/M = 200 × $0.25/1M = $0.00005
    // output 100 × $15/1M = $0.0015
    // uncached clamped to 0, no input cost
    expect(cost).toBeCloseTo(0.00005 + 0.0015, 8);
  });
});

// ─── Phase 3: buildCodexConfig ───────────────────────────────────────────────

describe("buildCodexConfig", () => {
  // Save and restore the global fetch so we don't leak mocks between tests.
  const originalFetch = globalThis.fetch;
  // These tests assert the EXACT set of mcp_servers keys, which is only the
  // installed-server merge logic. Disable the always-on context-mode entry so
  // those exact-key assertions stay valid; a dedicated block below verifies
  // the context-mode + features behavior. Save/restore the env to avoid leaks.
  let prevContextModeDisabled: string | undefined;

  beforeEach(() => {
    prevContextModeDisabled = process.env.CONTEXT_MODE_DISABLED;
    process.env.CONTEXT_MODE_DISABLED = "true";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (prevContextModeDisabled === undefined) delete process.env.CONTEXT_MODE_DISABLED;
    else process.env.CONTEXT_MODE_DISABLED = prevContextModeDisabled;
  });

  // Helper: build a ProviderSessionConfig pointed at a mock endpoint.
  function cfg(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
    return {
      prompt: "hello",
      systemPrompt: "",
      model: "gpt-5.4",
      role: "worker",
      agentId: "agent-mcp-test",
      taskId: "task-mcp-test",
      apiUrl: "http://test.invalid",
      apiKey: "test-key",
      cwd: "",
      logFile: `/tmp/codex-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
      ...overrides,
    };
  }

  // Helper: build a Response-shaped stub for globalThis.fetch.
  function stubFetch(body: unknown, status = 200): typeof globalThis.fetch {
    return async (
      _input: Parameters<typeof globalThis.fetch>[0],
      _init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> => {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  test("zero installed MCP servers → only 'agent-swarm' entry", async () => {
    globalThis.fetch = stubFetch({ servers: [], total: 0 });
    const emitted: ProviderEvent[] = [];
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", (e) => emitted.push(e));

    const mcp = merged.mcp_servers as Record<string, Record<string, unknown>>;
    expect(Object.keys(mcp)).toEqual(["agent-swarm"]);
    expect(mcp["agent-swarm"]?.url).toBe("http://test.invalid/mcp");
    const headers = mcp["agent-swarm"]?.http_headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["X-Agent-ID"]).toBe("agent-mcp-test");
    expect(headers["X-Source-Task-Id"]).toBe("task-mcp-test");
    expect(mcp["agent-swarm"]?.enabled).toBe(true);
    expect(mcp["agent-swarm"]?.startup_timeout_sec).toBe(30);
    expect(mcp["agent-swarm"]?.tool_timeout_sec).toBe(120);

    // Baseline overrides are included
    expect(merged.model).toBe("gpt-5.4");
    expect(merged.approval_policy).toBe("never");
    expect(merged.sandbox_mode).toBe("danger-full-access");
    expect(merged.skip_git_repo_check).toBe(true);
    expect(merged.show_raw_agent_reasoning).toBe(false);

    // No warnings emitted
    expect(emitted.filter((e) => e.type === "raw_stderr")).toHaveLength(0);
  });

  test("one HTTP-transport installed server → both 'agent-swarm' and installed server present", async () => {
    globalThis.fetch = stubFetch({
      servers: [
        {
          name: "sentry-mcp",
          transport: "http",
          isActive: true,
          isEnabled: true,
          url: "https://sentry.example.com/mcp",
          headers: JSON.stringify({ "X-Custom": "static" }),
          resolvedHeaders: { Authorization: "Bearer sentry-token" },
        },
      ],
      total: 1,
    });

    const emitted: ProviderEvent[] = [];
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", (e) => emitted.push(e));
    const mcp = merged.mcp_servers as Record<string, Record<string, unknown>>;

    expect(Object.keys(mcp).sort()).toEqual(["agent-swarm", "sentry-mcp"]);
    expect(mcp["sentry-mcp"]?.url).toBe("https://sentry.example.com/mcp");
    expect(mcp["sentry-mcp"]?.http_headers).toEqual({
      "X-Custom": "static",
      Authorization: "Bearer sentry-token",
    });
    expect(mcp["sentry-mcp"]?.enabled).toBe(true);
    expect(mcp["sentry-mcp"]?.startup_timeout_sec).toBe(30);
    expect(mcp["sentry-mcp"]?.tool_timeout_sec).toBe(120);
    expect(mcp["sentry-mcp"]?.command).toBeUndefined();
  });

  test("one SSE-transport installed server → skipped with warning", async () => {
    globalThis.fetch = stubFetch({
      servers: [
        {
          name: "legacy-sse",
          transport: "sse",
          isActive: true,
          isEnabled: true,
          url: "https://legacy.example.com/sse",
        },
      ],
      total: 1,
    });

    const emitted: ProviderEvent[] = [];
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", (e) => emitted.push(e));
    const mcp = merged.mcp_servers as Record<string, Record<string, unknown>>;

    expect(Object.keys(mcp)).toEqual(["agent-swarm"]);
    expect(mcp["legacy-sse"]).toBeUndefined();

    const warnings = emitted.filter((e) => e.type === "raw_stderr");
    expect(warnings).toHaveLength(1);
    const warn = warnings[0];
    if (warn && warn.type === "raw_stderr") {
      expect(warn.content).toContain("legacy-sse");
      expect(warn.content).toContain("SSE");
      expect(warn.content).toContain("openai/codex#2129");
    }
  });

  test("one stdio-transport installed server → emits command/args/env", async () => {
    globalThis.fetch = stubFetch({
      servers: [
        {
          name: "filesystem",
          transport: "stdio",
          isActive: true,
          isEnabled: true,
          command: "/usr/local/bin/mcp-filesystem",
          args: JSON.stringify(["--root", "/workspace"]),
          resolvedEnv: { SECRET_KEY: "sk-abc" },
        },
      ],
      total: 1,
    });

    const emitted: ProviderEvent[] = [];
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", (e) => emitted.push(e));
    const mcp = merged.mcp_servers as Record<string, Record<string, unknown>>;

    expect(Object.keys(mcp).sort()).toEqual(["agent-swarm", "filesystem"]);
    expect(mcp.filesystem?.command).toBe("/usr/local/bin/mcp-filesystem");
    expect(mcp.filesystem?.args).toEqual(["--root", "/workspace"]);
    expect(mcp.filesystem?.env).toEqual({ SECRET_KEY: "sk-abc" });
    expect(mcp.filesystem?.url).toBeUndefined();
    expect(mcp.filesystem?.http_headers).toBeUndefined();
  });

  test("fetch failure → returns config with only 'agent-swarm' and emits warning", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const emitted: ProviderEvent[] = [];
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", (e) => emitted.push(e));
    const mcp = merged.mcp_servers as Record<string, Record<string, unknown>>;

    expect(Object.keys(mcp)).toEqual(["agent-swarm"]);

    const warnings = emitted.filter((e) => e.type === "raw_stderr");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const warn = warnings[0];
    if (warn && warn.type === "raw_stderr") {
      expect(warn.content).toContain("Failed to fetch installed MCP servers");
      expect(warn.content).toContain("ECONNREFUSED");
    }
  });

  test("HTTP 500 → returns config with only 'agent-swarm' and emits warning", async () => {
    globalThis.fetch = stubFetch({ error: "internal server error" }, 500);

    const emitted: ProviderEvent[] = [];
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", (e) => emitted.push(e));
    const mcp = merged.mcp_servers as Record<string, Record<string, unknown>>;

    expect(Object.keys(mcp)).toEqual(["agent-swarm"]);

    const warnings = emitted.filter((e) => e.type === "raw_stderr");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const warn = warnings[0];
    if (warn && warn.type === "raw_stderr") {
      expect(warn.content).toContain("Failed to fetch installed MCP servers");
      expect(warn.content).toContain("500");
    }
  });

  test("inactive/disabled servers are skipped", async () => {
    globalThis.fetch = stubFetch({
      servers: [
        {
          name: "disabled",
          transport: "http",
          isActive: true,
          isEnabled: false,
          url: "https://disabled.example.com",
        },
        {
          name: "inactive",
          transport: "http",
          isActive: false,
          isEnabled: true,
          url: "https://inactive.example.com",
        },
      ],
      total: 2,
    });

    const emitted: ProviderEvent[] = [];
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", (e) => emitted.push(e));
    const mcp = merged.mcp_servers as Record<string, Record<string, unknown>>;

    expect(Object.keys(mcp)).toEqual(["agent-swarm"]);
  });

  test("model parameter is used in baseline merged config", async () => {
    globalThis.fetch = stubFetch({ servers: [] });
    const merged = await buildCodexConfig(cfg(), "gpt-5.3-codex", () => {});
    expect(merged.model).toBe("gpt-5.3-codex");
  });
});

// ─── Phase 3: buildCodexConfig — context-mode MCP + hook feature flags ───────

describe("buildCodexConfig — context-mode + features", () => {
  const originalFetch = globalThis.fetch;
  // Explicitly own CONTEXT_MODE_DISABLED here. Save the ambient value up front
  // and restore it after every test so we never leak the mutation to siblings.
  let prevContextModeDisabled: string | undefined;

  beforeEach(() => {
    prevContextModeDisabled = process.env.CONTEXT_MODE_DISABLED;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (prevContextModeDisabled === undefined) delete process.env.CONTEXT_MODE_DISABLED;
    else process.env.CONTEXT_MODE_DISABLED = prevContextModeDisabled;
  });

  function cfg(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
    return {
      prompt: "hello",
      systemPrompt: "",
      model: "gpt-5.4",
      role: "worker",
      agentId: "agent-mcp-test",
      taskId: "task-mcp-test",
      apiUrl: "http://test.invalid",
      apiKey: "test-key",
      cwd: "",
      logFile: `/tmp/codex-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
      ...overrides,
    };
  }

  function stubFetch(body: unknown, status = 200): typeof globalThis.fetch {
    return async (): Promise<Response> => {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    };
  }

  test("includes the 'context-mode' mcp_servers entry by default", async () => {
    delete process.env.CONTEXT_MODE_DISABLED;
    globalThis.fetch = stubFetch({ servers: [], total: 0 });
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", () => {});
    const mcp = merged.mcp_servers as Record<string, Record<string, unknown>>;

    expect(Object.keys(mcp).sort()).toEqual(["agent-swarm", "context-mode"]);
    expect(mcp["context-mode"]?.command).toBe("context-mode");
    expect(mcp["context-mode"]?.enabled).toBe(true);
    expect(mcp["context-mode"]?.startup_timeout_sec).toBe(30);
    expect(mcp["context-mode"]?.tool_timeout_sec).toBe(120);
  });

  test("excludes the 'context-mode' entry when CONTEXT_MODE_DISABLED=true", async () => {
    process.env.CONTEXT_MODE_DISABLED = "true";
    globalThis.fetch = stubFetch({ servers: [], total: 0 });
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", () => {});
    const mcp = merged.mcp_servers as Record<string, Record<string, unknown>>;

    expect(Object.keys(mcp)).toEqual(["agent-swarm"]);
    expect(mcp["context-mode"]).toBeUndefined();
  });

  test("sets features.hooks and features.plugin_hooks to true", async () => {
    delete process.env.CONTEXT_MODE_DISABLED;
    globalThis.fetch = stubFetch({ servers: [], total: 0 });
    const merged = await buildCodexConfig(cfg(), "gpt-5.4", () => {});

    const features = merged.features as Record<string, unknown>;
    expect(features.hooks).toBe(true);
    expect(features.plugin_hooks).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — session-end summarization
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Drive a CodexSession through a fake `Thread` AND inject summarization deps.
 * Mirrors `runSessionWithFakeThread` but also lets the caller stub out
 * `runSummarize` / `fetchRetrievalsForTask` / `postRatings` / `buildRatingsFromLlm`
 * via the adapter constructor.
 */
async function runSessionWithFakeThreadAndDeps(
  events: ThreadEvent[],
  config: ProviderSessionConfig,
  summarizeDeps: SummarizeSessionForCodexDeps,
): Promise<{ emitted: ProviderEvent[]; result: ProviderResult }> {
  const sdk = await import("@openai/codex-sdk");
  const originalStartThread = (
    sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
  ).startThread;

  const fakeThread = makeFakeThread(events);
  (sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }).startThread =
    function startThread(): unknown {
      return fakeThread as unknown;
    };

  try {
    const adapter = new CodexAdapter({ summarizeDeps, bypassSubprocess: true });
    const session = await adapter.createSession(config);
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    const result = await session.waitForCompletion();
    return { emitted, result };
  } finally {
    (
      sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
    ).startThread = originalStartThread;
  }
}

type RunSummarizeArgs = Parameters<NonNullable<SummarizeSessionForCodexDeps["runSummarize"]>>[0];
type RunSummarizeResult = Awaited<
  ReturnType<NonNullable<SummarizeSessionForCodexDeps["runSummarize"]>>
>;
type PostRatingsArgs = Parameters<NonNullable<SummarizeSessionForCodexDeps["postRatings"]>>[0];

describe("CodexSession session-end summarization", () => {
  const tmpLogDir = `/tmp/codex-adapter-summary-test-${Date.now()}`;
  let prevSkipEnv: string | undefined;
  let prevMemoryRaters: string | undefined;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const consoleErrors: unknown[][] = [];
  const origFetch = globalThis.fetch;
  const origConsoleError = console.error;
  type FetchHandlerResp = {
    ok: boolean;
    status: number;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
  };
  let fetchHandler: ((url: string, init?: RequestInit) => Promise<FetchHandlerResp>) | null = null;

  beforeAll(() => {
    mkdirSync(tmpLogDir, { recursive: true });
    // Capture so we don't clobber the outer describe's env override on exit.
    prevSkipEnv = process.env.SKIP_SESSION_SUMMARY;
    prevMemoryRaters = process.env.MEMORY_RATERS;
    delete process.env.SKIP_SESSION_SUMMARY;
    delete process.env.MEMORY_RATERS;
  });

  afterAll(() => {
    rmSync(tmpLogDir, { recursive: true, force: true });
    if (prevSkipEnv === undefined) delete process.env.SKIP_SESSION_SUMMARY;
    else process.env.SKIP_SESSION_SUMMARY = prevSkipEnv;
    if (prevMemoryRaters === undefined) delete process.env.MEMORY_RATERS;
    else process.env.MEMORY_RATERS = prevMemoryRaters;
  });

  beforeEach(() => {
    fetchCalls.length = 0;
    consoleErrors.length = 0;
    fetchHandler = async (url) => {
      if (url.includes("/api/memory/index")) {
        return {
          ok: true,
          status: 202,
          text: async () => "",
          json: async () => ({ queued: true, memoryIds: ["mem-1"] }),
        };
      }
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      fetchCalls.push({ url: urlStr, init });
      if (!fetchHandler) return new Response("{}", { status: 200 });
      return fetchHandler(urlStr, init) as unknown as Response;
    }) as typeof fetch;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.error = origConsoleError;
    delete process.env.SKIP_SESSION_SUMMARY;
    delete process.env.MEMORY_RATERS;
  });

  /**
   * Helper: build the canonical event sequence used by every summarization
   * test: thread.started → turn.started → tool started → tool completed →
   * agent_message → turn.completed. Each test customises the agent_message
   * text or omits a step as needed.
   */
  function buildSummaryEvents(opts: { agentText?: string } = {}): ThreadEvent[] {
    const cmdItem: CommandExecutionItem = {
      id: "cmd-1",
      type: "command_execution",
      command: "ls",
      aggregated_output: "file1\nfile2",
      exit_code: 0,
      status: "completed",
    };
    const agentMsg: AgentMessageItem = {
      id: "msg-1",
      type: "agent_message",
      text: opts.agentText ?? "I listed the files.",
    };
    return [
      { type: "thread.started", thread_id: "t1" },
      { type: "turn.started" },
      { type: "item.started", item: cmdItem as ThreadItem },
      { type: "item.completed", item: cmdItem as ThreadItem },
      { type: "item.completed", item: agentMsg as ThreadItem },
      {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      },
    ];
  }

  test("happy path: runSummarize is invoked + POST /api/memory/index captured", async () => {
    const events = buildSummaryEvents();

    let runSummarizeCalls = 0;
    let lastRunSummarizeArgs: RunSummarizeArgs | null = null;
    const deps: SummarizeSessionForCodexDeps = {
      runSummarize: async (args) => {
        runSummarizeCalls += 1;
        lastRunSummarizeArgs = args;
        return {
          summary: "Listed files in the current working directory.",
          ratings: [],
        } as RunSummarizeResult;
      },
    };

    const config = testConfig({
      logFile: join(tmpLogDir, "happy.log"),
      cwd: "",
      prompt: "what's in this dir?",
    });

    await runSessionWithFakeThreadAndDeps(events, config, deps);

    expect(runSummarizeCalls).toBe(1);
    expect(lastRunSummarizeArgs).not.toBeNull();
    expect(lastRunSummarizeArgs!.harness).toBe("codex");
    expect(lastRunSummarizeArgs!.taskContext.sourceTaskId).toBe("task-test");
    expect(lastRunSummarizeArgs!.taskContext.agentId).toBe("agent-test");
    expect(lastRunSummarizeArgs!.apiUrl).toBe("http://localhost:0");
    expect(lastRunSummarizeArgs!.apiKey).toBe("test");

    // Transcript must contain all four signal lines.
    const transcript = lastRunSummarizeArgs!.transcript;
    expect(transcript).toContain("User: what's in this dir?");
    expect(transcript).toContain("Tool[bash] started:");
    expect(transcript).toContain("Tool[bash] completed:");
    expect(transcript).toContain("Assistant: I listed the files.");

    // /api/memory/index POST captured with expected body.
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(1);
    const body = JSON.parse(indexCalls[0]!.init?.body as string) as Record<string, unknown>;
    expect(body.scope).toBe("agent");
    expect(body.source).toBe("session_summary");
    expect(body.sourceTaskId).toBe("task-test");
    expect(body.agentId).toBe("agent-test");
    expect(body.name).toBe("session-summary");
    expect(body.content).toBe("Listed files in the current working directory.");

    expect(consoleErrors.length).toBe(0);
  });

  test("SKIP_SESSION_SUMMARY=1 → no runSummarize call, no POST", async () => {
    process.env.SKIP_SESSION_SUMMARY = "1";
    const events = buildSummaryEvents();

    let runSummarizeCalls = 0;
    const deps: SummarizeSessionForCodexDeps = {
      runSummarize: async () => {
        runSummarizeCalls += 1;
        return null;
      },
    };

    const config = testConfig({
      logFile: join(tmpLogDir, "skip.log"),
      cwd: "",
    });
    await runSessionWithFakeThreadAndDeps(events, config, deps);

    expect(runSummarizeCalls).toBe(0);
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
  });

  test("missing taskId → no runSummarize call, no POST", async () => {
    const events = buildSummaryEvents();

    let runSummarizeCalls = 0;
    const deps: SummarizeSessionForCodexDeps = {
      runSummarize: async () => {
        runSummarizeCalls += 1;
        return null;
      },
    };

    const config = testConfig({
      logFile: join(tmpLogDir, "no-task.log"),
      cwd: "",
      taskId: "", // falsy
    });
    await runSessionWithFakeThreadAndDeps(events, config, deps);

    expect(runSummarizeCalls).toBe(0);
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
  });

  test("runSummarize throws → existing logFileHandle.end() + agentsMdHandle.cleanup() still run", async () => {
    // Use a real temp dir as cwd so we exercise writeCodexAgentsMd, then spy on
    // the resulting AGENTS.md file. After cleanup the file MUST be gone.
    const cwd = `/tmp/codex-summary-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    mkdirSync(cwd, { recursive: true });
    const agentsMdPath = join(cwd, "AGENTS.md");

    const events = buildSummaryEvents();
    const deps: SummarizeSessionForCodexDeps = {
      runSummarize: async () => {
        throw new Error("boom");
      },
    };

    const logFile = join(tmpLogDir, "throw.log");
    const config = testConfig({
      logFile,
      cwd,
      systemPrompt: "test system prompt", // ensures AGENTS.md gets written
    });
    await runSessionWithFakeThreadAndDeps(events, config, deps);

    // AGENTS.md cleanup must have run despite the summarize throw.
    expect(await Bun.file(agentsMdPath).exists()).toBe(false);

    // Log file flush must have run despite the summarize throw — the log file
    // exists and contains at least one event JSONL line.
    const logContent = await Bun.file(logFile).text();
    expect(logContent.length).toBeGreaterThan(0);
    expect(logContent).toContain("session_init");

    // The summarize failure was logged via console.error.
    const summaryErrors = consoleErrors.filter(
      (args) =>
        typeof args[0] === "string" &&
        (args[0] as string).startsWith("session_summary failed (codex):"),
    );
    expect(summaryErrors.length).toBe(1);

    // No /api/memory/index POST attempted.
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);

    rmSync(cwd, { recursive: true, force: true });
  });

  test("length gate — summary ≤ 20 chars → no POST", async () => {
    const events = buildSummaryEvents();
    const deps: SummarizeSessionForCodexDeps = {
      runSummarize: async () => ({ summary: "tiny", ratings: [] }) as RunSummarizeResult,
    };

    const config = testConfig({ logFile: join(tmpLogDir, "short.log"), cwd: "" });
    await runSessionWithFakeThreadAndDeps(events, config, deps);

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
  });

  test("'no significant learnings' gate → no POST", async () => {
    const events = buildSummaryEvents();
    const deps: SummarizeSessionForCodexDeps = {
      runSummarize: async () =>
        ({
          summary: "No significant learnings from this session.",
          ratings: [],
        }) as RunSummarizeResult,
    };

    const config = testConfig({ logFile: join(tmpLogDir, "no-learn.log"), cwd: "" });
    await runSessionWithFakeThreadAndDeps(events, config, deps);

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
  });

  test("null runSummarize result → no POST, no error log", async () => {
    const events = buildSummaryEvents();
    const deps: SummarizeSessionForCodexDeps = {
      runSummarize: async () => null,
    };

    const config = testConfig({ logFile: join(tmpLogDir, "null.log"), cwd: "" });
    await runSessionWithFakeThreadAndDeps(events, config, deps);

    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(0);
    expect(consoleErrors.length).toBe(0);
  });

  test("ratings path — MEMORY_RATERS=llm → postRatings called with `events:` key (NOT `ratings:`)", async () => {
    process.env.MEMORY_RATERS = "llm";
    const events = buildSummaryEvents();

    const retrievalRow = { id: "mem-A", name: "memory A", content: "..." };

    let lastPostRatingsArgs: PostRatingsArgs | null = null;
    const deps: SummarizeSessionForCodexDeps = {
      fetchRetrievalsForTask: async () => [retrievalRow] as never,
      runSummarize: async (args) => {
        expect(args.retrievals.length).toBe(1);
        expect(args.retrievals[0]!.id).toBe("mem-A");
        return {
          summary: "Long-enough summary with real content for the index POST.",
          ratings: [{ id: "mem-A", score: 0.8, reasoning: "useful" }],
        } as RunSummarizeResult;
      },
      postRatings: async (args) => {
        lastPostRatingsArgs = args;
        return { ok: true, status: 200 };
      },
      buildRatingsFromLlm: (ratings, retrievals) => {
        const allowed = new Set(retrievals.map((r) => r.id));
        return ratings
          .filter((r) => allowed.has(r.id))
          .map((r) => ({
            memoryId: r.id,
            signal: 2 * r.score - 1,
            weight: 0.8,
            source: "llm",
            reasoning: r.reasoning,
          }));
      },
    };

    const config = testConfig({ logFile: join(tmpLogDir, "ratings.log"), cwd: "" });
    await runSessionWithFakeThreadAndDeps(events, config, deps);

    // Index POST happened
    const indexCalls = fetchCalls.filter((c) => c.url.endsWith("/api/memory/index"));
    expect(indexCalls.length).toBe(1);

    // postRatings was called with `events:` key, NOT `ratings:` — guards
    // against the plan/signature mismatch flagged by the orchestrator.
    expect(lastPostRatingsArgs).not.toBeNull();
    expect(lastPostRatingsArgs!.apiUrl).toBe("http://localhost:0");
    expect(lastPostRatingsArgs!.agentId).toBe("agent-test");
    expect(lastPostRatingsArgs!.taskId).toBe("task-test");
    expect(Array.isArray(lastPostRatingsArgs!.events)).toBe(true);
    expect(lastPostRatingsArgs!.events.length).toBe(1);
    expect(lastPostRatingsArgs!.events[0]!.memoryId).toBe("mem-A");
    expect(lastPostRatingsArgs!.events[0]!.source).toBe("llm");

    // Guard against accidentally passing a `ratings:` key.
    expect((lastPostRatingsArgs as unknown as Record<string, unknown>).ratings).toBeUndefined();

    expect(consoleErrors.length).toBe(0);
  });

  test("POST /api/memory/index 500 → exactly one console.error('… (codex):', …)", async () => {
    const events = buildSummaryEvents();
    fetchHandler = async (url) => {
      if (url.includes("/api/memory/index")) {
        return {
          ok: false,
          status: 500,
          text: async () => "internal server error",
          json: async () => ({}),
        };
      }
      return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
    };

    const deps: SummarizeSessionForCodexDeps = {
      runSummarize: async () =>
        ({
          summary: "A valid long-enough summary that passes the length gate.",
          ratings: [],
        }) as RunSummarizeResult,
    };

    const config = testConfig({ logFile: join(tmpLogDir, "post500.log"), cwd: "" });
    await runSessionWithFakeThreadAndDeps(events, config, deps);

    const matching = consoleErrors.filter(
      (args) =>
        typeof args[0] === "string" &&
        (args[0] as string).startsWith("session_summary: /api/memory/index POST failed (codex):"),
    );
    expect(matching.length).toBe(1);
    expect(matching[0]![1]).toBe(500);
  });
});

describe("CodexSession — rate-limit error preservation", () => {
  const tmpLogDir = `/tmp/codex-rate-limit-test-${Date.now()}`;
  let prevSkipEnv: string | undefined;

  beforeAll(() => {
    mkdirSync(tmpLogDir, { recursive: true });
    prevSkipEnv = process.env.SKIP_SESSION_SUMMARY;
    process.env.SKIP_SESSION_SUMMARY = "1";
  });

  afterAll(() => {
    rmSync(tmpLogDir, { recursive: true, force: true });
    if (prevSkipEnv === undefined) delete process.env.SKIP_SESSION_SUMMARY;
    else process.env.SKIP_SESSION_SUMMARY = prevSkipEnv;
  });

  afterEach(() => {
    // Keep afterEach from the test runner clean
  });

  test("terminalError survives SDK post-stream throw and surfaces as [usage-limit] failureReason", async () => {
    const usageLimitMsg =
      "You've hit your usage limit. To get more access now, send a request to your admin or try again at 8:35 PM.";
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-ratelimit-1" },
      { type: "turn.started" },
      { type: "error", message: usageLimitMsg },
      { type: "turn.failed", error: { message: usageLimitMsg } },
    ];
    const sdkThrow = new Error("Codex Exec exited with code 1: Reading prompt from stdin");

    const { result } = await runSessionWithThrowingThread(
      events,
      sdkThrow,
      testConfig({ logFile: join(tmpLogDir, "ratelimit-preserve.log"), cwd: "" }),
    );

    // Bug #1 fix: structured failureReason must survive the SDK throw
    expect(result.failureReason).toMatch(/\[usage-limit\]/);
    expect(result.failureReason).not.toContain("Reading prompt from stdin");
    expect(result.isError).toBe(true);
    // Parser must have extracted a reset time
    expect(result.rateLimitResetAt).toBeDefined();
    const resetMs = new Date(result.rateLimitResetAt!).getTime();
    expect(resetMs).toBeGreaterThan(Date.now());
  });

  test("AbortError still settles as cancelled even when terminalError is absent (regression guard)", async () => {
    // If the session is aborted before any error event, the AbortError path
    // must still win over the terminalError preservation branch.
    const sdk = await import("@openai/codex-sdk");
    const originalStartThread = (
      sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
    ).startThread;

    const fakeThread = {
      id: null,
      runStreamed: async (_input: string, opts?: { signal?: AbortSignal }) => {
        async function* generate(): AsyncGenerator<ThreadEvent> {
          yield { type: "thread.started", thread_id: "thread-abort-guard" };
          yield { type: "turn.started" };
          await new Promise<void>((resolve) => {
            const onAbort = () => {
              opts?.signal?.removeEventListener("abort", onAbort);
              resolve();
            };
            if (opts?.signal?.aborted) {
              resolve();
              return;
            }
            opts?.signal?.addEventListener("abort", onAbort);
            setTimeout(resolve, 5000);
          });
          if (opts?.signal?.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
        }
        return { events: generate() };
      },
    };

    (
      sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
    ).startThread = function startThread(): unknown {
      return fakeThread as unknown;
    };

    try {
      const adapter = new CodexAdapter({ bypassSubprocess: true });
      const config = testConfig({
        logFile: join(tmpLogDir, "abort-guard.log"),
        cwd: "",
        taskId: "",
        apiUrl: "",
        apiKey: "",
      });
      const session = await adapter.createSession(config);
      const emitted: ProviderEvent[] = [];
      session.onEvent((e) => emitted.push(e));
      await new Promise((resolve) => setTimeout(resolve, 30));
      await session.abort();
      const result = await session.waitForCompletion();

      expect(result.failureReason).toBe("cancelled");
      expect(result.exitCode).toBe(130);
    } finally {
      (
        sdk.Codex.prototype as unknown as { startThread: (...args: unknown[]) => unknown }
      ).startThread = originalStartThread;
    }
  });

  test("real unexpected exception (no terminalError) still falls through to outer catch", async () => {
    // When the SDK throws before any error event, the outer catch must fire normally.
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-unexpected" },
      { type: "turn.started" },
    ];
    const unexpectedErr = new Error("unexpected network failure");

    const { result } = await runSessionWithThrowingThread(
      events,
      unexpectedErr,
      testConfig({ logFile: join(tmpLogDir, "unexpected-err.log"), cwd: "" }),
    );

    // No terminalError → outer catch fires → failureReason is the raw exception message
    expect(result.failureReason).toBe("unexpected network failure");
    expect(result.isError).toBe(true);
    expect(result.rateLimitResetAt).toBeUndefined();
  });
});
