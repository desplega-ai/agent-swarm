import type { WorkflowDefinition, WorkflowNode } from "../types";
import type { ExecutorRegistry } from "./executors/registry";
import { resolveForeachParent } from "./foreach-join";

/**
 * Executor types a `foreach` body must not use, with the reason. Every other
 * registered executor is a valid body.
 */
export const FOREACH_BODY_REJECTED: Readonly<Record<string, string>> = {
  foreach: "nested fan-out is not supported: synthetic ids and the join resolve one level only",
};

/**
 * Built-in executors accepted as a `foreach` body, by how one item completes:
 * `inline` items are run and settled by the foreach driver; `parks` items wait
 * on their own resume path (task, child run, approval, wait), which settles
 * the item through `settleForeachChild`. A `system-one-decision` without
 * `humanReview` returns inline.
 *
 * Every built-in executor must appear here or in FOREACH_BODY_REJECTED; the
 * registry exhaustiveness test enforces that a new executor gets a decision.
 */
export const FOREACH_BODY_ACCEPTED: Readonly<Record<string, "inline" | "parks">> = {
  script: "inline",
  "swarm-script": "inline",
  "raw-llm": "inline",
  notify: "inline",
  "property-match": "inline",
  "code-match": "inline",
  validate: "inline",
  vcs: "inline",
  "system-one-extraction": "inline",
  "agent-task": "parks",
  "sub-workflow": "parks",
  "human-in-the-loop": "parks",
  wait: "parks",
  "system-one-decision": "parks",
};

/**
 * True when `type` may be a foreach body: not rejected, and registered (or a
 * known built-in when no registry is passed).
 */
export function isForeachBodyType(type: string, registry?: ExecutorRegistry): boolean {
  if (Object.hasOwn(FOREACH_BODY_REJECTED, type)) return false;
  return registry ? registry.has(type) : Object.hasOwn(FOREACH_BODY_ACCEPTED, type);
}

/**
 * The validation error for a foreach body type, or null when it is allowed.
 * Without a registry only the rejection list applies, so a custom executor
 * registered at run time is not refused by a registry-less validation pass.
 */
export function foreachBodyTypeError(
  nodeId: string,
  type: string,
  registry?: ExecutorRegistry,
): string | null {
  const reason = FOREACH_BODY_REJECTED[type];
  if (reason !== undefined) {
    return `Node "${nodeId}" foreach config.body.type "${type}" is not supported: ${reason} (a ${type} body inside foreach "${nodeId}" is rejected)`;
  }
  if (registry && !registry.has(type)) {
    return `Node "${nodeId}" foreach config.body.type "${type}" is not a registered executor`;
  }
  return null;
}

/**
 * The definition node a step row executes. A real node wins. A synthetic
 * foreach child id (`<foreachId>#<itemKey>`) resolves to a node synthesized
 * from the parent's body: the child's id, the body's type and config, and the
 * parent's declared `inputs` (the body sees the parent's input context, and the
 * script-body allowlist classifies those aliases by their source).
 */
export function resolveStepNode(
  def: Pick<WorkflowDefinition, "nodes">,
  nodeId: string,
): WorkflowNode | null {
  const node = def.nodes.find((candidate) => candidate.id === nodeId);
  if (node) return node;
  const parent = resolveForeachParent(def, nodeId);
  if (!parent) return null;
  const body = parent.config.body;
  if (!isRecord(body) || typeof body.type !== "string") return null;
  // `item` and `index` are bound per item, so a parent alias with either name
  // is dropped: it would otherwise classify item data by the alias's source
  // and let it past the script-body allowlist.
  const inputs = parent.inputs
    ? Object.fromEntries(
        Object.entries(parent.inputs).filter(([alias]) => !FOREACH_ITEM_BINDINGS.has(alias)),
      )
    : undefined;
  return {
    id: nodeId,
    type: body.type,
    config: isRecord(body.config) ? body.config : {},
    ...(inputs ? { inputs } : {}),
  };
}

const FOREACH_ITEM_BINDINGS = new Set(["item", "index"]);

export const FOREACH_FAILURE_POLICIES = ["fail-fast", "collect-outcomes"] as const;
export type ForeachFailurePolicy = (typeof FOREACH_FAILURE_POLICIES)[number];

/**
 * How a failed or cancelled item affects its fan-out. `config.failurePolicy`
 * wins; otherwise it follows the workflow's `onNodeFailure`, so a definition
 * without the field behaves as before: `"continue"` collects outcomes, the
 * default `"fail"` is fail-fast.
 */
export function effectiveFailurePolicy(
  node: WorkflowNode,
  def: Pick<WorkflowDefinition, "onNodeFailure">,
): ForeachFailurePolicy {
  const configured = node.config.failurePolicy;
  if (configured === "fail-fast" || configured === "collect-outcomes") return configured;
  return def.onNodeFailure === "continue" ? "collect-outcomes" : "fail-fast";
}

/** How many items of a fan-out may be in flight at once. Unbounded by default. */
export function foreachConcurrencyCap(node: WorkflowNode): number {
  const cap = node.config.concurrency;
  return typeof cap === "number" && Number.isInteger(cap) && cap >= 1
    ? cap
    : Number.POSITIVE_INFINITY;
}

/**
 * The failure mode a foreach child's task failure takes: the fan-out's
 * effective policy for a synthetic child, the workflow's `onNodeFailure`
 * otherwise.
 */
export function stepFailureMode(
  def: Pick<WorkflowDefinition, "nodes" | "onNodeFailure">,
  nodeId: string,
): "fail" | "continue" {
  const parent = resolveForeachParent(def, nodeId);
  if (parent) return effectiveFailurePolicy(parent, def) === "fail-fast" ? "fail" : "continue";
  return def.onNodeFailure ?? "fail";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
