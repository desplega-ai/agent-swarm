import { describe, expect, test } from "bun:test";
import { itemsToParsedMessages, normalizeSessionLogs } from "../ui/src/logs-parser/index.ts";
import type { SessionLogRecord, ToolUseBlock } from "../ui/src/logs-parser/types.ts";

function row(content: unknown, cli: string, i: number): SessionLogRecord {
  return {
    id: `r${i}`,
    taskId: "task-1",
    sessionId: "session-1",
    iteration: 0,
    cli,
    content: typeof content === "string" ? content : JSON.stringify(content),
    lineNumber: i,
    createdAt: `2026-07-01T00:00:0${i}.000Z`,
  };
}

function toolBlocks(rows: SessionLogRecord[]): ToolUseBlock[] {
  return itemsToParsedMessages(normalizeSessionLogs(rows).items).flatMap((message) =>
    message.content.filter((block): block is ToolUseBlock => block.type === "tool_use"),
  );
}

describe("UI logs-parser adapters", () => {
  test("opencode enriches tool_start with rich input from message.part.updated", () => {
    const tools = toolBlocks([
      row(
        { type: "tool_start", toolCallId: "call_1", toolName: "task_action", args: {} },
        "opencode",
        0,
      ),
      row(
        {
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
              },
            },
          },
        },
        "opencode",
        1,
      ),
      row(
        { type: "tool_end", toolCallId: "call_1", toolName: "task_action", result: "ok" },
        "opencode",
        2,
      ),
    ]);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.input).toEqual({
      action: "create",
      task: "Investigate Project Alpha",
    });
  });

  test("pi accepts alternate content/parts envelopes and argument aliases", () => {
    const tools = toolBlocks([
      row(
        {
          type: "assistant",
          parts: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "store_progress",
              arguments: { status: "completed" },
            },
          ],
        },
        "pi",
        0,
      ),
    ]);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("store_progress");
    expect(tools[0]?.input).toEqual({ status: "completed" });
  });
});
