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
import { CURVE, parseCalibration, SAVINGS_TIERS, type SavingsTier } from "../be/savings/model";

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

/** `per` sessions at each of 1..61 turns whose tokens grow linearly with the turn count. */
function sessions(per: number, outlier = true): OpusSession[] {
  const out: OpusSession[] = [];
  for (let turns = 1; turns <= 61; turns++) {
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
