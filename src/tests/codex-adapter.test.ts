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
import { CodexAdapter } from "../providers/codex-adapter";
import { writeCodexAgentsMd } from "../providers/codex-agents-md";
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

    // context_usage event fired
    const contextUsage = emitted.find((e) => e.type === "context_usage");
    expect(contextUsage).toBeDefined();

    // result event is final and non-error
    const resultEvent = emitted.findLast((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    if (resultEvent && resultEvent.type === "result") {
      expect(resultEvent.isError).toBe(false);
      expect(resultEvent.cost.inputTokens).toBe(100);
      expect(resultEvent.cost.outputTokens).toBe(50);
      expect(resultEvent.cost.cacheReadTokens).toBe(25);
      expect(resultEvent.cost.numTurns).toBe(1);
      expect(resultEvent.cost.model).toBe("gpt-5.4");
    }

    // ProviderResult
    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("thread-abc");
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
