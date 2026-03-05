import { describe, expect, test } from "bun:test";
import { emitClaudeStreamLineEvents } from "../commands/providers/claude-adapter.ts";
import type { ProviderRuntimeEvent } from "../commands/providers/types.ts";
import { SessionErrorTracker } from "../utils/error-tracker.ts";

describe("emitClaudeStreamLineEvents", () => {
  test("parses session init from a single JSON line", async () => {
    const events: ProviderRuntimeEvent[] = [];
    const tracker = new SessionErrorTracker();

    await emitClaudeStreamLineEvents(
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-123" }),
      async (event) => {
        events.push(event);
      },
      tracker,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "stream_line",
      provider: "claude",
      line: '{"type":"system","subtype":"init","session_id":"sess-123"}',
    });
    expect(events[1]).toEqual({
      type: "session_init",
      provider: "claude",
      sessionId: "sess-123",
    });
  });

  test("parses result usage from an unterminated final line", async () => {
    const events: ProviderRuntimeEvent[] = [];
    const tracker = new SessionErrorTracker();

    await emitClaudeStreamLineEvents(
      '{"type":"result","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":1},"duration_ms":99,"num_turns":3,"is_error":false}',
      async (event) => {
        events.push(event);
      },
      tracker,
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({
      type: "result",
      provider: "claude",
      totalCostUsd: 0.5,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
      durationMs: 99,
      numTurns: 3,
      isError: false,
      raw: {
        type: "result",
        total_cost_usd: 0.5,
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
        duration_ms: 99,
        num_turns: 3,
        is_error: false,
      },
    });
  });
});
