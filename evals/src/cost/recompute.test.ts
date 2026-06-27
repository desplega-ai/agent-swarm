import { describe, expect, test } from "bun:test";
import { recomputeCost, recomputeCostMulti } from "./recompute.ts";

// ---- claude fixtures (shape copied from evals.db raw-session-logs artifacts) ----

function claudeLogRow(opts: { msgId: string; usage: Record<string, number>; model?: string }): {
  cli: string;
  content: string;
} {
  return {
    cli: "claude",
    content: JSON.stringify({
      type: "assistant",
      message: {
        model: opts.model ?? "claude-haiku-4-5-20251001",
        id: opts.msgId,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "working on it" }],
        usage: opts.usage,
      },
    }),
  };
}

const CLAUDE_USAGE_A = {
  input_tokens: 10,
  cache_creation_input_tokens: 13584,
  cache_read_input_tokens: 13568,
  output_tokens: 7,
};
const CLAUDE_USAGE_B = {
  input_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 30920,
  output_tokens: 428,
};

describe("recomputeCost: claude", () => {
  test("dedupes log rows by message.id and prices via the anthropic section", async () => {
    const result = await recomputeCost({
      provider: "claude",
      configModel: "haiku",
      logRows: [
        { cli: "claude", content: JSON.stringify({ type: "system", subtype: "hook_started" }) },
        claudeLogRow({ msgId: "msg_A", usage: CLAUDE_USAGE_A }),
        // multi-content-block messages repeat the same usage — must count once
        claudeLogRow({ msgId: "msg_A", usage: CLAUDE_USAGE_A }),
        claudeLogRow({ msgId: "msg_B", usage: CLAUDE_USAGE_B }),
        { cli: "claude", content: "not json at all" },
      ],
      sessionFiles: [],
    });
    expect(result.tokens).toEqual({
      model: "claude-haiku-4-5-20251001",
      inputTokens: 20,
      outputTokens: 435,
      cacheReadTokens: 44488,
      cacheWriteTokens: 13584,
    });
    // claude-haiku-4-5: $1 in / $5 out / $0.1 cache-read / $1.25 cache-write per 1M;
    // anthropic input EXCLUDES cache tokens.
    // (20*1 + 44488*0.1 + 13584*1.25 + 435*5) / 1e6
    expect(result.costUsd).toBeCloseTo(0.0236238, 8);
  });

  test("falls back to session files (dedupe by requestId, keep last)", async () => {
    const line = (requestId: string, usage: Record<string, number>) =>
      JSON.stringify({
        type: "assistant",
        requestId,
        message: { id: "msg_X", model: "claude-haiku-4-5-20251001", usage },
      });
    const result = await recomputeCost({
      provider: "claude",
      configModel: null,
      logRows: [],
      sessionFiles: [
        {
          path: "/home/worker/.claude/projects/-workspace/x.jsonl",
          content: [
            JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
            line("req_1", CLAUDE_USAGE_B),
            line("req_1", CLAUDE_USAGE_B), // repeated per content block
          ].join("\n"),
        },
      ],
    });
    expect(result.tokens?.inputTokens).toBe(10);
    expect(result.tokens?.outputTokens).toBe(428);
    expect(result.tokens?.cacheReadTokens).toBe(30920);
    // (10*1 + 30920*0.1 + 0*1.25 + 428*5) / 1e6
    expect(result.costUsd).toBeCloseTo(0.005242, 8);
  });

  test("unknown model + alias config → priced via the alias's latest family model (v7 §8)", async () => {
    const result = await recomputeCost({
      provider: "claude",
      configModel: "haiku",
      logRows: [
        claudeLogRow({ msgId: "msg_A", usage: CLAUDE_USAGE_A, model: "some-internal-model" }),
      ],
      sessionFiles: [],
    });
    // "haiku" → claude-haiku-4-5: (10*1 + 13568*0.1 + 13584*1.25 + 7*5) / 1e6
    expect(result.costUsd).toBeCloseTo(0.0183818, 8);
    expect(result.tokens?.model).toBe("some-internal-model");
    expect(result.tokens?.cacheWriteTokens).toBe(13584);
  });

  test("unknown model + null config → unpriced but tokens kept", async () => {
    const result = await recomputeCost({
      provider: "claude",
      configModel: null,
      logRows: [
        claudeLogRow({ msgId: "msg_A", usage: CLAUDE_USAGE_A, model: "some-internal-model" }),
      ],
      sessionFiles: [],
    });
    expect(result.costUsd).toBeNull();
    expect(result.tokens?.model).toBe("some-internal-model");
    expect(result.tokens?.cacheWriteTokens).toBe(13584);
  });
});

// ---- pi fixtures (shape copied from evals.db ~/.pi/agent/sessions artifacts) ----

function piAssistantLine(opts: { usage: Record<string, unknown>; model?: string }): string {
  return JSON.stringify({
    type: "message",
    id: "45803767",
    timestamp: "2026-06-11T15:36:20.145Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "write", arguments: {} }],
      api: "openai-completions",
      provider: "openrouter",
      model: opts.model ?? "deepseek/deepseek-v4-flash",
      usage: opts.usage,
    },
  });
}

const PI_HEADER = JSON.stringify({ type: "session", version: 3, cwd: "/workspace" });
const PI_USER = JSON.stringify({
  type: "message",
  message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
});

describe("recomputeCost: pi", () => {
  test("sums provider-reported usage.cost.total directly", async () => {
    const result = await recomputeCost({
      provider: "pi",
      configModel: "openrouter/deepseek/deepseek-v4-flash",
      logRows: [],
      sessionFiles: [
        {
          path: "/home/worker/.pi/agent/sessions/--workspace--/s.jsonl",
          content: [
            PI_HEADER,
            PI_USER,
            piAssistantLine({
              usage: {
                input: 36745,
                output: 109,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 36854,
                cost: { input: 0.0036745, output: 0.0000218, total: 0.0036963 },
              },
            }),
            piAssistantLine({
              usage: {
                input: 36666,
                output: 70,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 36736,
                cost: { input: 0.0036666, output: 0.000014, total: 0.0036806 },
              },
            }),
          ].join("\n"),
        },
        { path: "/home/worker/.pi/agent/auth.json", content: "{}" },
      ],
    });
    expect(result.costUsd).toBeCloseTo(0.0073769, 10);
    expect(result.tokens).toEqual({
      model: "deepseek/deepseek-v4-flash",
      inputTokens: 73411,
      outputTokens: 179,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("tokens × rates backstop when usage.cost is absent", async () => {
    const result = await recomputeCost({
      provider: "pi",
      configModel: null,
      logRows: [],
      sessionFiles: [
        {
          path: "/home/worker/.pi/agent/sessions/--workspace--/s.jsonl",
          content: piAssistantLine({
            usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
          }),
        },
      ],
    });
    // deepseek/deepseek-v4-flash: $0.0983 in / $0.1966 out per 1M
    expect(result.costUsd).toBeCloseTo((1000 * 0.0983 + 500 * 0.1966) / 1e6, 12);
  });
});

// ---- opencode ----

describe("recomputeCost: opencode", () => {
  test("sums message cost; tokens from tokens.{input,output,cache}", async () => {
    const message = JSON.stringify({
      id: "msg_oc",
      role: "assistant",
      sessionID: "ses_1",
      modelID: "deepseek/deepseek-v4-flash",
      providerID: "openrouter",
      cost: 0.0012,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
    });
    const result = await recomputeCost({
      provider: "opencode",
      configModel: null,
      logRows: [],
      sessionFiles: [
        { path: "/home/worker/.local/share/opencode/storage/message/m.json", content: message },
      ],
    });
    expect(result.costUsd).toBeCloseTo(0.0012, 10);
    expect(result.tokens).toEqual({
      model: "deepseek/deepseek-v4-flash",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });
});

// ---- codex ----

describe("recomputeCost: codex", () => {
  test("uses the LAST cumulative token_count per rollout; openai input includes cache", async () => {
    const tokenCount = (total: Record<string, number>) =>
      JSON.stringify({
        timestamp: "2026-06-11T15:00:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: total,
            last_token_usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            },
          },
        },
      });
    const result = await recomputeCost({
      provider: "codex",
      configModel: null,
      logRows: [],
      sessionFiles: [
        {
          path: "/home/worker/.codex/sessions/2026/06/11/rollout-x.jsonl",
          content: [
            JSON.stringify({
              type: "turn_context",
              payload: { model: "gpt-5-codex", cwd: "/workspace" },
            }),
            tokenCount({
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 200,
              reasoning_output_tokens: 50,
            }),
            tokenCount({
              input_tokens: 2000,
              cached_input_tokens: 800,
              output_tokens: 400,
              reasoning_output_tokens: 100,
            }),
          ].join("\n"),
        },
      ],
    });
    expect(result.tokens).toEqual({
      model: "gpt-5-codex",
      inputTokens: 2000,
      outputTokens: 400,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
    });
    // gpt-5-codex: $1.25 in / $10 out / $0.125 cache-read per 1M; input INCLUDES cache:
    // ((2000-800)*1.25 + 800*0.125 + 400*10) / 1e6
    expect(result.costUsd).toBeCloseTo(0.0056, 10);
  });
});

// ---- heterogeneous-roster per-member merge (v7 §12.5) ----

describe("recomputeCostMulti: per-member merge (v7 §12.5)", () => {
  test("claude member + pi member: Σ of member costs, field-wise Σ of tokens, dominant model across ALL events", async () => {
    const result = await recomputeCostMulti([
      {
        provider: "claude",
        configModel: "haiku",
        logRows: [
          claudeLogRow({ msgId: "msg_A", usage: CLAUDE_USAGE_A }),
          claudeLogRow({ msgId: "msg_B", usage: CLAUDE_USAGE_B }),
        ],
        sessionFiles: [],
      },
      {
        provider: "pi",
        configModel: "openrouter/deepseek/deepseek-v4-flash",
        logRows: [],
        sessionFiles: [
          {
            path: "/home/worker/.pi/agent/sessions/--workspace--/s.jsonl",
            content: piAssistantLine({
              usage: {
                input: 1000,
                output: 500,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { input: 0.0001, output: 0.0001, total: 0.0002 },
              },
            }),
          },
        ],
      },
    ]);
    // member costs: claude per the single-member test (0.0236238) + pi provider-reported 0.0002
    expect(result.costUsd).toBeCloseTo(0.0236238 + 0.0002, 8);
    // field-wise sums across both members' events
    expect(result.tokens?.inputTokens).toBe(20 + 1000);
    expect(result.tokens?.outputTokens).toBe(435 + 500);
    expect(result.tokens?.cacheReadTokens).toBe(44488);
    expect(result.tokens?.cacheWriteTokens).toBe(13584);
    // dominant model across ALL members' events: claude contributes 2 events, pi 1
    expect(result.tokens?.model).toBe("claude-haiku-4-5-20251001");
  });

  test("single input matches recomputeCost (homogeneous parity)", async () => {
    const input = {
      provider: "claude" as const,
      configModel: "haiku",
      logRows: [claudeLogRow({ msgId: "msg_A", usage: CLAUDE_USAGE_A })],
      sessionFiles: [],
    };
    expect(await recomputeCostMulti([input])).toEqual(await recomputeCost(input));
  });

  test("one priced member + one unparseable member: cost = the priced member's, tokens kept", async () => {
    const result = await recomputeCostMulti([
      {
        provider: "claude",
        configModel: "haiku",
        logRows: [claudeLogRow({ msgId: "msg_A", usage: CLAUDE_USAGE_A })],
        sessionFiles: [],
      },
      {
        provider: "opencode",
        configModel: null,
        logRows: [],
        sessionFiles: [{ path: "/x", content: "not json" }],
      },
    ]);
    expect(result.costUsd).toBeCloseTo(0.0183818, 8);
    expect(result.tokens?.model).toBe("claude-haiku-4-5-20251001");
  });

  test("members with unpriceable models: null cost but merged tokens (never NaN)", async () => {
    const result = await recomputeCostMulti([
      {
        provider: "claude",
        configModel: null,
        logRows: [claudeLogRow({ msgId: "msg_A", usage: CLAUDE_USAGE_A, model: "mystery-model" })],
        sessionFiles: [],
      },
    ]);
    expect(result.costUsd).toBeNull();
    expect(result.tokens?.model).toBe("mystery-model");
    expect(JSON.stringify(result)).not.toContain("NaN");
  });

  test("empty inputs / nothing extractable → all nulls", async () => {
    expect(await recomputeCostMulti([])).toEqual({ costUsd: null, tokens: null });
    expect(
      await recomputeCostMulti([
        { provider: "pi", configModel: null, logRows: [], sessionFiles: [] },
      ]),
    ).toEqual({ costUsd: null, tokens: null });
  });
});

// ---- failure modes ----

describe("recomputeCost: failure modes", () => {
  test("nothing extractable → all nulls, never throws", async () => {
    const result = await recomputeCost({
      provider: "pi",
      configModel: null,
      logRows: [{ cli: "pi", content: "garbage{{{" }],
      sessionFiles: [{ path: "/x", content: "also\nnot\njson" }],
    });
    expect(result).toEqual({ costUsd: null, tokens: null });
  });

  test("empty input → all nulls", async () => {
    const result = await recomputeCost({
      provider: "codex",
      configModel: null,
      logRows: [],
      sessionFiles: [],
    });
    expect(result).toEqual({ costUsd: null, tokens: null });
  });
});
