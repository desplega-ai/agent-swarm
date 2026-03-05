import { describe, expect, test } from "bun:test";
import {
  extractUsageFromPiEvent,
  extractUsageFromPiStats,
  mergeUsageSnapshots,
} from "../commands/providers/pi-mono-adapter.ts";

describe("pi usage extraction", () => {
  test("extracts usage from streaming assistant partial events", () => {
    const usage = extractUsageFromPiEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        partial: {
          usage: {
            input: 123,
            output: 45,
            cacheRead: 6,
            cacheWrite: 7,
            cost: {
              total: 0.00123,
            },
          },
        },
      },
    });

    expect(usage).toEqual({
      totalCostUsd: 0.00123,
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 6,
      cacheWriteTokens: 7,
    });
  });

  test("tracks turn_end events as turn increments", () => {
    const usage = extractUsageFromPiEvent({
      type: "turn_end",
    });

    expect(usage.numTurns).toBe(1);
  });

  test("merges snapshots using max counters and summed turns", () => {
    const merged = mergeUsageSnapshots(
      {
        totalCostUsd: 0.001,
        inputTokens: 100,
        outputTokens: 20,
        numTurns: 2,
      },
      {
        totalCostUsd: 0.002,
        inputTokens: 140,
        outputTokens: 18,
        numTurns: 1,
      },
    );

    expect(merged).toEqual({
      totalCostUsd: 0.002,
      inputTokens: 140,
      outputTokens: 20,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      numTurns: 3,
    });
  });

  test("extracts stats usage from pi session stats", () => {
    const usage = extractUsageFromPiStats({
      cost: { total: 0.0042 },
      input: 1200,
      output: 300,
      cacheRead: 40,
      cacheWrite: 10,
      turns: 5,
    });

    expect(usage).toEqual({
      totalCostUsd: 0.0042,
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      numTurns: 5,
    });
  });
});
