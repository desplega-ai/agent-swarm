import { describe, expect, test } from "bun:test";
import { normalizeSessionLogs } from "../src/logs-parser";
import type { SessionLogRecord } from "../src/logs-parser/types";
import fixture from "./fixtures/cursor-qa-sessions.json";

const session = (taskId: string): SessionLogRecord[] => fixture.filter((r) => r.taskId === taskId);

describe("cursor reader", () => {
  // Real rows from two local cursor e2e sessions: a swarm MCP store-progress
  // call, and a shell call cancelled mid-run.
  test("real persisted rows render with no unknown rows", () => {
    const parsed = normalizeSessionLogs(fixture);
    expect(parsed.gate).toEqual({ total: 48, ok: 48, bad: 0, passed: true });
    expect(parsed.items.some((item) => item.kind === "unknown")).toBe(false);
  });

  test("an MCP call pairs under its swarm tool name and chunked text merges", () => {
    const parsed = normalizeSessionLogs(session("task-cursor-mcp"));
    const call = parsed.items.find((item) => item.kind === "tool_call");
    expect(call?.tool?.name).toBe("mcp__agent-swarm__store-progress");
    expect(call?.tool?.input).toMatchObject({ status: "completed" });
    const result = parsed.pairing.resultById.get(call?.tool?.id ?? "");
    expect(result?.result?.isError).toBe(false);
    expect(String(result?.result?.payload)).toContain("marked as completed");
    expect(parsed.pairing.orphanCalls).toEqual([]);

    const texts = parsed.items.filter((item) => item.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]?.coveredRecIds?.length).toBeGreaterThan(0);

    const model = parsed.items.find(
      (item) => (item.meta as { type?: string } | undefined)?.type === "model.selected",
    );
    expect((model?.meta as { subtype?: string }).subtype).toBe("cursor · gpt-5.4-nano");
    const done = parsed.items.find(
      (item) => (item.meta as { type?: string } | undefined)?.type === "turn.completed",
    );
    expect((done?.meta as { usage?: Record<string, number> }).usage?.output_tokens).toBeGreaterThan(
      0,
    );
  });

  test("a cancelled run ends on an error result with the shell call unanswered", () => {
    const parsed = normalizeSessionLogs(session("task-cursor-cancel"));
    const call = parsed.items.find((item) => item.kind === "tool_call");
    expect(call?.tool?.name).toBe("Bash");
    expect(parsed.pairing.orphanCalls).toEqual([call?.tool?.id ?? ""]);
    const last = parsed.items.at(-1);
    expect(last?.kind).toBe("result");
    expect(last?.meta).toMatchObject({
      type: "cursor_run_error",
      subtype: "cancelled",
      isError: true,
    });
  });
});
