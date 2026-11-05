#!/usr/bin/env bun
/**
 * Re-derive the automation-savings session curve from this deployment's own
 * `session_costs`, and optionally store it so the savings endpoints use it
 * instead of the constants shipped in `src/be/savings/model.ts`.
 *
 *   bun scripts/calibrate-savings-curve.ts [--days 30] [--end <ISO>] [--apply]
 *
 * Needs a running swarm API (`MCP_BASE_URL`, the key via getApiKey()). Without
 * `--apply` it is read-only: it prints the derived calibration as JSON on
 * stdout and a comparison against the shipped curve on stderr. With `--apply`
 * it writes the JSON to the global `SAVINGS_CURVE_CALIBRATION` config row.
 * Delete that row to go back to the shipped curve.
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
 */
import { parseArgs } from "node:util";
import {
  CALIBRATION_MODEL,
  CURVE,
  type CurveSet,
  SAVINGS_CALIBRATION_KEY,
  SAVINGS_TIERS,
  type SavingsTier,
  StoredCalibrationSchema,
  TAU_MAX,
} from "../src/be/savings/model";
import { getApiKey } from "../src/utils/api-key";

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
/** Fewer opus sessions than this in the window: refuse to calibrate. */
export const MIN_SESSIONS = 300;
/** Fewer sessions than this for a tier model: use SPEED_FALLBACK. */
const MIN_SPEED_SESSIONS = 30;
/** `--apply` refuses a curve whose mean cost is further than this factor from the shipped one. */
const SANITY_FACTOR = 3;

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
  curve: CurveSet;
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

/** Linear fill of the gaps, flat past the ends, then non-decreasing. */
function fillMonotone(series: (number | undefined)[]): number[] {
  const known = series.flatMap((v, i) => (v === undefined ? [] : [i]));
  const first = known[0] as number;
  const last = known[known.length - 1] as number;
  let floor = 0;
  return series.map((_, i) => {
    let v: number;
    if (i <= first) v = series[first] as number;
    else if (i >= last) v = series[last] as number;
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

/** One value per turn count 1..TAU_MAX: a trimmed mean of `value`, smoothed and non-decreasing. */
function curveOf(sessions: OpusSession[], value: (s: OpusSession) => number): number[] {
  const byTurns = new Map<number, number[]>();
  for (const s of sessions) {
    if (s.turns < 1 || s.turns > TAU_MAX) continue;
    byTurns.set(s.turns, [...(byTurns.get(s.turns) ?? []), value(s)]);
  }
  const raw = Array.from({ length: TAU_MAX }, (_, i) => {
    const at = byTurns.get(i + 1);
    return at && at.length >= MIN_SESSIONS_PER_TURN ? trimmedMean(at) : undefined;
  });
  // shortcut: turn 1 is never read (tau >= T0 = 2), so it takes the value of turn 2 instead of a noisy estimate.
  raw[0] = undefined;
  const smoothed = smooth(raw.slice(1), SMOOTH_HALF_WIDTH);
  if (smoothed.every((v) => v === undefined)) {
    throw new Error("no turn count has enough sessions to calibrate");
  }
  const filled = fillMonotone(smoothed);
  return [filled[0] as number, ...filled];
}

const round = (x: number, digits: number) => Number(x.toFixed(digits));

export function deriveCurves(input: DeriveInput): DerivedCalibration {
  const { opus, prices, tierTurns, end } = input;
  const usable = opus.filter((s) => s.turns >= 1 && s.turns <= TAU_MAX);
  if (usable.length < MIN_SESSIONS) {
    throw new Error(
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

  const opusHrs = curveOf(usable, (s) => s.durationMs / 3.6e6);
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
        usd: curveOf(usable, price(prices[tier])).map((v) => round(v, 4)),
        hrs: opusHrs.map((v) => round(v * speed[tier], 5)),
      },
    ]),
  ) as CurveSet;
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

// ---- API access --------------------------------------------------------------------------

const PAGE = 1000;

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

/** Read-only query through the API's bounded executor; a concurrency rejection is retried, never read as empty. */
async function query(base: string, sql: string, params: unknown[]): Promise<unknown[][]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(`${base}/api/db-query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    if (res.status === 429) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`db-query ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { rows: unknown[][]; truncated: boolean };
    if (body.truncated) throw new Error("db-query result was truncated; lower the page size");
    return body.rows;
  }
  throw new Error("db-query stayed at its concurrency cap after 6 attempts");
}

/** Keyset-paged read of `sql`, which selects the session id first and takes `id > ?` as its last parameter. */
async function pages(base: string, sql: string, params: unknown[]): Promise<unknown[][]> {
  const out: unknown[][] = [];
  let after = "";
  for (;;) {
    const rows = await query(base, sql, [...params, after]);
    out.push(...rows);
    if (rows.length < PAGE) return out;
    after = String((rows[rows.length - 1] as unknown[])[0]);
  }
}

const num = (v: unknown) => Number(v) || 0;

export async function fetchInput(base: string, start: Date, end: Date): Promise<DeriveInput> {
  const window = [start.toISOString(), end.toISOString()];
  const opusRows = await pages(
    base,
    `SELECT s.id, s.numTurns, s.durationMs, json_extract(j.value,'$.inputTokens'), json_extract(j.value,'$.outputTokens'),
       json_extract(j.value,'$.cacheReadTokens'), json_extract(j.value,'$.cacheWriteTokens'), json_extract(j.value,'$.costUsd'), s.totalCostUsd
     FROM session_costs s, json_each(CASE WHEN json_valid(s.modelBreakdown) THEN s.modelBreakdown ELSE '[]' END) j
     WHERE s.model = ? AND json_extract(j.value,'$.model') = ? AND s.createdAt >= ? AND s.createdAt < ?
       AND s.numTurns BETWEEN 1 AND ${TAU_MAX} AND s.id > ? ORDER BY s.id LIMIT ${PAGE}`,
    [CALIBRATION_MODEL, CALIBRATION_MODEL, ...window],
  );
  const opus = opusRows.map((r) => ({
    turns: num(r[1]),
    durationMs: num(r[2]),
    inputTokens: num(r[3]),
    outputTokens: num(r[4]),
    cacheReadTokens: num(r[5]),
    cacheWriteTokens: num(r[6]),
    costUsd: num(r[7]),
    otherUsd: Math.max(0, num(r[8]) - num(r[7])),
  }));

  const priceRows = await query(
    base,
    `SELECT model, token_class, price_per_million_usd FROM pricing
     WHERE provider = 'claude' AND model IN (${SAVINGS_TIERS.map(() => "?").join(",")}) AND effective_from <= ?
     ORDER BY effective_from`,
    [...SAVINGS_TIERS.map((t) => TIER_MODEL[t]), end.getTime()],
  );
  const latest = new Map<string, number>(); // later effective_from overwrites earlier
  for (const r of priceRows) latest.set(`${r[0]}|${r[1]}`, num(r[2]));
  const prices = Object.fromEntries(
    SAVINGS_TIERS.map((tier) => [
      tier,
      Object.fromEntries(
        (["input", "output", "cached_input", "cache_write_1h"] as const).map((cls) => {
          const p = latest.get(`${TIER_MODEL[tier]}|${cls}`);
          if (p === undefined) throw new Error(`no ${cls} price for ${TIER_MODEL[tier]}`);
          return [cls, p];
        }),
      ),
    ]),
  ) as Record<SavingsTier, TierPrices>;

  const tierTurns: DeriveInput["tierTurns"] = {};
  for (const tier of SAVINGS_TIERS) {
    if (tier === "smart") continue;
    const rows = await pages(
      base,
      `SELECT id, numTurns, durationMs FROM session_costs
       WHERE model = ? AND createdAt >= ? AND createdAt < ? AND numTurns BETWEEN 3 AND ${TAU_MAX} AND id > ? ORDER BY id LIMIT ${PAGE}`,
      [TIER_MODEL[tier], ...window],
    );
    tierTurns[tier] = rows.map((r) => ({ turns: num(r[1]), durationMs: num(r[2]) }));
  }
  return { opus, prices, tierTurns, end };
}

async function main() {
  const { values } = parseArgs({
    options: {
      days: { type: "string", default: "30" },
      end: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  const base = (process.env.MCP_BASE_URL ?? "http://localhost:3013").replace(/\/$/, "");
  const end = values.end ? new Date(values.end) : new Date();
  const days = Number(values.days);
  if (Number.isNaN(end.getTime()) || !(days >= 1 && days <= 90)) {
    throw new Error("--end must be an ISO date and --days 1..90");
  }
  const start = new Date(end.getTime() - days * 86_400_000);
  const derived = deriveCurves(await fetchInput(base, start, end));
  const stored = {
    calibratedAt: derived.calibratedAt,
    model: derived.model,
    curve: derived.curve,
  };
  StoredCalibrationSchema.parse(stored);

  const perTurn = Array.from({ length: TAU_MAX }, () => 0);
  for (const s of derived.usable) perTurn[s.turns - 1] = (perTurn[s.turns - 1] as number) + 1;
  const cmp = compareToShipped(derived.curve, perTurn);
  console.error(
    `window ${start.toISOString()} .. ${end.toISOString()}  sessions ${derived.sessions}  repricing within 1%: ${(derived.repriceMatch * 100).toFixed(1)}%  speed ${JSON.stringify(derived.speed)}`,
  );
  console.error("tier     key  median   max     >5%     weighted  (turns 2..61 vs shipped)");
  for (const c of cmp) {
    console.error(
      `${c.tier.padEnd(8)} ${c.key.padEnd(4)} ${(c.median * 100).toFixed(1).padStart(5)}%  ${(c.max * 100).toFixed(1).padStart(5)}%  ${`${c.over5pct}/${c.points}`.padEnd(7)}  ${c.weighted.toFixed(3)}`,
    );
  }
  console.log(JSON.stringify(stored));

  if (!values.apply) return;
  const mean = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const ratio = mean(derived.curve.smart.usd) / mean(CURVE.smart.usd);
  if (ratio > SANITY_FACTOR || ratio < 1 / SANITY_FACTOR) {
    throw new Error(`derived smart curve is ${ratio.toFixed(2)}x the shipped one; not applying`);
  }
  const res = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "global",
      key: SAVINGS_CALIBRATION_KEY,
      value: JSON.stringify(stored),
      // The row is read by the API only; keep a 9 KB blob out of every agent's environment.
      exportToEnv: false,
      description: "Savings session curve derived from this deployment's sessions",
    }),
  });
  if (!res.ok) throw new Error(`config write ${res.status}: ${(await res.text()).slice(0, 300)}`);
  console.error(`stored ${SAVINGS_CALIBRATION_KEY}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
