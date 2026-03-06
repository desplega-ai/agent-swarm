import { describe, expect, test } from "bun:test";
import {
  createProviderEventProcessor,
  type ProviderPersistenceCallbacks,
} from "../commands/providers/runtime-normalizer.ts";
import type { ProviderRuntimeEvent } from "../commands/providers/types.ts";

function createCallbacks() {
  const calls = {
    sessions: [] as string[],
    lines: [] as string[],
    costs: [] as Array<{ totalCostUsd: number; inputTokens: number; outputTokens: number }>,
  };

  const callbacks: ProviderPersistenceCallbacks = {
    onSessionInit: async (sessionId) => {
      calls.sessions.push(sessionId);
    },
    onStreamLine: async (line) => {
      calls.lines.push(line);
    },
    onCostData: async (cost) => {
      calls.costs.push({
        totalCostUsd: cost.totalCostUsd,
        inputTokens: cost.inputTokens ?? 0,
        outputTokens: cost.outputTokens ?? 0,
      });
    },
  };

  return { callbacks, calls };
}

describe("provider runtime normalization", () => {
  test("maps session_init event to session persistence callback", async () => {
    const { callbacks, calls } = createCallbacks();
    const processor = createProviderEventProcessor(callbacks);

    const event: ProviderRuntimeEvent = {
      type: "session_init",
      sessionId: "session-123",
      provider: "claude",
    };

    await processor(event);
    expect(calls.sessions).toEqual(["session-123"]);
  });

  test("maps result event to cost persistence callback", async () => {
    const { callbacks, calls } = createCallbacks();
    const processor = createProviderEventProcessor(callbacks);

    const event: ProviderRuntimeEvent = {
      type: "result",
      provider: "claude",
      totalCostUsd: 1.23,
      usage: {
        inputTokens: 100,
        outputTokens: 42,
      },
      durationMs: 5000,
      numTurns: 2,
      isError: false,
    };

    await processor(event);
    expect(calls.costs).toEqual([
      {
        totalCostUsd: 1.23,
        inputTokens: 100,
        outputTokens: 42,
      },
    ]);
  });

  test("maps stream_line event to log callback", async () => {
    const { callbacks, calls } = createCallbacks();
    const processor = createProviderEventProcessor(callbacks);

    const event: ProviderRuntimeEvent = {
      type: "stream_line",
      provider: "claude",
      line: '{"type":"assistant","text":"hello"}',
    };

    await processor(event);
    expect(calls.lines).toEqual(['{"type":"assistant","text":"hello"}']);
  });
});
