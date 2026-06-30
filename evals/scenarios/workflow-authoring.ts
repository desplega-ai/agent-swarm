import type { CheckResult, DeterministicCheck, JudgeContext, Scenario } from "../src/types.ts";
import {
  apiList,
  clamp01,
  hasTool,
  safeStringify,
  scoreResult,
  taskToolUses,
} from "./orchestration-utils.ts";

type WorkflowNode = {
  id: string;
  type: string;
  next?: string | string[] | Record<string, string>;
  inputs?: Record<string, string>;
  config?: Record<string, unknown>;
};

type WorkflowRecord = {
  id: string;
  name: string;
  definition?: { nodes?: WorkflowNode[] };
  triggerSchema?: Record<string, unknown>;
  enabled?: boolean;
  nodeCount?: number;
};

async function workflows(ctx: JudgeContext): Promise<WorkflowRecord[]> {
  return apiList<WorkflowRecord>(ctx, "/api/workflows?fields=full", ["workflows"]);
}

function nextTargets(node: WorkflowNode): string[] {
  if (!node.next) return [];
  if (typeof node.next === "string") return [node.next];
  if (Array.isArray(node.next)) return node.next;
  return Object.values(node.next);
}

function isConnected(nodes: WorkflowNode[]): boolean {
  if (nodes.length === 0) return false;
  const targeted = new Set(nodes.flatMap(nextTargets));
  const entry = nodes.find((n) => !targeted.has(n.id)) ?? nodes[0];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const queue = [entry.id];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const target of nextTargets(byId.get(id)!)) queue.push(target);
  }
  return seen.size === nodes.length;
}

function interpolationInputsCovered(nodes: WorkflowNode[]): boolean {
  for (const node of nodes) {
    const text = safeStringify(node.config);
    const refs = [...text.matchAll(/\{\{\s*([a-zA-Z0-9_-]+)\./g)].map((m) => m[1]);
    const external = refs.filter((r) => r !== "trigger" && r !== "input");
    for (const ref of external) {
      if (
        !Object.values(node.inputs ?? {}).some(
          (source) => source.startsWith(`${ref}.`) || source === ref,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

const supportedSchemaKeys = new Set(["type", "required", "properties", "enum", "const", "items"]);

function onlySupportedSchemaKeys(value: unknown, inProperties = false): boolean {
  if (!value || typeof value !== "object") return true;
  if (Array.isArray(value))
    return value.every((item) => onlySupportedSchemaKeys(item, inProperties));
  for (const [key, child] of Object.entries(value)) {
    if (!inProperties && !supportedSchemaKeys.has(key)) return false;
    if (!onlySupportedSchemaKeys(child, key === "properties")) return false;
  }
  return true;
}

const workflowExistsGate: DeterministicCheck = {
  name: "workflow-exists",
  fn: async (ctx) => {
    const rows = await workflows(ctx);
    return { pass: rows.length === 1, detail: `${rows.length} workflows found` };
  },
};

const workflowDagCheck: DeterministicCheck = {
  name: "workflow-dag-behavior",
  fn: async (ctx): Promise<CheckResult> => {
    const wf = (await workflows(ctx))[0];
    const nodes = wf?.definition?.nodes ?? [];
    const tools = await taskToolUses(ctx, ctx.tasks[0]);
    const usedTool = hasTool(tools, ["create-workflow", "create_workflow"]);
    if (!usedTool) return { pass: false, score: 0, detail: "create-workflow tool was not used" };

    const nodeScore = nodes.length >= 4 ? 1 : nodes.length === 3 ? 0.5 : 0;
    const hasSwarmScript = nodes.some((n) => n.type === "swarm-script" && n.config?.scriptName);
    const hasAgentTaskWithSchema = nodes.some(
      (n) => n.type === "agent-task" && n.config && "outputSchema" in n.config,
    );
    const inputsCovered = interpolationInputsCovered(nodes);
    const connected = isConnected(nodes);
    const score =
      (nodeScore * 2 +
        (hasSwarmScript ? 3 : 0) +
        (inputsCovered ? 2 : 0) +
        (connected ? 1 : 0) +
        (hasAgentTaskWithSchema ? 1 : 0)) /
      9;
    return scoreResult("workflow DAG", score, [
      `nodes=${nodes.length}`,
      `swarm-script=${hasSwarmScript ? "yes" : "no"}`,
      `inputs=${inputsCovered ? "covered" : "missing"}`,
      `connected=${connected ? "yes" : "no"}`,
      `agent-outputSchema=${hasAgentTaskWithSchema ? "yes" : "no"}`,
    ]);
  },
};

const triggerSchemaCheck: DeterministicCheck = {
  name: "trigger-schema-supported",
  fn: async (ctx): Promise<CheckResult> => {
    const schema = (await workflows(ctx))[0]?.triggerSchema;
    const present = Boolean(schema && Object.keys(schema).length > 0);
    const supported = present && onlySupportedSchemaKeys(schema);
    const hasRequiredPayload =
      present &&
      safeStringify(schema).includes("repository") &&
      safeStringify(schema).includes("pullRequest");
    return scoreResult(
      "trigger schema",
      ((present ? 1 : 0) + (supported ? 1 : 0) + (hasRequiredPayload ? 1 : 0)) / 3,
      [
        `present=${present ? "yes" : "no"}`,
        `supported-keywords=${supported ? "yes" : "no"}`,
        `payload-fields=${hasRequiredPayload ? "yes" : "no"}`,
      ],
    );
  },
};

const workflowCorrectnessCheck: DeterministicCheck = {
  name: "workflow-correctness",
  fn: async (ctx): Promise<CheckResult> => {
    const wf = (await workflows(ctx))[0];
    const nodes = wf?.definition?.nodes ?? [];
    const requiredTypes = ["swarm-script", "agent-task"];
    const matched = requiredTypes.filter((type) => nodes.some((n) => n.type === type)).length;
    const score = clamp01((matched + (wf?.enabled === false ? 0 : 1)) / 3);
    return {
      pass: score >= 1,
      score,
      detail: `${matched}/2 required node types plus enabled workflow`,
    };
  },
};

export const workflowAuthoring: Scenario = {
  id: "workflow-authoring",
  name: "Workflow authoring",
  description:
    "Author a multi-node workflow through the swarm workflow tool, grading the persisted DAG, input mappings, reusable swarm-script selection, and trigger schema.",
  workers: 1,
  tasks: [
    {
      title: "Create a deterministic PR-review workflow",
      description: [
        "Create exactly one workflow using the create-workflow MCP tool.",
        "The workflow should accept a pull-request webhook payload with repository, pullRequest number, and requester fields.",
        "Use a reusable swarm-script node discovered from the script catalog for the deterministic lint/check phase; do not inline that logic as a plain script node.",
        "Then use an agent-task node that consumes the script result through an explicit inputs mapping and requires structured JSON output with summary, passed, and nextAction fields.",
        "Finish with a notification/summary node or equivalent final node. Use a triggerSchema with only supported keywords: type, required, properties, enum, const, items.",
        "Report completion through store-progress after the workflow is created.",
      ].join("\n"),
    },
  ],
  outcome: {
    gates: [workflowExistsGate],
    dimensions: [
      { name: "workflow-dag", weight: 4, checks: [workflowDagCheck] },
      { name: "trigger-schema", weight: 2, checks: [triggerSchemaCheck] },
      { name: "correctness", weight: 1, checks: [workflowCorrectnessCheck] },
    ],
  },
  timeoutMs: 10 * 60_000,
};

export const __test__ = {
  workflowDagCheck,
  triggerSchemaCheck,
  workflowCorrectnessCheck,
  workflowExistsGate,
  onlySupportedSchemaKeys,
};
