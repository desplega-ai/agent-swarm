import { describe, expect, test } from "bun:test";
import { createProviderAdapter } from "../providers";
import { ClaudeAdapter } from "../providers/claude-adapter";
import { PiMonoAdapter } from "../providers/pi-mono-adapter";
import type { CostData, ProviderEvent } from "../providers/types";

describe("createProviderAdapter", () => {
  test("returns ClaudeAdapter for 'claude'", () => {
    const adapter = createProviderAdapter("claude");
    expect(adapter).toBeInstanceOf(ClaudeAdapter);
    expect(adapter.name).toBe("claude");
  });

  test("returns PiMonoAdapter for 'pi'", () => {
    const adapter = createProviderAdapter("pi");
    expect(adapter).toBeInstanceOf(PiMonoAdapter);
    expect(adapter.name).toBe("pi");
  });

  test("throws for unknown provider", () => {
    expect(() => createProviderAdapter("unknown")).toThrow(
      'Unknown HARNESS_PROVIDER: "unknown". Supported: claude, pi, codex, devin, claude-managed',
    );
  });

  test("throws for empty string", () => {
    expect(() => createProviderAdapter("")).toThrow("Unknown HARNESS_PROVIDER");
  });
});

describe("ProviderEvent type narrowing", () => {
  test("session_init event has sessionId", () => {
    const event: ProviderEvent = { type: "session_init", sessionId: "abc-123" };
    if (event.type === "session_init") {
      expect(event.sessionId).toBe("abc-123");
    }
  });

  test("result event has cost data", () => {
    const cost: CostData = {
      sessionId: "sess-1",
      agentId: "agent-1",
      totalCostUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      durationMs: 5000,
      numTurns: 3,
      model: "opus",
      isError: false,
    };
    const event: ProviderEvent = { type: "result", cost, isError: false };
    if (event.type === "result") {
      expect(event.cost.totalCostUsd).toBe(0.05);
      expect(event.cost.inputTokens).toBe(1000);
      expect(event.cost.outputTokens).toBe(500);
    }
  });

  test("error event has message", () => {
    const event: ProviderEvent = { type: "error", message: "boom", category: "api_error" };
    if (event.type === "error") {
      expect(event.message).toBe("boom");
      expect(event.category).toBe("api_error");
    }
  });

  test("raw_log event has content string", () => {
    const event: ProviderEvent = { type: "raw_log", content: "some output" };
    if (event.type === "raw_log") {
      expect(event.content).toBe("some output");
    }
  });
});

describe("CostData shape", () => {
  test("matches expected API fields", () => {
    const cost: CostData = {
      sessionId: "sess-1",
      taskId: "task-1",
      agentId: "agent-1",
      totalCostUsd: 0.12,
      inputTokens: 2000,
      outputTokens: 1000,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
      durationMs: 10000,
      numTurns: 5,
      model: "claude-opus-4-20250514",
      isError: false,
    };

    // All required fields present
    expect(cost.sessionId).toBe("sess-1");
    expect(cost.taskId).toBe("task-1");
    expect(cost.agentId).toBe("agent-1");
    expect(cost.totalCostUsd).toBeGreaterThan(0);
    expect(cost.durationMs).toBeGreaterThanOrEqual(0);
    expect(cost.numTurns).toBeGreaterThan(0);
    expect(cost.model).toBeTruthy();
    expect(typeof cost.isError).toBe("boolean");
  });

  test("optional fields can be undefined", () => {
    const cost: CostData = {
      sessionId: "",
      agentId: "agent-1",
      totalCostUsd: 0,
      durationMs: 0,
      numTurns: 0,
      model: "opus",
      isError: false,
    };

    expect(cost.taskId).toBeUndefined();
    expect(cost.inputTokens).toBeUndefined();
    expect(cost.outputTokens).toBeUndefined();
    expect(cost.cacheReadTokens).toBeUndefined();
    expect(cost.cacheWriteTokens).toBeUndefined();
  });
});
