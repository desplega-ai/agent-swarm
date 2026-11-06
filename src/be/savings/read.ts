/**
 * Read path of the savings rollup: sums the daily buckets of a window, shares
 * the schedule cap across the versions of a job, applies the enabled-only rule
 * and prices at the requested tier. All of that happens at read time, so a
 * tier or window change needs no recomputation.
 */
import { getDbClient } from "../db";
import type { DbParam } from "../db-client";
import {
  allocateSchedule,
  INLINE_SCRIPT_NAME,
  isEnabledOnlyRouter,
  MODEL_VERSION,
  type PricedWorkflow,
  priceScript,
  priceWorkflow,
  type SavingsBand,
  type SavingsTier,
  type ScheduleAllocation,
  type ScriptFacts,
  type ScriptKind,
  splitByDay,
  splitScriptByDay,
  type WorkflowFacts,
} from "./model";
import { dayStartIso, SAVINGS_FACT_COLUMNS, savingsRollupGeneration, utcDay } from "./rollup";

const DAY_MS = 86_400_000;

export type SavingsWindow = { start: string; end: string; days: number };

export type WorkflowSavingsRow = PricedWorkflow & { workflowId: string; name: string };

export type SavingsTotals = {
  runs: number;
  substitutedRuns: number;
  enabledOnlyRuns: number;
  measuredUsd: number;
  estimatedLlmUsd: number;
  actualUsd: number;
  agentOnlyUsd: SavingsBand;
  savingUsd: SavingsBand;
  actualHours: number;
  hoursSaved: SavingsBand;
};

export type SavingsDailyPoint = {
  day: string;
  savingUsd: number;
  actualUsd: number;
  measuredUsd: number;
  estimatedLlmUsd: number;
};

export type WorkflowSavingsRead = {
  window: SavingsWindow;
  /** Newest rollup time of the window's days; null before the first rollup. */
  computedAt: string | null;
  /** Every day of the window has been computed under the current model version. */
  complete: boolean;
  rows: WorkflowSavingsRow[];
  total: SavingsTotals | null;
  /** p50 per UTC day of the window, oldest first, summed over the rows; they add up to the total. */
  points: SavingsDailyPoint[];
};

type BucketRow = WorkflowFacts & { day: string; jobId: string; jobKey: string; jobName: string };
type Job = {
  workflowId: string;
  jobKey: string;
  name: string;
  facts: WorkflowFacts;
  days: BucketRow[];
};

const zeroFacts = (): WorkflowFacts => ({
  runs: 0,
  countedRuns: 0,
  schedRuns: 0,
  schedEffectRuns: 0,
  eventRuns: 0,
  effectRuns: 0,
  effectOpsSum: 0,
  opsSum: 0,
  agentTasks: 0,
  agentUsd: 0,
  agentMs: 0,
  followupUsd: 0,
  recordedLlmUsd: 0,
  estimatedLlmUsd: 0,
  computeSecs: 0,
});

function addFacts(into: WorkflowFacts, row: WorkflowFacts): void {
  for (const c of SAVINGS_FACT_COLUMNS) into[c] += Number(row[c]) || 0;
}

/** The window: the last `days` UTC days, today included, ending now. */
export function savingsWindow(days: number, now: number): SavingsWindow & { firstDay: string } {
  const firstDay = utcDay(now - (days - 1) * DAY_MS);
  return { start: dayStartIso(firstDay), end: new Date(now).toISOString(), days, firstDay };
}

const isRetired = (name: string) => /-retired-\d{4}-\d{2}-\d{2}$/.test(name);

/** At most this many UTC days of buckets per synchronous query. */
const CHUNK_DAYS = 3;
/** Jobs priced between two event-loop yields. */
const PRICE_BATCH = 100;
/** A cached fleet read is reused at most this long, even when nothing bumped. */
const FLEET_CACHE_TTL_MS = 60_000;

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Run a bucket query over the window in CHUNK_DAYS slices and fold each slice
 * with `onRows`, yielding to the event loop between them: a fleet window is
 * ~100k rows, and one synchronous read and fold of them stalls every other
 * request. `params` gets each slice's bounds; slices arrive oldest first.
 */
async function forEachDayChunk<T>(
  sql: string,
  params: (from: string, to: string) => DbParam[],
  firstDay: string,
  lastDay: string,
  onRows: (rows: T[]) => void,
): Promise<void> {
  for (let from = firstDay; from <= lastDay; ) {
    const toMs = Math.min(
      Date.parse(dayStartIso(from)) + (CHUNK_DAYS - 1) * DAY_MS,
      Date.parse(dayStartIso(lastDay)),
    );
    if (from !== firstDay) await yieldLoop();
    onRows(await getDbClient().query<T>(sql, params(from, utcDay(toMs))));
    from = utcDay(toMs + DAY_MS);
  }
}

/** The priced part of a read, shared by every band: the band only picks the total. */
type PricedCore<R> = {
  computedAt: string | null;
  rows: R[];
  jobTotal: SavingsTotals | null;
  fleetTotal: SavingsTotals | null;
  points: SavingsDailyPoint[];
};

type FleetCacheEntry = { fingerprint: string; at: number; value: Promise<PricedCore<unknown>> };
const fleetCache = new Map<string, FleetCacheEntry>();
let fleetLoads = 0;

/** Test hook: forget cached fleet reads. */
export function resetSavingsReadCache(): void {
  fleetCache.clear();
  fleetLoads = 0;
}

/** Test hook: how many fleet reads hit the database since the last reset. */
export const savingsFleetLoads = (): number => fleetLoads;

/**
 * One load per window, tier and rollup state: concurrent readers (the fleet
 * page fires four) share the in-flight promise, and later ones reuse the
 * result until a rollup write changes the fingerprint or the TTL runs out.
 */
function cachedFleet<R>(
  key: string,
  fingerprint: string,
  load: () => Promise<PricedCore<R>>,
): Promise<PricedCore<R>> {
  const now = Date.now();
  const hit = fleetCache.get(key);
  if (hit && hit.fingerprint === fingerprint && now - hit.at < FLEET_CACHE_TTL_MS) {
    return hit.value as Promise<PricedCore<R>>;
  }
  for (const [k, e] of fleetCache) if (now - e.at >= FLEET_CACHE_TTL_MS) fleetCache.delete(k);
  fleetLoads++;
  const value = load();
  const entry: FleetCacheEntry = { fingerprint, at: now, value };
  fleetCache.set(key, entry);
  value.catch(() => {
    if (fleetCache.get(key) === entry) fleetCache.delete(key);
  });
  return value;
}

/**
 * Price the workflows of a window from the rollup: every workflow when
 * `workflowId` is absent, else that one (its job's other versions still share
 * the schedule cap). `band: "fleet"` prices the total with the fleet spread
 * even for one row, for a caller that adds it to other totals.
 */
export async function readWorkflowSavings(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
  workflowId?: string;
  band?: "fleet";
}): Promise<WorkflowSavingsRead> {
  const client = getDbClient();
  const { firstDay, ...window } = savingsWindow(opts.days, opts.now);
  const lastDay = utcDay(opts.now);
  const marker = await client.get<{ n: number; at: string | null }>(
    "SELECT count(*) n, max(computedAt) at FROM automation_savings_days WHERE jobKind='workflow' AND modelVersion=? AND day>=? AND day<=?",
    [MODEL_VERSION, firstDay, lastDay],
  );
  const complete = Number(marker?.n) >= opts.days;
  const markerAt = marker?.at ?? null;
  const scope = { days: opts.days, tier: opts.tier, firstDay, lastDay, markerAt };

  let core: PricedCore<WorkflowSavingsRow>;
  if (opts.workflowId) {
    const own = await client.get<{ jobKey: string }>(
      "SELECT jobKey FROM automation_savings_daily WHERE jobKind='workflow' AND jobId=? AND day>=? AND day<=? LIMIT 1",
      [opts.workflowId, firstDay, lastDay],
    );
    if (!own) {
      return { window, computedAt: markerAt, complete, rows: [], total: null, points: [] };
    }
    core = await priceWorkflowBuckets({
      ...scope,
      jobKey: own.jobKey,
      workflowId: opts.workflowId,
    });
  } else {
    core = await cachedFleet(
      `workflow:${opts.days}:${opts.tier}:${firstDay}:${lastDay}`,
      `${savingsRollupGeneration()}:${marker?.n}:${markerAt}`,
      () => priceWorkflowBuckets(scope),
    );
  }
  const band = opts.band ?? (core.rows.length === 1 ? "job" : "fleet");
  return {
    window,
    computedAt: core.computedAt,
    complete,
    rows: [...core.rows],
    total: band === "job" ? core.jobTotal : core.fleetTotal,
    points: [...core.points],
  };
}

async function priceWorkflowBuckets(scope: {
  days: number;
  tier: SavingsTier;
  firstDay: string;
  lastDay: string;
  markerAt: string | null;
  jobKey?: string;
  workflowId?: string;
}): Promise<PricedCore<WorkflowSavingsRow>> {
  const keyFilter = scope.jobKey !== undefined ? "AND jobKey=?" : "";
  let computedAt = scope.markerAt;
  const jobs = new Map<string, Job>();
  const fold = (buckets: (BucketRow & { computedAt: string })[]) => {
    for (const b of buckets) {
      if (!computedAt || b.computedAt > computedAt) computedAt = b.computedAt;
      let job = jobs.get(b.jobId);
      if (!job) {
        job = {
          workflowId: b.jobId,
          jobKey: b.jobKey,
          name: b.jobName,
          facts: zeroFacts(),
          days: [],
        };
        jobs.set(b.jobId, job);
      }
      // The newest bucket carries the current name.
      job.name = b.jobName;
      addFacts(job.facts, b);
      job.days.push(b);
    }
  };
  await forEachDayChunk(
    `SELECT day, jobId, jobKey, jobName, computedAt, ${SAVINGS_FACT_COLUMNS.join(", ")}
     FROM automation_savings_daily
     WHERE jobKind='workflow' AND subKind='' AND modelVersion=? AND day>=? AND day<=? ${keyFilter}
     ORDER BY day`,
    (from, to) => [MODEL_VERSION, from, to, ...(scope.jobKey !== undefined ? [scope.jobKey] : [])],
    scope.firstDay,
    scope.lastDay,
    fold,
  );

  // Versions of one job share the schedule cap: the live version first, then
  // retired copies by name. A version priced by the enabled-only rule takes no
  // share of the cap.
  const allocations = new Map<string, ScheduleAllocation>();
  const byKey = new Map<string, Job[]>();
  for (const job of jobs.values()) {
    if (isEnabledOnlyRouter(job.facts, scope.days)) continue;
    byKey.set(job.jobKey, [...(byKey.get(job.jobKey) ?? []), job]);
  }
  for (const versions of byKey.values()) {
    versions.sort(
      (a, b) =>
        Number(isRetired(a.name)) - Number(isRetired(b.name)) || a.name.localeCompare(b.name),
    );
    const shares = allocateSchedule(
      versions.map((v) => v.facts),
      scope.days,
    );
    versions.forEach((v, i) => {
      allocations.set(v.workflowId, shares[i] as ScheduleAllocation);
    });
  }

  const selected = [...jobs.values()].filter(
    (j) => !scope.workflowId || j.workflowId === scope.workflowId,
  );
  const rows: WorkflowSavingsRow[] = [];
  const jobParts: PricedWorkflow[] = [];
  const fleetParts: PricedWorkflow[] = [];
  const dayParts: SavingsDailyPoint[][] = [];
  const pricing = { tier: scope.tier, days: scope.days };
  for (const [i, job] of selected.entries()) {
    if (i > 0 && i % PRICE_BATCH === 0) await yieldLoop();
    const allocation = allocations.get(job.workflowId);
    const priced = priceWorkflow(job.facts, { ...pricing, band: "job" }, allocation);
    rows.push({ ...priced, workflowId: job.workflowId, name: job.name });
    jobParts.push(priced);
    fleetParts.push(priceWorkflow(job.facts, { ...pricing, band: "fleet" }, allocation));
    dayParts.push(splitByDay(job.facts, job.days, pricing, priced));
  }
  rows.sort((a, b) => b.savingUsd.p50 - a.savingUsd.p50);

  return {
    computedAt,
    rows,
    jobTotal: jobParts.length > 0 ? sumTotals(jobParts) : null,
    fleetTotal: fleetParts.length > 0 ? sumTotals(fleetParts) : null,
    points: rows.length > 0 ? fillDays(dayParts.flat(), scope.firstDay, scope.days) : [],
  };
}

function sumBand(parts: SavingsBand[]): SavingsBand {
  return {
    p10: parts.reduce((s, b) => s + b.p10, 0),
    p50: parts.reduce((s, b) => s + b.p50, 0),
    p90: parts.reduce((s, b) => s + b.p90, 0),
  };
}

function sumTotals(parts: PricedWorkflow[]): SavingsTotals {
  return {
    runs: parts.reduce((s, p) => s + p.runs, 0),
    substitutedRuns: parts.reduce((s, p) => s + p.substitutedRuns, 0),
    enabledOnlyRuns: parts.reduce((s, p) => s + p.enabledOnlyRuns, 0),
    measuredUsd: parts.reduce((s, p) => s + p.measuredUsd, 0),
    estimatedLlmUsd: parts.reduce((s, p) => s + p.estimatedLlmUsd, 0),
    actualUsd: parts.reduce((s, p) => s + p.actualUsd, 0),
    agentOnlyUsd: sumBand(parts.map((p) => p.agentOnlyUsd)),
    savingUsd: sumBand(parts.map((p) => p.savingUsd)),
    actualHours: parts.reduce((s, p) => s + p.actualHours, 0),
    hoursSaved: sumBand(parts.map((p) => p.hoursSaved)),
  };
}

/** One point per day of the window, adding up the points of each day; days without runs are zero. */
function fillDays(
  points: SavingsDailyPoint[],
  firstDay: string,
  windowDays: number,
): SavingsDailyPoint[] {
  const days = Array.from({ length: windowDays }, (_, i) => {
    const day = utcDay(Date.parse(dayStartIso(firstDay)) + i * DAY_MS);
    return { day, savingUsd: 0, actualUsd: 0, measuredUsd: 0, estimatedLlmUsd: 0 };
  });
  const byDay = new Map(days.map((p) => [p.day, p]));
  for (const p of points) {
    const d = byDay.get(p.day);
    if (!d) continue;
    d.savingUsd += p.savingUsd;
    d.actualUsd += p.actualUsd;
    d.measuredUsd += p.measuredUsd;
    d.estimatedLlmUsd += p.estimatedLlmUsd;
  }
  return days;
}

export type ScriptSavingsRow = PricedWorkflow & {
  kind: ScriptKind;
  scriptName: string;
  name: string;
};

export type ScriptSavingsRead = Omit<WorkflowSavingsRead, "rows"> & { rows: ScriptSavingsRow[] };

/** A script name the savings route answers for: one in the catalog, or the inline-source bucket. */
export async function isKnownScriptName(name: string): Promise<boolean> {
  if (name === INLINE_SCRIPT_NAME) return true;
  return !!(await getDbClient().get<{ n: number }>("SELECT 1 n FROM scripts WHERE name=? LIMIT 1", [
    name,
  ]));
}

const zeroScriptFacts = (): ScriptFacts => ({
  runs: 0,
  apiRuns: 0,
  effectRuns: 0,
  apiEffectRuns: 0,
  opsSum: 0,
  computeSecs: 0,
});

type ScriptBucketRow = {
  day: string;
  jobId: string;
  subKind: string;
  computedAt: string;
  runs: number;
  effectRuns: number;
  opsSum: number;
  computeSecs: number;
};

/** Fold a bucket row (subKind '' = non-API runs, 'api' = API runs) into script facts. */
function addScriptBucket(into: ScriptFacts, b: ScriptBucketRow): void {
  const runs = Number(b.runs) || 0;
  const effect = Number(b.effectRuns) || 0;
  into.runs += runs;
  into.opsSum += Number(b.opsSum) || 0;
  into.computeSecs += Number(b.computeSecs) || 0;
  if (b.subKind === "api") {
    into.apiRuns += runs;
    into.apiEffectRuns += effect;
  } else {
    into.effectRuns += effect;
  }
}

/**
 * Price the scripts of a window from the rollup: every script name when
 * `scriptName` is absent, else that one. A script is "scheduled" when a
 * schedule targets it now (v7 reads the same at run time); scripts are keyed
 * by name, so an agent-scoped and a global script of one name share a row.
 */
export async function readScriptSavings(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
  scriptName?: string;
  /** As in `readWorkflowSavings`. */
  band?: "fleet";
}): Promise<ScriptSavingsRead> {
  const client = getDbClient();
  const { firstDay, ...window } = savingsWindow(opts.days, opts.now);
  const lastDay = utcDay(opts.now);
  const marker = await client.get<{ n: number; at: string | null }>(
    "SELECT count(*) n, max(computedAt) at FROM automation_savings_days WHERE jobKind='script' AND modelVersion=? AND day>=? AND day<=?",
    [MODEL_VERSION, firstDay, lastDay],
  );
  const complete = Number(marker?.n) >= opts.days;
  const scheduled = (
    await client.query<{ scriptName: string }>(
      "SELECT DISTINCT scriptName FROM scheduled_tasks WHERE targetType='script' AND scriptName IS NOT NULL ORDER BY scriptName",
    )
  ).map((r) => r.scriptName);
  const scope = {
    days: opts.days,
    tier: opts.tier,
    firstDay,
    lastDay,
    markerAt: marker?.at ?? null,
    scheduled: new Set(scheduled),
    scriptName: opts.scriptName,
  };
  const core =
    opts.scriptName !== undefined
      ? await priceScriptBuckets(scope)
      : await cachedFleet(
          `script:${opts.days}:${opts.tier}:${firstDay}:${lastDay}`,
          `${savingsRollupGeneration()}:${marker?.n}:${scope.markerAt}:${JSON.stringify(scheduled)}`,
          () => priceScriptBuckets(scope),
        );
  const band = opts.band ?? (core.rows.length === 1 ? "job" : "fleet");
  return {
    window,
    computedAt: core.computedAt,
    complete,
    rows: [...core.rows],
    total: band === "job" ? core.jobTotal : core.fleetTotal,
    points: [...core.points],
  };
}

async function priceScriptBuckets(scope: {
  days: number;
  tier: SavingsTier;
  firstDay: string;
  lastDay: string;
  markerAt: string | null;
  scheduled: Set<string>;
  scriptName?: string;
}): Promise<PricedCore<ScriptSavingsRow>> {
  const byName = scope.scriptName !== undefined;
  let computedAt = scope.markerAt;
  const jobs = new Map<string, { facts: ScriptFacts; days: Map<string, ScriptFacts> }>();
  await forEachDayChunk<ScriptBucketRow>(
    `SELECT day, jobId, subKind, computedAt, runs, effectRuns, opsSum, computeSecs
     FROM automation_savings_daily
     WHERE jobKind='script' AND modelVersion=? AND day>=? AND day<=? ${byName ? "AND jobId=?" : ""}
     ORDER BY day`,
    (from, to) => [MODEL_VERSION, from, to, ...(byName ? [scope.scriptName as string] : [])],
    scope.firstDay,
    scope.lastDay,
    (buckets) => {
      for (const b of buckets) {
        if (!computedAt || b.computedAt > computedAt) computedAt = b.computedAt;
        let job = jobs.get(b.jobId);
        if (!job) {
          job = { facts: zeroScriptFacts(), days: new Map() };
          jobs.set(b.jobId, job);
        }
        addScriptBucket(job.facts, b);
        const day = job.days.get(b.day) ?? zeroScriptFacts();
        addScriptBucket(day, b);
        job.days.set(b.day, day);
      }
    },
  );

  const rows: ScriptSavingsRow[] = [];
  const jobParts: PricedWorkflow[] = [];
  const fleetParts: PricedWorkflow[] = [];
  const dayParts: SavingsDailyPoint[][] = [];
  let i = 0;
  for (const [scriptName, job] of jobs) {
    if (i > 0 && i % PRICE_BATCH === 0) await yieldLoop();
    i++;
    const kind: ScriptKind = scope.scheduled.has(scriptName)
      ? "script-scheduled"
      : "script-agent-invoked";
    const pricing = { tier: scope.tier, days: scope.days, kind };
    const priced = priceScript(job.facts, { ...pricing, band: "job" });
    rows.push({ ...priced, kind, scriptName, name: scriptName });
    jobParts.push(priced);
    fleetParts.push(priceScript(job.facts, { ...pricing, band: "fleet" }));
    dayParts.push(
      splitScriptByDay(
        job.facts,
        [...job.days].map(([day, f]) => ({ ...f, day })),
        priced,
      ),
    );
  }
  rows.sort((a, b) => b.savingUsd.p50 - a.savingUsd.p50);

  return {
    computedAt,
    rows,
    jobTotal: jobParts.length > 0 ? sumTotals(jobParts) : null,
    fleetTotal: fleetParts.length > 0 ? sumTotals(fleetParts) : null,
    points: rows.length > 0 ? fillDays(dayParts.flat(), scope.firstDay, scope.days) : [],
  };
}

export type FleetKindTotals = {
  jobs: number;
  runs: number;
  substitutedRuns: number;
  /** p50 */
  savingUsd: number;
  /** p50 */
  hoursSaved: number;
};

export type FleetSavingsRead = Omit<WorkflowSavingsRead, "rows"> & {
  workflows: WorkflowSavingsRow[];
  scripts: ScriptSavingsRow[];
  byKind: {
    workflows: FleetKindTotals;
    scheduledScripts: FleetKindTotals;
    agentInvokedScripts: FleetKindTotals;
  };
};

function kindTotals(rows: PricedWorkflow[]): FleetKindTotals {
  return {
    jobs: rows.length,
    runs: rows.reduce((s, r) => s + r.runs, 0),
    substitutedRuns: rows.reduce((s, r) => s + r.substitutedRuns, 0),
    savingUsd: rows.reduce((s, r) => s + r.savingUsd.p50, 0),
    hoursSaved: rows.reduce((s, r) => s + r.hoursSaved.p50, 0),
  };
}

function addTotals(a: SavingsTotals, b: SavingsTotals): SavingsTotals {
  const band = (x: SavingsBand, y: SavingsBand) => sumBand([x, y]);
  return {
    runs: a.runs + b.runs,
    substitutedRuns: a.substitutedRuns + b.substitutedRuns,
    enabledOnlyRuns: a.enabledOnlyRuns + b.enabledOnlyRuns,
    measuredUsd: a.measuredUsd + b.measuredUsd,
    estimatedLlmUsd: a.estimatedLlmUsd + b.estimatedLlmUsd,
    actualUsd: a.actualUsd + b.actualUsd,
    agentOnlyUsd: band(a.agentOnlyUsd, b.agentOnlyUsd),
    savingUsd: band(a.savingUsd, b.savingUsd),
    actualHours: a.actualHours + b.actualHours,
    hoursSaved: band(a.hoursSaved, b.hoursSaved),
  };
}

/**
 * The fleet: every workflow and every script of the window. The total uses
 * the fleet band unless the fleet is one job; the daily points add up to its p50.
 */
export async function readFleetSavings(opts: {
  days: number;
  tier: SavingsTier;
  now: number;
}): Promise<FleetSavingsRead> {
  const wf = await readWorkflowSavings({ ...opts, band: "fleet" });
  const sc = await readScriptSavings({ ...opts, band: "fleet" });
  const all: PricedWorkflow[] = [...wf.rows, ...sc.rows];
  const total =
    all.length === 1
      ? sumTotals(all)
      : wf.total && sc.total
        ? addTotals(wf.total, sc.total)
        : (wf.total ?? sc.total);
  const points =
    all.length > 0
      ? fillDays(
          [...wf.points, ...sc.points],
          savingsWindow(opts.days, opts.now).firstDay,
          opts.days,
        )
      : [];
  const computedAt =
    wf.computedAt && sc.computedAt
      ? wf.computedAt > sc.computedAt
        ? wf.computedAt
        : sc.computedAt
      : (wf.computedAt ?? sc.computedAt);
  return {
    window: wf.window,
    computedAt,
    complete: wf.complete && sc.complete,
    workflows: wf.rows,
    scripts: sc.rows,
    total,
    points,
    byKind: {
      workflows: kindTotals(wf.rows),
      scheduledScripts: kindTotals(sc.rows.filter((r) => r.kind === "script-scheduled")),
      agentInvokedScripts: kindTotals(sc.rows.filter((r) => r.kind === "script-agent-invoked")),
    },
  };
}

/** Session spend of the whole swarm in the window, the same sum the usage page shows. */
export async function readFleetLlmUsd(window: SavingsWindow): Promise<number> {
  const row = await getDbClient().get<{ usd: number | null }>(
    "SELECT sum(totalCostUsd) usd FROM session_costs WHERE createdAt>=? AND createdAt<=?",
    [window.start, window.end],
  );
  return Number(row?.usd) || 0;
}
