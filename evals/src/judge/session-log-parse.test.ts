import { describe, expect, it } from "bun:test";
import type { SessionLogRow } from "../swarm/client.ts";
import { parseToolUses, toolUseMatches } from "./session-log-parse.ts";

/** Build a minimal SessionLogRow around one JSONL `content` line. */
function row(content: string, overrides: Partial<SessionLogRow> = {}): SessionLogRow {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    taskId: overrides.taskId ?? "task-1",
    sessionId: overrides.sessionId ?? "sess-1",
    iteration: overrides.iteration ?? 0,
    cli: overrides.cli ?? "claude",
    content,
    lineNumber: overrides.lineNumber ?? 0,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

describe("parseToolUses — Claude stream-json", () => {
  it("extracts tool_use name + input and backfills isError from a later tool_result", () => {
    const rows: SessionLogRow[] = [
      // assistant turn with two tool_use blocks (one MCP, one Bash)
      row(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "let me check the tasks" },
              {
                type: "tool_use",
                id: "toolu_01",
                name: "mcp__agent-swarm__get-tasks",
                input: { status: "completed" },
              },
              {
                type: "tool_use",
                id: "toolu_02",
                name: "Bash",
                input: { command: "ls /workspace" },
              },
            ],
          },
        }),
      ),
      // user turn carrying the tool_result for the Bash call — flagged error
      row(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_02",
                is_error: true,
                content: "no such dir",
              },
              { type: "tool_result", tool_use_id: "toolu_01", content: "[]" },
            ],
          },
        }),
      ),
    ];

    const uses = parseToolUses(rows);
    expect(uses).toHaveLength(2);

    const getTasks = uses.find((u) => u.toolName === "mcp__agent-swarm__get-tasks");
    expect(getTasks).toBeDefined();
    expect(getTasks?.input).toEqual({ status: "completed" });
    expect(getTasks?.isError).toBe(false);
    expect(getTasks?.taskId).toBe("task-1");

    const bash = uses.find((u) => u.toolName === "Bash");
    expect(bash?.input).toEqual({ command: "ls /workspace" });
    expect(bash?.isError).toBe(true);
  });

  it("leaves isError undefined when no tool_result line is present", () => {
    const uses = parseToolUses([
      row(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "Write", input: { path: "/x" } }],
          },
        }),
      ),
    ]);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.toolName).toBe("Write");
    expect(uses[0]?.isError).toBeUndefined();
  });
});

describe("parseToolUses — Codex raw_log ThreadEvents", () => {
  it("extracts command_execution / mcp_tool_call / web_search with error flags", () => {
    const rows: SessionLogRow[] = [
      // successful bash via item.completed
      row(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "c1",
            command: "cat report.md",
            status: "completed",
            exit_code: 0,
          },
        }),
        { cli: "codex" },
      ),
      // failed bash (non-zero exit)
      row(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            id: "c2",
            command: "grep missing file",
            status: "completed",
            exit_code: 2,
          },
        }),
        { cli: "codex" },
      ),
      // MCP tool call that failed
      row(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "mcp_tool_call",
            id: "m1",
            server: "agent-swarm",
            tool: "send-task",
            arguments: { agentId: "w1" },
            status: "failed",
          },
        }),
        { cli: "codex" },
      ),
      // web search via item.started
      row(
        JSON.stringify({
          type: "item.started",
          item: { type: "web_search", id: "w0", query: "swarm delegation" },
        }),
        { cli: "codex" },
      ),
    ];

    const uses = parseToolUses(rows);
    const names = uses.map((u) => u.toolName);
    expect(names).toContain("bash");
    expect(names).toContain("send-task");
    expect(names).toContain("WebSearch");

    const okBash = uses.find((u) => u.toolName === "bash" && !u.isError);
    expect(okBash?.input).toEqual({ command: "cat report.md" });

    const failBash = uses.find((u) => u.toolName === "bash" && u.isError);
    expect(failBash?.input).toEqual({ command: "grep missing file" });

    const send = uses.find((u) => u.toolName === "send-task");
    expect(send?.isError).toBe(true);
    expect(send?.input).toEqual({
      server: "agent-swarm",
      tool: "send-task",
      arguments: { agentId: "w1" },
    });
  });

  it("ignores non-tool codex items (agent_message, reasoning)", () => {
    const uses = parseToolUses([
      row(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", id: "a1", text: "done" },
        }),
        { cli: "codex" },
      ),
      row(JSON.stringify({ type: "item.completed", item: { type: "reasoning", id: "r1" } }), {
        cli: "codex",
      }),
    ]);
    expect(uses).toHaveLength(0);
  });
});

describe("parseToolUses — pi/opencode-style envelope", () => {
  it("extracts tool_use from a content array under message.content", () => {
    const uses = parseToolUses([
      row(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "p1", name: "get-tasks", input: { unassigned: true } },
            ],
          },
        }),
        { cli: "pi" },
      ),
    ]);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.toolName).toBe("get-tasks");
    expect(uses[0]?.input).toEqual({ unassigned: true });
  });
});

describe("parseToolUses — opencode native events", () => {
  it("dedupes a tool_start + part-update + tool_end triple into one ToolUse with rich input, isError=false", () => {
    // Real opencode shape: tool_start.args is empty; the rich input + terminal
    // status only show up on message.part.updated; tool_end carries no error.
    const rows: SessionLogRow[] = [
      row(
        JSON.stringify({
          type: "tool_start",
          toolCallId: "call_abc",
          toolName: "read",
          args: {},
        }),
        { cli: "opencode" },
      ),
      row(
        JSON.stringify({
          id: "evt_1",
          type: "message.part.updated",
          properties: {
            sessionID: "ses_1",
            part: {
              id: "prt_1",
              type: "tool",
              tool: "read",
              callID: "call_abc",
              state: { status: "running", input: { filePath: "/workspace/todos.md" } },
            },
          },
        }),
        { cli: "opencode" },
      ),
      row(
        JSON.stringify({
          id: "evt_2",
          type: "message.part.updated",
          properties: {
            sessionID: "ses_1",
            part: {
              id: "prt_1",
              type: "tool",
              tool: "read",
              callID: "call_abc",
              state: {
                status: "completed",
                input: { filePath: "/workspace/todos.md" },
                output: "<file contents>",
              },
            },
          },
        }),
        { cli: "opencode" },
      ),
      row(
        JSON.stringify({
          type: "tool_end",
          toolCallId: "call_abc",
          toolName: "read",
          result: "<file contents>",
        }),
        { cli: "opencode" },
      ),
    ];

    const uses = parseToolUses(rows);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.toolName).toBe("read");
    expect(uses[0]?.input).toEqual({ filePath: "/workspace/todos.md" });
    expect(uses[0]?.isError).toBe(false);
    expect(uses[0]?.taskId).toBe("task-1");
  });

  it("flags isError=true when a tool part reaches state.status === 'error'", () => {
    const rows: SessionLogRow[] = [
      row(
        JSON.stringify({
          type: "tool_start",
          toolCallId: "call_err",
          toolName: "swarm_get-task-details",
          args: {},
        }),
        { cli: "opencode" },
      ),
      row(
        JSON.stringify({
          type: "message.part.updated",
          properties: {
            sessionID: "ses_1",
            part: {
              type: "tool",
              tool: "swarm_get-task-details",
              callID: "call_err",
              state: {
                status: "error",
                input: { taskId: "dcca3f90" },
                error: "MCP error -32602: Invalid UUID",
              },
            },
          },
        }),
        { cli: "opencode" },
      ),
    ];

    const uses = parseToolUses(rows);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.toolName).toBe("swarm_get-task-details");
    expect(uses[0]?.input).toEqual({ taskId: "dcca3f90" });
    expect(uses[0]?.isError).toBe(true);
  });

  it("extracts from a lone tool_start (no part-update / tool_end) with empty input", () => {
    const uses = parseToolUses([
      row(
        JSON.stringify({ type: "tool_start", toolCallId: "call_x", toolName: "bash", args: {} }),
        { cli: "opencode" },
      ),
    ]);
    expect(uses).toHaveLength(1);
    expect(uses[0]?.toolName).toBe("bash");
    expect(uses[0]?.input).toEqual({});
    expect(uses[0]?.isError).toBeUndefined();
  });

  it("skips non-tool opencode lines (text part, step-start, delta, heartbeat) without throwing", () => {
    const rows: SessionLogRow[] = [
      row(
        JSON.stringify({
          type: "message.part.updated",
          properties: {
            sessionID: "ses_1",
            part: { type: "text", text: "/work-on-task ...", id: "prt_t" },
          },
        }),
        { cli: "opencode" },
      ),
      row(
        JSON.stringify({
          type: "message.part.updated",
          properties: { sessionID: "ses_1", part: { type: "step-start", id: "prt_s" } },
        }),
        { cli: "opencode" },
      ),
      row(JSON.stringify({ type: "message.part.delta", properties: {} }), { cli: "opencode" }),
      row(JSON.stringify({ type: "server.heartbeat" }), { cli: "opencode" }),
      row(JSON.stringify({ type: "tool_start", toolCallId: "c1" }), { cli: "opencode" }), // no toolName
      row("not json {{{", { cli: "opencode" }),
    ];
    expect(() => parseToolUses(rows)).not.toThrow();
    expect(parseToolUses(rows)).toHaveLength(0);
  });
});

describe("parseToolUses — robustness", () => {
  it("skips malformed / non-tool / empty lines without throwing", () => {
    const rows: SessionLogRow[] = [
      row("not json at all {{{"),
      row(""),
      row(JSON.stringify({ type: "system", subtype: "init" })),
      row(JSON.stringify({ type: "result", result: "ok", total_cost_usd: 0.01 })),
      row(JSON.stringify({ type: "assistant", message: { content: "plain string, no blocks" } })),
      row(JSON.stringify({ type: "assistant" })), // no message at all
      row(JSON.stringify(["array", "top-level"])),
      row(JSON.stringify({ type: "item.completed" })), // no item
    ];
    expect(() => parseToolUses(rows)).not.toThrow();
    expect(parseToolUses(rows)).toHaveLength(0);
  });
});

describe("toolUseMatches", () => {
  it("matches the bare swarm slug against the MCP-prefixed tool name and vice-versa", () => {
    expect(toolUseMatches("mcp__agent-swarm__send-task", ["send-task"])).toBe(true);
    expect(toolUseMatches("send-task", ["mcp__agent-swarm__send-task"])).toBe(false); // contains check is directional
    expect(toolUseMatches("mcp__agent-swarm__get-tasks", ["get-tasks", "send-task"])).toBe(true);
    expect(toolUseMatches("Bash", ["send-task"])).toBe(false);
  });

  it("supports RegExp patterns and is case-insensitive for strings", () => {
    expect(toolUseMatches("GET-TASKS", ["get-tasks"])).toBe(true);
    expect(toolUseMatches("mcp__agent-swarm__get-tasks", [/get-tasks$/])).toBe(true);
    expect(toolUseMatches("Write", [/^Edit$/])).toBe(false);
  });
});
