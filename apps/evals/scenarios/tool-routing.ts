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
// dispatch-order: a PARTIAL order over the hops, additive to routingCheck
// above. Only the causal edges the task implies are graded: recall memory
// before delegating the follow-up, and delegate before completing. KV and
// task-lookup can happen anywhere; a strict first-use order over all five
// stages penalized harmless reorderings (e.g. a kv-set before the lookup).
// Each edge scores when both stages are present and the first use of the
// earlier stage comes before the first use of the later one.
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

/** Graded before→after edges, as indices into ROUTING_STAGES. */
const ROUTING_EDGES: Array<[number, number]> = [
  [0, 3], // memory-recall before delegate-followup
  [3, 4], // delegate-followup before complete
];

function partialOrderScore(indices: number[]): { score: number; edges: string[] } {
  const edges = ROUTING_EDGES.map(([a, b]) => {
    const ia = indices[a]!;
    const ib = indices[b]!;
    const ok = ia >= 0 && ib >= 0 && ia < ib;
    return {
      ok,
      label: `${ROUTING_STAGES[a]!.label}<${ROUTING_STAGES[b]!.label}=${ok ? "ok" : "no"}`,
    };
  });
  return {
    score: edges.filter((e) => e.ok).length / ROUTING_EDGES.length,
    edges: edges.map((e) => e.label),
  };
}

const routingSequenceCheck: DeterministicCheck = {
  name: "tool-routing-hop-order",
  fn: async (ctx): Promise<CheckResult> => {
    const tools = await taskToolUses(ctx, ctx.tasks[0]);
    if (tools.length === 0) return { pass: false, score: 0, detail: "no parsed tool calls" };
    const indices = firstStageIndices(tools, ROUTING_STAGES);
    const { score, edges } = partialOrderScore(indices);
    return scoreResult("routing hop order", score, [
      ...edges,
      ...ROUTING_STAGES.map((s, i) => `${s.label}=${indices[i]! >= 0 ? indices[i] : "absent"}`),
    ]);
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

const routingCorrectnessCheck: DeterministicCheck = {
  name: "routing-artifacts",
  fn: async (ctx): Promise<CheckResult> => {
    const kvEntries = await workerKvEntries(ctx, await taskToolUses(ctx, ctx.tasks[0]));
    const alphaTasks = ctx.tasks.filter((t: SwarmTask) =>
      /alpha/i.test(`${t.title}\n${t.description}\n${safeStringify(t.tags)}`),
    );
    const followUps = ctx.tasks.filter(
      (t) => t.parentTaskId === ctx.tasks[0]?.id || /next phase|follow.?up/i.test(t.description),
    );
    const output = ctx.tasks[0]?.result ?? "";
    const mentionsAlpha = /project alpha|alpha/i.test(output);
    const score =
      ((kvEntries.length > 0 ? 1 : 0) +
        (alphaTasks.length > 0 ? 1 : 0) +
        (followUps.length > 0 ? 1 : 0) +
        (mentionsAlpha ? 1 : 0)) /
      4;
    return {
      pass: score >= 1,
      score,
      detail: `kv=${kvEntries.length}, alphaTasks=${alphaTasks.length}, followups=${followUps.length}, outputAlpha=${mentionsAlpha}`,
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

/**
 * Structured-output gate (folded in from the retired structured-output-adherence
 * scenario): the completion output must be ONLY a JSON object matching the
 * task's outputSchema, with every field correctly typed.
 */
const ROUTING_OUTPUT_SCHEMA = {
  type: "object",
  required: ["alphaSummary", "checkpointKey", "followUpCreated"],
  properties: {
    alphaSummary: { type: "string" },
    checkpointKey: { type: "string" },
    followUpCreated: { type: "boolean" },
  },
};

function structuredOutputProblem(output: unknown): string | null {
  if (typeof output !== "string" || !output.trim()) return "no task output";
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return "output is not valid JSON";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return "JSON output is not an object";
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.alphaSummary !== "string" || !obj.alphaSummary.trim())
    return "alphaSummary missing or not a string";
  if (typeof obj.checkpointKey !== "string") return "checkpointKey missing or not a string";
  if (typeof obj.followUpCreated !== "boolean") return "followUpCreated missing or not a boolean";
  return null;
}

const structuredOutputGate: DeterministicCheck = {
  name: "routing-structured-output",
  fn: async (ctx) => {
    const problem = structuredOutputProblem(ctx.tasks[0]?.result);
    return { pass: problem === null, detail: problem ?? "output matches the outputSchema" };
  },
};

export const toolRouting: Scenario = {
  id: "tool-routing",
  name: "Tool routing",
  description:
    "Behavioral scenario that grades whether a worker uses swarm MCP tools for memory, KV state, task lookup, delegation, and structured completion instead of raw shell/API workarounds.",
  workers: 1,
  seed: {
    memories: [
      "Project Alpha handoff: deployment readiness lives in the swarm task history, and checkpoint state belongs in KV under alpha/checkpoint.",
      "Project Alpha requires a follow-up task for phase two after completed alpha tasks are summarized.",
    ],
    sqlDump: "sql-audit-history.sql",
  },
  tasks: [
    {
      title: "Route Project Alpha through the swarm tools",
      outputSchema: ROUTING_OUTPUT_SCHEMA,
      description: [
        "Start by recalling memories about Project Alpha.",
        "Store a checkpoint in the swarm KV store under key alpha/checkpoint.",
        "Use the swarm task-listing tool to find relevant completed tasks and summarize what you found.",
        "Create one follow-up task for the next Alpha phase using the task/delegation tool. Avoid raw curl/fetch against /api endpoints.",
        "Complete through store-progress with output that is ONLY a JSON object (no markdown or prose): alphaSummary string, checkpointKey string, followUpCreated boolean.",
      ].join("\n"),
    },
  ],
  outcome: {
    gates: [routingOutputGate, structuredOutputGate],
    dimensions: [
      { name: "tool-selection", weight: 5, checks: [routingCheck] },
      { name: "dispatch-order", weight: 2, checks: [routingSequenceCheck] },
      { name: "correctness", weight: 1, checks: [routingCorrectnessCheck] },
    ],
  },
  timeoutMs: 8 * 60_000,
};

export const __test__ = {
  routingCheck,
  routingSequenceCheck,
  routingCorrectnessCheck,
  routingOutputGate,
  structuredOutputGate,
  structuredOutputProblem,
  partialOrderScore,
  ROUTING_STAGES,
};
