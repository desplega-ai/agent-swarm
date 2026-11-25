/**
 * Live facts for one workflow over a window, read from workflow_runs, steps,
 * agent tasks and session costs. The SQL is ported from the
 * `automation-savings-estimate` script (v7); pricing lives in `model.ts`.
 */
import type { SavingsReader } from "@desplega/storage";
import { getStorage } from "../storage";
import {
  DEFAULT_OPS,
  INLINE_OPS,
  INLINE_SCRIPT_NAME,
  JEV_PER_M,
  nodeOpsOf,
  type ScriptFacts,
  scriptOpsFromAwaitCount,
  type WorkflowFacts,
} from "./model";

/** Runs a read query rendered by the savings repository. Absent: the API's own DB client. */
export type SavingsSql = SavingsReader;

const repo = () => getStorage().repos.savings;

/**
 * Above this many runs in the window a live (on-request) computation refuses:
 * the router has 12k to 30k runs a day and its step scan alone takes seconds.
 * The daily rollup has no limit: it runs off the request path, one day at a time.
 */
export const LIVE_MAX_RUNS = 10_000;

export type WorkflowWindow =
  | { status: "ok"; facts: WorkflowFacts; byDay: DayFacts[] }
  | { status: "too-many-runs"; runs: number };

/** One UTC day's facts. The window's facts are the sum over its days. */
export type DayFacts = WorkflowFacts & { day: string };

const num = (v: unknown): number => Number(v) || 0;

export const emptyFacts = (runs: number): WorkflowFacts => ({
  runs,
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
  childTaskUsd: 0,
  childTaskMs: 0,
  recordedLlmUsd: 0,
  estimatedLlmUsd: 0,
  computeSecs: 0,
});

/** Ops per script name; a global script wins over an agent-scoped one of the same name. */
async function scriptOps(names: string[], sql?: SavingsSql): Promise<Map<string, number>> {
  const ops = new Map<string, number>();
  const unique = [...new Set(names.filter(Boolean))];
  if (unique.length === 0) return ops;
  // Chunked: a day can have over a thousand script names.
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const rows = await repo().listScriptAwaitCounts(chunk, sql);
    for (const row of rows) ops.set(row.name, scriptOpsFromAwaitCount(row.aw));
  }
  return ops;
}

/**
 * How runs are grouped: by UTC day (`YYYY-MM-DD`), or by UTC minute
 * (`YYYY-MM-DDTHH:MM`) so a reader can drop the runs before a window start
 * that falls inside the scanned slice.
 */
export type SavingsBucket = "day" | "minute";

/** Every run's facts, grouped by the UTC day (or minute) it started; the window facts are their sum. */
export async function computeWorkflowWindow(
  workflow: { id: string; definition: unknown },
  window: { start: string; end: string },
  sql?: SavingsSql,
  opts: { maxRuns?: number; bucket?: SavingsBucket } = {},
): Promise<WorkflowWindow> {
  const bucket = opts.bucket ?? "day";
  const span = { start: window.start, end: window.end };
  const maxRuns = opts.maxRuns ?? LIVE_MAX_RUNS;
  // Index-only count first, so a high-volume workflow never reaches the step scans.
  const total = await repo().countWorkflowRunsInSpan(workflow.id, span, sql);
  if (total === 0) return { status: "ok", facts: emptyFacts(0), byDay: [] };
  if (total > maxRuns) return { status: "too-many-runs", runs: total };

  const days = new Map<string, DayFacts>();
  const dayOf = (d: unknown): DayFacts => {
    const key = String(d);
    let f = days.get(key);
    if (!f) {
      f = { day: key, ...emptyFacts(0) };
      days.set(key, f);
    }
    return f;
  };

  const byTrigger = await repo().workflowRunsByTrigger(workflow.id, span, bucket, sql);
  let schedRuns = 0;
  for (const row of byTrigger) {
    const f = dayOf(row.d);
    const n = num(row.n);
    f.runs += n;
    if (row.tt === "event") f.eventRuns += n;
    if (row.st === "skipped" || row.st === "cancelled") continue;
    f.countedRuns += n;
    if (row.tt === "schedule") {
      f.schedRuns += n;
      schedRuns += n;
    }
  }
  if (schedRuns > 0) {
    const effect = await repo().workflowScheduledEffectRuns(workflow.id, span, bucket, sql);
    for (const row of effect) dayOf(row.d).schedEffectRuns += num(row.n);
  }

  const definition = (workflow.definition ?? {}) as {
    nodes?: { id: string; type: string; config?: Record<string, unknown> }[];
  };
  const scriptNames = (definition.nodes ?? [])
    .filter((n) => n.type === "swarm-script")
    .map((n) => n.config?.scriptName)
    .filter((n): n is string => typeof n === "string");
  const nodeOps = nodeOpsOf(definition, await scriptOps(scriptNames, sql));

  const steps = await repo().workflowStepFacts(workflow.id, span, bucket, sql);
  for (const x of steps) {
    const f = dayOf(x.d);
    // foreach iterations store `<nodeId>#<i>`.
    f.opsSum += (nodeOps.get(String(x.nid).split("#")[0] ?? "") ?? 0) * num(x.n);
    f.recordedLlmUsd += num(x.jev) + num(x.clairic);
    f.estimatedLlmUsd += (num(x.itok) / 1e6) * JEV_PER_M + (num(x.rchars) * (1.2 / 4 + 0.3)) / 1e6;
    f.computeSecs += num(x.secs);
  }

  const agent = await repo().workflowAgentSpend(workflow.id, span, bucket, sql);
  for (const row of agent) {
    const f = dayOf(row.d);
    f.agentTasks += num(row.tasks);
    f.agentUsd += num(row.usd);
    f.agentMs += num(row.ms);
  }
  const followups = await repo().workflowFollowupSpend(workflow.id, span, bucket, sql);
  for (const row of followups) dayOf(row.d).followupUsd += num(row.fup);

  // Effect runs of any trigger, found from the child side (child runs via
  // parentStepId, tasks via workflowRunId), with the steps of those runs:
  // the enabled-only rule prices only these.
  const effect = await repo().workflowEffectSteps(workflow.id, span, bucket, sql);
  for (const row of effect) {
    const f = dayOf(row.d);
    // The row with no node id carries the day's effect-run count.
    if (row.nid === null) f.effectRuns += num(row.n);
    else f.effectOpsSum += (nodeOps.get(String(row.nid).split("#")[0] ?? "") ?? 0) * num(row.n);
  }

  const byDay = [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  const facts = emptyFacts(0);
  for (const f of byDay) {
    for (const k of Object.keys(facts) as (keyof WorkflowFacts)[]) facts[k] += f[k];
  }
  return { status: "ok", facts, byDay };
}

/** One script's facts per UTC day. */
export type ScriptDayFacts = ScriptFacts & { day: string };
export type ScriptWindowFacts = { scriptName: string; byDay: ScriptDayFacts[] };

/** The script_runs filter of a window, narrowed to one script name (runs without one by INLINE_SCRIPT_NAME). */
const scriptFilter = (opts: { scriptName?: string }) => ({
  scriptName: opts.scriptName,
  inlineName: INLINE_SCRIPT_NAME,
});

/** Runs of every script (or of one script) in the window. */
export async function countScriptRuns(
  window: { start: string; end: string },
  sql?: SavingsSql,
  opts: { scriptName?: string } = {},
): Promise<number> {
  return repo().countScriptRuns({ start: window.start, end: window.end }, scriptFilter(opts), sql);
}

/**
 * Facts of every script with runs in the window (or of one script), grouped by
 * the UTC day (or minute) the runs started. Ported from v7 `scriptJobs`: runs are keyed by
 * `scriptName` (runs without one by INLINE_SCRIPT_NAME), ops are the `await`
 * count of the catalog source (the global row wins), and a run had an effect
 * when its output names an agent task created while it ran (up to 20 minutes
 * after it started), counted on the day the run started. v7 folds names beyond its first 900 into a tail row; here
 * every name keeps its own row and ops.
 */
export async function computeScriptWindow(
  window: { start: string; end: string },
  sql?: SavingsSql,
  opts: { scriptName?: string; bucket?: SavingsBucket } = {},
): Promise<ScriptWindowFacts[]> {
  const span = { start: window.start, end: window.end };
  const bucket = opts.bucket ?? "day";
  const filter = scriptFilter(opts);
  const runs = await repo().scriptRunsByName(span, bucket, filter, sql);
  if (runs.length === 0) return [];
  const names = [...new Set(runs.map((r) => String(r.nm)))].filter((n) => n !== INLINE_SCRIPT_NAME);
  const ops = await scriptOps(names, sql);

  // Only scripts whose source can create an agent task or start a workflow are probed for effects.
  const dispatchers: string[] = [];
  for (let i = 0; i < names.length; i += 500) {
    dispatchers.push(...(await repo().listDispatchingScripts(names.slice(i, i + 500), sql)));
  }
  // Effect runs per day the run started, like their runs: a run at 23:59 whose
  // task lands after midnight still credits its own day, so tasks are read up
  // to 20 minutes past the window end.
  const effects = new Map<string, { other: number; api: number }>();
  const rows = await repo().scriptEffectRuns(span, bucket, filter, dispatchers, sql);
  for (const row of rows) {
    const key = `${row.nm}\u0000${row.d}`;
    const e = effects.get(key) ?? { other: 0, api: 0 };
    if (num(row.api)) e.api += num(row.n);
    else e.other += num(row.n);
    effects.set(key, e);
  }

  const byName = new Map<string, ScriptDayFacts[]>();
  const push = (nm: string, f: ScriptDayFacts) => byName.set(nm, [...(byName.get(nm) ?? []), f]);
  for (const r of runs) {
    const nm = String(r.nm);
    const n = num(r.n);
    const perRun = nm === INLINE_SCRIPT_NAME ? INLINE_OPS : (ops.get(nm) ?? DEFAULT_OPS);
    const e = effects.get(`${nm}\u0000${r.d}`);
    push(nm, {
      day: String(r.d),
      runs: n,
      apiRuns: num(r.api),
      effectRuns: e?.other ?? 0,
      apiEffectRuns: e?.api ?? 0,
      opsSum: perRun * n,
      computeSecs: num(r.secs),
    });
  }
  return [...byName.entries()]
    .map(([scriptName, byDay]) => ({
      scriptName,
      byDay: byDay.sort((a, b) => a.day.localeCompare(b.day)),
    }))
    .sort((a, b) => a.scriptName.localeCompare(b.scriptName));
}

/** A workflow's link to something its runs caused, for one UTC day. */
export type SavingsLink = {
  parentJobId: string;
  childKind: "workflow" | "script" | "task";
  /** Workflow id, script name, or "" for tasks. */
  childJobId: string;
  /**
   * `sub-workflow`: child run of a sub-workflow node (parentStepId).
   * `step-workflow`, `step-script`, `step-task`: a run, nested script run or
   * task a swarm-script step made. `descendant-task`: a task below the
   * agent-task nodes' tasks (parentTaskId).
   */
  linkKind: "sub-workflow" | "step-workflow" | "step-script" | "step-task" | "descendant-task";
  n: number;
  /** Session cost of linked tasks (with their descendants for `step-task`); 0 for runs. */
  actualUsd: number;
  /** The part of `actualUsd` the parent's own row keeps on both sides. */
  keptUsd: number;
};

export type WorkflowLinksDay = {
  links: SavingsLink[];
  /** Per parent workflow: spend of the tasks it caused without owning them (`WorkflowFacts.childTaskUsd`). */
  childTasks: Map<string, { usd: number; ms: number }>;
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A run or task a step made starts while the step runs, or within 5 s of its end. */
const STEP_GRACE_MS = 5_000;
/** Deepest task chain followed below a root task (the deepest seen is 17). */
const MAX_TASK_DEPTH = 20;

async function inChunks<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 500) out.push(...(await fn(ids.slice(i, i + 500))));
  return out;
}

/**
 * What every workflow's runs caused on one UTC day (by the child's start),
 * for the "with components" view and the kept spend of unowned tasks.
 *
 * - Sub-workflow children: `parentStepId`, exact.
 * - Runs, tasks and nested script runs a swarm-script step made: the step id
 *   its run token stamped (`sourceStepId`). Unstamped runs and tasks (made
 *   before the stamp existed, or by a run with no token) fall back to an id in
 *   the step's output plus a start inside the step; stamped rows never take
 *   that path. Nested script runs are linked only when stamped: matching them
 *   by time is too noisy (agents call the same scripts by hand).
 * - Task spend: the tasks the steps made, and the descendants (`parentTaskId`,
 *   stopping at a task with its own workflow run) of those and of the
 *   agent-task nodes' tasks.
 */
export async function computeWorkflowLinksDay(
  window: { start: string; end: string },
  workflows: { id: string; definition: unknown }[],
  sql?: SavingsSql,
): Promise<WorkflowLinksDay> {
  const span = { start: window.start, end: window.end };
  const links = new Map<string, SavingsLink>();
  const add = (l: Omit<SavingsLink, "actualUsd" | "keptUsd"> & { usd?: number }) => {
    const key = [l.parentJobId, l.childKind, l.childJobId, l.linkKind].join("\u0000");
    const prev = links.get(key);
    const usd = l.usd ?? 0;
    links.set(key, {
      parentJobId: l.parentJobId,
      childKind: l.childKind,
      childJobId: l.childJobId,
      linkKind: l.linkKind,
      n: (prev?.n ?? 0) + l.n,
      actualUsd: (prev?.actualUsd ?? 0) + usd,
      keptUsd: (prev?.keptUsd ?? 0) + (l.childKind === "task" ? usd : 0),
    });
  };

  const subRuns = await repo().subWorkflowLinks(span, sql);
  for (const r of subRuns) {
    add({
      parentJobId: r.pid,
      childKind: "workflow",
      childJobId: r.cid,
      linkKind: "sub-workflow",
      n: num(r.n),
    });
  }
  const stampedRuns = await repo().stampedWorkflowLinks(span, sql);
  for (const r of stampedRuns) {
    add({
      parentJobId: r.pid,
      childKind: "workflow",
      childJobId: r.cid,
      linkKind: "step-workflow",
      n: num(r.n),
    });
  }
  const stampedScripts = await repo().stampedScriptLinks(span, INLINE_SCRIPT_NAME, sql);
  for (const r of stampedScripts) {
    add({
      parentJobId: r.pid,
      childKind: "script",
      childJobId: String(r.nm),
      linkKind: "step-script",
      n: num(r.n),
    });
  }

  // Tasks the steps made, per parent workflow.
  const stepTasks = new Map<string, string>();
  for (const r of await repo().listStepTasks(span, sql)) {
    stepTasks.set(String(r.id), String(r.pid));
  }

  await linkFromStepOutputs(window, workflows, sql, (pid, kind, id, childWorkflowId) => {
    if (kind === "task") {
      if (!stepTasks.has(id)) stepTasks.set(id, pid);
    } else {
      add({
        parentJobId: pid,
        childKind: "workflow",
        childJobId: childWorkflowId as string,
        linkKind: "step-workflow",
        n: 1,
      });
    }
  });

  // Agent-task nodes' tasks: their own cost is in the row already; only their descendants add.
  const nodeTasks = new Map<string, string>();
  for (const r of await repo().listNodeTasks(span, sql)) {
    nodeTasks.set(String(r.id), String(r.pid));
  }

  const childTasks = new Map<string, { usd: number; ms: number }>();
  const keep = (pid: string, usd: number, ms: number) => {
    const c = childTasks.get(pid) ?? { usd: 0, ms: 0 };
    childTasks.set(pid, { usd: c.usd + usd, ms: c.ms + ms });
  };
  // Each task counts under exactly one root: the walk stops at any other root
  // of the day and at any task a step or a node owns (on any day), so all
  // roots go in as one set.
  const roots = [...new Set([...stepTasks.keys(), ...nodeTasks.keys()])];
  const trees = await repo().listTaskTrees(roots, MAX_TASK_DEPTH, sql);
  for (const t of trees) {
    const root = String(t.root);
    const below = num(t.below) === 1;
    const fromStep = stepTasks.get(root);
    const pid = fromStep ?? nodeTasks.get(root);
    if (!pid) continue;
    // A node task's own cost is the row's agentUsd; a step task counts whole.
    if (!fromStep && !below) continue;
    const usd = num(t.usd);
    keep(pid, usd, num(t.ms));
    if (fromStep) {
      // n counts the tasks the step made; their descendants add only spend.
      add({
        parentJobId: pid,
        childKind: "task",
        childJobId: "",
        linkKind: "step-task",
        n: below ? 0 : num(t.n),
        usd,
      });
    } else {
      add({
        parentJobId: pid,
        childKind: "task",
        childJobId: "",
        linkKind: "descendant-task",
        n: num(t.n),
        usd,
      });
    }
  }
  return { links: [...links.values()], childTasks };
}

/**
 * The unstamped fallback: runs and tasks whose id a dispatching step's output
 * names and that started while the step ran. Only steps of nodes whose script
 * can dispatch are read.
 */
async function linkFromStepOutputs(
  window: { start: string; end: string },
  workflows: { id: string; definition: unknown }[],
  sql: SavingsSql | undefined,
  onLink: (
    parentWorkflowId: string,
    kind: "workflow" | "task",
    id: string,
    childWorkflowId?: string,
  ) => void,
): Promise<void> {
  const nodesByWorkflow = new Map<string, { nodeId: string; scriptName: string }[]>();
  for (const w of workflows) {
    const nodes =
      (
        (w.definition ?? {}) as {
          nodes?: { id: string; type: string; config?: Record<string, unknown> }[];
        }
      ).nodes ?? [];
    const scripted = nodes
      .filter((n) => n.type === "swarm-script" && typeof n.config?.scriptName === "string")
      .map((n) => ({ nodeId: n.id, scriptName: n.config?.scriptName as string }));
    if (scripted.length > 0) nodesByWorkflow.set(w.id, scripted);
  }
  const names = [...new Set([...nodesByWorkflow.values()].flat().map((n) => n.scriptName))];
  if (names.length === 0) return;
  const dispatchers = new Set(
    (await inChunks(names, (chunk) => repo().listDispatchingScripts(chunk, sql))).map((r) =>
      String(r),
    ),
  );
  for (const [workflowId, nodes] of nodesByWorkflow) {
    const nodeIds = nodes.filter((n) => dispatchers.has(n.scriptName)).map((n) => n.nodeId);
    if (nodeIds.length === 0) continue;
    const steps = await repo().listDispatchSteps(
      workflowId,
      { start: window.start, end: window.end },
      nodeIds,
      sql,
    );
    const named = new Map<string, { sa: number; fa: number }[]>();
    for (const s of steps) {
      const range = { sa: Date.parse(s.sa), fa: Date.parse(s.fa) + STEP_GRACE_MS };
      for (const id of new Set(String(s.output).toLowerCase().match(UUID_RE) ?? [])) {
        if (id === String(s.id)) continue;
        named.set(id, [...(named.get(id) ?? []), range]);
      }
    }
    if (named.size === 0) continue;
    const inStep = (id: string, at: string) =>
      (named.get(id) ?? []).some((r) => Date.parse(at) >= r.sa && Date.parse(at) <= r.fa);
    const ids = [...named.keys()];
    const runs = await inChunks(ids, (chunk) => repo().listUnstampedRuns(chunk, sql));
    for (const r of runs) {
      if (inStep(String(r.id), String(r.at)))
        onLink(workflowId, "workflow", String(r.id), String(r.wid));
    }
    const tasks = await inChunks(ids, (chunk) => repo().listUnstampedTasks(chunk, sql));
    for (const t of tasks) {
      if (inStep(String(t.id), String(t.at))) onLink(workflowId, "task", String(t.id));
    }
  }
}
