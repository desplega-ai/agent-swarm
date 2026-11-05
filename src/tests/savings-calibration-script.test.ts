import { describe, expect, test } from "bun:test";
import {
  compareToShipped,
  type DeriveInput,
  deriveCurves,
  MIN_SESSIONS,
  type OpusSession,
  type TierPrices,
  trimmedMean,
} from "../../scripts/calibrate-savings-curve";
import {
  CURVE,
  parseCalibration,
  priceWorkflow,
  SAVINGS_TIERS,
  type SavingsTier,
  type WorkflowFacts,
} from "../be/savings/model";

const PRICES: Record<SavingsTier, TierPrices> = {
  smol: { input: 0.1, output: 0.5, cached_input: 0.01, cache_write_1h: 0.2 },
  regular: { input: 2, output: 10, cached_input: 0.1, cache_write_1h: 4 },
  smart: { input: 4, output: 20, cached_input: 0.2, cache_write_1h: 8 },
  ultra: { input: 10, output: 50, cached_input: 0.25, cache_write_1h: 20 },
};
const OTHER = 0.001;
const costAt = (s: Omit<OpusSession, "costUsd" | "otherUsd">, p: TierPrices) =>
  (s.inputTokens * p.input +
    s.outputTokens * p.output +
    s.cacheReadTokens * p.cached_input +
    s.cacheWriteTokens * p.cache_write_1h) /
  1e6;

/** `per` sessions at each of `from`..`to` turns whose tokens grow linearly with the turn count. */
function sessions(per: number, outlier = true, from = 1, to = 61): OpusSession[] {
  const out: OpusSession[] = [];
  for (let turns = from; turns <= to; turns++) {
    for (let k = 0; k < per; k++) {
      const base = {
        turns,
        durationMs: 3_000 * turns,
        inputTokens: 10,
        outputTokens: 300 * turns,
        cacheReadTokens: 20_000 * turns,
        cacheWriteTokens: 5_000 + 100 * turns,
      };
      // One runaway session per turn count: the trimmed mean must ignore it.
      const blowup = outlier && k === 0 ? 50 : 1;
      const tokens = { ...base, cacheReadTokens: base.cacheReadTokens * blowup };
      out.push({ ...tokens, costUsd: costAt(tokens, PRICES.smart), otherUsd: OTHER });
    }
  }
  return out;
}

const input = (opus: OpusSession[], tierTurns: DeriveInput["tierTurns"] = {}): DeriveInput => ({
  opus,
  prices: PRICES,
  tierTurns,
  end: new Date("2026-12-01T10:00:00Z"),
});

describe("calibrate-savings-curve", () => {
  test("recovers a known linear cost curve per tier, ignoring outlier sessions", () => {
    const out = deriveCurves(input(sessions(20)));
    for (const tier of SAVINGS_TIERS) {
      for (let turns = 2; turns <= 61; turns++) {
        const clean = {
          inputTokens: 10,
          outputTokens: 300 * turns,
          cacheReadTokens: 20_000 * turns,
          cacheWriteTokens: 5_000 + 100 * turns,
        };
        const truth = costAt(clean, PRICES[tier]) + OTHER;
        expect(out.curve[tier].usd[turns - 1] as number).toBeCloseTo(truth, 3);
      }
    }
    expect(out.repriceMatch).toBe(1);
    expect(out.calibratedAt).toBe("2026-12-01");
    // The result is what the API stores: it must parse.
    expect(
      parseCalibration(
        JSON.stringify({ calibratedAt: out.calibratedAt, model: out.model, curve: out.curve }),
      ),
    ).not.toBeNull();
  });

  test("tier hours are opus hours times the tier's measured speed; a thin tier uses the fallback", () => {
    // Opus runs 3 s a turn; haiku 4.5 s (1.5x), 40 sessions. Sonnet has 2 sessions: fallback.
    const haiku = Array.from({ length: 40 }, () => ({ turns: 10, durationMs: 45_000 }));
    const sonnet = [
      { turns: 10, durationMs: 100_000 },
      { turns: 5, durationMs: 100_000 },
    ];
    const out = deriveCurves(input(sessions(20), { smol: haiku, regular: sonnet }));
    expect(out.speed).toEqual({ smol: 1.5, regular: 1.29, smart: 1, ultra: 1 });
    expect(out.curve.smol.hrs[19]).toBeCloseTo((out.curve.smart.hrs[19] as number) * 1.5, 4);
  });

  test("a curve is non-decreasing even when a turn count is noisy", () => {
    const noisy = sessions(20, false).map((s) =>
      s.turns === 30 ? { ...s, cacheReadTokens: 1, outputTokens: 1 } : s,
    );
    const { smart } = deriveCurves(input(noisy)).curve;
    smart.usd.forEach((v, i) => {
      if (i > 0) expect(v).toBeGreaterThanOrEqual(smart.usd[i - 1] as number);
    });
  });

  test("negative control: too few sessions refuses to calibrate", () => {
    expect(() => deriveCurves(input(sessions(20).slice(0, MIN_SESSIONS - 1)))).toThrow(
      /only \d+ opus sessions/,
    );
  });

  // Dollar figures below are the session curve's own unit, before R, the review cost and the error band.
  test("negative control: 300 five-turn sessions do not become a flat curve", () => {
    // Without a coverage rule this prices a 2-turn job like a 5-turn one (the 5-turn point at every turn).
    const fiveTurn = sessions(300, false, 5, 5);
    expect(fiveTurn).toHaveLength(300);
    expect(() => deriveCurves(input(fiveTurn))).toThrow(/turn coverage too thin/);
  });

  test("refuses a window that misses the bottom or the top of the turn range", () => {
    expect(() => deriveCurves(input(sessions(20, false, 6, 61)))).toThrow(
      /reaching turn 3 or lower/,
    );
    expect(() => deriveCurves(input(sessions(40, false, 2, 19)))).toThrow(/turn 20 or higher/);
    // 7 supported turn counts spanning 2..30: both ends reached, too few points between them.
    const gappy = sessions(60, false, 2, 30).filter(
      (s) => s.turns === 2 || s.turns === 30 || s.turns % 5 === 0,
    );
    expect(() => deriveCurves(input(gappy))).toThrow(/need at least 15/);
  });

  test("past the data the shipped shape is used, scaled to the last supported turn", () => {
    const out = deriveCurves(input(sessions(20, false, 2, 30)));
    for (const tier of SAVINGS_TIERS) {
      const usd = out.curve[tier].usd;
      const scale = (usd[29] as number) / CURVE[tier].usd[29];
      for (const turns of [31, 45, 61]) {
        expect(usd[turns - 1] as number).toBeCloseTo(CURVE[tier].usd[turns - 1] * scale, 3);
      }
      // Not flat: the tail keeps climbing.
      expect(usd[60] as number).toBeGreaterThan((usd[29] as number) * 1.5);
    }
  });

  test("below the data the shipped shape is used, scaled to the first supported turn", () => {
    const out = deriveCurves(input(sessions(20, false, 3, 61)));
    for (const tier of SAVINGS_TIERS) {
      const usd = out.curve[tier].usd;
      const scale = (usd[2] as number) / CURVE[tier].usd[2];
      expect(usd[1] as number).toBeCloseTo(CURVE[tier].usd[1] * scale, 3);
      expect(usd[1] as number).toBeLessThan(usd[2] as number);
    }
  });

  test("a sparse-tail curve still prices more ops higher, past the data too", () => {
    const out = deriveCurves(input(sessions(20, false, 2, 30)));
    const facts = (opsSum: number): WorkflowFacts => ({
      runs: 100,
      schedRuns: 0,
      schedEffectRuns: 0,
      countedRuns: 100,
      opsSum,
      agentTasks: 0,
      agentUsd: 0,
      followupUsd: 0,
      agentMs: 0,
      recordedLlmUsd: 0,
      estimatedLlmUsd: 0,
      computeSecs: 0,
    });
    const perRun = (ops: number) =>
      priceWorkflow(facts(ops * 100), { tier: "smart", days: 30, band: "job", curve: out.curve })
        .agentOnlyUsdPerRun;
    expect(perRun(1)).toBeLessThan(perRun(60));
    expect(perRun(120)).toBeGreaterThan(perRun(60));
  });

  test("compareToShipped is 1.0 on the shipped curve and flags a doubled one", () => {
    const weights = Array.from({ length: 61 }, () => 1);
    for (const c of compareToShipped(CURVE, weights)) {
      expect(c.weighted).toBe(1);
      expect(c.over5pct).toBe(0);
    }
    const doubled = Object.fromEntries(
      SAVINGS_TIERS.map((t) => [t, { usd: CURVE[t].usd.map((v) => v * 2), hrs: CURVE[t].hrs }]),
    ) as typeof CURVE;
    const usd = compareToShipped(doubled, weights).filter((c) => c.key === "usd");
    for (const c of usd) {
      expect(c.weighted).toBeCloseTo(2, 6);
      expect(c.over5pct).toBe(60);
    }
  });

  test("trimmedMean drops the extremes", () => {
    expect(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 1000])).toBe(5.5);
  });
});
