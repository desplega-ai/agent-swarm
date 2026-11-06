/**
 * Re-derive the automation-savings session curve from this deployment's own
 * `session_costs`, and optionally store it so the savings endpoints use it
 * instead of the constants shipped in `src/be/savings/model.ts`.
 *
 * Served by `POST /api/savings/calibration` (`src/http/savings-calibration.ts`), which
 * also owns the deadline, the one-run-at-a-time lock and the config write. Delete the
 * global `SAVINGS_CURVE_CALIBRATION` row to go back to the shipped curve.
 *
 * Method, rebuilt from the v7 calibration notes (research/cost/2026-11-05); it reproduces
 * the shipped curve to about 1% on session-weighted average, not point for point:
 * - cost(t, tier): 10%-trimmed mean, over this window's opus 5.5 sessions of
 *   exactly t turns, of the session's opus tokens repriced at the tier's list
 *   prices plus the stored cost of its other models (sub-agents), t = 1..61.
 *   The curve is then smoothed with a +-2 turn local linear fit and made
 *   non-decreasing.
 * - hrs(t, tier): the same for agent-active hours (durationMs) on opus,
 *   times the tier's speed against opus (median ms per turn).
 * - Coverage: a turn count with fewer than MIN_SESSIONS_PER_TURN sessions is unsupported.
 *   Gaps between supported turn counts are interpolated. The curve is refused unless the
 *   supported counts reach MIN_LOW_TURN at the bottom and MIN_HIGH_TURN at the top. Past the
 *   outermost supported count the shipped curve's shape is used, scaled to meet that count.
 */
import type { SavingsSql } from "./compute";
import {
  CALIBRATION_MODEL,
  CURVE,
  type CurveSet,
  SAVINGS_TIERS,
  type SavingsTier,
  TAU_MAX,
} from "./model";

/** The model each tier bills at. */
export const TIER_MODEL: Record<SavingsTier, string> = {
  smol: "claude-haiku-5-5",
  regular: "claude-sonnet-5-5",
  smart: CALIBRATION_MODEL,
  ultra: "claude-fable-5-1",
};

/** Hours per turn against opus, used when a tier has too few sessions to measure (v7 values). */
export const SPEED_FALLBACK: Record<SavingsTier, number> = {
  smol: 1.54,
  regular: 1.29,
  smart: 1,
  ultra: 1,
};

const TRIM = 0.1;
const SMOOTH_HALF_WIDTH = 2;
/** Fewer sessions than this at one turn count: the point is filled from its neighbours. */
const MIN_SESSIONS_PER_TURN = 5;
/** Refuse a curve whose lowest supported turn count is above this: short jobs are what the model prices most. */
export const MIN_LOW_TURN = 3;
/** Refuse a curve whose highest supported turn count is below this (tau 20 is 65 ops per run). */
export const MIN_HIGH_TURN = 20;
/** Refuse a curve built on fewer supported turn counts than this (of 60). */
export const MIN_SUPPORTED_TURNS = 15;
/** Fewer opus sessions than this in the window: refuse to calibrate. */
export const MIN_SESSIONS = 300;
/** Fewer sessions than this for a tier model: use SPEED_FALLBACK. */
const MIN_SPEED_SESSIONS = 30;
/** A curve whose mean cost is further than this factor from the shipped one is never applied. */
export const SANITY_FACTOR = 3;
/** Rows read per query; the read pages by keyset so no query is unbounded. */
const PAGE = 1000;
/** Refuse a window with more sessions than this: one run must stay inside the API's memory. */
export const MAX_SESSIONS_READ = 200_000;

/** The data cannot support a curve; the message is the reason shown to the caller. */
export class CalibrationRefusal extends Error {}

/** `CurveSet` with plain arrays: what a derivation produces and the API serializes. */
export type DerivedCurveSet = Record<SavingsTier, { usd: number[]; hrs: number[] }>;

export type OpusSession = {
  turns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The cost the harness stored for the opus tokens, for the repricing control. */
  costUsd: number;
  /** Stored cost of the session's other models (sub-agents), kept as is at every tier. */
  otherUsd: number;
};
export type TierPrices = Record<"input" | "output" | "cached_input" | "cache_write_1h", number>; // USD per million tokens
export type TurnDuration = { turns: number; durationMs: number };

export type DeriveInput = {
  opus: OpusSession[];
  prices: Record<SavingsTier, TierPrices>;
  /** ms-per-turn samples of each non-opus tier model's own sessions. */
  tierTurns: Partial<Record<SavingsTier, TurnDuration[]>>;
  end: Date;
};

export type DerivedCalibration = {
  calibratedAt: string;
  model: string;
  curve: DerivedCurveSet;
  sessions: number;
  usable: OpusSession[];
  speed: Record<SavingsTier, number>;
  /** Share of sessions whose repriced opus cost is within 1% of the stored cost. */
  repriceMatch: number;
};

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

export function trimmedMean(values: number[], trim = TRIM): number {
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * trim);
  const kept = sorted.slice(cut, sorted.length - cut);
  return kept.reduce((s, v) => s + v, 0) / kept.length;
}

/**
 * Local linear fit over the defined points within `half` turns, evaluated at each point.
 * Unlike a moving average it does not pull the end points toward their inner neighbours.
 * Undefined points stay undefined.
 */
function smooth(series: (number | undefined)[], half: number): (number | undefined)[] {
  return series.map((v, i) => {
    if (v === undefined) return undefined;
    const pts: [number, number][] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(series.length - 1, i + half); j++) {
      const y = series[j];
      if (y !== undefined) pts.push([j, y]);
    }
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    if (sxx === 0) return my;
    const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx;
    return my + slope * (i - mx);
  });
}

/**
 * Fill the gaps, then make the series non-decreasing. Between two known points the fill is
 * linear. Past the first or last known point it follows `reference` (the shipped curve) scaled
 * to meet that point, because a flat extension would price every turn count beyond the data
 * at the edge's level.
 */
function fillMonotone(series: (number | undefined)[], reference: readonly number[]): number[] {
  const known = series.flatMap((v, i) => (v === undefined ? [] : [i]));
  const first = known[0] as number;
  const last = known[known.length - 1] as number;
  const scaled = (i: number, anchor: number) =>
    (series[anchor] as number) * ((reference[i] as number) / (reference[anchor] as number));
  let floor = 0;
  return series.map((_, i) => {
    let v: number;
    if (i < first) v = scaled(i, first);
    else if (i > last) v = scaled(i, last);
    else {
      const lo = known.filter((k) => k <= i).at(-1) as number;
      const hi = known.find((k) => k >= i) as number;
      const a = series[lo] as number;
      const b = series[hi] as number;
      v = lo === hi ? a : a + ((b - a) * (i - lo)) / (hi - lo);
    }
    floor = Math.max(floor, v);
    return floor;
  });
}

/**
 * One value per turn count 1..TAU_MAX: a trimmed mean of `value`, smoothed and non-decreasing.
 * `reference` is the shipped series of the same quantity, used past the supported turn counts.
 */
function curveOf(
  sessions: OpusSession[],
  value: (s: OpusSession) => number,
  reference: readonly number[],
): number[] {
  const byTurns = new Map<number, number[]>();
  for (const s of sessions) {
    if (s.turns < 1 || s.turns > TAU_MAX) continue;
    const at = byTurns.get(s.turns);
    if (at) at.push(value(s));
    else byTurns.set(s.turns, [value(s)]);
  }
  const raw = Array.from({ length: TAU_MAX }, (_, i) => {
    const at = byTurns.get(i + 1);
    return at && at.length >= MIN_SESSIONS_PER_TURN ? trimmedMean(at) : undefined;
  });
  // shortcut: turn 1 is never read (tau >= T0 = 2), so it takes the value of turn 2 instead of a noisy estimate.
  raw[0] = undefined;
  const supported = raw.flatMap((v, i) => (v === undefined ? [] : [i + 1]));
  const lo = supported[0];
  const hi = supported[supported.length - 1];
  if (
    lo === undefined ||
    hi === undefined ||
    lo > MIN_LOW_TURN ||
    hi < MIN_HIGH_TURN ||
    supported.length < MIN_SUPPORTED_TURNS
  ) {
    throw new CalibrationRefusal(
      `turn coverage too thin: ${supported.length} of ${TAU_MAX - 1} turn counts have ${MIN_SESSIONS_PER_TURN}+ sessions` +
        `${lo === undefined ? "" : ` (turns ${lo}..${hi})`}; need at least ${MIN_SUPPORTED_TURNS}, reaching turn ${MIN_LOW_TURN} or lower and turn ${MIN_HIGH_TURN} or higher`,
    );
  }
  const smoothed = smooth(raw.slice(1), SMOOTH_HALF_WIDTH);
  const filled = fillMonotone(smoothed, reference.slice(1));
  return [filled[0] as number, ...filled];
}

const round = (x: number, digits: number) => Number(x.toFixed(digits));

export function deriveCurves(input: DeriveInput): DerivedCalibration {
  const { opus, prices, tierTurns, end } = input;
  const usable = opus.filter((s) => s.turns >= 1 && s.turns <= TAU_MAX);
  if (usable.length < MIN_SESSIONS) {
    throw new CalibrationRefusal(
      `only ${usable.length} opus sessions of 1..${TAU_MAX} turns in the window; need ${MIN_SESSIONS}`,
    );
  }
  const opusTokensCost = (p: TierPrices) => (s: OpusSession) =>
    (s.inputTokens * p.input +
      s.outputTokens * p.output +
      s.cacheReadTokens * p.cached_input +
      s.cacheWriteTokens * p.cache_write_1h) /
    1e6;
  const price = (p: TierPrices) => (s: OpusSession) => opusTokensCost(p)(s) + s.otherUsd;
  // The harness bills every cache write at the 1h rate, so repricing at opus prices must give back the stored cost.
  const opusCost = opusTokensCost(prices.smart);
  const repriceMatch =
    usable.filter((s) => Math.abs(opusCost(s) - s.costUsd) <= 0.01 * s.costUsd).length /
    usable.length;

  const opusHrs = curveOf(usable, (s) => s.durationMs / 3.6e6, CURVE.smart.hrs);
  const perTurn = (rows: TurnDuration[]) =>
    median(
      rows.filter((r) => r.turns >= 3 && r.turns <= TAU_MAX).map((r) => r.durationMs / r.turns),
    );
  const opusPerTurn = perTurn(usable.map((s) => ({ turns: s.turns, durationMs: s.durationMs })));
  const speed = Object.fromEntries(
    SAVINGS_TIERS.map((tier) => {
      const rows = (tierTurns[tier] ?? []).filter((r) => r.turns >= 3 && r.turns <= TAU_MAX);
      if (tier === "smart") return [tier, 1];
      return [
        tier,
        rows.length >= MIN_SPEED_SESSIONS
          ? round(perTurn(rows) / opusPerTurn, 3)
          : SPEED_FALLBACK[tier],
      ];
    }),
  ) as Record<SavingsTier, number>;

  const curve = Object.fromEntries(
    SAVINGS_TIERS.map((tier) => [
      tier,
      {
        usd: curveOf(usable, price(prices[tier]), CURVE[tier].usd).map((v) => round(v, 4)),
        hrs: opusHrs.map((v) => round(v * speed[tier], 5)),
      },
    ]),
  ) as DerivedCurveSet;
  return {
    calibratedAt: end.toISOString().slice(0, 10),
    model: CALIBRATION_MODEL,
    curve,
    sessions: usable.length,
    usable,
    speed,
    repriceMatch,
  };
}

/**
 * Per-tier deviation of a curve from the shipped one over turns 2..TAU_MAX (turn 1 is never
 * read). `weighted` is the session-weighted mean of derived over shipped: what the model
 * would price on the fleet's own session lengths.
 */
export function compareToShipped(curve: CurveSet, sessionsPerTurn: number[]) {
  return SAVINGS_TIERS.flatMap((tier) =>
    (["usd", "hrs"] as const).map((key) => {
      const pairs = curve[tier][key]
        .map((v, i) => ({ ratio: v / (CURVE[tier][key][i] as number), w: sessionsPerTurn[i] ?? 0 }))
        .slice(1);
      const dev = pairs.map((p) => Math.abs(p.ratio - 1)).sort((a, b) => a - b);
      const w = pairs.reduce((s, p) => s + p.w, 0);
      return {
        tier,
        key,
        median: dev[Math.floor(dev.length / 2)] as number,
        max: dev[dev.length - 1] as number,
        over5pct: dev.filter((d) => d > 0.05).length,
        points: dev.length,
        weighted: pairs.reduce((s, p) => s + p.w * p.ratio, 0) / w,
      };
    }),
  );
}

// ---- Reading the sessions ----------------------------------------------------------------

const num = (v: unknown) => Number(v) || 0;

/** Keyset-paged read of `sql`, which selects `id` and takes `id > ?` as its last parameter. */
async function pages<T extends { id: string }>(
  sql: SavingsSql,
  query: string,
  params: (string | number)[],
): Promise<T[]> {
  const out: T[] = [];
  let after = "";
  for (;;) {
    const rows = await sql<T>(query, [...params, after]);
    out.push(...rows);
    if (out.length > MAX_SESSIONS_READ) {
      throw new CalibrationRefusal(
        `more than ${MAX_SESSIONS_READ} sessions in the window; use a shorter window (days)`,
      );
    }
    if (rows.length < PAGE) return out;
    after = (rows[rows.length - 1] as T).id;
  }
}

export async function fetchInput(sql: SavingsSql, start: Date, end: Date): Promise<DeriveInput> {
  const window = [start.toISOString(), end.toISOString()];
  const opusRows = await pages<Record<string, unknown> & { id: string }>(
    sql,
    `SELECT s.id AS id, s.numTurns AS turns, s.durationMs AS durationMs,
       json_extract(j.value,'$.inputTokens') AS inputTokens, json_extract(j.value,'$.outputTokens') AS outputTokens,
       json_extract(j.value,'$.cacheReadTokens') AS cacheReadTokens, json_extract(j.value,'$.cacheWriteTokens') AS cacheWriteTokens,
       json_extract(j.value,'$.costUsd') AS costUsd, s.totalCostUsd AS totalCostUsd
     FROM session_costs s, json_each(CASE WHEN json_valid(s.modelBreakdown) THEN s.modelBreakdown ELSE '[]' END) j
     WHERE s.model = ? AND json_extract(j.value,'$.model') = ? AND s.createdAt >= ? AND s.createdAt < ?
       AND s.numTurns BETWEEN 1 AND ${TAU_MAX} AND s.id > ? ORDER BY s.id LIMIT ${PAGE}`,
    [CALIBRATION_MODEL, CALIBRATION_MODEL, ...window],
  );
  const opus = opusRows.map((r) => ({
    turns: num(r.turns),
    durationMs: num(r.durationMs),
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadTokens: num(r.cacheReadTokens),
    cacheWriteTokens: num(r.cacheWriteTokens),
    costUsd: num(r.costUsd),
    otherUsd: Math.max(0, num(r.totalCostUsd) - num(r.costUsd)),
  }));

  const priceRows = await sql<{ model: string; token_class: string; price: number }>(
    `SELECT model, token_class, price_per_million_usd AS price FROM pricing
     WHERE provider = 'claude' AND model IN (${SAVINGS_TIERS.map(() => "?").join(",")}) AND effective_from <= ?
     ORDER BY effective_from`,
    [...SAVINGS_TIERS.map((t) => TIER_MODEL[t]), end.getTime()],
  );
  const latest = new Map<string, number>(); // later effective_from overwrites earlier
  for (const r of priceRows) latest.set(`${r.model}|${r.token_class}`, num(r.price));
  const prices = Object.fromEntries(
    SAVINGS_TIERS.map((tier) => [
      tier,
      Object.fromEntries(
        (["input", "output", "cached_input", "cache_write_1h"] as const).map((cls) => {
          const p = latest.get(`${TIER_MODEL[tier]}|${cls}`);
          if (p === undefined) {
            throw new CalibrationRefusal(`no ${cls} price for ${TIER_MODEL[tier]}`);
          }
          return [cls, p];
        }),
      ),
    ]),
  ) as Record<SavingsTier, TierPrices>;

  const tierTurns: DeriveInput["tierTurns"] = {};
  for (const tier of SAVINGS_TIERS) {
    if (tier === "smart") continue;
    const rows = await pages<{ id: string; turns: number; durationMs: number }>(
      sql,
      `SELECT id, numTurns AS turns, durationMs FROM session_costs
       WHERE model = ? AND createdAt >= ? AND createdAt < ? AND numTurns BETWEEN 3 AND ${TAU_MAX} AND id > ? ORDER BY id LIMIT ${PAGE}`,
      [TIER_MODEL[tier], ...window],
    );
    tierTurns[tier] = rows.map((r) => ({ turns: num(r.turns), durationMs: num(r.durationMs) }));
  }
  return { opus, prices, tierTurns, end };
}

// ---- The run -----------------------------------------------------------------------------

export type CalibrationGap = ReturnType<typeof compareToShipped>[number];

export type CalibrationRun = {
  window: { start: string; end: string; days: number };
  /** Opus sessions of 1..TAU_MAX turns used; 0 when the run was refused before counting. */
  sessions: number;
  /** Why the data cannot support a curve. When set, `calibration` is null. */
  refusal: string | null;
  /** The derived curve in the form the config row stores. */
  calibration: StoredCalibration | null;
  speed: Record<SavingsTier, number> | null;
  repriceMatch: number | null;
  /** Per tier and quantity, the derived curve against the shipped one. */
  gaps: CalibrationGap[];
  /** Derived smart-tier mean cost over the shipped one. */
  meanRatio: number | null;
  /** Why a derived curve must not be applied (mean cost beyond SANITY_FACTOR); null when it may be. */
  applyBlocked: string | null;
};

export type StoredCalibration = {
  calibratedAt: string;
  model: string;
  curve: DerivedCurveSet;
  window: { start: string; end: string; sessions: number };
};

/** Read the window's sessions through `sql` and derive the curve. Never writes. */
export async function calibrate(
  sql: SavingsSql,
  opts: { days: number; end: Date },
): Promise<CalibrationRun> {
  const start = new Date(opts.end.getTime() - opts.days * 86_400_000);
  const window = { start: start.toISOString(), end: opts.end.toISOString(), days: opts.days };
  const refused = (refusal: string): CalibrationRun => ({
    window,
    sessions: 0,
    refusal,
    calibration: null,
    speed: null,
    repriceMatch: null,
    gaps: [],
    meanRatio: null,
    applyBlocked: null,
  });
  let derived: DerivedCalibration;
  try {
    derived = deriveCurves(await fetchInput(sql, start, opts.end));
  } catch (err) {
    if (err instanceof CalibrationRefusal) return refused(err.message);
    throw err;
  }
  const perTurn = Array.from({ length: TAU_MAX }, () => 0);
  for (const s of derived.usable) perTurn[s.turns - 1] = (perTurn[s.turns - 1] as number) + 1;
  const mean = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const meanRatio = mean(derived.curve.smart.usd) / mean(CURVE.smart.usd);
  return {
    window,
    sessions: derived.sessions,
    refusal: null,
    calibration: {
      calibratedAt: derived.calibratedAt,
      model: derived.model,
      curve: derived.curve,
      window: { start: window.start, end: window.end, sessions: derived.sessions },
    },
    speed: derived.speed,
    repriceMatch: derived.repriceMatch,
    gaps: compareToShipped(derived.curve, perTurn),
    meanRatio,
    applyBlocked:
      meanRatio > SANITY_FACTOR || meanRatio < 1 / SANITY_FACTOR
        ? `derived smart curve is ${meanRatio.toFixed(2)}x the shipped one (limit ${SANITY_FACTOR}x)`
        : null,
  };
}
