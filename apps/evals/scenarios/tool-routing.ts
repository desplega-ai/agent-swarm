import { type ToolUse, toolUseMatches } from "../src/judge/session-log-parse.ts";
import type {
  CheckResult,
  DeterministicCheck,
  JudgeContext,
  Scenario,
  SwarmTask,
} from "../src/types.ts";
import {
  apiList,
  firstStageIndices,
  hasTool,
  rawApiToolCount,
  type SequenceStage,
  safeStringify,
  scoreResult,
  stageOrderScore,
  taskToolUses,
} from "./orchestration-utils.ts";

type KvEntry = { key?: string; value?: unknown };

const routingCheck: DeterministicCheck = {
  name: "mcp-tool-routing",
  fn: async (ctx): Promise<CheckResult> => {
    const tools = await taskToolUses(ctx, ctx.tasks[0]);
    const memory = hasTool(tools, [
      "memory-search",
      "memory_search",
      "smart-recall",
      "task-context-gathering",
    ]);
    const kv = hasTool(tools, ["kv-set", "kv_set", "kv-get", "kv_get"]);
    const getTasks = tools.find((u) => /get[-_]tasks/.test(u.toolName));
    const filteredTasks = Boolean(
      getTasks && /alpha|completed|tags|status/i.test(safeStringify(getTasks.input)),
    );
    const sendTask = hasTool(tools, ["send-task", "send_task", "task-action", "task_action"]);
    const progress = hasTool(tools, ["store-progress", "store_progress"]);
    const rawPenalty = Math.min(0.4, rawApiToolCount(tools) * 0.2);
    if (tools.length === 0) return { pass: false, score: 0, detail: "no parsed tool calls" };
    const score = Math.max(
      0,
      ((memory ? 2 : 0) +
        (kv ? 2 : 0) +
        (filteredTasks ? 2 : getTasks ? 1 : 0) +
        (sendTask ? 2 : 0) +
        (progress ? 1 : 0)) /
        9 -
        rawPenalty,
    );
    return scoreResult("tool routing", score, [
      `memory=${memory ? "yes" : "no"}`,
      `kv=${kv ? "yes" : "no"}`,
      `get-tasks=${filteredTasks ? "filtered" : getTasks ? "unfiltered" : "no"}`,
      `send-task=${sendTask ? "yes" : "no"}`,
      `raw-api-penalty=${rawPenalty.toFixed(2)}`,
    ]);
  },
};

// ---------------------------------------------------------------------------
// dispatch-order: a hop-SEQUENCE structural axis, additive to routingCheck
// above. routingCheck only grades tool-category PRESENCE ("did you touch
// memory/kv/get-tasks/send-task at all") — a run that fires them in a
// scrambled order (e.g. dispatches the follow-up task BEFORE it ever looked up
// the completed-alpha tasks the follow-up is supposed to build on) scores
// identically to one that respects the causal order the prompt implies. This
// is the single-worker analog of "the right hop happened at the right point in
// the sequence" — Edge-F1-style order fidelity (stageOrderScore) rather than
// Node-F1-style presence.
// ---------------------------------------------------------------------------
const ROUTING_STAGES: SequenceStage[] = [
  {
    label: "memory-recall",
    patterns: ["memory-search", "memory_search", "smart-recall", "task-context-gathering"],
  },
  { label: "kv-checkpoint", patterns: ["kv-set", "kv_set", "kv-get", "kv_get"] },
  { label: "task-lookup", patterns: [/get[-_]tasks/i] },
  {
    label: "delegate-followup",
    patterns: ["send-task", "send_task", "task-action", "task_action"],
  },
  { label: "complete", patterns: ["store-progress", "store_progress"] },
];

const routingSequenceCheck: DeterministicCheck = {
  name: "tool-routing-hop-order",
  fn: async (ctx): Promise<CheckResult> => {
    const tools = await taskToolUses(ctx, ctx.tasks[0]);
    if (tools.length === 0) return { pass: false, score: 0, detail: "no parsed tool calls" };
    const indices = firstStageIndices(tools, ROUTING_STAGES);
    const score = stageOrderScore(indices);
    return scoreResult(
      "routing hop order",
      score,
      ROUTING_STAGES.map((s, i) => `${s.label}=${indices[i]! >= 0 ? indices[i] : "absent"}`),
    );
  },
};

/**
 * Namespaces the worker's kv-set may have written to, most specific first: an
 * explicit `namespace` arg, the task's `contextKey` (the server default when
 * the call carries X-Source-Task-Id), then `task:agent:<workerId>`. The judge
 * client sends no X-Agent-ID, so a bare `GET /api/kv` lists the wrong
 * namespace; every read here uses the explicit `/api/kv/_/<ns>` form.
 */
function kvNamespaces(ctx: JudgeContext, tools: ToolUse[]): string[] {
  const out: string[] = [];
  for (const u of tools) {
    if (!toolUseMatches(u.toolName, ["kv-set", "kv_set"])) continue;
    const input = (u.input ?? {}) as Record<string, unknown>;
    const args = (input.arguments ?? input) as Record<string, unknown>;
    if (typeof args.namespace === "string" && args.namespace) out.push(args.namespace);
  }
  const task = ctx.tasks[0];
  if (typeof task?.contextKey === "string" && task.contextKey) out.push(task.contextKey);
  const agentId = task?.agentId ?? ctx.workers[0]?.agentId;
  if (typeof agentId === "string" && agentId) out.push(`task:agent:${agentId}`);
  return [...new Set(out)];
}

async function workerKvEntries(ctx: JudgeContext, tools: ToolUse[]): Promise<KvEntry[]> {
  for (const ns of kvNamespaces(ctx, tools)) {
    const entries = await apiList<KvEntry>(ctx, `/api/kv/_/${encodeURIComponent(ns)}`, ["entries"]);
    if (entries.length > 0) return entries;
  }
  return [];
}

// v2 (2026-09-28): v1 graded "correctness" as "the word alpha appears in the
// output, a KV entry exists, a follow-up exists" — satisfiable without reading a
// single task, and the seeded history holds no alpha tasks at all. v2 grades an
// answer key that lives only in the seeded history (same fixture as sql-audit):
// the completed count and the highest-priority completed task, plus a KV
// checkpoint and a follow-up task that carry those facts.
const COMPLETED_COUNT = /(?<![\d.])21(?![\d.])/;
const TOP_TASK = /rotate[\s\S]{0,40}payments[\s\S]{0,40}api[\s\S]{0,20}keys/i;

const routingCorrectnessCheck: DeterministicCheck = {
  name: "routing-artifacts",
  fn: async (ctx): Promise<CheckResult> => {
    const root = ctx.tasks[0];
    const kvEntries = await workerKvEntries(ctx, await taskToolUses(ctx, root));
    const checkpoint = kvEntries.find((e) => e.key === "alpha/checkpoint");
    const checkpointText = safeStringify(checkpoint?.value);
    const followUps = ctx.tasks.filter(
      (t) =>
        t.id !== root?.id && (t.parentTaskId === root?.id || t.creatorAgentId === root?.agentId),
    );
    const followUpText = followUps
      .map((t) => `${t.title ?? ""}\n${t.description ?? ""}`)
      .join("\n");
    const output = root?.result ?? "";
    const parts = {
      outputCount: COMPLETED_COUNT.test(output),
      outputTop: TOP_TASK.test(output),
      checkpoint: Boolean(checkpoint) && COMPLETED_COUNT.test(checkpointText),
      followUpTop: TOP_TASK.test(followUpText),
      oneFollowUp: followUps.length === 1,
    };
    const score = Object.values(parts).filter(Boolean).length / Object.keys(parts).length;
    return {
      pass: score >= 1,
      score,
      detail: Object.entries(parts)
        .map(([k, v]) => `${k}=${v ? "yes" : "no"}`)
        .concat(`followups=${followUps.length}`, `kv=${kvEntries.length}`)
        .join(", "),
    };
  },
};

const routingOutputGate: DeterministicCheck = {
  name: "routing-output-present",
  fn: async (ctx) => {
    const output = ctx.tasks[0]?.result;
    return {
      pass: typeof output === "string" && output.trim().length > 0,
      detail: typeof output === "string" ? `${output.length} output chars` : "no task output",
    };
  },
};

export const toolRouting: Scenario = {
  id: "tool-routing",
  name: "Tool routing",
  description:
    "Behavioral scenario: a worker must discover the handoff conventions from memory, read the seeded task history through swarm tools, and carry the right facts into KV and a follow-up task.",
  workers: 1,
  seed: {
    memories: [
      "Project Alpha handoff: Alpha's phase-one scope is every task in the swarm task history that finished with status completed. Checkpoint state belongs in KV under the exact key alpha/checkpoint and must record how many phase-one tasks completed.",
      "Project Alpha phase two starts from the single highest-priority completed phase-one task: the phase-two follow-up task must name that task's title.",
    ],
    sqlDump: "sql-audit-history.sql",
  },
  tasks: [
    {
      title: "Route Project Alpha through the swarm tools",
      description: [
        "Hand Project Alpha from phase one to phase two. The handoff conventions are in swarm memory; follow them exactly.",
        "Use the swarm's own MCP tools for every step. Do not use raw curl/fetch against /api endpoints and do not use db-query.",
        "Create exactly one follow-up task for phase two.",
        "Complete through store-progress with JSON including alphaSummary (with the completed count and the top task title), checkpointKey, and followUpCreated.",
      ].join("\n"),
    },
  ],
  outcome: {
    gates: [routingOutputGate],
    dimensions: [
      { name: "tool-selection", weight: 5, checks: [routingCheck] },
      { name: "dispatch-order", weight: 2, checks: [routingSequenceCheck] },
      { name: "correctness", weight: 4, checks: [routingCorrectnessCheck] },
    ],
  },
  timeoutMs: 8 * 60_000,
};

export const __test__ = {
  routingCheck,
  routingSequenceCheck,
  routingCorrectnessCheck,
  routingOutputGate,
  ROUTING_STAGES,
};
