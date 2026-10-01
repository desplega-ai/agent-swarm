import { describe, expect, test } from "bun:test";
import { itemsToParsedMessages, normalizeSessionLogs } from "../src/logs-parser";
import type { ProviderMetaBlock, SessionLogRecord } from "../src/logs-parser/types";
import fixture from "./fixtures/dsh-qa-sessions.json";

function histogram(logs: SessionLogRecord[]) {
  const parsed = normalizeSessionLogs(logs);
  const blocks = itemsToParsedMessages(parsed.items).flatMap((message) => message.content);
  const counts: Record<string, number> = {};
  for (const block of blocks) {
    const key = block.type === "provider_meta" ? `${block.type}:${block.kind}` : block.type;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return { parsed, blocks, counts };
}

function metas(logs: SessionLogRecord[]): ProviderMetaBlock[] {
  return histogram(logs).blocks.filter(
    (block): block is ProviderMetaBlock => block.type === "provider_meta",
  );
}

function rows(events: unknown[]): SessionLogRecord[] {
  return events.map((event, i) => ({
    ...fixture[0],
    id: `row-${i}`,
    lineNumber: i,
    content: JSON.stringify(event),
  }));
}

describe("dsh reader", () => {
  // Real rows from two dsh QA sessions: a tool-error run and an upstream 429.
  test("real persisted rows render text, paired tools, usage and errors with no unknown rows", () => {
    const { parsed, counts } = histogram(fixture);
    expect(parsed.gate).toEqual({ total: 26, ok: 26, bad: 0, passed: true });
    expect(counts).toEqual({
      "provider_meta:internal": 4,
      text: 3,
      tool_use: 2,
      tool_result: 2,
      "provider_meta:helper": 1,
      "provider_meta:result": 1,
    });
    expect(parsed.items.some((item) => item.kind === "unknown")).toBe(false);
    expect(parsed.pairing.paired).toBe(2);
    expect(parsed.pairing.orphanCalls).toEqual([]);
    expect(parsed.pairing.orphanResults).toEqual([]);

    const read = parsed.items.find(
      (item) => item.kind === "tool_call" && item.tool?.name === "Read",
    );
    expect(read?.tool?.input).toEqual({ file_path: "/nonexistent/dsh-qa/secret-token.txt" });
    const readResult = parsed.pairing.resultById.get(read?.tool?.id ?? "");
    expect(readResult?.result?.isError).toBe(true);
    expect(readResult?.result?.payload).toContain("not found");

    const bash = parsed.items.find(
      (item) => item.kind === "tool_call" && item.tool?.name === "bash",
    );
    expect(bash?.tool?.input).toHaveProperty("command");
    expect(parsed.pairing.resultById.get(bash?.tool?.id ?? "")?.result?.isError).toBe(false);
  });

  test("lifecycle rows map onto the existing runtime, turn usage and result renderers", () => {
    const blocks = metas(fixture);
    const runtime = blocks.filter((b) => b.kind === "internal").map((b) => b.data.type);
    expect(runtime).toEqual(["session.started", "turn.started", "session.started", "turn.started"]);

    const usage = blocks.find((b) => b.kind === "helper");
    expect(usage?.data.helperType).toBe("turn_usage");
    // Three steps: 22118+66+70 uncached, 11520+33664+33792 cached.
    expect(usage?.data.usage).toEqual({
      input_tokens: 22254 + 78976,
      cached_input_tokens: 78976,
      output_tokens: 61 + 77 + 120,
    });

    // The first final repeats the last assistant message and the second is empty,
    // so neither gets a row; only the 429 turn error does.
    const results = blocks.filter((b) => b.kind === "result");
    expect(results.map((b) => b.data.type)).toEqual(["dsh_turn_error"]);

    const failed = results[0];
    expect(failed?.data.isError).toBe(true);
    expect(failed?.data.subtype).toBe("error");
    expect(String(failed?.data.output)).toStartWith("429:");
    // Missing cacheReadTokens are inferred from totalTokens.
    expect(failed?.data.usage).toEqual({
      input_tokens: 33309 + 279,
      cache_read_input_tokens: 33656 - 279 - 97,
      output_tokens: 94 + 97,
    });
  });

  test("stderr, truncation, a distinct final and runtime errors stay visible", () => {
    const { parsed, blocks } = histogram(
      rows([
        { type: "text", text: "partial", truncated: true },
        { type: "tool_call", callId: "c1", tool: "grep", input: { pattern: "x", path: "src" } },
        { type: "tool_result", callId: "c1", status: "completed", result: "hit", truncated: true },
        { type: "stderr", content: "dsh: RATE_LIMIT", timestamp: 1 },
        { type: "final", text: "done" },
        { type: "error", message: "boom" },
        { type: "future_event", value: 1 },
      ]),
    );
    expect(parsed.items[0]?.text).toBe("partial\n… [truncated by dsh]");
    expect(parsed.items[1]?.tool?.name).toBe("Grep");
    expect(parsed.items[2]?.result?.payload).toBe("hit\n… [truncated by dsh]");
    expect(parsed.items[3]?.text).toBe("[stderr] dsh: RATE_LIMIT");
    const results = blocks.filter((b) => b.type === "provider_meta" && b.kind === "result");
    expect(results.map((b) => (b as ProviderMetaBlock).data.output)).toEqual(["done", "boom"]);
    expect(parsed.items.at(-1)?.kind).toBe("unknown");
  });
});
