import type {
  PatchResult,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowPatch,
} from "../types";
import type { ExecutorRegistry } from "./executors/registry";

/** Extract all target node IDs from a node's `next` field */
export function getNextTargets(next: string | string[] | Record<string, string>): string[] {
  if (typeof next === "string") return [next];
  if (Array.isArray(next)) return next;
  return Object.values(next);
}

/**
 * Auto-generate edges from `next` references — for UI graph rendering.
 */
export function generateEdges(def: WorkflowDefinition): WorkflowEdge[] {
  const edges: WorkflowEdge[] = [];
  for (const node of def.nodes) {
    if (!node.next) continue;
    if (typeof node.next === "string") {
      edges.push({
        id: `${node.id}→${node.next}`,
        source: node.id,
        target: node.next,
        sourcePort: "default",
      });
    } else if (Array.isArray(node.next)) {
      for (const targetId of node.next) {
        edges.push({
          id: `${node.id}→${targetId}`,
          source: node.id,
          target: targetId,
          sourcePort: "default",
        });
      }
    } else {
      for (const [port, targetId] of Object.entries(node.next)) {
        edges.push({
          id: `${node.id}→${targetId}:${port}`,
          source: node.id,
          target: targetId,
          sourcePort: port,
        });
      }
    }
  }
  return edges;
}

/**
 * Find entry nodes — nodes that no other node references via `next`.
 */
export function findEntryNodes(def: WorkflowDefinition): WorkflowNode[] {
  const targets = new Set<string>();
  for (const node of def.nodes) {
    if (!node.next) continue;
    for (const targetId of getNextTargets(node.next)) {
      targets.add(targetId);
    }
  }
  return def.nodes.filter((n) => !targets.has(n.id));
}

/**
 * Get successor node IDs for a given node and port.
 */
export function getSuccessors(
  def: WorkflowDefinition,
  nodeId: string,
  port?: string,
): WorkflowNode[] {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node?.next) return [];

  const targetIds: string[] = [];
  if (typeof node.next === "string") {
    // Single next — any port matches
    targetIds.push(node.next);
  } else if (Array.isArray(node.next)) {
    // Fan-out — all targets are parallel successors (port is ignored)
    targetIds.push(...node.next);
  } else {
    if (port) {
      // Port-based — look up the specific port
      const targetId = node.next[port];
      if (targetId) targetIds.push(targetId);
    } else {
      // No port specified — return all targets
      targetIds.push(...Object.values(node.next));
    }
  }

  return targetIds
    .map((id) => def.nodes.find((n) => n.id === id))
    .filter((n): n is WorkflowNode => n != null);
}

/**
 * Check whether `sourceId` is a transitive predecessor (upstream) of `targetId`.
 * Uses reverse BFS from target backwards through the graph.
 */
export function isUpstream(def: WorkflowDefinition, sourceId: string, targetId: string): boolean {
  // Build reverse dependency map: target → list of source nodes that point to it
  const reverseDeps = new Map<string, string[]>();
  for (const node of def.nodes) {
    if (!node.next) continue;
    for (const target of getNextTargets(node.next)) {
      if (!reverseDeps.has(target)) reverseDeps.set(target, []);
      reverseDeps.get(target)!.push(node.id);
    }
  }

  // BFS backwards from targetId
  const visited = new Set<string>();
  const queue = [targetId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const preds = reverseDeps.get(current) || [];
    for (const pred of preds) {
      if (visited.has(pred)) continue;
      visited.add(pred);
      if (pred === sourceId) return true;
      queue.push(pred);
    }
  }
  return false;
}

function containsInterpolationToken(value: unknown): boolean {
  if (typeof value === "string") return value.includes("{{") && value.includes("}}");
  if (Array.isArray(value)) return value.some(containsInterpolationToken);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsInterpolationToken);
  }
  return false;
}

/**
 * Node ids of a stored definition — passed to validateDefinition as
 * `legacyNodeIds` by update/patch paths so ids that predate the reserved-`#`
 * rule stay editable.
 */
export function definitionNodeIds(def: WorkflowDefinition): Set<string> {
  return new Set(def.nodes.map((node) => node.id));
}

/**
 * Validate a workflow definition for structural correctness.
 *
 * Checks:
 * 1. All `next` references point to existing node IDs
 * 2. Exactly one entry node (no incoming `next` references)
 * 3. No orphaned nodes (every non-entry node must be reachable from entry)
 * 4. All node types are registered in the executor registry (if provided)
 * 5. Input mappings reference existing, upstream nodes
 */
export function validateDefinition(
  def: WorkflowDefinition,
  registry?: ExecutorRegistry,
  options: { legacyNodeIds?: ReadonlySet<string> } = {},
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const nodeIds = new Set(def.nodes.map((n) => n.id));

  for (const node of def.nodes) {
    // `#` is reserved for synthetic foreach child ids — but only for NEW or
    // renamed nodes. Node ids were unrestricted before this rule, so update/patch
    // paths pass the stored definition's ids (legacyNodeIds) to keep a workflow
    // that already contains one editable instead of bricked.
    if (node.id.includes("#") && !options.legacyNodeIds?.has(node.id)) {
      errors.push(`Node "${node.id}" contains reserved character "#"`);
    }
    if (node.type === "foreach") {
      validateForeachNode(node, errors);
      // A legacy `#` id may stay editable as a NORMAL node, but never as a foreach
      // parent: its children would be `a#b#item`, and parseSyntheticNodeId splits on
      // the FIRST `#`, so the join would resolve them to parent "a" and never close.
      if (node.id.includes("#")) {
        errors.push(
          `Node "${node.id}" cannot be a foreach: its id contains "#", which is reserved for synthetic child ids`,
        );
      }
      if (isUpstream(def, node.id, node.id)) {
        errors.push("foreach inside a loop is not supported in v1");
      }
      // Synthetic children are named `<foreachId>#<itemKey>`. A (legacy,
      // grandfathered) node whose id starts with that prefix would be
      // indistinguishable from a child — resolveForeachParent would classify
      // both, corrupting the join and routing — so the foreach itself is
      // rejected when such a sibling exists.
      const collidingSibling = def.nodes.find(
        (other) => other.id !== node.id && other.id.startsWith(`${node.id}#`),
      );
      if (collidingSibling) {
        errors.push(
          `Node "${node.id}" cannot be a foreach: node "${collidingSibling.id}" collides with its synthetic child id space ("${node.id}#…")`,
        );
      }
    }
  }

  // 1. Check all next refs point to existing nodes
  for (const node of def.nodes) {
    if (!node.next) continue;
    if (typeof node.next === "string") {
      if (!nodeIds.has(node.next)) {
        errors.push(`Node "${node.id}" references non-existent next target "${node.next}"`);
      }
    } else if (Array.isArray(node.next)) {
      for (const targetId of node.next) {
        if (!nodeIds.has(targetId)) {
          errors.push(`Node "${node.id}" fan-out references non-existent target "${targetId}"`);
        }
      }
    } else {
      for (const [port, targetId] of Object.entries(node.next)) {
        if (!nodeIds.has(targetId)) {
          errors.push(
            `Node "${node.id}" port "${port}" references non-existent target "${targetId}"`,
          );
        }
      }
    }
  }

  // 2. Check exactly one entry node
  const entryNodes = findEntryNodes(def);
  if (entryNodes.length === 0) {
    errors.push("No entry node found (every node is a target of some other node)");
  } else if (entryNodes.length > 1) {
    const ids = entryNodes.map((n) => `"${n.id}"`).join(", ");
    errors.push(`Multiple entry nodes found: ${ids} (expected exactly one)`);
  }

  // 3. Check for orphaned nodes (unreachable from entry)
  if (entryNodes.length === 1) {
    const reachable = new Set<string>();
    const queue = [entryNodes[0]!.id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      const node = def.nodes.find((n) => n.id === current);
      if (!node?.next) continue;
      for (const targetId of getNextTargets(node.next)) {
        queue.push(targetId);
      }
    }
    for (const node of def.nodes) {
      if (!reachable.has(node.id)) {
        errors.push(`Node "${node.id}" is unreachable from the entry node`);
      }
    }
  }

  // 4. Check all node types and executor-specific configs (if registry provided)
  if (registry) {
    for (const node of def.nodes) {
      if (!registry.has(node.type)) {
        errors.push(`Node "${node.id}" uses unregistered executor type "${node.type}"`);
        continue;
      }

      reportStaticConfigIssues(node, registry.get(node.type).configSchema, node.config, errors);

      // A foreach body is executed by the agent-task executor per item — hold its
      // static config to the same schema a top-level agent-task node gets, so an
      // invalid field (priority: 101, tags: "x") fails at authoring instead of
      // after the fan-out materialized. Interpolated fields defer as usual.
      if (node.type === "foreach" && registry.has("agent-task")) {
        const body = node.config.body;
        const bodyConfig =
          typeof body === "object" && body !== null && !Array.isArray(body)
            ? (body as Record<string, unknown>).config
            : undefined;
        if (typeof bodyConfig === "object" && bodyConfig !== null && !Array.isArray(bodyConfig)) {
          reportStaticConfigIssues(
            node,
            registry.get("agent-task").configSchema,
            bodyConfig,
            errors,
            "config.body.config",
          );
        }
      }
    }
  }

  // 5. Check input mappings reference existing, upstream nodes
  for (const node of def.nodes) {
    if (!node.inputs) continue;
    for (const [localName, sourcePath] of Object.entries(node.inputs)) {
      const [sourceNodeId] = sourcePath.split(".");
      if (!sourceNodeId) continue;

      // Skip built-in context sources
      if (sourceNodeId === "trigger" || sourceNodeId === "input" || sourceNodeId === "run") {
        continue;
      }

      // Check source node exists
      if (!nodeIds.has(sourceNodeId)) {
        errors.push(
          `Node "${node.id}" input "${localName}" references non-existent node "${sourceNodeId}"`,
        );
        continue;
      }

      // Check source node is upstream (transitive predecessor)
      if (!isUpstream(def, sourceNodeId, node.id)) {
        errors.push(
          `Node "${node.id}" input "${localName}" references "${sourceNodeId}" which is not upstream`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Report schema issues for the statically-known parts of a config object.
 * Fields containing interpolation tokens defer to the same executor schema
 * after interpolation; static values fail at authoring time.
 */
function reportStaticConfigIssues(
  node: WorkflowNode,
  schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: unknown[] } } },
  config: unknown,
  errors: string[],
  pathPrefix = "config",
): void {
  const result = schema.safeParse(config);
  if (result.success) return;
  for (const rawIssue of result.error?.issues ?? []) {
    const issue = rawIssue as { path: PropertyKey[]; message: string };
    const issuePath = issue.path.map(String);
    const path = [pathPrefix, ...issuePath].join(".");
    let value: unknown = config;
    for (const segment of issue.path) {
      if (value === null || typeof value !== "object") {
        value = undefined;
        break;
      }
      value = (value as Record<PropertyKey, unknown>)[segment];
    }
    if (containsInterpolationToken(value)) continue;
    const renderedValue = value === undefined ? "undefined" : JSON.stringify(value);
    errors.push(
      `Node "${node.id}" (${node.type}) ${path} has invalid value ${renderedValue}: ${issue.message}`,
    );
  }
}

function validateForeachNode(node: WorkflowNode, errors: string[]): void {
  const config = node.config;
  if (Object.hasOwn(config, "concurrency")) {
    errors.push(`Node "${node.id}" foreach concurrency is not supported in v1`);
  }

  // The asynchronous join (joinForeach) checkpoints the aggregate and routes
  // successors without re-entering executeStep, so node-level outputSchema /
  // validation would be silently skipped on every async completion. Reject at
  // authoring time rather than half-enforcing. The per-child agent-task
  // body.config.outputSchema is unaffected.
  if (node.outputSchema !== undefined || node.validation !== undefined) {
    errors.push(
      `Node "${node.id}" foreach node-level outputSchema/validation is not supported in v1`,
    );
  }

  const over = config.over;
  const isInterpolatedArray = typeof over === "string" && /^\{\{[^}]+\}\}$/.test(over.trim());
  if (!Array.isArray(over) && !isInterpolatedArray) {
    errors.push(
      `Node "${node.id}" foreach config.over must be an array or one exact {{interpolation}} token`,
    );
  }

  if (typeof config.itemKey !== "string" || config.itemKey.length === 0) {
    errors.push(`Node "${node.id}" foreach config.itemKey must be a non-empty string`);
  }

  const body = config.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    errors.push(`Node "${node.id}" foreach config.body must be an object`);
    return;
  }
  const bodyRecord = body as Record<string, unknown>;
  if (bodyRecord.type !== "agent-task") {
    errors.push(`Node "${node.id}" foreach config.body.type must be "agent-task" in v1`);
  }
  if (
    typeof bodyRecord.config !== "object" ||
    bodyRecord.config === null ||
    Array.isArray(bodyRecord.config)
  ) {
    errors.push(`Node "${node.id}" foreach config.body.config must be an object`);
    return;
  }
  const bodyConfig = bodyRecord.config as Record<string, unknown>;
  if (typeof bodyConfig.template !== "string") {
    errors.push(`Node "${node.id}" foreach agent-task body.config.template must be a string`);
  }
}

/**
 * Apply a patch to a workflow definition. Returns a result with the
 * patched definition and a list of errors (empty if all operations succeeded).
 *
 * Operations are applied in order: delete → create → update.
 * Each operation collects errors independently — all operations are attempted
 * even if earlier ones have errors. Validation of the resulting definition
 * (next refs, entry nodes, etc.) is the caller's responsibility.
 */
export function applyDefinitionPatch(def: WorkflowDefinition, patch: WorkflowPatch): PatchResult {
  const errors: string[] = [];
  let nodes = [...def.nodes];

  // 1. Delete
  if (patch.delete?.length) {
    const missing = patch.delete.filter((id) => !nodes.some((n) => n.id === id));
    if (missing.length > 0) {
      errors.push(`Cannot delete non-existent nodes: ${missing.join(", ")}`);
    }
    const toDelete = new Set(patch.delete);
    nodes = nodes.filter((n) => !toDelete.has(n.id));
  }

  // 2. Create
  if (patch.create?.length) {
    const existingIds = new Set(nodes.map((n) => n.id));
    for (const newNode of patch.create) {
      if (existingIds.has(newNode.id)) {
        errors.push(`Cannot create node with duplicate ID: "${newNode.id}"`);
        continue;
      }
      nodes.push(newNode);
      existingIds.add(newNode.id);
    }
  }

  // 3. Update (shallow merge per node)
  if (patch.update?.length) {
    for (const { nodeId, node: partial } of patch.update) {
      const idx = nodes.findIndex((n) => n.id === nodeId);
      if (idx === -1) {
        errors.push(`Cannot update non-existent node: "${nodeId}"`);
        continue;
      }
      // Filter out undefined values so we don't overwrite required fields with undefined
      const defined: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(partial)) {
        if (v !== undefined) defined[k] = v;
      }
      nodes[idx] = { ...nodes[idx], ...defined, id: nodeId } as WorkflowNode;
    }
  }

  const patchedDef: WorkflowDefinition = { ...def, nodes };
  if (patch.onNodeFailure !== undefined) {
    patchedDef.onNodeFailure = patch.onNodeFailure;
  }

  return { definition: patchedDef, errors };
}
