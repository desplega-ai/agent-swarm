import type { CheckResult, DeterministicCheck, Scenario, SwarmTask } from "../src/types.ts";
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

const routingCorrectnessCheck: DeterministicCheck = {
  name: "routing-artifacts",
  fn: async (ctx): Promise<CheckResult> => {
    const kvEntries = await apiList<KvEntry>(ctx, "/api/kv", ["entries"]);
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
      description: [
        "Start by recalling memories about Project Alpha.",
        "Store a checkpoint in the swarm KV store under key alpha/checkpoint.",
        "Use the swarm task-listing tool to find relevant completed tasks and summarize what you found.",
        "Create one follow-up task for the next Alpha phase using the task/delegation tool. Avoid raw curl/fetch against /api endpoints.",
        "Complete through store-progress with JSON including alphaSummary, checkpointKey, and followUpCreated.",
      ].join("\n"),
    },
  ],
  outcome: {
    gates: [routingOutputGate],
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
  ROUTING_STAGES,
};
