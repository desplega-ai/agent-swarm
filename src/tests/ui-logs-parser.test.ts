import { describe, expect, test } from "bun:test";
import {
  normalizeSessionLogs,
  parseSessionLogs,
  type SessionLogRecord,
  unwrapResult,
} from "../../ui/src/logs-parser";

function log(
  id: string,
  cli: string,
  lineNumber: number,
  content: unknown,
  createdAt = "2026-06-01T10:00:00.000Z",
): SessionLogRecord {
  return {
    id,
    taskId: "task-1",
    sessionId: "session-1",
    iteration: 1,
    cli,
    content: typeof content === "string" ? content : JSON.stringify(content),
    lineNumber,
    createdAt,
  };
}

describe("ui logs parser", () => {
  test("orders opencode deltas before reassembling streamed text", () => {
    const result = normalizeSessionLogs([
      log("delta-2", "opencode", 2, {
        type: "message.part.delta",
        properties: { partID: "part-1", delta: "world" },
      }),
      log("updated", "opencode", 3, {
        type: "message.part.updated",
        properties: { part: { id: "part-1", type: "text" } },
      }),
      log("delta-1", "opencode", 1, {
        type: "message.part.delta",
        properties: { partID: "part-1", delta: "Hello " },
      }),
    ]);

    expect(result.gate).toEqual({ total: 3, ok: 3, bad: 0, passed: true });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.kind).toBe("text");
    expect(result.items[0]?.text).toBe("Hello world");
    expect(result.items[0]?.recId).toBe("delta-1");
  });

  test("pairs codex started and completed tool events by item id", () => {
    const result = normalizeSessionLogs([
      log("start", "codex", 1, {
        type: "item.started",
        item: { id: "item-1", type: "command_execution", command: "pwd" },
      }),
      log("done", "codex", 2, {
        type: "item.completed",
        item: {
          id: "item-1",
          type: "command_execution",
          aggregated_output: "/tmp\n",
          exit_code: 0,
        },
      }),
    ]);

    expect(result.items.map((item) => item.kind)).toEqual(["tool_call", "tool_result"]);
    expect(result.pairing.paired).toBe(1);
    expect(result.pairing.orphanCalls).toEqual([]);
    expect(result.pairing.orphanResults).toEqual([]);
  });

  test("normalizes claude-managed raw SSE events without unknown noise", () => {
    const result = normalizeSessionLogs([
      log("status", "claude-managed", 1, {
        type: "session.status_running",
        id: "evt-running",
      }),
      log("message", "claude-managed", 2, {
        type: "agent.message",
        id: "evt-message",
        content: [{ type: "text", text: "Hello from managed agent" }],
      }),
      log("tool", "claude-managed", 3, {
        type: "agent.tool_use",
        id: "tool-1",
        name: "read_file",
        input: { path: "/etc/hosts" },
      }),
      log("result", "claude-managed", 4, {
        type: "agent.tool_result",
        id: "tool-result-1",
        tool_use_id: "tool-1",
        content: [{ type: "text", text: "127.0.0.1 localhost" }],
        is_error: false,
      }),
    ]);

    expect(result.items.map((item) => item.kind)).toEqual([
      "lifecycle",
      "text",
      "tool_call",
      "tool_result",
    ]);
    expect(result.items.some((item) => item.kind === "unknown")).toBe(false);
    expect(result.pairing.paired).toBe(1);
    expect(result.pairing.orphanCalls).toEqual([]);
    expect(result.pairing.orphanResults).toEqual([]);
  });

  test("keeps parse errors visible in the compatibility message output", () => {
    const messages = parseSessionLogs([log("bad", "claude", 1, "{not-json")]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content[0]).toEqual({
      type: "provider_meta",
      kind: "parse_error",
      provider: "claude",
      data: { raw: "{not-json" },
    });
  });

  test("classifies claude runtime noise as internal or helper metadata", () => {
    const messages = parseSessionLogs([
      log("rate", "claude", 1, {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1779202200 },
      }),
      log("think", "claude", 2, {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 150,
        estimated_tokens_delta: 100,
      }),
      log("hook", "claude", 3, {
        type: "system",
        subtype: "hook_response",
        hook_id: "hook-1",
        hook_event: "SessionStart",
        outcome: "success",
      }),
    ]);

    expect(messages.map((message) => message.content[0])).toEqual([
      expect.objectContaining({
        type: "provider_meta",
        kind: "internal",
        data: expect.objectContaining({ internalType: "rate_limit" }),
      }),
      expect.objectContaining({
        type: "provider_meta",
        kind: "helper",
        data: expect.objectContaining({ helperType: "thinking_tokens" }),
      }),
      expect.objectContaining({
        type: "provider_meta",
        kind: "internal",
        data: expect.objectContaining({ internalType: "hook" }),
      }),
    ]);
  });

  test("classifies codex and opencode lifecycle rows for shared rendering", () => {
    const codex = parseSessionLogs([
      log("turn", "codex", 1, {
        type: "turn.completed",
        usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10 },
      }),
    ]);
    const opencode = parseSessionLogs([
      log("context", "opencode", 1, {
        type: "context_usage",
        contextUsedTokens: 25_000,
        contextTotalTokens: 200_000,
        contextPercent: 12.5,
      }),
      log("session", "opencode", 2, {
        type: "session_init",
        sessionId: "ses_1",
        provider: "opencode",
      }),
      log("heartbeat", "opencode", 3, { type: "server.heartbeat", properties: {} }),
      log("connected", "opencode", 4, { type: "server.connected", properties: {} }),
      log("result", "opencode", 5, {
        type: "result",
        cost: { totalCostUsd: 0.12, inputTokens: 100, outputTokens: 20 },
        isError: false,
      }),
    ]);

    expect(codex[0]?.content[0]).toEqual(
      expect.objectContaining({
        type: "provider_meta",
        kind: "helper",
        data: expect.objectContaining({ helperType: "turn_usage" }),
      }),
    );
    expect(opencode.map((message) => message.content[0])).toEqual([
      expect.objectContaining({
        type: "provider_meta",
        kind: "helper",
        data: expect.objectContaining({ helperType: "context_usage" }),
      }),
      expect.objectContaining({
        type: "provider_meta",
        kind: "internal",
        data: expect.objectContaining({ internalType: "runtime" }),
      }),
      expect.objectContaining({ type: "provider_meta", kind: "result" }),
    ]);
  });

  test("keeps devin provider meta and transcript messages on the generic path", () => {
    const messages = parseSessionLogs([
      log("status", "devin", 1, {
        type: "system",
        message: { role: "system", content: "" },
        provider_meta: { provider: "devin", kind: "status", status: "running" },
      }),
      log("message", "devin", 2, {
        type: "assistant",
        message: { role: "assistant", content: "Devin update" },
      }),
    ]);

    expect(messages.map((message) => message.content[0])).toEqual([
      expect.objectContaining({
        type: "provider_meta",
        kind: "status",
        provider: "devin",
        data: expect.objectContaining({ status: "running" }),
      }),
      { type: "text", text: "Devin update" },
    ]);
  });

  test("unwraps prose followed by embedded JSON", () => {
    expect(unwrapResult('Created file\n\n{"ok":true,"path":"a.ts"}')).toEqual({
      prose: "Created file",
      json: { ok: true, path: "a.ts" },
    });
  });

  test("unwraps pi tool result content text wrappers", () => {
    const messages = parseSessionLogs([
      log("pi-result", "pi", 1, {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "functions.memory-get:1",
              content: JSON.stringify({
                content: [{ type: "text", text: 'Memory retrieved.\n\n{"ok":true}' }],
              }),
            },
          ],
        },
      }),
    ]);

    expect(messages[0]?.content[0]).toEqual(
      expect.objectContaining({
        type: "tool_result",
        content: 'Memory retrieved.\n\n{\n  "ok": true\n}',
      }),
    );
  });
});
