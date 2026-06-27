import { describe, expect, test } from "bun:test";
import type { SessionCostRow } from "../swarm/client.ts";
import type { RecomputeResult, TokenTotals } from "../types.ts";
import { resolveAttemptCost } from "./index.ts";

/**
 * v7 §11.1 (FROZEN) direct unit coverage for the runner's attempt cost/token
 * decision (`resolveAttemptCost`, extracted from `runAttemptOnce`):
 *
 * 1. harness-priced rows WITH tokens → costSource "harness", tokens from the
 *    rows, recompute thunk NEVER invoked;
 * 2. harness-priced rows with NULL/zero token columns → tokens-only recompute
 *    (costUsd / costSource "harness" untouched);
 * 3. tokens-only recompute yielding nothing → tokens stay the zero harness
 *    sum, cost fields still untouched;
 * 4. no priced rows → full recompute ("recomputed" / "unpriced").
 */

const row = (over: Partial<SessionCostRow>): SessionCostRow => ({
  totalCostUsd: null,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  model: null,
  costSource: "unpriced",
  ...over,
});

const TOKENS: TokenTotals = {
  model: "claude-fable-5",
  inputTokens: 1200,
  outputTokens: 340,
  cacheReadTokens: 5000,
  cacheWriteTokens: 90,
};

/** Recompute thunk that records invocations and returns a fixed result. */
const recomputeStub = (
  result: RecomputeResult,
): { calls: number[]; run: () => Promise<RecomputeResult> } => {
  const calls: number[] = [];
  return {
    calls,
    run: async () => {
      calls.push(Date.now());
      return result;
    },
  };
};

describe("resolveAttemptCost (v7 §11.1 frozen rule)", () => {
  test("harness-priced rows with tokens: harness branch, recompute never runs", async () => {
    const stub = recomputeStub({ costUsd: 9.99, tokens: TOKENS });
    const out = await resolveAttemptCost({
      allRows: [
        row({
          totalCostUsd: 0.25,
          inputTokens: 100,
          outputTokens: 20,
          model: "claude-fable-5",
          costSource: "harness",
        }),
        row({ totalCostUsd: 0.15, inputTokens: 50, outputTokens: 10, costSource: "harness" }),
      ],
      runRecompute: stub.run,
    });
    expect(stub.calls.length).toBe(0);
    expect(out.costUsd).toBeCloseTo(0.4, 10);
    expect(out.costSource).toBe("harness");
    expect(out.tokens).toEqual({
      model: "claude-fable-5",
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(out.recomputeMs).toBe(0);
  });

  test("harness-priced rows with NULL token columns: tokens-only recompute, cost untouched", async () => {
    const logs: string[] = [];
    const stub = recomputeStub({ costUsd: 123.45, tokens: TOKENS });
    const out = await resolveAttemptCost({
      allRows: [
        // priced rows whose token columns are all NULL — the A.4 gap shape
        row({ totalCostUsd: 0.31, model: "claude-fable-5", costSource: "harness" }),
        row({ totalCostUsd: 0.09, costSource: "harness" }),
      ],
      runRecompute: stub.run,
      log: (m) => logs.push(m),
    });
    expect(stub.calls.length).toBe(1);
    // tokens come from the extractor…
    expect(out.tokens).toEqual(TOKENS);
    // …but costUsd / costSource are NEVER touched by the recompute result
    expect(out.costUsd).toBeCloseTo(0.4, 10);
    expect(out.costSource).toBe("harness");
    expect(logs.some((m) => m.includes("harness rows carried no tokens"))).toBe(true);
  });

  test("priced via costSource tag alone (zero USD) still counts as harness-priced", async () => {
    const stub = recomputeStub({ costUsd: null, tokens: TOKENS });
    const out = await resolveAttemptCost({
      allRows: [row({ totalCostUsd: 0, costSource: "pricing-table" })],
      runRecompute: stub.run,
    });
    expect(out.costSource).toBe("harness");
    expect(out.costUsd).toBe(0);
    expect(stub.calls.length).toBe(1); // zero tokens on the row → tokens-only recompute
    expect(out.tokens).toEqual(TOKENS);
  });

  test("tokens-only recompute yields null tokens: zero harness sum kept, cost untouched", async () => {
    const stub = recomputeStub({ costUsd: 5, tokens: null });
    const out = await resolveAttemptCost({
      allRows: [row({ totalCostUsd: 0.5, costSource: "harness" })],
      runRecompute: stub.run,
    });
    expect(stub.calls.length).toBe(1);
    expect(out.costUsd).toBe(0.5);
    expect(out.costSource).toBe("harness");
    // the zero-token harness sum stays (recompute had nothing better)
    expect(out.tokens).toEqual({
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  test("tokens-only recompute yields zero-total tokens: harness sum kept", async () => {
    const zero: TokenTotals = {
      model: "x",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const out = await resolveAttemptCost({
      allRows: [row({ totalCostUsd: 0.5, costSource: "harness" })],
      runRecompute: async () => ({ costUsd: null, tokens: zero }),
    });
    expect(out.costSource).toBe("harness");
    expect(out.tokens?.model).toBe(null); // recomputed zero totals are NOT adopted
  });

  test("no rows: full recompute path → recomputed when extractor prices it", async () => {
    const stub = recomputeStub({ costUsd: 0.0123, tokens: TOKENS });
    const out = await resolveAttemptCost({ allRows: [], runRecompute: stub.run });
    expect(stub.calls.length).toBe(1);
    expect(out.costUsd).toBe(0.0123);
    expect(out.costSource).toBe("recomputed");
    expect(out.tokens).toEqual(TOKENS);
  });

  test("unpriced rows only: full recompute path, tokens stored even when unpriced", async () => {
    const stub = recomputeStub({ costUsd: null, tokens: TOKENS });
    const out = await resolveAttemptCost({
      allRows: [row({ inputTokens: 10, outputTokens: 5, costSource: "unpriced" })],
      runRecompute: stub.run,
    });
    expect(stub.calls.length).toBe(1);
    expect(out.costUsd).toBe(null);
    expect(out.costSource).toBe("unpriced");
    expect(out.tokens).toEqual(TOKENS); // tokens (if any) still stored
  });
});
