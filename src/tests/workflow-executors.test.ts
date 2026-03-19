import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
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

  test("runs bash script and captures stdout", async () => {
    const result = await executor.run(input({ runtime: "bash", script: "echo 'hello world'" }, {}));
    expect(result.status).toBe("success");
    const out = result.output as { exitCode: number; stdout: string; stderr: string };
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("hello world");
    expect(out.stderr).toBe("");
    expect(result.nextPort).toBe("success");
  });

  test("captures stderr on failure", async () => {
    const result = await executor.run(
      input({ runtime: "bash", script: "echo err >&2; exit 1" }, {}),
    );
    expect(result.status).toBe("success"); // executor succeeds, script fails
    const out = result.output as { exitCode: number; stdout: string; stderr: string };
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe("err");
    expect(result.nextPort).toBe("failure");
  });

  test("returns failure port on non-zero exit code", async () => {
    const result = await executor.run(input({ runtime: "bash", script: "exit 42" }, {}));
    expect(result.nextPort).toBe("failure");
    const out = result.output as { exitCode: number };
    expect(out.exitCode).toBe(42);
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
  test("registers all 8 executors (7 instant + 1 async)", () => {
    const registry = createExecutorRegistry(mockDeps);
    const types = registry.types();

    expect(types).toContain("property-match");
    expect(types).toContain("code-match");
    expect(types).toContain("notify");
    expect(types).toContain("raw-llm");
    expect(types).toContain("script");
    expect(types).toContain("vcs");
    expect(types).toContain("validate");
    expect(types).toContain("agent-task");
    expect(types).toHaveLength(8);
  });

  test("instant executors have mode instant, async executors have mode async", () => {
    const registry = createExecutorRegistry(mockDeps);
    const instantTypes = [
      "property-match",
      "code-match",
      "notify",
      "raw-llm",
      "script",
      "vcs",
      "validate",
    ];
    for (const type of instantTypes) {
      expect(registry.get(type).mode).toBe("instant");
    }
    expect(registry.get("agent-task").mode).toBe("async");
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
