import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";

// Mock slack/app to avoid dynamic import issues in parallel test execution
mock.module("../slack/app", () => ({
  getSlackApp: () => null,
}));

import type { ExecutorMeta } from "../types";
import type { ExecutorDependencies, ExecutorInput } from "../workflows/executors/base";
import { CodeMatchExecutor, CodeMatchOutputSchema } from "../workflows/executors/code-match";
import { NotifyExecutor } from "../workflows/executors/notify";
import {
  PropertyMatchExecutor,
  PropertyMatchOutputSchema,
} from "../workflows/executors/property-match";
import { RawLlmExecutor } from "../workflows/executors/raw-llm";
import { createExecutorRegistry } from "../workflows/executors/registry";
import { ScriptExecutor, ScriptOutputSchema } from "../workflows/executors/script";
import { ValidateExecutor, ValidateOutputSchema } from "../workflows/executors/validate";
import { VcsExecutor, VcsOutputSchema } from "../workflows/executors/vcs";

const TEST_DB_PATH = "./test-workflow-executors.sqlite";

// ─── Mock Dependencies ───────────────────────────────────────

const postedMessages: { channelId: string; content: string }[] = [];

const mockDeps: ExecutorDependencies = {
  db: {
    postMessage: (channelId: string, _agentId: string | null, content: string) => {
      const msg = { id: `msg-${Date.now()}`, channelId, content };
      postedMessages.push({ channelId, content });
      return msg;
    },
  } as unknown as typeof import("../be/db"),
  eventBus: { emit: () => {}, on: () => {}, off: () => {} },
  interpolate: (template: string, ctx: Record<string, unknown>) => {
    return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
      const keys = path.trim().split(".");
      let value: unknown = ctx;
      for (const key of keys) {
        if (value == null || typeof value !== "object") return "";
        value = (value as Record<string, unknown>)[key];
      }
      if (value == null) return "";
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    });
  },
};

const mockMeta: ExecutorMeta = {
  runId: "00000000-0000-0000-0000-000000000001",
  stepId: "00000000-0000-0000-0000-000000000002",
  nodeId: "test-node",
  workflowId: "00000000-0000-0000-0000-000000000003",
  dryRun: false,
};

function input(
  config: Record<string, unknown>,
  context: Record<string, unknown> = {},
): ExecutorInput {
  return { config, context, meta: mockMeta };
}

// ─── Setup / Teardown ────────────────────────────────────────

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {
    // File doesn't exist
  }
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // File may not exist
    }
  }
});

// ─── PropertyMatch Executor ──────────────────────────────────

describe("PropertyMatchExecutor", () => {
  const executor = new PropertyMatchExecutor(mockDeps);

  test("config schema rejects empty conditions", () => {
    const result = executor.configSchema.safeParse({ conditions: [] });
    expect(result.success).toBe(false);
  });

  test("config schema rejects missing conditions", () => {
    const result = executor.configSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("config schema accepts valid config", () => {
    const result = executor.configSchema.safeParse({
      conditions: [{ field: "data.value", op: "eq", value: 42 }],
    });
    expect(result.success).toBe(true);
  });

  test("config schema defaults mode to all", () => {
    const result = executor.configSchema.parse({
      conditions: [{ field: "x", op: "eq", value: 1 }],
    });
    expect(result.mode).toBe("all");
  });

  test("returns true port when all conditions pass (mode=all)", async () => {
    const result = await executor.run(
      input(
        {
          conditions: [
            { field: "a", op: "eq", value: 1 },
            { field: "b", op: "gt", value: 0 },
          ],
        },
        { a: 1, b: 5 },
      ),
    );
    expect(result.status).toBe("success");
    expect(result.nextPort).toBe("true");
    const out = result.output as { passed: boolean };
    expect(out.passed).toBe(true);
  });

  test("returns false port when one condition fails (mode=all)", async () => {
    const result = await executor.run(
      input(
        {
          conditions: [
            { field: "a", op: "eq", value: 1 },
            { field: "b", op: "eq", value: 999 },
          ],
        },
        { a: 1, b: 5 },
      ),
    );
    expect(result.nextPort).toBe("false");
  });

  test("returns true port when one condition passes (mode=any)", async () => {
    const result = await executor.run(
      input(
        {
          conditions: [
            { field: "a", op: "eq", value: 999 },
            { field: "b", op: "eq", value: 5 },
          ],
          mode: "any",
        },
        { a: 1, b: 5 },
      ),
    );
    expect(result.nextPort).toBe("true");
  });

  test("resolves nested dot-path fields", async () => {
    const result = await executor.run(
      input(
        { conditions: [{ field: "data.nested.value", op: "eq", value: "hello" }] },
        { data: { nested: { value: "hello" } } },
      ),
    );
    expect(result.nextPort).toBe("true");
  });

  test("contains operator works on strings", async () => {
    const result = await executor.run(
      input(
        { conditions: [{ field: "msg", op: "contains", value: "world" }] },
        { msg: "hello world" },
      ),
    );
    expect(result.nextPort).toBe("true");
  });

  test("exists operator returns true for defined value", async () => {
    const result = await executor.run(
      input({ conditions: [{ field: "x", op: "exists" }] }, { x: 0 }),
    );
    expect(result.nextPort).toBe("true");
  });

  test("exists operator returns false for undefined value", async () => {
    const result = await executor.run(
      input({ conditions: [{ field: "missing", op: "exists" }] }, {}),
    );
    expect(result.nextPort).toBe("false");
  });

  test("output schema validates correctly", () => {
    const valid = PropertyMatchOutputSchema.safeParse({
      passed: true,
      results: [{ field: "x", op: "eq", expected: 1, actual: 1, passed: true }],
    });
    expect(valid.success).toBe(true);
  });
});

// ─── CodeMatch Executor ──────────────────────────────────────

describe("CodeMatchExecutor", () => {
  const executor = new CodeMatchExecutor(mockDeps);

  test("config schema rejects empty outputPorts", () => {
    const result = executor.configSchema.safeParse({ code: "return true", outputPorts: [] });
    expect(result.success).toBe(false);
  });

  test("config schema rejects missing code", () => {
    const result = executor.configSchema.safeParse({ outputPorts: ["a"] });
    expect(result.success).toBe(false);
  });

  test("config schema accepts valid config", () => {
    const result = executor.configSchema.safeParse({
      code: "(input) => true",
      outputPorts: ["true", "false"],
    });
    expect(result.success).toBe(true);
  });

  test("executes code and returns port", async () => {
    const result = await executor.run(
      input(
        { code: "(input) => input.value > 10 ? 'high' : 'low'", outputPorts: ["high", "low"] },
        { value: 42 },
      ),
    );
    expect(result.status).toBe("success");
    expect(result.nextPort).toBe("high");
    const out = result.output as { port: string };
    expect(out.port).toBe("high");
  });

  test("maps boolean result to true/false port", async () => {
    const result = await executor.run(
      input({ code: "(input) => input.x === 1", outputPorts: ["true", "false"] }, { x: 1 }),
    );
    expect(result.nextPort).toBe("true");
  });

  test("fails when returned port not in outputPorts", async () => {
    const result = await executor.run(
      input({ code: "(input) => 'unknown'", outputPorts: ["a", "b"] }, {}),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("not in outputPorts");
  });

  test("fails on code execution error", async () => {
    const result = await executor.run(
      input({ code: "(input) => { throw new Error('boom') }", outputPorts: ["a"] }, {}),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("boom");
  });

  test("sandboxes dangerous globals: process is undefined", async () => {
    const result = await executor.run(
      input(
        {
          code: "(input) => typeof process === 'undefined' ? 'safe' : 'unsafe'",
          outputPorts: ["safe", "unsafe"],
        },
        {},
      ),
    );
    expect(result.nextPort).toBe("safe");
  });

  test("sandboxes dangerous globals: Bun is undefined", async () => {
    const result = await executor.run(
      input(
        {
          code: "(input) => typeof Bun === 'undefined' ? 'safe' : 'unsafe'",
          outputPorts: ["safe", "unsafe"],
        },
        {},
      ),
    );
    expect(result.nextPort).toBe("safe");
  });

  test("sandboxes dangerous globals: require is undefined", async () => {
    const result = await executor.run(
      input(
        {
          code: "(input) => typeof require === 'undefined' ? 'safe' : 'unsafe'",
          outputPorts: ["safe", "unsafe"],
        },
        {},
      ),
    );
    expect(result.nextPort).toBe("safe");
  });

  test("sandboxes dangerous globals: fetch is undefined", async () => {
    const result = await executor.run(
      input(
        {
          code: "(input) => typeof fetch === 'undefined' ? 'safe' : 'unsafe'",
          outputPorts: ["safe", "unsafe"],
        },
        {},
      ),
    );
    expect(result.nextPort).toBe("safe");
  });

  test("output schema validates correctly", () => {
    const valid = CodeMatchOutputSchema.safeParse({ port: "high", rawResult: "high" });
    expect(valid.success).toBe(true);
  });
});

// ─── Notify Executor ─────────────────────────────────────────

describe("NotifyExecutor", () => {
  const executor = new NotifyExecutor(mockDeps);

  test("config schema rejects invalid channel", () => {
    const result = executor.configSchema.safeParse({
      channel: "invalid",
      template: "hi",
    });
    expect(result.success).toBe(false);
  });

  test("config schema accepts valid config", () => {
    const result = executor.configSchema.safeParse({
      channel: "swarm",
      template: "hello {{name}}",
    });
    expect(result.success).toBe(true);
  });

  test("swarm channel posts message when target is set", async () => {
    postedMessages.length = 0;
    const result = await executor.run(
      input({ channel: "swarm", target: "channel-1", template: "Hello {{who}}" }, { who: "world" }),
    );
    expect(result.status).toBe("success");
    const out = result.output as { sent: boolean; message: string };
    expect(out.sent).toBe(true);
    expect(out.message).toBe("Hello world");
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].channelId).toBe("channel-1");
  });

  test("swarm channel returns sent=false when no target", async () => {
    const result = await executor.run(input({ channel: "swarm", template: "no target" }, {}));
    const out = result.output as { sent: boolean };
    expect(out.sent).toBe(false);
  });

  test("slack stub returns sent=false", async () => {
    const result = await executor.run(
      input({ channel: "slack", target: "#general", template: "hi" }, {}),
    );
    expect(result.status).toBe("success");
    const out = result.output as { sent: boolean };
    expect(out.sent).toBe(false);
  });

  test("email stub returns sent=false", async () => {
    const result = await executor.run(
      input({ channel: "email", target: "user@test.com", template: "hi" }, {}),
    );
    const out = result.output as { sent: boolean };
    expect(out.sent).toBe(false);
  });
});

// ─── RawLlm Executor ────────────────────────────────────────

describe("RawLlmExecutor", () => {
  const executor = new RawLlmExecutor(mockDeps);

  test("config schema rejects missing prompt", () => {
    const result = executor.configSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("config schema accepts valid config with prompt only", () => {
    const result = executor.configSchema.safeParse({ prompt: "classify this" });
    expect(result.success).toBe(true);
  });

  test("config schema accepts full config", () => {
    const result = executor.configSchema.safeParse({
      prompt: "classify",
      model: "openai/gpt-4o",
      schema: { type: "object", properties: { category: { type: "string" } } },
      fallbackPort: "error",
    });
    expect(result.success).toBe(true);
  });

  // LLM integration tests — behavior depends on whether OPENROUTER_API_KEY is set
  test("handles LLM call (success or fallback)", async () => {
    const result = await executor.run(input({ prompt: "Say hello", fallbackPort: "error" }, {}));
    // Either the LLM call succeeds or falls back
    expect(result.status).toBe("success");
    if (result.nextPort === "error") {
      // Fallback path — LLM call failed (no API key or network error)
      expect(result.error).toContain("fallback");
    } else {
      // Success path — LLM returned a result
      const out = result.output as { result: unknown; model: string };
      expect(out.model).toBeDefined();
      expect(out.result).toBeDefined();
    }
  });

  test("handles LLM call without fallback (success or failure)", async () => {
    const result = await executor.run(input({ prompt: "Say hello" }, {}));
    // Either the LLM call succeeds or fails
    if (result.status === "failed") {
      expect(result.error).toContain("LLM call failed");
    } else {
      expect(result.status).toBe("success");
      const out = result.output as { result: unknown; model: string };
      expect(out.result).toBeDefined();
    }
  });
});

// ─── Script Executor ─────────────────────────────────────────

describe("ScriptExecutor", () => {
  const executor = new ScriptExecutor(mockDeps);

  test("config schema rejects missing runtime", () => {
    const result = executor.configSchema.safeParse({ script: "echo hi" });
    expect(result.success).toBe(false);
  });

  test("config schema rejects invalid runtime", () => {
    const result = executor.configSchema.safeParse({ runtime: "ruby", script: "puts 'hi'" });
    expect(result.success).toBe(false);
  });

  test("config schema accepts valid config", () => {
    const result = executor.configSchema.safeParse({
      runtime: "bash",
      script: "echo hello",
    });
    expect(result.success).toBe(true);
  });

  test("config schema defaults timeout to 30000", () => {
    const result = executor.configSchema.parse({ runtime: "bash", script: "echo hi" });
    expect(result.timeout).toBe(30_000);
  });

  test("config schema accepts the 5m timeout ceiling and rejects larger values", () => {
    expect(
      executor.configSchema.safeParse({
        runtime: "bash",
        script: "echo hi",
        timeout: 300_000,
      }).success,
    ).toBe(true);
    expect(
      executor.configSchema.safeParse({
        runtime: "bash",
        script: "echo hi",
        timeout: 300_001,
      }).success,
    ).toBe(false);
  });

  test("runs bash script and captures stdout", async () => {
    const result = await executor.run(input({ runtime: "bash", script: "echo 'hello world'" }, {}));
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string; stderr: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("hello world");
    expect(out.stderr).toBe("");
    expect(result.nextPort).toBe("success");
  });

  test("marks step failed and captures stderr on non-zero exit", async () => {
    const result = await executor.run(
      input({ runtime: "bash", script: "echo err >&2; exit 1" }, {}),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("err");
    const out = result.output as { exitCode: number; stdout: string; stderr: string };
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe("err");
  });

  test("marks step failed on non-zero exit code (exit 1)", async () => {
    const result = await executor.run(input({ runtime: "bash", script: "exit 1" }, {}));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Script exited with code 1");
    const out = result.output as { exitCode: number };
    expect(out?.exitCode).toBe(1);
  });

  test("marks step failed with exit code in error when no stderr (exit 42)", async () => {
    const result = await executor.run(input({ runtime: "bash", script: "exit 42" }, {}));
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Script exited with code 42");
    const out = result.output as { exitCode: number };
    expect(out?.exitCode).toBe(42);
  });

  test("runs TypeScript script via bun", async () => {
    const result = await executor.run(
      input({ runtime: "ts", script: "console.log('ts works')" }, {}),
    );
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("ts works");
  });

  test("output schema validates correctly", () => {
    const valid = ScriptOutputSchema.safeParse({ exitCode: 0, stdout: "hi", stderr: "" });
    expect(valid.success).toBe(true);
  });

  test("keeps raw {exitCode, stdout, stderr} when stdout is not valid JSON", async () => {
    const result = await executor.run(
      input({ runtime: "bash", script: "echo 'not-json {at all'" }, {}),
    );
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string; stderr: string } & {
      parsed?: unknown;
    };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("not-json {at all");
    expect(out.stderr).toBe("");
    // No parsed key merged in — only the raw three fields are present.
    expect(Object.keys(out).sort()).toEqual(["exitCode", "stderr", "stdout"]);
  });

  test("populates structured output on timeout instead of leaving it null", async () => {
    const result = await executor.run(
      input({ runtime: "bash", script: "sleep 5", timeout: 1000 }, {}),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Script timed out after 1000ms");
    const out = result.output as { exitCode: number; stdout: string; stderr: string };
    expect(out).toBeDefined();
    expect(out.exitCode).toBe(-1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Script timed out after 1000ms");
  });

  test("a timed-out script is TERMINATED, not just abandoned (Promise.race regression)", async () => {
    // A `sleep` is not bounded by the CPU ulimit, so before this fix the
    // wall-clock timeout only abandoned the promise and the child kept
    // running — long enough to finish its side effect after the step failed.
    const dir = `${process.env.TMPDIR ?? "/tmp"}/script-kill-${crypto.randomUUID()}`;
    await Bun.$`mkdir -p ${dir}`;
    const marker = `${dir}/still-alive`;
    try {
      const startedAt = Date.now();
      const result = await executor.run(
        input({ runtime: "bash", script: `sleep 6; touch ${marker}`, timeout: 1000, cwd: dir }, {}),
      );
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Script timed out after 1000ms");
      // The executor must not return until the child has actually been reaped.
      expect(Date.now() - startedAt).toBeLessThan(6_000);

      // Wait past when the abandoned child would have created its marker.
      await Bun.sleep(6_500);
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await Bun.$`rm -rf ${dir}`.catch(() => {});
    }
  }, 20_000);

  // ─── Sandbox regression tests (superagent.sh c27edfd7, finding b132d7c5) ──

  test("child process never inherits the server's secrets — env is scrubbed, not passed through", async () => {
    const savedKey = process.env.AGENT_SWARM_API_KEY;
    process.env.AGENT_SWARM_API_KEY = "super-secret-operator-bearer";
    process.env.SOME_OTHER_SERVER_SECRET = "also-should-not-leak";
    try {
      const result = await executor.run(
        input(
          {
            runtime: "bash",
            script: 'printf \'[%s][%s]\' "$AGENT_SWARM_API_KEY" "$SOME_OTHER_SERVER_SECRET"',
          },
          {},
        ),
      );
      expect(result.status).toBe("success");
      const out = result.output as { stdout: string };
      // Neither var exists in the child's env at all — bash prints empty strings.
      expect(out.stdout).toBe("[][]");
    } finally {
      if (savedKey === undefined) delete process.env.AGENT_SWARM_API_KEY;
      else process.env.AGENT_SWARM_API_KEY = savedKey;
      delete process.env.SOME_OTHER_SERVER_SECRET;
    }
  });

  test("resource ulimits actually apply to the spawned process (not just documented)", async () => {
    const result = await executor.run(input({ runtime: "bash", script: "ulimit -v" }, {}));
    expect(result.status).toBe("success");
    const out = result.output as { stdout: string };
    // "unlimited" means no cap took effect; any other value is a real (finite) ulimit.
    expect(out.stdout).not.toBe("unlimited");
    expect(Number(out.stdout)).toBeGreaterThan(0);
  });

  test("no explicit cwd: runs in a scoped tmpdir, not the server's working directory", async () => {
    const result = await executor.run(input({ runtime: "bash", script: "pwd" }, {}));
    expect(result.status).toBe("success");
    const out = result.output as { stdout: string };
    expect(out.stdout).not.toBe(process.cwd());
    expect(out.stdout).toContain("workflow-script-");
  });

  // ─── Codex review follow-ups (PR #1112, review 4876200033) ──────────────

  test("truncated stdout carries an explicit marker instead of silently presenting a partial result as complete (PRRT_kwDOQr3Tmc6XCRu1)", async () => {
    const result = await executor.run(
      input({ runtime: "bash", script: "head -c 2000000 /dev/zero | tr '\\0' 'a'" }, {}),
    );
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("…[stdout truncated]");
    // Capped at MAX_OUTPUT_BYTES (1 MiB), well short of the 2,000,000 'a's emitted.
    expect(out.stdout.length).toBeGreaterThan(1_000_000);
    expect(out.stdout.length).toBeLessThan(1_100_000);
  });

  test("drain-deadline snapshot keeps the partial output already read instead of discarding it as empty (PRRT_kwDOQr3Tmc6XCRuy)", async () => {
    // The direct child prints known output, backgrounds a descendant that
    // inherits its stdout pipe, then exits. `proc.exited` resolves
    // immediately, but the descendant keeps the pipe's write end open past
    // STREAM_DRAIN_GRACE_MS (5s) — the exact "successful script + surviving
    // descendant holding the pipe" scenario the review comment described.
    const result = await executor.run(
      input({ runtime: "bash", script: "printf 'kept-output'; sleep 8 & disown; exit 0" }, {}),
    );
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    // The bytes read before the deadline fired must survive — not an empty string.
    expect(out.stdout).toContain("kept-output");
    expect(out.stdout).toContain("…[stdout truncated]");
  }, 10_000);

  // ─── argv-injection regression (Codex review, PR #1112 comment 3732205426,
  // thread PRRT_kwDOQr3Tmc6XH7VS) ───────────────────────────────────────
  //
  // engine.ts's interpolateNodeConfig deliberately routes dynamic/untrusted
  // per-run values (webhook trigger.*, upstream node stdout) into `args`
  // rather than the script body, on the stated assumption that args are
  // "passed as separate argv elements (data), not spliced into source text."
  // That assumption held for bash -c and python3 -c (both stop option
  // parsing after the -c operand — confirmed empirically below) but NOT for
  // `bun -e`, which kept parsing recognized flags out of trailing argv and
  // running them: an interpolated arg literally named `--eval=<code>` was a
  // second, attacker-controlled script.

  test("bun runtime: an arg shaped like --eval=<code> is inert data, not executed", async () => {
    const result = await executor.run(
      input(
        {
          runtime: "ts",
          script: "console.log(JSON.stringify(process.argv.slice(1)))",
          args: ["--eval=console.log('INJECTED')"],
        },
        {},
      ),
    );
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    // If `--eval=...` had executed as a second script, its own console.log
    // would print "INJECTED" on its own line BEFORE the JSON.stringify line
    // below runs, making stdout two lines and JSON.parse fail outright.
    // A single clean JSON array — the literal string, unexecuted — is proof.
    expect(JSON.parse(out.stdout)).toEqual(["--eval=console.log('INJECTED')"]);
  });

  test("bun runtime: an arg shaped like --preload=<path> is inert data, not loaded", async () => {
    const result = await executor.run(
      input(
        {
          runtime: "ts",
          script: "console.log(JSON.stringify(process.argv.slice(1)))",
          args: ["--preload=/tmp/should-not-be-loaded-as-a-module.js", "-r"],
        },
        {},
      ),
    );
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string };
    // A real --preload would fail the process (module not found) before this
    // script body ever ran — success + the literal args back is proof both
    // "flags" were treated as plain strings.
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual([
      "--preload=/tmp/should-not-be-loaded-as-a-module.js",
      "-r",
    ]);
  });

  test("bun runtime: normal args keep their previous argv indexing after the -- fix", async () => {
    const result = await executor.run(
      input(
        {
          runtime: "ts",
          script: "console.log(JSON.stringify(process.argv.slice(1)))",
          args: ["hello", "world"],
        },
        {},
      ),
    );
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string };
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(["hello", "world"]);
  });

  test("bash runtime: an arg shaped like --eval=<code> was already inert (documents why -- is not added)", async () => {
    // bash -c script [$0 [$1 ...]] binds the first trailing arg to $0, not to
    // an option — there is no flag-reparsing surface to close here, and
    // adding `--` would shift $0 into args[0], breaking existing workflows.
    const result = await executor.run(
      input(
        {
          runtime: "bash",
          script: 'printf \'[%s][%s]\' "$0" "$1"',
          args: ["--eval=INJECTED", "second"],
        },
        {},
      ),
    );
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string };
    expect(out.stdout).toBe("[--eval=INJECTED][second]");
  });

  test("python runtime: an arg shaped like -c <code> was already inert (documents why -- is not added)", async () => {
    // python3 -c code also stops option parsing after the -c operand —
    // trailing args (even another literal -c) land verbatim in sys.argv.
    const result = await executor.run(
      input(
        {
          runtime: "python",
          script: "import sys; print(sys.argv[1:])",
          args: ["-c", "print('INJECTED')"],
        },
        {},
      ),
    );
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string };
    // Both trailing args land verbatim in sys.argv as data — if `-c
    // "print('INJECTED')"` had been re-parsed as a second -c invocation, its
    // print would appear as a separate line rather than inside this repr.
    expect(out.stdout).toBe("['-c', \"print('INJECTED')\"]");
  });
});

// ─── VCS Executor ────────────────────────────────────────────

describe("VcsExecutor", () => {
  const executor = new VcsExecutor(mockDeps);

  test("config schema rejects invalid action", () => {
    const result = executor.configSchema.safeParse({
      action: "delete-repo",
      provider: "github",
      repo: "owner/repo",
    });
    expect(result.success).toBe(false);
  });

  test("config schema rejects invalid provider", () => {
    const result = executor.configSchema.safeParse({
      action: "create-issue",
      provider: "bitbucket",
      repo: "owner/repo",
    });
    expect(result.success).toBe(false);
  });

  test("config schema accepts valid config", () => {
    const result = executor.configSchema.safeParse({
      action: "create-issue",
      provider: "github",
      repo: "owner/repo",
      title: "Bug report",
      body: "Something broke",
    });
    expect(result.success).toBe(true);
  });

  test("returns stub output with url and id", async () => {
    const result = await executor.run(
      input({ action: "create-issue", provider: "github", repo: "org/repo", title: "Test" }, {}),
    );
    expect(result.status).toBe("success");
    const out = result.output as { url: string; id: string };
    expect(out.url).toContain("github.com");
    expect(out.url).toContain("org/repo");
    expect(out.id).toContain("stub-");
  });

  test("interpolates title and body from context", async () => {
    const result = await executor.run(
      input(
        {
          action: "create-pr",
          provider: "github",
          repo: "org/repo",
          title: "PR: {{task}}",
          body: "Details: {{details}}",
        },
        { task: "fix bug", details: "memory leak" },
      ),
    );
    expect(result.status).toBe("success");
  });

  test("output schema validates correctly", () => {
    const valid = VcsOutputSchema.safeParse({ url: "https://github.com/x/y/1", id: "123" });
    expect(valid.success).toBe(true);

    const validNumeric = VcsOutputSchema.safeParse({ url: "https://github.com/x/y/1", id: 123 });
    expect(validNumeric.success).toBe(true);
  });
});

// ─── Validate Executor ───────────────────────────────────────

describe("ValidateExecutor", () => {
  const executor = new ValidateExecutor(mockDeps);

  test("config schema rejects missing targetNodeId", () => {
    const result = executor.configSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("config schema accepts targetNodeId only", () => {
    const result = executor.configSchema.safeParse({ targetNodeId: "step1" });
    expect(result.success).toBe(true);
  });

  test("config schema accepts full config", () => {
    const result = executor.configSchema.safeParse({
      targetNodeId: "step1",
      prompt: "Is the output valid?",
      schema: { type: "object", properties: { name: { type: "string" } } },
    });
    expect(result.success).toBe(true);
  });

  test("fails when target node has no output", async () => {
    const result = await executor.run(input({ targetNodeId: "missing" }, {}));
    expect(result.status).toBe("success");
    expect(result.nextPort).toBe("fail");
    const out = result.output as { pass: boolean; reasoning: string };
    expect(out.pass).toBe(false);
    expect(out.reasoning).toContain("no output");
  });

  test("passes when target node exists and no criteria given", async () => {
    const result = await executor.run(
      input({ targetNodeId: "step1" }, { step1: { data: "something" } }),
    );
    expect(result.status).toBe("success");
    expect(result.nextPort).toBe("pass");
  });

  test("schema validation passes for matching data", async () => {
    const result = await executor.run(
      input(
        {
          targetNodeId: "step1",
          schema: {
            type: "object",
            properties: { stdout: { const: "good-data" } },
          },
        },
        { step1: { stdout: "good-data" } },
      ),
    );
    expect(result.nextPort).toBe("pass");
  });

  test("schema validation fails for non-matching data", async () => {
    const result = await executor.run(
      input(
        {
          targetNodeId: "step1",
          schema: {
            type: "object",
            properties: { stdout: { const: "good-data" } },
          },
        },
        { step1: { stdout: "bad-data" } },
      ),
    );
    expect(result.nextPort).toBe("fail");
    const out = result.output as { pass: boolean; reasoning: string };
    expect(out.pass).toBe(false);
    expect(out.reasoning).toContain("Schema validation failed");
  });

  test("schema validation checks type", async () => {
    const result = await executor.run(
      input({ targetNodeId: "step1", schema: { type: "string" } }, { step1: 42 }),
    );
    expect(result.nextPort).toBe("fail");
  });

  test("schema validation checks required properties", async () => {
    const result = await executor.run(
      input(
        {
          targetNodeId: "step1",
          schema: { type: "object", required: ["name", "age"] },
        },
        { step1: { name: "Alice" } },
      ),
    );
    expect(result.nextPort).toBe("fail");
    const out = result.output as { reasoning: string };
    expect(out.reasoning).toContain("age");
  });

  test("output schema validates correctly", () => {
    const valid = ValidateOutputSchema.safeParse({
      pass: true,
      reasoning: "Looks good",
      confidence: 0.95,
    });
    expect(valid.success).toBe(true);

    const invalid = ValidateOutputSchema.safeParse({
      pass: true,
      reasoning: "Looks good",
      confidence: 1.5, // Out of range
    });
    expect(invalid.success).toBe(false);
  });
});

// ─── Registry Wiring ─────────────────────────────────────────

describe("createExecutorRegistry", () => {
  test("registers all 12 executors (8 instant + 4 async)", () => {
    const registry = createExecutorRegistry(mockDeps);
    const types = registry.types();

    expect(types).toContain("property-match");
    expect(types).toContain("code-match");
    expect(types).toContain("notify");
    expect(types).toContain("raw-llm");
    expect(types).toContain("script");
    expect(types).toContain("swarm-script");
    expect(types).toContain("vcs");
    expect(types).toContain("validate");
    expect(types).toContain("agent-task");
    expect(types).toContain("foreach");
    expect(types).toContain("human-in-the-loop");
    expect(types).toContain("wait");
    expect(types).toHaveLength(12);
  });

  test("instant executors have mode instant, async executors have mode async", () => {
    const registry = createExecutorRegistry(mockDeps);
    const instantTypes = [
      "property-match",
      "code-match",
      "notify",
      "raw-llm",
      "script",
      "swarm-script",
      "vcs",
      "validate",
    ];
    for (const type of instantTypes) {
      expect(registry.get(type).mode).toBe("instant");
    }
    expect(registry.get("agent-task").mode).toBe("async");
    expect(registry.get("foreach").mode).toBe("async");
    expect(registry.get("human-in-the-loop").mode).toBe("async");
    expect(registry.get("wait").mode).toBe("async");
  });

  test("get() retrieves the correct executor by type", () => {
    const registry = createExecutorRegistry(mockDeps);
    const pm = registry.get("property-match");
    expect(pm).toBeInstanceOf(PropertyMatchExecutor);

    const cm = registry.get("code-match");
    expect(cm).toBeInstanceOf(CodeMatchExecutor);

    const sc = registry.get("script");
    expect(sc).toBeInstanceOf(ScriptExecutor);
  });
});
