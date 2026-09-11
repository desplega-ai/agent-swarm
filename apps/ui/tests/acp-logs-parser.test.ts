import { describe, expect, test } from "bun:test";
import { normalizeSessionLogs as normalizeEvalLogs } from "../../evals/ui/src/logs-parser";
import { itemsToParsedMessages, normalizeSessionLogs } from "../src/logs-parser";
import type { SessionLogRecord } from "../src/logs-parser/types";
import fixture from "./fixtures/acp-beea63b7.json";

for (const [name, normalize] of [
  ["dashboard", normalizeSessionLogs],
  ["evals", normalizeEvalLogs],
] as const) {
  describe(`ACP reader (${name})`, () => {
    test("golden real persisted rows retain content and pair tools without protocol noise", () => {
      const parsed = normalize(fixture);
      const blocks = itemsToParsedMessages(parsed.items).flatMap((message) => message.content);
      const histogram: Record<string, number> = {};
      for (const block of blocks) {
        const key = block.type === "provider_meta" ? `${block.type}:${block.kind}` : block.type;
        histogram[key] = (histogram[key] ?? 0) + 1;
      }
      expect(parsed.gate).toEqual({ total: 30, ok: 30, bad: 0, passed: true });
      expect(histogram).toEqual({
        "provider_meta:internal": 1,
        text: 2,
        thinking: 1,
        tool_use: 2,
        tool_result: 2,
        "provider_meta:helper": 1,
        "provider_meta:result": 1,
      });
      expect(parsed.pairing.paired).toBe(2);
      expect(parsed.pairing.orphanCalls).toEqual([]);
      expect(parsed.pairing.orphanResults).toEqual([]);
      const bash = parsed.items.find((item) => item.tool?.name === "bash");
      expect(bash?.tool?.input).toEqual({
        cwd: "/workspace",
        command: "mkdir -p /workspace/shared/linkedin-infographics-2026-09-10/specs",
        description: "Create specs directory",
      });
      expect(blocks).toContainEqual({
        type: "tool_result",
        tool_use_id: bash?.tool?.id,
        content: "(no output)",
        isError: false,
      });
      const todo = parsed.items.find((item) => item.tool?.id === "call_01f2695fbe0b4f1daa7949b9");
      expect(todo?.tool?.name).toBe("todowrite");
      expect(todo?.tool?.input).toHaveProperty("todos");
      expect(todo?.coveredRecIds).toHaveLength(1);
      expect(JSON.stringify(blocks)).not.toContain("configOptions");
      expect(JSON.stringify(blocks)).not.toContain("acp_tool_call_update");
    });

    test("partial input, content-only updates, failed output and unrelated progress survive", () => {
      const events = [
        { type: "tool_start", toolCallId: "call", toolName: "bash", args: { cwd: "/tmp" } },
        {
          type: "custom",
          name: "acp_tool_call_update",
          data: { toolCallId: "call", rawInput: { command: "false" }, status: "in_progress" },
        },
        {
          type: "custom",
          name: "acp_tool_call_update",
          data: {
            toolCallId: "call",
            content: [{ type: "content", content: { type: "text", text: "working" } }],
          },
        },
        { type: "progress", message: "ACP tool call in_progress" },
        { type: "progress", message: "Waiting for authentication" },
        {
          type: "tool_end",
          toolCallId: "call",
          toolName: "Failure title",
          result: { status: "failed", rawOutput: "exit 1" },
        },
        {
          type: "custom",
          name: "acp_tool_call_update",
          data: { toolCallId: "missing", status: "in_progress" },
        },
        { type: "custom", name: "future_notification", data: { value: true } },
      ];
      const logs: SessionLogRecord[] = events.map((event, i) => ({
        ...fixture[0],
        id: String(i),
        lineNumber: i,
        content: JSON.stringify(event),
      }));
      const parsed = normalize(logs);
      expect(parsed.items[0].tool).toEqual({
        id: "call",
        name: "bash",
        input: { cwd: "/tmp", command: "false" },
      });
      expect(parsed.items[0].coveredRecIds).toEqual(["1", "2"]);
      expect(parsed.items[0].meta).toMatchObject({
        status: "failed",
        content: expect.any(Array),
      });
      expect(parsed.items.filter((item) => item.kind === "lifecycle")).toHaveLength(3);
      expect(itemsToParsedMessages(parsed.items).flatMap((m) => m.content)).toContainEqual({
        type: "tool_result",
        tool_use_id: "call",
        content: "exit 1",
        isError: true,
      });
    });
  });
}
