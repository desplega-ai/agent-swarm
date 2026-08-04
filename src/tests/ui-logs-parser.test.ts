import { describe, expect, test } from "bun:test";
import {
  normalizeSessionLogs,
  parseSessionLogs,
  type SessionLogRecord,
  unwrapResult,
} from "../../apps/ui/src/logs-parser";

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
    expect(result.items[0]?.coveredRecIds).toEqual(["delta-2", "updated"]);
  });

  test("classifies the current opencode lifecycle vocabulary without unknown rows", () => {
    const types = [
      "message.updated",
      "session.status",
      "session.updated",
      "session.idle",
      "plugin.added",
      "catalog.updated",
      "reference.updated",
      "integration.updated",
      "todo.updated",
    ];
    const result = normalizeSessionLogs(
      types.map((type, index) =>
        log(`event-${index}`, "opencode", index + 1, {
          type,
          properties: { sessionID: "ses_1" },
        }),
      ),
    );

    expect(result.items).toHaveLength(types.length);
    expect(result.items.every((item) => item.kind === "lifecycle")).toBe(true);
    expect(result.items.some((item) => item.kind === "unknown")).toBe(false);
  });

  test("drops opencode server transport noise", () => {
    const result = normalizeSessionLogs([
      log("heartbeat", "opencode", 1, { type: "server.heartbeat", properties: {} }),
      log("connected", "opencode", 2, { type: "server.connected", properties: {} }),
      log("future-server", "opencode", 3, { type: "server.reconnected", properties: {} }),
    ]);

    expect(result.items).toEqual([]);
  });

  test("enriches opencode tool pairs from tool parts without orphaning calls", () => {
    const result = normalizeSessionLogs([
      log("tool-start", "opencode", 1, {
        type: "tool_start",
        toolCallId: "call_1",
        toolName: "tool",
        args: {},
      }),
      log("tool-pending", "opencode", 2, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_1",
            type: "tool",
            tool: "task_action",
            callID: "call_1",
            state: {
              status: "pending",
              input: { action: "create", task: "Investigate Project Alpha" },
            },
          },
        },
      }),
      log("tool-completed", "opencode", 3, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_1",
            type: "tool",
            tool: "task_action",
            callID: "call_1",
            state: {
              status: "completed",
              input: { action: "create", task: "Investigate Project Alpha" },
              output: "created",
            },
          },
        },
      }),
      log("tool-end", "opencode", 4, {
        type: "tool_end",
        toolCallId: "call_1",
        toolName: "tool",
        result: "created",
      }),
    ]);

    expect(result.items.map((item) => item.kind)).toEqual(["tool_call", "tool_result"]);
    expect(result.items[0]?.tool).toEqual({
      id: "call_1",
      name: "task_action",
      input: { action: "create", task: "Investigate Project Alpha" },
    });
    expect(result.items[0]?.coveredRecIds).toEqual(["tool-pending", "tool-completed"]);
    expect(result.items[1]?.result).toEqual({
      id: "call_1",
      payload: "created",
      isError: false,
    });
    expect(result.pairing).toEqual(
      expect.objectContaining({ paired: 1, orphanCalls: [], orphanResults: [] }),
    );
  });

  test("keeps malformed opencode deltas self-describing", () => {
    const messages = parseSessionLogs([
      log("bad-delta", "opencode", 1, {
        type: "message.part.delta",
        properties: { field: "text", delta: "orphaned" },
      }),
    ]);

    expect(messages[0]?.content[0]).toEqual(
      expect.objectContaining({
        type: "provider_meta",
        kind: "unknown",
        data: expect.objectContaining({
          type: "message.part.delta",
          eventType: "message.part.delta",
        }),
      }),
    );
  });

  test("normalizes opencode session diffs and file edits as file changes", () => {
    const result = normalizeSessionLogs([
      log("diff", "opencode", 1, {
        type: "session.diff",
        properties: { sessionID: "ses_1", diff: "@@ -1 +1 @@" },
      }),
      log("edited", "opencode", 2, {
        type: "file.edited",
        properties: { path: "src/index.ts" },
      }),
    ]);

    expect(result.items.map((item) => item.kind)).toEqual(["file_change", "file_change"]);
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

  test("pairs codex collaboration calls and surfaces collaboration state", () => {
    const result = normalizeSessionLogs([
      log("start", "codex", 1, {
        type: "item.started",
        item: {
          id: "item-60",
          type: "collab_tool_call",
          tool: "wait",
          prompt: "Wait for delegated work",
          receiver_thread_ids: ["thread-1"],
          agents_states: { "thread-1": "running" },
          status: "in_progress",
        },
      }),
      log("done", "codex", 2, {
        type: "item.completed",
        item: {
          id: "item-60",
          type: "collab_tool_call",
          tool: "wait",
          prompt: null,
          receiver_thread_ids: [],
          agents_states: {},
          status: "completed",
        },
      }),
    ]);

    expect(result.items.map((item) => item.kind)).toEqual(["tool_call", "tool_result"]);
    expect(result.items[0]?.tool).toEqual({
      id: "item-60",
      name: "wait",
      input: {
        prompt: "Wait for delegated work",
        receiver_thread_ids: ["thread-1"],
        agents_states: { "thread-1": "running" },
        status: "in_progress",
      },
    });
    expect(result.items[1]?.result?.payload).toEqual({
      prompt: null,
      receiver_thread_ids: [],
      agents_states: {},
      status: "completed",
    });
    expect(result.pairing.paired).toBe(1);
  });

  test("renders the live codex error item shape as a failed result", () => {
    const messages = parseSessionLogs([
      log("error", "codex", 1, {
        type: "item.completed",
        item: {
          id: "item_0",
          type: "error",
          message: "Skill descriptions were shortened to fit the 2% skills context budget.",
        },
      }),
    ]);

    expect(messages[0]?.content[0]).toEqual(
      expect.objectContaining({
        type: "provider_meta",
        kind: "result",
        provider: "codex",
        data: expect.objectContaining({
          type: "codex_error",
          output: "Skill descriptions were shortened to fit the 2% skills context budget.",
          isError: true,
        }),
      }),
    );
  });

  test("replaces codex todo snapshots on item.updated instead of appending rows", () => {
    const result = normalizeSessionLogs([
      log("start", "codex", 1, {
        type: "item.started",
        item: { id: "todo-1", type: "todo_list", items: [{ text: "First", completed: false }] },
      }),
      log("update", "codex", 2, {
        type: "item.updated",
        item: {
          id: "todo-1",
          type: "todo_list",
          items: [{ text: "First", completed: true }],
        },
      }),
      log("done", "codex", 3, {
        type: "item.completed",
        item: {
          id: "todo-1",
          type: "todo_list",
          items: [{ text: "First", completed: true }],
        },
      }),
    ]);

    expect(result.items.map((item) => item.kind)).toEqual(["tool_call", "tool_result"]);
    expect(result.items[0]?.tool?.input).toEqual(
      expect.objectContaining({ items: [{ text: "First", completed: true }] }),
    );
    expect(result.pairing).toEqual(
      expect.objectContaining({ paired: 1, orphanCalls: [], orphanResults: [] }),
    );
  });

  test("handles codex started web searches and intentionally waits for completed file diffs", () => {
    const result = normalizeSessionLogs([
      log("web-start", "codex", 1, {
        type: "item.started",
        item: { id: "web-1", type: "web_search", query: "agent swarm" },
      }),
      log("web-done", "codex", 2, {
        type: "item.completed",
        item: { id: "web-1", type: "web_search", query: "agent swarm", status: "completed" },
      }),
      log("file-start", "codex", 3, {
        type: "item.started",
        item: { id: "file-1", type: "file_change", changes: [] },
      }),
      log("file-done", "codex", 4, {
        type: "item.completed",
        item: { id: "file-1", type: "file_change", changes: [{ path: "a.ts" }] },
      }),
    ]);

    expect(result.items.map((item) => item.kind)).toEqual([
      "tool_call",
      "tool_result",
      "file_change",
    ]);
    expect(result.pairing.paired).toBe(1);
  });

  test("normalizes claude tool progress as a parent-linked heartbeat helper", () => {
    const messages = parseSessionLogs([
      log("progress", "claude", 1, {
        type: "tool_progress",
        tool_use_id: "toolu_01-heartbeat-9",
        tool_name: "Bash",
        parent_tool_use_id: "toolu_01",
        elapsed_time_seconds: 300,
        heartbeat: true,
        session_id: "session-1",
      }),
    ]);

    expect(messages[0]?.content[0]).toEqual(
      expect.objectContaining({
        type: "provider_meta",
        kind: "helper",
        data: expect.objectContaining({
          helperType: "tool_progress",
          toolName: "Bash",
          parentToolUseId: "toolu_01",
          elapsedSeconds: 300,
          heartbeat: true,
        }),
      }),
    );
  });

  test("renders stderr and raw_stderr as system lines across adapters", () => {
    const codex = normalizeSessionLogs([
      log("stderr", "codex", 1, {
        type: "stderr",
        content: "internal-ai: kind=openrouter callerTag=session-summary:codex\n",
      }),
    ]);
    const claude = normalizeSessionLogs([
      log("stderr", "claude", 1, { type: "raw_stderr", content: "claude warning\n" }),
    ]);
    const opencode = normalizeSessionLogs([
      log("stderr", "opencode", 1, {
        type: "raw_stderr",
        content: "[opencode] skill resolver warning\n",
      }),
    ]);

    expect([codex.items[0], claude.items[0], opencode.items[0]]).toEqual([
      expect.objectContaining({
        kind: "text",
        role: "system",
        text: "[stderr] internal-ai: kind=openrouter callerTag=session-summary:codex",
      }),
      expect.objectContaining({ kind: "text", role: "system", text: "[stderr] claude warning" }),
      expect.objectContaining({
        kind: "text",
        role: "system",
        text: "[stderr] [opencode] skill resolver warning",
      }),
    ]);
  });

  test("makes unknown top-level and nested codex event types self-describing", () => {
    const messages = parseSessionLogs([
      log("top", "codex", 1, { type: "future.event", value: 1 }),
      log("nested", "codex", 2, {
        type: "item.completed",
        item: { id: "future-1", type: "future_item" },
      }),
    ]);

    expect(messages.map((message) => message.content[0])).toEqual([
      expect.objectContaining({
        type: "provider_meta",
        kind: "unknown",
        data: expect.objectContaining({ type: "future.event", eventType: "future.event" }),
      }),
      expect.objectContaining({
        type: "provider_meta",
        kind: "unknown",
        data: expect.objectContaining({
          type: "item.completed · future_item",
          eventType: "item.completed",
          itemType: "future_item",
        }),
      }),
    ]);
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

  test("renders pi top-level assistant text through the anthropic adapter", () => {
    const messages = parseSessionLogs([
      log("pi-assistant", "pi", 1, {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Pi response" }] },
      }),
    ]);

    expect(messages[0]).toEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "Pi response" }],
      }),
    );
  });
});
