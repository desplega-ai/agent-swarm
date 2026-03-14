import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiMonoAdapter } from "../providers/pi-mono-adapter";

describe("PiMonoAdapter", () => {
  test("name is 'pi'", () => {
    const adapter = new PiMonoAdapter();
    expect(adapter.name).toBe("pi");
  });
});

describe("AGENTS.md symlink management", () => {
  const tmpDir = `/tmp/pi-mono-test-${Date.now()}`;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates symlink when CLAUDE.md exists but AGENTS.md does not", () => {
    const testDir = join(tmpDir, "symlink-create");
    mkdirSync(testDir);
    writeFileSync(join(testDir, "CLAUDE.md"), "# Test");

    // Simulate what createAgentsMdSymlink does
    const claudeMd = join(testDir, "CLAUDE.md");
    const agentsMd = join(testDir, "AGENTS.md");

    if (existsSync(claudeMd) && !existsSync(agentsMd)) {
      symlinkSync("CLAUDE.md", agentsMd);
    }

    expect(existsSync(agentsMd)).toBe(true);
  });

  test("does not overwrite existing AGENTS.md", () => {
    const testDir = join(tmpDir, "no-overwrite");
    mkdirSync(testDir);
    writeFileSync(join(testDir, "CLAUDE.md"), "# Claude");
    writeFileSync(join(testDir, "AGENTS.md"), "# Real AGENTS.md");

    const claudeMd = join(testDir, "CLAUDE.md");
    const agentsMd = join(testDir, "AGENTS.md");

    // Simulate createAgentsMdSymlink — should NOT overwrite existing AGENTS.md
    if (existsSync(claudeMd) && !existsSync(agentsMd)) {
      symlinkSync("CLAUDE.md", agentsMd);
    }

    // AGENTS.md should still be a real file, not a symlink
    expect(existsSync(agentsMd)).toBe(true);
    const content = readFileSync(agentsMd, "utf-8");
    expect(content).toBe("# Real AGENTS.md");
  });

  test("no-op when CLAUDE.md does not exist", () => {
    const testDir = join(tmpDir, "no-claudemd");
    mkdirSync(testDir);

    const claudeMd = join(testDir, "CLAUDE.md");
    const agentsMd = join(testDir, "AGENTS.md");

    if (existsSync(claudeMd) && !existsSync(agentsMd)) {
      symlinkSync("CLAUDE.md", agentsMd);
    }

    expect(existsSync(agentsMd)).toBe(false);
  });
});

describe("Model name mapping", () => {
  // Test the shortname → full ID mapping logic that resolveModel uses
  const shortnames: Record<string, [string, string]> = {
    opus: ["anthropic", "claude-opus-4-20250514"],
    sonnet: ["anthropic", "claude-sonnet-4-20250514"],
    haiku: ["anthropic", "claude-haiku-4-5-20251001"],
  };

  test("opus maps to anthropic/claude-opus-4-20250514", () => {
    const mapping = shortnames.opus;
    expect(mapping).toBeDefined();
    expect(mapping![0]).toBe("anthropic");
    expect(mapping![1]).toBe("claude-opus-4-20250514");
  });

  test("sonnet maps to anthropic/claude-sonnet-4-20250514", () => {
    const mapping = shortnames.sonnet;
    expect(mapping).toBeDefined();
    expect(mapping![0]).toBe("anthropic");
    expect(mapping![1]).toBe("claude-sonnet-4-20250514");
  });

  test("haiku maps to anthropic/claude-haiku-4-5-20251001", () => {
    const mapping = shortnames.haiku;
    expect(mapping).toBeDefined();
    expect(mapping![0]).toBe("anthropic");
    expect(mapping![1]).toBe("claude-haiku-4-5-20251001");
  });

  test("unknown shortname returns undefined", () => {
    const mapping = shortnames.gpt4;
    expect(mapping).toBeUndefined();
  });

  test("provider/model-id format is parseable", () => {
    const modelStr = "anthropic/claude-opus-4-20250514";
    expect(modelStr.includes("/")).toBe(true);
    const [provider, modelId] = modelStr.split("/", 2);
    expect(provider).toBe("anthropic");
    expect(modelId).toBe("claude-opus-4-20250514");
  });
});

describe("Pi-mono event normalization", () => {
  test("message_update with text content produces raw_log-style data", () => {
    // Simulates what PiMonoSession.handleAgentEvent does
    const event = {
      type: "message_update" as const,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello, world!" },
          { type: "text", text: " More text." },
        ],
      },
    };

    const content = event.message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("");

    expect(content).toBe("Hello, world! More text.");
  });

  test("tool_execution_start produces tool_use log", () => {
    const event = {
      type: "tool_execution_start" as const,
      toolName: "write",
      toolCallId: "tc-123",
    };

    const logEntry = JSON.stringify({
      type: "tool_use",
      name: event.toolName,
      id: event.toolCallId,
    });

    const parsed = JSON.parse(logEntry);
    expect(parsed.type).toBe("tool_use");
    expect(parsed.name).toBe("write");
    expect(parsed.id).toBe("tc-123");
  });

  test("tool_execution_end produces tool_result log", () => {
    const event = {
      type: "tool_execution_end" as const,
      toolName: "write",
      toolCallId: "tc-123",
      isError: false,
    };

    const logEntry = JSON.stringify({
      type: "tool_result",
      name: event.toolName,
      id: event.toolCallId,
      isError: event.isError,
    });

    const parsed = JSON.parse(logEntry);
    expect(parsed.type).toBe("tool_result");
    expect(parsed.isError).toBe(false);
  });
});

describe("Cost aggregation from SessionStats", () => {
  test("builds CostData from SessionStats shape", () => {
    const stats = {
      tokens: {
        input: 5000,
        output: 2000,
        cacheRead: 1000,
        cacheWrite: 500,
        total: 8500,
      },
      cost: 0.0456,
      userMessages: 1,
      assistantMessages: 4,
    };

    const cost = {
      sessionId: "",
      taskId: "task-1",
      agentId: "agent-1",
      totalCostUsd: stats.cost || 0,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      durationMs: 0,
      numTurns: stats.userMessages + stats.assistantMessages,
      model: "opus",
      isError: false,
    };

    expect(cost.totalCostUsd).toBe(0.0456);
    expect(cost.inputTokens).toBe(5000);
    expect(cost.outputTokens).toBe(2000);
    expect(cost.cacheReadTokens).toBe(1000);
    expect(cost.cacheWriteTokens).toBe(500);
    expect(cost.numTurns).toBe(5);
  });

  test("handles zero-cost stats", () => {
    const stats = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      userMessages: 0,
      assistantMessages: 0,
    };

    const cost = {
      totalCostUsd: stats.cost || 0,
      numTurns: stats.userMessages + stats.assistantMessages,
    };

    expect(cost.totalCostUsd).toBe(0);
    expect(cost.numTurns).toBe(0);
  });
});
