import { describe, expect, test } from "bun:test";
import { normalizeClaudeMessage } from "../providers/claude-session-events";

const state = {
  taskId: "task-fixture",
  agentId: "agent-fixture",
  model: "claude-opus-5-5",
  contextWindowSize: 1_000_000,
  transport: "cli" as const,
};

// Trimmed from a claude CLI stream-json `result` line.
const resultLine = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 48_210,
  num_turns: 6,
  session_id: "session-fixture",
  total_cost_usd: 0.3121,
  usage: {
    input_tokens: 12,
    cache_creation_input_tokens: 20_792,
    cache_read_input_tokens: 54_611,
    output_tokens: 2_993,
    output_tokens_details: { thinking_tokens: 1_304 },
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_792 },
  },
  modelUsage: {
    "claude-opus-5-5": {
      inputTokens: 12,
      outputTokens: 2_993,
      cacheReadInputTokens: 54_611,
      cacheCreationInputTokens: 20_792,
      webSearchRequests: 0,
      costUSD: 0.3121,
      contextWindow: 1_000_000,
    },
  },
};

describe("claude result-line thinking tokens", () => {
  test("records output_tokens_details.thinking_tokens without touching output or cost", () => {
    const { cost } = normalizeClaudeMessage(resultLine, state);
    expect(cost).toMatchObject({
      thinkingTokens: 1_304,
      outputTokens: 2_993,
      totalCostUsd: 0.3121,
    });
  });

  test("reports zero when the result line has no thinking breakdown", () => {
    const { output_tokens_details: _, ...usage } = resultLine.usage;
    const { cost } = normalizeClaudeMessage({ ...resultLine, usage }, state);
    expect(cost?.thinkingTokens).toBe(0);
  });
});
