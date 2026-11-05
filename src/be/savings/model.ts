/**
 * Automation savings model: what the work a workflow did would have cost if
 * agent tasks had done it instead.
 *
 * Port of the `automation-savings-estimate` script, version 7, calibrated on
 * 2026-11-05 against opus 5.5 session costs. Change a constant here only
 * together with a new calibration.
 *
 * Per substituted run: agent-only cost = R * curve(tau) * err + F, with
 * tau = T0 + K * ops (capped at TAU_MAX turns), where ops counts the awaited
 * I/O calls of the deterministic steps. Agent-task nodes inside a workflow are
 * kept at their actual cost on both sides; only the deterministic glue is
 * substituted.
 */

export const SAVINGS_TIERS = ["smol", "regular", "smart", "ultra"] as const;
export type SavingsTier = (typeof SAVINGS_TIERS)[number];
export type SavingsBand = { p10: number; p50: number; p90: number };
type Quantile = keyof SavingsBand;

export const CALIBRATION_MODEL = "claude-opus-5-5";
export const CALIBRATED_AT = "2026-11-05";
/**
 * Version of the constants and of the facts the daily rollup stores. Bump it
 * with any change here or in the rollup's SQL: buckets computed under an older
 * version are recomputed on the next tick.
 */
export const MODEL_VERSION = 1;

/** Agent turns per deterministic op. */
export const K = 0.2753;
/** Bootstrap turns of a fresh agent session. */
export const T0 = 2;
/** tau cap: the fleet's p95 session length in turns. */
export const TAU_MAX = 61;
/** An agent would not poll faster than hourly: schedule runs count at most 24 a day. */
export const CAP_PER_DAY = 24;
/** Lead follow-up review per standalone agent task, USD. */
export const F_FOLLOWUP = 0.107;
/** USD per million SystemOne input tokens when a run records no cost. */
export const JEV_PER_M = 0.042;
/** Failure and retry multiplier, from scheduled agent tasks. */
export const R: SavingsBand = { p10: 1.011, p50: 1.02, p90: 1.03 };
/** Leave-one-out backtest spread for a single job. */
export const ERR_JOB: SavingsBand = { p10: 0.542, p50: 1.0, p90: 1.508 };
/** Monte Carlo spread for a fleet sum. */
export const ERR_FLEET: SavingsBand = { p10: 0.746, p50: 1.0, p90: 1.325 };
/** Ops of a swarm-script node whose script is not in the catalog. */
export const DEFAULT_OPS = 9;
/** Ops of a script run with inline source (no catalog entry), from v7. */
export const INLINE_OPS = 3.9;
/** Job id of the script runs that carry no script name (inline source). */
export const INLINE_SCRIPT_NAME = "(inline source)";
/** Upper bound on the ops counted for one script. */
export const MAX_SCRIPT_OPS = 100;
/**
 * Enabled-only rule (an event router): an event-triggered workflow that ran
 * more than this many times a day on average, and where fewer than
 * ROUTER_MAX_EFFECT_SHARE of its runs had an effect, is a filter over an event
 * stream. Only its effect runs count, each as one agent decision.
 * The v7 script names the router; a product needs a rule. The plan's 24 a day
 * also caught an event workflow that does real work on every run (41 runs a
 * day, no linked effects), so the threshold is 10 events an hour.
 */
export const ROUTER_MIN_RUNS_PER_DAY = 240;
export const ROUTER_MAX_EFFECT_SHARE = 0.1;
/** Share of runs with `triggerType='event'` for a workflow to count as event-triggered. */
export const ROUTER_MIN_EVENT_SHARE = 0.9;

// Session cost (USD) and agent-active hours by session length in turns
// (index 0 = 1 turn), per tier, from 30 days of session_costs repriced at each
// tier's model.
export const CURVE: Record<SavingsTier, { usd: readonly number[]; hrs: readonly number[] }> = {
  smol: {
    usd: [
      0.0056, 0.0068, 0.0075, 0.0086, 0.0092, 0.0105, 0.012, 0.0146, 0.0163, 0.0171, 0.0184, 0.02,
      0.0212, 0.0222, 0.0225, 0.0242, 0.0254, 0.0268, 0.028, 0.0291, 0.0306, 0.0319, 0.0333, 0.0353,
      0.0359, 0.0374, 0.0389, 0.0413, 0.043, 0.0434, 0.045, 0.047, 0.0489, 0.0505, 0.051, 0.0535,
      0.0554, 0.057, 0.0586, 0.0595, 0.0612, 0.0633, 0.065, 0.0679, 0.0683, 0.0702, 0.0717, 0.0742,
      0.0757, 0.0764, 0.078, 0.0805, 0.0824, 0.0842, 0.085, 0.0881, 0.0901, 0.093, 0.0949, 0.0963,
      0.0979,
    ],
    hrs: [
      0.00409, 0.00521, 0.00674, 0.00831, 0.00993, 0.0126, 0.01586, 0.01997, 0.02272, 0.02392,
      0.02615, 0.03049, 0.034, 0.03708, 0.03835, 0.04398, 0.04779, 0.05207, 0.05544, 0.05811,
      0.06247, 0.06595, 0.07002, 0.07589, 0.0778, 0.08234, 0.08704, 0.09357, 0.09884, 0.10091,
      0.10694, 0.11393, 0.12002, 0.12476, 0.12736, 0.13666, 0.14271, 0.14854, 0.15322, 0.15738,
      0.16341, 0.17023, 0.17766, 0.18815, 0.18983, 0.19846, 0.1996, 0.20217, 0.20833, 0.21012,
      0.21538, 0.2224, 0.23067, 0.23488, 0.23825, 0.24844, 0.25554, 0.26838, 0.27469, 0.27725,
      0.28259,
    ],
  },
  regular: {
    usd: [
      0.0878, 0.1074, 0.1211, 0.1383, 0.1497, 0.1699, 0.196, 0.2372, 0.2628, 0.2762, 0.2952, 0.3209,
      0.3399, 0.3544, 0.3593, 0.3859, 0.4041, 0.425, 0.4435, 0.4586, 0.4817, 0.5001, 0.5215, 0.5501,
      0.5582, 0.5795, 0.6027, 0.6364, 0.6621, 0.6678, 0.6917, 0.7189, 0.7459, 0.7683, 0.7758,
      0.8096, 0.8361, 0.8588, 0.8806, 0.893, 0.9152, 0.9422, 0.9654, 1.0056, 1.0108, 1.0351, 1.0545,
      1.0885, 1.108, 1.1184, 1.1389, 1.1716, 1.1969, 1.2205, 1.2309, 1.2733, 1.3003, 1.3399, 1.3639,
      1.3838, 1.4053,
    ],
    hrs: [
      0.00341, 0.00435, 0.00562, 0.00693, 0.00828, 0.0105, 0.01322, 0.01665, 0.01894, 0.01994,
      0.0218, 0.02541, 0.02834, 0.0309, 0.03197, 0.03665, 0.03983, 0.0434, 0.04621, 0.04844,
      0.05207, 0.05497, 0.05836, 0.06326, 0.06485, 0.06863, 0.07255, 0.07799, 0.08239, 0.08411,
      0.08914, 0.09496, 0.10004, 0.10399, 0.10616, 0.11391, 0.11896, 0.12382, 0.12771, 0.13118,
      0.13621, 0.14189, 0.14808, 0.15683, 0.15823, 0.16542, 0.16638, 0.16852, 0.17365, 0.17514,
      0.17952, 0.18537, 0.19227, 0.19578, 0.19858, 0.20708, 0.213, 0.22371, 0.22896, 0.23109,
      0.23555,
    ],
  },
  smart: {
    usd: [
      0.1746, 0.2138, 0.2413, 0.2756, 0.2983, 0.3385, 0.3907, 0.4729, 0.5243, 0.551, 0.589, 0.6402,
      0.6783, 0.7075, 0.7173, 0.7705, 0.8068, 0.8487, 0.8857, 0.9158, 0.9621, 0.9989, 1.0416,
      1.0987, 1.1149, 1.1576, 1.2041, 1.2714, 1.3225, 1.3339, 1.3815, 1.4359, 1.49, 1.5347, 1.5496,
      1.617, 1.67, 1.7153, 1.7596, 1.7844, 1.8288, 1.8828, 1.9291, 2.0095, 2.0198, 2.0683, 2.1069,
      2.1748, 2.2137, 2.2345, 2.2752, 2.3413, 2.3918, 2.4388, 2.4595, 2.5444, 2.5985, 2.678, 2.7259,
      2.7657, 2.8086,
    ],
    hrs: [
      0.00265, 0.00338, 0.00437, 0.00539, 0.00644, 0.00817, 0.01029, 0.01296, 0.01474, 0.01552,
      0.01696, 0.01978, 0.02205, 0.02405, 0.02488, 0.02852, 0.031, 0.03377, 0.03596, 0.03769,
      0.04052, 0.04278, 0.04541, 0.04923, 0.05046, 0.05341, 0.05645, 0.06069, 0.06411, 0.06545,
      0.06937, 0.0739, 0.07785, 0.08092, 0.08261, 0.08865, 0.09257, 0.09635, 0.09939, 0.10209,
      0.106, 0.11041, 0.11524, 0.12204, 0.12313, 0.12873, 0.12947, 0.13114, 0.13513, 0.13629,
      0.1397, 0.14425, 0.14962, 0.15235, 0.15453, 0.16114, 0.16575, 0.17408, 0.17817, 0.17983,
      0.1833,
    ],
  },
  ultra: {
    usd: [
      0.4215, 0.5126, 0.5737, 0.6515, 0.702, 0.7922, 0.9108, 1.0969, 1.2137, 1.2729, 1.3559, 1.4659,
      1.5471, 1.6075, 1.6273, 1.7385, 1.8143, 1.9006, 1.9774, 2.0389, 2.1345, 2.211, 2.2993, 2.4146,
      2.4463, 2.5326, 2.6278, 2.7635, 2.8673, 2.8901, 2.9876, 3.0983, 3.2073, 3.2964, 3.3254,
      3.4593, 3.5632, 3.6518, 3.7384, 3.784, 3.8661, 3.9685, 4.0556, 4.2104, 4.229, 4.3174, 4.3912,
      4.5199, 4.5949, 4.6375, 4.7124, 4.8381, 4.931, 5.017, 5.0554, 5.2133, 5.3132, 5.4655, 5.5501,
      5.6254, 5.7067,
    ],
    hrs: [
      0.00265, 0.00338, 0.00437, 0.00539, 0.00644, 0.00817, 0.01029, 0.01296, 0.01474, 0.01552,
      0.01696, 0.01978, 0.02205, 0.02405, 0.02488, 0.02852, 0.031, 0.03377, 0.03596, 0.03769,
      0.04052, 0.04278, 0.04541, 0.04923, 0.05046, 0.05341, 0.05645, 0.06069, 0.06411, 0.06545,
      0.06937, 0.0739, 0.07785, 0.08092, 0.08261, 0.08865, 0.09257, 0.09635, 0.09939, 0.10209,
      0.106, 0.11041, 0.11524, 0.12204, 0.12313, 0.12873, 0.12947, 0.13114, 0.13513, 0.13629,
      0.1397, 0.14425, 0.14962, 0.15235, 0.15453, 0.16114, 0.16575, 0.17408, 0.17817, 0.17983,
      0.1833,
    ],
  },
};

/** Linear interpolation on the tier curve; tau is clamped to [1, TAU_MAX]. */
export function curve(tau: number, tier: SavingsTier, key: "usd" | "hrs"): number {
  const t = Math.max(1, Math.min(TAU_MAX, tau));
  const a = CURVE[tier][key];
  const lo = Math.floor(t);
  const hi = Math.ceil(t);
  const vLo = a[lo - 1] as number;
  const vHi = a[hi - 1] as number;
  return vLo + (vHi - vLo) * (t - lo);
}

/** Retired copies (`<name>-retired-YYYY-MM-DD`) are versions of one job. */
export function jobKey(name: string): string {
  return name.replace(/-retired-\d{4}-\d{2}-\d{2}$/, "");
}

/** Count of `await` in a script's source, as the ops a swarm-script node performs. */
export function scriptOpsFromAwaitCount(awaits: number): number {
  return Math.min(MAX_SCRIPT_OPS, Number(awaits) || 0);
}

type DefinitionNode = { id: string; type: string; config?: Record<string, unknown> };

/** Deterministic ops per node id. Agent-task, wait and control nodes count 0. */
export function nodeOpsOf(
  definition: { nodes?: DefinitionNode[] } | null | undefined,
  opsByScript: ReadonlyMap<string, number>,
): Map<string, number> {
  const ops = new Map<string, number>();
  for (const node of definition?.nodes ?? []) {
    let o = 0;
    if (node.type === "swarm-script") {
      const name = node.config?.scriptName;
      o = (typeof name === "string" ? opsByScript.get(name) : undefined) ?? DEFAULT_OPS;
    } else if (node.type === "script") {
      o = Math.max(1, (JSON.stringify(node.config ?? {}).match(/\bawait\b/g) ?? []).length);
    } else if (
      ["system-one-decision", "system-one-extraction", "raw-llm", "notify", "code-match"].includes(
        node.type,
      )
    ) {
      o = 1;
    }
    ops.set(node.id, o);
  }
  return ops;
}

/** Tier-independent facts about one workflow over a window. */
export type WorkflowFacts = {
  /** Every run that started in the window. */
  runs: number;
  /** Runs that were not skipped or cancelled. */
  countedRuns: number;
  /** Counted runs started by a schedule. */
  schedRuns: number;
  /** Of `schedRuns`, the runs that created an agent task or started a child workflow. */
  schedEffectRuns: number;
  /** Runs started by an event trigger. */
  eventRuns: number;
  /** Runs of any trigger and status that created an agent task or started a child workflow. */
  effectRuns: number;
  /** Deterministic ops summed over the steps of the effect runs. */
  effectOpsSum: number;
  /** Deterministic ops summed over every step of every run. */
  opsSum: number;
  agentTasks: number;
  /** Session cost of the agent tasks the runs created. */
  agentUsd: number;
  agentMs: number;
  /** Lead follow-up review cost of those agent tasks. */
  followupUsd: number;
  /** LLM cost a run reported itself (report node). */
  recordedLlmUsd: number;
  /** LLM cost estimated from SystemOne tokens and raw-llm output size. */
  estimatedLlmUsd: number;
  /** Wall time of the deterministic steps. */
  computeSecs: number;
};

export type PricedWorkflow = {
  /** True when the enabled-only rule priced only the effect runs. */
  enabledOnlyRule: boolean;
  runs: number;
  substitutedRuns: number;
  /** Schedule runs above the hourly cap that still count because they had an effect. */
  effectRuns: number;
  enabledOnlyRuns: number;
  capApplied: boolean;
  opsPerRun: number;
  /** Measured spend of every run in the window: agent tasks, their reviews, recorded LLM cost. */
  measuredUsd: number;
  /**
   * LLM spend estimated from tokens and output size, not measured. Zero when the
   * runs recorded their LLM cost, which then counts in `measuredUsd` instead.
   */
  estimatedLlmUsd: number;
  /**
   * Scaled estimate, not a measurement:
   * `(measuredUsd + estimatedLlmUsd) * substitutedRuns / runs`.
   * The estimator's actual side; it assumes spend is spread evenly over runs.
   */
  actualUsd: number;
  agentOnlyUsd: SavingsBand;
  savingUsd: SavingsBand;
  /** Scaled estimate like `actualUsd`: measured hours times the substituted share. */
  actualHours: number;
  agentOnlyHours: SavingsBand;
  hoursSaved: SavingsBand;
  /** What one substituted run would cost an agent at p50 (R * curve + review). */
  agentOnlyUsdPerRun: number;
};

/**
 * Split spend into measured and estimated. The window picks the LLM source
 * (`useRecorded`): when any run recorded its LLM cost, no day adds an estimate.
 */
function spendOf(
  facts: WorkflowFacts,
  useRecorded: boolean,
): { measuredUsd: number; estimatedLlmUsd: number } {
  return {
    measuredUsd: facts.agentUsd + facts.followupUsd + (useRecorded ? facts.recordedLlmUsd : 0),
    estimatedLlmUsd: useRecorded ? 0 : facts.estimatedLlmUsd,
  };
}

const bandOf = (fn: (q: Quantile) => number): SavingsBand => ({
  p10: fn("p10"),
  p50: fn("p50"),
  p90: fn("p90"),
});

/** Schedule runs one version of a job substitutes, and how many of them fit under the cap. */
export type ScheduleAllocation = { vSched: number; vCap: number };

/**
 * Share the hourly cap across the versions of one job (`jobKey`), in order.
 * A run with a downstream effect always counts, so the job total is
 * max(min(all schedule runs, cap), all effect runs). Same arithmetic as v7.
 */
export function allocateSchedule(
  versions: readonly Pick<WorkflowFacts, "schedRuns" | "schedEffectRuns">[],
  days: number,
): ScheduleAllocation[] {
  const cap = CAP_PER_DAY * days;
  let used = 0;
  let eff = 0;
  return versions.map((v) => {
    const vCap = Math.min(v.schedRuns, Math.max(0, cap - used));
    const vSched = Math.max(Math.min(used + v.schedRuns, cap), eff + v.schedEffectRuns) - used;
    used += vSched;
    eff += v.schedEffectRuns;
    return { vSched, vCap };
  });
}

/** The enabled-only rule (see ROUTER_MIN_RUNS_PER_DAY). */
export function isEnabledOnlyRouter(facts: WorkflowFacts, days: number): boolean {
  return (
    facts.runs > ROUTER_MIN_RUNS_PER_DAY * days &&
    facts.effectRuns < ROUTER_MAX_EFFECT_SHARE * facts.runs &&
    facts.eventRuns >= ROUTER_MIN_EVENT_SHARE * facts.runs
  );
}

/** A router run with an effect is one agent decision at the run's own ops; the job it starts is priced on its own row. */
function priceRouter(
  facts: WorkflowFacts,
  opts: { tier: SavingsTier; band: "job" | "fleet" },
): PricedWorkflow {
  const v = facts.effectRuns;
  const opsPerRun = v > 0 ? facts.effectOpsSum / v : 0;
  const tau = Math.min(TAU_MAX, T0 + K * opsPerRun);
  const unitUsd = v > 0 ? curve(tau, opts.tier, "usd") : 0;
  const unitHrs = v > 0 ? curve(tau, opts.tier, "hrs") : 0;
  const review = unitUsd > 0 ? F_FOLLOWUP : 0;
  const err = opts.band === "job" ? ERR_JOB : ERR_FLEET;
  const agentOnlyUsd = bandOf((q) => v * (R[q] * unitUsd * err[q] + review));
  const agentOnlyHours = bandOf((q) => v * R[q] * unitHrs * err[q]);
  return {
    enabledOnlyRule: true,
    runs: facts.runs,
    substitutedRuns: v,
    effectRuns: v,
    enabledOnlyRuns: facts.runs - v,
    capApplied: false,
    opsPerRun,
    // Measured spend is reported; the rule subtracts nothing (v7: the jobs
    // the router starts are priced, with their spend, on their own rows).
    ...spendOf(facts, facts.recordedLlmUsd > 0),
    actualUsd: 0,
    agentOnlyUsd,
    savingUsd: agentOnlyUsd,
    actualHours: 0,
    agentOnlyHours,
    hoursSaved: agentOnlyHours,
    agentOnlyUsdPerRun: R.p50 * unitUsd + review,
  };
}

/**
 * Price one workflow's facts at a tier. `band` picks the error spread: `job`
 * for a single job, `fleet` for a sum over many jobs. `allocation` carries the
 * cap shared with the job's other versions (`allocateSchedule`); without it the
 * workflow is the job's only version.
 */
export function priceWorkflow(
  facts: WorkflowFacts,
  opts: { tier: SavingsTier; days: number; band: "job" | "fleet" },
  allocation?: ScheduleAllocation,
): PricedWorkflow {
  if (isEnabledOnlyRouter(facts, opts.days)) return priceRouter(facts, opts);
  const runs = facts.runs;
  // Schedule runs: at most the hourly cap, but a run with a downstream effect always counts.
  const { vSched, vCap } =
    allocation ?? (allocateSchedule([facts], opts.days)[0] as ScheduleAllocation);
  const substituted = vSched + (facts.countedRuns - facts.schedRuns);
  const opsPerRun = runs > 0 ? facts.opsSum / runs : 0;
  const tau = Math.min(TAU_MAX, T0 + K * opsPerRun);
  // A pure agent dispatcher (no deterministic ops) substitutes nothing.
  const orchestrates = !(opsPerRun < 1 && facts.agentTasks > 0);
  const unitUsd = orchestrates ? curve(tau, opts.tier, "usd") : 0;
  const unitHrs = orchestrates ? curve(tau, opts.tier, "hrs") : 0;
  const review = unitUsd > 0 ? F_FOLLOWUP : 0;
  const share = runs > 0 ? substituted / runs : 0;
  const { measuredUsd, estimatedLlmUsd } = spendOf(facts, facts.recordedLlmUsd > 0);
  const keptUsd = (facts.agentUsd + facts.followupUsd) * share;
  const keptHours = (facts.agentMs / 3.6e6) * share;
  const actualUsd = (measuredUsd + estimatedLlmUsd) * share;
  const actualHours = (facts.agentMs / 3.6e6 + facts.computeSecs / 3600) * share;
  const err = opts.band === "job" ? ERR_JOB : ERR_FLEET;
  const agentOnlyUsd = bandOf((q) => keptUsd + substituted * (R[q] * unitUsd * err[q] + review));
  const agentOnlyHours = bandOf((q) => keptHours + substituted * R[q] * unitHrs * err[q]);
  return {
    enabledOnlyRule: false,
    runs,
    substitutedRuns: substituted,
    effectRuns: vSched - vCap,
    enabledOnlyRuns: runs - substituted,
    capApplied: vCap < facts.schedRuns,
    opsPerRun,
    measuredUsd,
    estimatedLlmUsd,
    actualUsd,
    agentOnlyUsd,
    savingUsd: bandOf((q) => agentOnlyUsd[q] - actualUsd),
    actualHours,
    agentOnlyHours,
    hoursSaved: bandOf((q) => agentOnlyHours[q] - actualHours),
    agentOnlyUsdPerRun: R.p50 * unitUsd + review,
  };
}

/**
 * Split a window's p50 saving, scaled actual cost, measured spend and
 * estimated LLM spend across the UTC days its runs started on, so the days
 * sum to `priceWorkflow` over the window. The unit
 * cost (tau), the substituted share and the LLM source are the window's.
 * When the hourly cap or the effect rule makes the window's counted schedule
 * runs differ from the raw ones, they are spread pro rata over the days'
 * schedule runs. A workflow priced by the enabled-only rule splits by its
 * days' effect runs.
 */
export function splitByDay(
  facts: WorkflowFacts,
  byDay: readonly (WorkflowFacts & { day: string })[],
  opts: { tier: SavingsTier; days: number },
  /** The window's pricing when it is already known (a cap shared with other versions). */
  pricedWindow?: PricedWorkflow,
): {
  day: string;
  savingUsd: number;
  actualUsd: number;
  measuredUsd: number;
  estimatedLlmUsd: number;
}[] {
  const priced = pricedWindow ?? priceWorkflow(facts, { ...opts, band: "job" });
  const useRecorded = facts.recordedLlmUsd > 0;
  // Enabled-only rule: each effect run is one decision at the window's unit cost.
  if (priced.enabledOnlyRule) {
    return byDay.map((d) => ({
      day: d.day,
      savingUsd: d.effectRuns * priced.agentOnlyUsdPerRun,
      actualUsd: 0,
      ...spendOf(d, useRecorded),
    }));
  }
  const runs = facts.runs;
  const share = runs > 0 ? priced.substitutedRuns / runs : 0;
  const nonSched = facts.countedRuns - facts.schedRuns;
  const vSched = priced.substitutedRuns - nonSched;
  // p50 agent-only cost of one substituted run (ERR_JOB.p50 is 1). The sum test pins this.
  const unitUsd = priced.agentOnlyUsdPerRun;
  return byDay.map((d) => {
    const substituted =
      (facts.schedRuns > 0 ? (vSched * d.schedRuns) / facts.schedRuns : 0) +
      (d.countedRuns - d.schedRuns);
    const { measuredUsd, estimatedLlmUsd } = spendOf(d, useRecorded);
    const keptUsd = (d.agentUsd + d.followupUsd) * share;
    const actualUsd = (measuredUsd + estimatedLlmUsd) * share;
    return {
      day: d.day,
      savingUsd: keptUsd + substituted * unitUsd - actualUsd,
      actualUsd,
      measuredUsd,
      estimatedLlmUsd,
    };
  });
}

/** Tier-independent facts about one script (by name) over a window. */
export type ScriptFacts = {
  /** Every run that started in the window. */
  runs: number;
  /** Runs started through an API endpoint: enabled-only unless they had an effect. */
  apiRuns: number;
  /** Non-API runs whose output names an agent task created while they ran. */
  effectRuns: number;
  /** API runs with such an effect. */
  apiEffectRuns: number;
  /** Ops summed over every run (ops per run times runs). */
  opsSum: number;
  /** Wall time of the runs. */
  computeSecs: number;
};

export type ScriptKind = "script-scheduled" | "script-agent-invoked";

/**
 * Price one script's facts at a tier, as v7 `scriptJobs` does. A scheduled
 * script (a schedule targets it) is a standalone agent task with a lead
 * review; any other script is priced as the extra turns it would add to the
 * calling agent's session (no bootstrap, no review). Non-API runs count at
 * most 24 a day, unless they had a downstream effect. An API run counts only
 * when it had an effect, then as a standalone decision with a review.
 * Scripts record no LLM spend and keep no agent active, so their actual
 * cost and agent-hours are 0.
 */
export function priceScript(
  facts: ScriptFacts,
  opts: { tier: SavingsTier; days: number; band: "job" | "fleet"; kind: ScriptKind },
): PricedWorkflow {
  const runs = facts.runs;
  const nonApi = runs - facts.apiRuns;
  const vCap = Math.min(nonApi, CAP_PER_DAY * opts.days);
  const v = Math.max(vCap, Math.min(nonApi, facts.effectRuns));
  const apiV = facts.apiEffectRuns;
  const opsPerRun = runs > 0 ? facts.opsSum / runs : 0;
  const tau = Math.min(TAU_MAX, T0 + K * opsPerRun);
  const fullUsd = curve(tau, opts.tier, "usd");
  const fullHrs = curve(tau, opts.tier, "hrs");
  const scheduled = opts.kind === "script-scheduled";
  const unitUsd = scheduled ? fullUsd : Math.max(0, fullUsd - curve(T0, opts.tier, "usd"));
  const unitHrs = scheduled ? fullHrs : Math.max(0, fullHrs - curve(T0, opts.tier, "hrs"));
  const review = scheduled ? F_FOLLOWUP : 0;
  const err = opts.band === "job" ? ERR_JOB : ERR_FLEET;
  const agentOnlyUsd = bandOf(
    (q) => v * (R[q] * unitUsd * err[q] + review) + apiV * (R[q] * fullUsd * err[q] + F_FOLLOWUP),
  );
  const agentOnlyHours = bandOf(
    (q) => v * R[q] * unitHrs * err[q] + apiV * R[q] * fullHrs * err[q],
  );
  // A script run keeps no agent active: scheduled and API runs have no agent,
  // and an agent-invoked run's wait is already inside the turns `unitHrs`
  // removes. v7 subtracted the runs' wall time, which made short runs negative.
  const actualHours = 0;
  return {
    enabledOnlyRule: false,
    runs,
    substitutedRuns: v + apiV,
    effectRuns: v - vCap + apiV,
    enabledOnlyRuns: runs - v - apiV,
    capApplied: vCap < nonApi,
    opsPerRun,
    measuredUsd: 0,
    estimatedLlmUsd: 0,
    actualUsd: 0,
    agentOnlyUsd,
    savingUsd: agentOnlyUsd,
    actualHours,
    agentOnlyHours,
    hoursSaved: bandOf((q) => agentOnlyHours[q] - actualHours),
    agentOnlyUsdPerRun: R.p50 * unitUsd + review,
  };
}

/**
 * Split a script's window p50 saving across the UTC days its runs started
 * on, so the days sum to `priceScript` over the window. Counted non-API runs
 * are spread pro rata over the days' non-API runs; API effect runs count on
 * their own day.
 */
export function splitScriptByDay(
  facts: ScriptFacts,
  byDay: readonly (ScriptFacts & { day: string })[],
  priced: PricedWorkflow,
): {
  day: string;
  savingUsd: number;
  actualUsd: number;
  measuredUsd: number;
  estimatedLlmUsd: number;
}[] {
  const nonApi = facts.runs - facts.apiRuns;
  const v = priced.substitutedRuns - facts.apiEffectRuns;
  const apiUnit =
    facts.apiEffectRuns > 0
      ? (priced.agentOnlyUsd.p50 - v * priced.agentOnlyUsdPerRun) / facts.apiEffectRuns
      : 0;
  return byDay.map((d) => ({
    day: d.day,
    savingUsd:
      (nonApi > 0 ? (v * (d.runs - d.apiRuns)) / nonApi : 0) * priced.agentOnlyUsdPerRun +
      d.apiEffectRuns * apiUnit,
    actualUsd: 0,
    measuredUsd: 0,
    estimatedLlmUsd: 0,
  }));
}
