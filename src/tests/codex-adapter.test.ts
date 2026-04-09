/**
 * Phase 2 unit tests for CodexAdapter / CodexSession.
 *
 * We stub the Codex SDK via a tiny fake `Thread` object whose `runStreamed`
 * returns a pre-built async iterable of `ThreadEvent`s. This exercises the
 * adapter's event normalization loop without pulling in the real SDK.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentMessageItem,
  CommandExecutionItem,
  ThreadEvent,
  ThreadItem,
} from "@openai/codex-sdk";
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
    const adapter = new CodexAdapter();
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

  beforeAll(() => {
    mkdirSync(tmpLogDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpLogDir, { recursive: true, force: true });
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

    // context_usage event fired with the *uncached + output* peak proxy
    // (input=100, cached=25, output=50 → uncached=75 → peak=125)
    // contextPercent is on a 0-100 scale (claude/pi convention).
    const contextUsage = emitted.find((e) => e.type === "context_usage");
    expect(contextUsage).toBeDefined();
    if (contextUsage && contextUsage.type === "context_usage") {
      expect(contextUsage.contextUsedTokens).toBe(125);
      expect(contextUsage.contextTotalTokens).toBe(200_000);
      // 125 / 200_000 × 100 = 0.0625
      expect(contextUsage.contextPercent).toBeCloseTo((125 / 200_000) * 100, 6);
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

  test("chatty turn: peakContextPercent uses uncached + output, not raw input_tokens", async () => {
    // Reproduces the verify-plan finding: a chatty turn where the SDK reports
    // input_tokens far in excess of the model's context window because the
    // total represents the SUM of every prompt across all model invocations
    // in the turn (with cache reuses billed at every roundtrip). Without the
    // peak-proxy fix this would clamp `contextPercent` to 1.0 even though no
    // single model call hit the limit. Use realistic numbers from the actual
    // E2E lead transcript captured during verification.
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
      // peak proxy = (357142 - 278912) + 2156 = 78230 + 2156 = 80386
      expect(contextUsage.contextUsedTokens).toBe(80386);
      expect(contextUsage.contextTotalTokens).toBe(200_000);
      // 80386 / 200000 × 100 = 40.193 — on the 0-100 scale, NOT clamped to 100
      expect(contextUsage.contextPercent).toBeCloseTo(40.193, 2);
      expect(contextUsage.contextPercent).toBeLessThan(100);
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
      const adapter = new CodexAdapter();
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
  test("returns false for empty / non-string session ids", async () => {
    const adapter = new CodexAdapter();
    expect(await adapter.canResume("")).toBe(false);
    // @ts-expect-error: deliberate runtime check for non-string input
    expect(await adapter.canResume(undefined)).toBe(false);
  });

  test("returns true when resumeThread succeeds and false when it throws", async () => {
    const sdk = await import("@openai/codex-sdk");
    const originalResume = (
      sdk.Codex.prototype as unknown as { resumeThread: (...args: unknown[]) => unknown }
    ).resumeThread;

    try {
      // Success path
      (
        sdk.Codex.prototype as unknown as { resumeThread: (...args: unknown[]) => unknown }
      ).resumeThread = function resumeThread(): unknown {
        return { id: "thread-resumed" };
      };
      const adapter = new CodexAdapter();
      expect(await adapter.canResume("thread-resumed")).toBe(true);

      // Failure path
      (
        sdk.Codex.prototype as unknown as { resumeThread: (...args: unknown[]) => unknown }
      ).resumeThread = function resumeThread(): unknown {
        throw new Error("not found");
      };
      expect(await adapter.canResume("thread-missing")).toBe(false);
    } finally {
      (
        sdk.Codex.prototype as unknown as { resumeThread: (...args: unknown[]) => unknown }
      ).resumeThread = originalResume;
    }
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

  test("claude shortname 'sonnet' → gpt-5.4-mini", () => {
    expect(resolveCodexModel("sonnet")).toBe("gpt-5.4-mini");
  });

  test("claude shortname 'haiku' → gpt-5.4-mini", () => {
    expect(resolveCodexModel("haiku")).toBe("gpt-5.4-mini");
  });

  test("passthrough 'gpt-5.4-mini' → gpt-5.4-mini", () => {
    expect(resolveCodexModel("gpt-5.4-mini")).toBe("gpt-5.4-mini");
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

  test("unknown model → CODEX_DEFAULT_MODEL", () => {
    expect(resolveCodexModel("unknown-model")).toBe(CODEX_DEFAULT_MODEL);
  });
});

describe("getCodexContextWindow", () => {
  test("gpt-5.4 → 200_000", () => {
    expect(getCodexContextWindow("gpt-5.4")).toBe(200_000);
  });

  test("gpt-5.4-mini → 200_000", () => {
    expect(getCodexContextWindow("gpt-5.4-mini")).toBe(200_000);
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

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
