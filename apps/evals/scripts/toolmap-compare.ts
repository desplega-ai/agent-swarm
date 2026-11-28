/**
 * toolmap-compare: the ship gates for harness tool mappings (plan Phase 5).
 *
 * Reads two finished runs of the same scenarios and configs, one per arm
 * (`run --worker-env HARNESS_TOOL_MAPPINGS_ENABLED=false|true`), and scores the
 * treatment arm against control per harness. Measured post hoc from each
 * attempt's stored `tasks.json`, `session-logs.jsonl` (upfront tasks) and
 * `spawned-session-logs.json` (child, follow-up and wake-up tasks) artifacts, so
 * the scenarios themselves need no change.
 *
 * Usage:
 *   cd apps/evals && bun scripts/toolmap-compare.ts --control <run id|name> --treatment <run id|name> [--out <dir>]
 *
 * Writes toolmap-report.md and toolmap-report.json to --out (default: cwd).
 * Exits 1 when any gate is FAIL or NO DATA, and before any gate when the inputs
 * are not a valid pair (`validateArms`) or an attempt's evidence is incomplete
 * (`attemptEvidence`): the report then lists the problems and no gates.
 *
 * The validation, extraction and gate math are pure functions so the unit test
 * feeds synthetic runs and attempts; DB I/O lives in `main()`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  countNativeComms,
  countNativeSpawns,
  countSwarmDispatch,
  memberCreatedTasks,
  swarmToolSlug,
} from "../scenarios/orchestration-utils.ts";
import { EXPERIMENT_SCENARIO_IDS } from "../scenarios/suite.ts";
import { parseToolUses } from "../src/judge/session-log-parse.ts";
import { parseSpawnedLogs, SPAWNED_LOGS_ARTIFACT } from "../src/runner/spawned-logs.ts";
import { bootstrapDiffCI } from "../src/stats.ts";
import type { SessionLogRow } from "../src/swarm/client.ts";
import type { AttemptRow, EvalRunRow, SwarmTask } from "../src/types.ts";

export type Arm = "control" | "treatment";

/** Worker-created tasks a correct run makes, per scenario (default 0). */
export const EXPECTED_WORKER_TASKS: Readonly<Record<string, number>> = {
  "tool-mapping-worker-comms": 1,
};

const COMMS_SCENARIO = "tool-mapping-worker-comms";

/** The worker env flag the two arms differ on. */
export const FLAG = "HARNESS_TOOL_MAPPINGS_ENABLED";

/** Plan Phase 4: rerun any cell with more excluded attempts than this. */
export const MAX_EXCLUDED_PER_CELL = 2;

/** The run row fields a valid pair must agree on. */
export interface ArmRun {
  run: Pick<EvalRunRow, "id" | "status" | "scenarioIds" | "configIds" | "workerEnv" | "efforts">;
  /** config id -> pinned resolved model (eval_run_configs). */
  pins: Record<string, string>;
  attempts: Pick<AttemptRow, "id" | "scenarioId" | "configId" | "scenarioVersion" | "status">[];
}

const TERMINAL = new Set(["passed", "failed", "error"]);
const canon = (v: Record<string, unknown> | null | undefined): string =>
  JSON.stringify(Object.entries(v ?? {}).sort(([a], [b]) => a.localeCompare(b)));
const sameSet = (a: string[], b: string[]): boolean =>
  JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

/**
 * Why the two runs are not a valid A/B pair; empty when they are. Both arms must
 * be finished runs of the same matrix, effort, pinned models and worker env,
 * differing only in an explicit flag value (false vs true), and every declared
 * cell must hold scored attempts at one shared scenario version.
 */
export function validateArms(control: ArmRun, treatment: ArmRun): string[] {
  const problems: string[] = [];
  const c = control.run;
  const t = treatment.run;
  if (c.id === t.id) problems.push(`control and treatment are the same run (${c.id})`);
  for (const [arm, r] of [
    ["control", c],
    ["treatment", t],
  ] as const) {
    if (r.status !== "done") problems.push(`${arm} run ${r.id} is ${r.status}, not done`);
  }
  const flag = (r: ArmRun["run"]) => r.workerEnv?.[FLAG];
  if (flag(c) !== "false")
    problems.push(`control run must set ${FLAG}=false, has ${flag(c) ?? "unset"}`);
  if (flag(t) !== "true")
    problems.push(`treatment run must set ${FLAG}=true, has ${flag(t) ?? "unset"}`);
  const otherEnv = (r: ArmRun["run"]) => canon({ ...r.workerEnv, [FLAG]: null });
  if (otherEnv(c) !== otherEnv(t)) problems.push("the arms' worker env differs beyond the flag");
  if (!sameSet(c.scenarioIds, t.scenarioIds)) problems.push("the arms ran different scenarios");
  if (!sameSet(c.configIds, t.configIds)) problems.push("the arms ran different configs");
  if (canon(c.efforts) !== canon(t.efforts))
    problems.push("the arms ran different reasoning efforts");
  if (canon(control.pins) !== canon(treatment.pins))
    problems.push("the arms pinned different models");
  const missing = EXPERIMENT_SCENARIO_IDS.filter(
    (s) => !c.scenarioIds.includes(s) || !t.scenarioIds.includes(s),
  );
  if (missing.length) problems.push(`required scenario(s) missing: ${missing.join(", ")}`);

  const versions = new Map<string, string>();
  for (const [arm, a] of [
    ["control", control],
    ["treatment", treatment],
  ] as const) {
    const declared = new Set(
      a.run.scenarioIds.flatMap((s) => a.run.configIds.map((cfg) => `${s} × ${cfg}`)),
    );
    for (const x of a.attempts) {
      if (!declared.has(`${x.scenarioId} × ${x.configId}`))
        problems.push(`${arm} attempt ${x.id} is outside the run's matrix`);
    }
    for (const cell of declared) {
      const cellAttempts = a.attempts.filter((x) => `${x.scenarioId} × ${x.configId}` === cell);
      const open = cellAttempts.filter((x) => !TERMINAL.has(x.status));
      const excluded = cellAttempts.filter((x) => x.status === "error").length;
      const kept = cellAttempts.length - excluded - open.length;
      if (cellAttempts.length === 0) problems.push(`${arm} cell ${cell} has no attempts`);
      else if (open.length)
        problems.push(`${arm} cell ${cell} has ${open.length} unfinished attempt(s)`);
      else if (kept === 0) problems.push(`${arm} cell ${cell} has every attempt excluded`);
      if (excluded > MAX_EXCLUDED_PER_CELL)
        problems.push(
          `${arm} cell ${cell} has ${excluded} excluded attempts (max ${MAX_EXCLUDED_PER_CELL})`,
        );
      const vs = [...new Set(cellAttempts.map((x) => String(x.scenarioVersion ?? "none")))];
      if (vs.length > 1)
        problems.push(`${arm} cell ${cell} mixes scenario versions ${vs.join(", ")}`);
      const prior = versions.get(cell);
      if (prior === undefined) versions.set(cell, vs.join(","));
      else if (vs.length && prior !== vs.join(","))
        problems.push(
          `cell ${cell} ran scenario version ${prior} in control, ${vs.join(",")} in treatment`,
        );
    }
  }
  return problems;
}

/** One stored artifact, as listArtifacts returns it. */
export interface StoredArtifact {
  kind: string;
  name: string | null;
  content?: string | null;
}

/** Same cap as the runner's raw-session-logs slice: a full artifact may be cut. */
const RAW_LOGS_CAP = 2_000_000;

/**
 * Tasks and every run task's session-log rows for one scored attempt, plus why
 * that evidence is incomplete (empty = complete). `upfrontTaskIds` is the
 * attempt's `taskIds`, the set raw-session-logs covers; every other run task in
 * tasks.json must be covered by the spawned-logs artifact.
 */
export function attemptEvidence(
  upfrontTaskIds: string[],
  artifacts: StoredArtifact[],
): { tasks: SwarmTask[]; logRows: SessionLogRow[]; problems: string[] } {
  const problems: string[] = [];
  let tasks: SwarmTask[] = [];
  const tasksArtifact = artifacts.find((x) => x.kind === "task" && x.name === "tasks.json");
  try {
    if (!tasksArtifact?.content) problems.push("tasks.json missing");
    else tasks = JSON.parse(tasksArtifact.content) as SwarmTask[];
  } catch {
    problems.push("tasks.json unparseable");
  }

  const logRows: SessionLogRow[] = [];
  const raw = artifacts.find((x) => x.kind === "raw-session-logs")?.content;
  if (!raw) problems.push("session-logs.jsonl missing");
  else {
    let bad = raw.length >= RAW_LOGS_CAP;
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        logRows.push(JSON.parse(line) as SessionLogRow);
      } catch {
        bad = true;
      }
    }
    if (bad) problems.push("session-logs.jsonl truncated or corrupt");
  }

  const covered = new Set(upfrontTaskIds);
  const spawnedContent = artifacts.find(
    (x) => x.kind === "meta" && x.name === SPAWNED_LOGS_ARTIFACT,
  )?.content;
  const spawned = spawnedContent ? parseSpawnedLogs(spawnedContent) : null;
  if (!spawnedContent)
    problems.push(`${SPAWNED_LOGS_ARTIFACT} missing (continuation logs not captured)`);
  else if (!spawned) problems.push(`${SPAWNED_LOGS_ARTIFACT} unparseable`);
  else {
    if (spawned.truncated) problems.push(`${SPAWNED_LOGS_ARTIFACT} truncated`);
    if (spawned.failedTaskIds.length)
      problems.push(`log fetch failed for task(s) ${spawned.failedTaskIds.join(", ")}`);
    for (const id of spawned.taskIds) covered.add(id);
    logRows.push(...spawned.rows);
  }
  const uncovered = tasks.filter((x) => x.origin !== "seed" && !x.skipped && !covered.has(x.id));
  if (uncovered.length)
    problems.push(`no session logs captured for task(s) ${uncovered.map((x) => x.id).join(", ")}`);
  return { tasks, logRows, problems };
}

/** The stored inputs for one attempt. */
export interface AttemptInput {
  arm: Arm;
  harness: string;
  scenarioId: string;
  /** status `error`: excluded from every metric. */
  excluded: boolean;
  passed: boolean;
  score: number;
  totalTokens: number | null;
  tasksMs: number | null;
  roster: { agentId: string; isLead: boolean }[];
  tasks: SwarmTask[];
  logRows: SessionLogRow[];
}

/** Per-attempt measurements. Lead fields are null on scenarios without a lead. */
export interface AttemptFacts {
  arm: Arm;
  harness: string;
  scenarioId: string;
  excluded: boolean;
  passed: boolean;
  score: number;
  hasLead: boolean;
  leadNativeSpawns: number | null;
  leadSwarmDispatch: number | null;
  spuriousWorkerTasks: number;
  workerNativeComms: number;
  workerSteers: number;
  totalTokens: number | null;
  tasksMs: number | null;
}

export function attemptFacts(a: AttemptInput): AttemptFacts {
  const lead = a.roster.find((m) => m.isLead)?.agentId;
  const taskOwner = new Map(a.tasks.map((t) => [t.id, t.agentId]));
  const uses = parseToolUses(a.logRows);
  const ofLead = uses.filter((u) => lead !== undefined && taskOwner.get(u.taskId ?? "") === lead);
  const ofWorkers = uses.filter((u) => {
    const owner = taskOwner.get(u.taskId ?? "");
    return owner != null && owner !== lead;
  });
  const workers = a.roster.map((m) => ({
    index: 0,
    agentId: m.agentId,
    isLead: m.isLead,
    exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    readFile: async () => null,
  }));
  const created = memberCreatedTasks({ tasks: a.tasks, workers }).length;
  return {
    arm: a.arm,
    harness: a.harness,
    scenarioId: a.scenarioId,
    excluded: a.excluded,
    passed: a.passed,
    score: a.score,
    hasLead: lead !== undefined,
    leadNativeSpawns: lead === undefined ? null : countNativeSpawns(ofLead),
    leadSwarmDispatch: lead === undefined ? null : countSwarmDispatch(ofLead),
    spuriousWorkerTasks: Math.max(0, created - (EXPECTED_WORKER_TASKS[a.scenarioId] ?? 0)),
    workerNativeComms: countNativeComms(ofWorkers),
    workerSteers: ofWorkers.filter((u) => swarmToolSlug(u.toolName) === "steer-task").length,
    totalTokens: a.totalTokens,
    tasksMs: a.tasksMs,
  };
}

export type GateStatus = "PASS" | "FAIL" | "NO DATA";

export interface GateResult {
  id: string;
  harness: string;
  status: GateStatus;
  detail: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const sum = (values: number[]): number => values.reduce((n, v) => n + v, 0);
const fmt = (n: number | null, digits = 2): string => (n === null ? "n/a" : n.toFixed(digits));

/** Median ratio treatment / control, or null when either side has no data. */
function medianRatio(t: (number | null)[], c: (number | null)[]): number | null {
  const mt = median(t.filter((v): v is number => v !== null));
  const mc = median(c.filter((v): v is number => v !== null));
  return mt === null || mc === null || mc === 0 ? null : mt / mc;
}

function gate(id: string, harness: string, ok: boolean | null, detail: string): GateResult {
  return { id, harness, status: ok === null ? "NO DATA" : ok ? "PASS" : "FAIL", detail };
}

/**
 * The Phase 5 gates G0-G7 for one harness (G8, prompt size, is a static test in
 * the root repo). Rates replace the plan's absolute counts so a cell with a
 * different attempt count keeps the same bar: G0 control 3/18, G1 treatment 1/18.
 */
export function evaluateHarness(harness: string, all: AttemptFacts[]): GateResult[] {
  const facts = all.filter((f) => f.harness === harness && !f.excluded);
  const arm = (a: Arm) => facts.filter((f) => f.arm === a);
  const leadOf = (a: Arm) => arm(a).filter((f) => f.hasLead);
  const spawnRate = (a: Arm): number | null => {
    const leads = leadOf(a);
    return leads.length === 0
      ? null
      : leads.filter((f) => (f.leadNativeSpawns ?? 0) > 0).length / leads.length;
  };
  const results: GateResult[] = [];

  const c0 = spawnRate("control");
  results.push(
    gate(
      "G0 headroom",
      harness,
      c0 === null ? null : c0 >= 3 / 18,
      `control lead native-spawn rate ${fmt(c0)} (bar 3/18)`,
    ),
  );

  const t1 = spawnRate("treatment");
  results.push(
    gate(
      "G1 lead native spawn",
      harness,
      t1 === null || c0 === null ? null : t1 <= 1 / 18 && t1 <= c0,
      `treatment rate ${fmt(t1)} vs control ${fmt(c0)} (bar 1/18, no higher than control)`,
    ),
  );

  const tLeads = leadOf("treatment");
  const dispatch = sum(tLeads.map((f) => f.leadSwarmDispatch ?? 0));
  const spawns = sum(tLeads.map((f) => f.leadNativeSpawns ?? 0));
  const share = dispatch + spawns === 0 ? null : dispatch / (dispatch + spawns);
  results.push(
    gate(
      "G2 lead swarm dispatch",
      harness,
      share === null ? null : share >= 0.9,
      `treatment share ${fmt(share)} (${dispatch} dispatch, ${spawns} native)`,
    ),
  );

  const spurious = (a: Arm) => sum(arm(a).map((f) => f.spuriousWorkerTasks));
  const t3 = spurious("treatment");
  const c3 = spurious("control");
  results.push(
    gate(
      "G3 worker spurious tasks",
      harness,
      arm("treatment").length === 0 ? null : t3 === 0 && t3 <= c3,
      `treatment ${t3}, control ${c3} (bar 0)`,
    ),
  );

  const scenarios = [...new Set(facts.map((f) => f.scenarioId))].sort();
  const cellMisses = scenarios.filter((s) => {
    const fails = (a: Arm) => arm(a).filter((f) => f.scenarioId === s && !f.passed).length;
    return fails("treatment") > fails("control") + 1;
  });
  const ci = bootstrapDiffCI(
    arm("treatment").map((f) => f.score),
    arm("control").map((f) => f.score),
    { seed: 0x70016a9 },
  );
  results.push(
    gate(
      "G4 task success",
      harness,
      arm("treatment").length === 0 || arm("control").length === 0
        ? null
        : cellMisses.length === 0 && ci.lo > -0.1,
      `score delta ${fmt(ci.diff)} [${fmt(ci.lo)}, ${fmt(ci.hi)}]${cellMisses.length ? `; cells with 2+ extra failures: ${cellMisses.join(", ")}` : ""}`,
    ),
  );

  const tokens = medianRatio(
    arm("treatment").map((f) => f.totalTokens),
    arm("control").map((f) => f.totalTokens),
  );
  results.push(
    gate(
      "G5 tokens",
      harness,
      tokens === null ? null : tokens <= 1.15,
      `median ratio ${fmt(tokens)} (bar 1.15)`,
    ),
  );

  for (const [label, withLead, bar] of [
    ["lead", true, 1.25],
    ["worker", false, 1.1],
  ] as const) {
    const pick = (a: Arm) =>
      arm(a)
        .filter((f) => f.hasLead === withLead)
        .map((f) => f.tasksMs);
    const ratio = medianRatio(pick("treatment"), pick("control"));
    results.push(
      gate(
        `G6 latency (${label})`,
        harness,
        ratio === null ? null : ratio <= bar,
        `median tasksMs ratio ${fmt(ratio)} (bar ${bar})`,
      ),
    );
  }

  const commsAttempts = arm("treatment").filter((f) => f.scenarioId === COMMS_SCENARIO);
  const commsOk = commsAttempts.filter((f) => f.workerSteers > 0 && f.workerNativeComms === 0);
  const rate = commsAttempts.length === 0 ? null : commsOk.length / commsAttempts.length;
  results.push(
    gate(
      "G7 worker comms",
      harness,
      rate === null ? null : rate >= 5 / 6,
      `${commsOk.length}/${commsAttempts.length} treatment attempts steered with no native comms (bar 5/6)`,
    ),
  );
  return results;
}

export function evaluateGates(facts: AttemptFacts[]): GateResult[] {
  const harnesses = [...new Set(facts.map((f) => f.harness))].sort();
  return harnesses.flatMap((h) => evaluateHarness(h, facts));
}

/** Per (harness, scenario, arm) cell metrics for the report table. */
export function cellRows(facts: AttemptFacts[]): Record<string, string | number>[] {
  const keys = [
    ...new Set(facts.map((f) => `${f.harness}\u0000${f.scenarioId}\u0000${f.arm}`)),
  ].sort();
  return keys.map((key) => {
    const [harness, scenarioId, arm] = key.split("\u0000") as [string, string, Arm];
    const cell = facts.filter(
      (f) => f.harness === harness && f.scenarioId === scenarioId && f.arm === arm,
    );
    const kept = cell.filter((f) => !f.excluded);
    const leads = kept.filter((f) => f.hasLead);
    const dispatch = sum(leads.map((f) => f.leadSwarmDispatch ?? 0));
    const spawns = sum(leads.map((f) => f.leadNativeSpawns ?? 0));
    return {
      harness,
      scenario: scenarioId,
      arm,
      attempts: kept.length,
      excluded: cell.length - kept.length,
      passRate: kept.length
        ? Number((kept.filter((f) => f.passed).length / kept.length).toFixed(2))
        : "n/a",
      meanScore: kept.length
        ? Number((sum(kept.map((f) => f.score)) / kept.length).toFixed(3))
        : "n/a",
      leadNativeSpawnsPerAttempt: leads.length ? Number((spawns / leads.length).toFixed(2)) : "n/a",
      leadDispatchShare:
        dispatch + spawns ? Number((dispatch / (dispatch + spawns)).toFixed(2)) : "n/a",
      spuriousWorkerTasks: sum(kept.map((f) => f.spuriousWorkerTasks)),
      medianTokens:
        median(kept.flatMap((f) => (f.totalTokens === null ? [] : [f.totalTokens]))) ?? "n/a",
      medianTasksMs: median(kept.flatMap((f) => (f.tasksMs === null ? [] : [f.tasksMs]))) ?? "n/a",
    };
  });
}

export function renderReport(opts: {
  control: string;
  treatment: string;
  /** Input problems; non-empty means no gates were evaluated. */
  problems?: string[];
  gates: GateResult[];
  cells: Record<string, string | number>[];
}): string {
  const table = (rows: Record<string, string | number>[]): string[] => {
    if (rows.length === 0) return ["(no rows)"];
    const cols = Object.keys(rows[0] as object);
    return [
      `| ${cols.join(" | ")} |`,
      `| ${cols.map(() => "---").join(" | ")} |`,
      ...rows.map((r) => `| ${cols.map((c) => String(r[c])).join(" | ")} |`),
    ];
  };
  return [
    "# Harness tool mappings: A/B gates",
    "",
    `Control run: \`${opts.control}\`. Treatment run: \`${opts.treatment}\`.`,
    "",
    ...(opts.problems?.length
      ? ["## Invalid input: no ship decision", "", ...opts.problems.map((p) => `- ${p}`), ""]
      : []),
    "## Gates",
    "",
    ...table(
      opts.gates.map((g) => ({
        harness: g.harness,
        gate: g.id,
        status: g.status,
        detail: g.detail,
      })),
    ),
    "",
    "## Cells",
    "",
    ...table(opts.cells),
    "",
  ].join("\n");
}

// ---- DB I/O ----

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      control: { type: "string" },
      treatment: { type: "string" },
      out: { type: "string", default: "." },
    },
  });
  if (!values.control || !values.treatment) {
    console.error(
      "usage: bun scripts/toolmap-compare.ts --control <run> --treatment <run> [--out <dir>]",
    );
    return 2;
  }
  const { initDb } = await import("../src/db/client.ts");
  const { listArtifacts, listAttempts, listRuns } = await import("../src/db/queries.ts");
  const { loadRegistry } = await import("../src/registry.ts");
  const db = await initDb();
  const runs = await listRuns(db);
  const registry = loadRegistry();
  const resolveRun = (ref: string) => {
    const run = runs.find((r) => r.id === ref) ?? runs.find((r) => r.name === ref);
    if (!run) throw new Error(`run "${ref}" not found by id or name`);
    return run;
  };

  const control = resolveRun(values.control);
  const treatment = resolveRun(values.treatment);
  const loadArm = async (run: EvalRunRow) => {
    const pins = await db.execute({
      sql: "SELECT config_id, resolved_model FROM eval_run_configs WHERE run_id = ?",
      args: [run.id],
    });
    return {
      run,
      pins: Object.fromEntries(
        pins.rows.map((r) => [String(r.config_id), String(r.resolved_model)]),
      ),
      attempts: await listAttempts(db, run.id),
    };
  };
  const arms = { control: await loadArm(control), treatment: await loadArm(treatment) };
  const problems = validateArms(arms.control, arms.treatment);

  const facts: AttemptFacts[] = [];
  for (const arm of ["control", "treatment"] as const) {
    for (const attempt of arms[arm].attempts) {
      const excluded = attempt.status === "error";
      const evidence = excluded
        ? { tasks: [], logRows: [], problems: [] }
        : attemptEvidence(
            attempt.taskIds,
            await listArtifacts(db, attempt.id, { withContent: true }),
          );
      for (const p of evidence.problems)
        problems.push(
          `${arm} attempt ${attempt.id} (${attempt.scenarioId} × ${attempt.configId}): ${p}`,
        );
      const t = attempt.tokens;
      facts.push(
        attemptFacts({
          arm,
          harness:
            registry.configs.get(attempt.configId)?.provider ??
            attempt.workers?.[0]?.provider ??
            attempt.configId,
          scenarioId: attempt.scenarioId,
          excluded,
          passed: attempt.passed === true,
          score: attempt.score ?? 0,
          totalTokens: t
            ? t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens
            : null,
          tasksMs: attempt.timings?.tasksMs ?? null,
          roster: (attempt.workers ?? []).map((w) => ({ agentId: w.agentId, isLead: w.isLead })),
          tasks: evidence.tasks,
          logRows: evidence.logRows,
        }),
      );
    }
  }

  // Gates on an invalid pair or incomplete evidence would be a ship decision on missing data.
  const gates = problems.length ? [] : evaluateGates(facts);
  if (!problems.length && gates.length === 0) problems.push("no scored attempts: no gates");
  const cells = cellRows(facts);
  mkdirSync(values.out, { recursive: true });
  const report = renderReport({
    control: values.control,
    treatment: values.treatment,
    problems,
    gates,
    cells,
  });
  writeFileSync(join(values.out, "toolmap-report.md"), report);
  writeFileSync(
    join(values.out, "toolmap-report.json"),
    `${JSON.stringify({ control: values.control, treatment: values.treatment, problems, gates, cells }, null, 2)}\n`,
  );
  console.log(report);
  if (problems.length > 0) {
    console.error(`${problems.length} input problem(s), no gates evaluated`);
    return 1;
  }
  const failing = gates.filter((g) => g.status !== "PASS");
  if (failing.length > 0) {
    console.error(
      `${failing.length} gate(s) not PASS: ${failing.map((g) => `${g.harness} ${g.id}`).join(", ")}`,
    );
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
