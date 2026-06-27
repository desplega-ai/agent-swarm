import { describe, expect, test } from "bun:test";
import type { LanguageModelUsage } from "ai";
import { lookupModelCost, type PricedModel, priceUsage } from "../cost/pricing.ts";
import type { JudgeContext, JudgeStep, TokenTotals } from "../types.ts";
import { AgenticJudgeError } from "./agentic.ts";
import { runChecks } from "./deterministic.ts";
import { beginJudging, clearJudging, endJudging, getJudgeLive } from "./live-registry.ts";
import { finishJudgeTrace, newJudgeTrace, usageToTokens } from "./llm.ts";

/** AI SDK v6 usage fixture: inputTokens is the TOTAL prompt (cache reads included). */
const usageFixture: LanguageModelUsage = {
  inputTokens: 1200,
  inputTokenDetails: { noCacheTokens: 800, cacheReadTokens: 400, cacheWriteTokens: 0 },
  outputTokens: 300,
  outputTokenDetails: { textTokens: 250, reasoningTokens: 50 },
  totalTokens: 1500,
};

function reasoningStep(overrides: Partial<JudgeStep>): JudgeStep {
  return {
    index: 0,
    kind: "reasoning",
    text: null,
    tool: null,
    args: null,
    output: null,
    pass: null,
    startedAt: new Date().toISOString(),
    durationMs: 10,
    tokens: null,
    costUsd: null,
    ...overrides,
  };
}

describe("usageToTokens", () => {
  test("maps total input, output and the cache breakdown", () => {
    expect(usageToTokens("judge/model", usageFixture)).toEqual({
      model: "judge/model",
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
  });

  test("undefined fields collapse to zeros", () => {
    const sparse: LanguageModelUsage = {
      inputTokens: undefined,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokens: undefined,
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
      totalTokens: undefined,
    };
    expect(usageToTokens(null, sparse)).toEqual({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });
});

describe("judge step pricing", () => {
  const model: PricedModel = {
    id: "judge/model",
    name: "Judge Model",
    reasoning: true,
    toolCall: true,
    context: 128_000,
    inputPerM: 1,
    outputPerM: 5,
    cacheReadPerM: 0.1,
    cacheWritePerM: null,
  };

  test("AI SDK semantics: input includes cache reads", () => {
    const tokens = usageToTokens("judge/model", usageFixture);
    // uncached = 1200-400 = 800; 800*1 + 400*0.1 + 0 + 300*5 = 2340 → /1e6
    expect(priceUsage(model, tokens, { inputIncludesCacheRead: true })).toBeCloseTo(0.00234, 10);
  });

  test("unpriced model (null rates) yields null, tokens are kept by the caller", () => {
    const unpriced = { ...model, inputPerM: null };
    const tokens = usageToTokens("judge/model", usageFixture);
    expect(priceUsage(unpriced, tokens, { inputIncludesCacheRead: true })).toBeNull();
  });

  test("judge OpenRouter id resolves via the pi mapping and prices end-to-end", async () => {
    const priced = await lookupModelCost("pi", "deepseek/deepseek-v4-pro");
    expect(priced).not.toBeNull();
    if (!priced) throw new Error("unreachable");
    const tokens: TokenTotals = {
      model: "deepseek/deepseek-v4-pro",
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    // 10000*0.435 + 2000*0.87 = 6090 → /1e6 (no cache tokens involved)
    expect(priceUsage(priced, tokens, { inputIncludesCacheRead: true })).toBeCloseTo(0.00609, 10);
  });
});

describe("finishJudgeTrace", () => {
  test("rolls up tokens and cost across reasoning steps", () => {
    const trace = newJudgeTrace("agentic", "judge/model");
    trace.steps.push(
      reasoningStep({
        index: 0,
        tokens: {
          model: "judge/model",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
        },
        costUsd: 0.001,
      }),
      reasoningStep({
        index: 1,
        kind: "tool",
        tool: "run_command",
        args: { command: "ls" },
        output: "{}",
      }),
      reasoningStep({
        index: 2,
        tokens: {
          model: "judge/model",
          inputTokens: 200,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        costUsd: null, // unpriced step — tokens still counted
      }),
    );
    finishJudgeTrace(trace);
    expect(trace.finishedAt).not.toBeNull();
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.tokens).toEqual({
      model: "judge/model",
      inputTokens: 300,
      outputTokens: 30,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
    });
    expect(trace.costUsd).toBeCloseTo(0.001, 10);
  });

  test("no usage-bearing steps → tokens and cost stay null (deterministic)", () => {
    const trace = newJudgeTrace("deterministic", null);
    trace.steps.push(reasoningStep({ kind: "check", tool: "a-check", pass: true, text: "ok" }));
    finishJudgeTrace(trace);
    expect(trace.tokens).toBeNull();
    expect(trace.costUsd).toBeNull();
    expect(trace.finishedAt).not.toBeNull();
  });
});

describe("runChecks trace assembly", () => {
  const ctx: JudgeContext = {
    tasks: [],
    transcript: "",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readFile: async () => null,
    apiGet: async () => ({}),
    workers: [],
  };
  const checks = [
    { name: "passes", fn: async () => ({ pass: true, detail: "all good" }) },
    { name: "fails", fn: async () => ({ pass: false, detail: "nope" }) },
    {
      name: "throws",
      fn: async () => {
        throw new Error("kaboom");
      },
    },
  ];

  test("per-check results carry durationMs; thrown checks stay failures", async () => {
    const results = await runChecks(checks, ctx);
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(results[0]).toMatchObject({ name: "passes", pass: true, detail: "all good" });
    expect(results[1]).toMatchObject({ name: "fails", pass: false, detail: "nope" });
    expect(results[2]?.pass).toBe(false);
    expect(results[2]?.detail).toBe("check threw: kaboom");
  });

  test("live trace streams check steps and finishes with null cost/tokens", async () => {
    const attemptId = `trace-test-${crypto.randomUUID()}`;
    const handle = beginJudging(attemptId);
    try {
      await runChecks(checks, ctx, handle);
      const live = getJudgeLive(attemptId);
      expect(live.judging).toBe(true);
      expect(live.traces).toHaveLength(1);
      const trace = live.traces[0];
      if (!trace) throw new Error("unreachable");
      expect(trace.judge).toBe("deterministic");
      expect(trace.model).toBeNull();
      expect(trace.finishedAt).not.toBeNull();
      expect(trace.costUsd).toBeNull();
      expect(trace.tokens).toBeNull();
      expect(trace.steps.map((s) => s.kind)).toEqual(["check", "check", "check"]);
      expect(trace.steps.map((s) => s.index)).toEqual([0, 1, 2]);
      expect(trace.steps.map((s) => s.tool)).toEqual(["passes", "fails", "throws"]);
      expect(trace.steps.map((s) => s.pass)).toEqual([true, false, false]);
      expect(trace.steps[2]?.text).toBe("check threw: kaboom");
      for (const s of trace.steps) {
        expect(s.durationMs).toBeGreaterThanOrEqual(0);
        expect(Date.parse(s.startedAt)).toBeGreaterThan(0);
      }
      endJudging(attemptId);
      expect(getJudgeLive(attemptId).judging).toBe(false);
      expect(getJudgeLive(attemptId).traces).toHaveLength(1);
    } finally {
      clearJudging(attemptId);
    }
    expect(getJudgeLive(attemptId)).toEqual({ judging: false, traces: [] });
  });
});

describe("AgenticJudgeError", () => {
  test("carries the partial trace and the inner cause", () => {
    const trace = newJudgeTrace("agentic", "judge/model");
    trace.error = "boom";
    const cause = new Error("inner flake");
    const err = new AgenticJudgeError("boom", trace, { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AgenticJudgeError);
    expect(err.name).toBe("AgenticJudgeError");
    expect(err.message).toBe("boom");
    expect(err.trace).toBe(trace);
    expect(err.cause).toBe(cause);
  });
});
