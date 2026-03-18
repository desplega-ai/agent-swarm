import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "../types";
import type { ExecutorRegistry } from "./executors/registry";

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
    if (typeof node.next === "string") {
      targets.add(node.next);
    } else {
      for (const targetId of Object.values(node.next)) {
        targets.add(targetId);
      }
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
 * Validate a workflow definition for structural correctness.
 *
 * Checks:
 * 1. All `next` references point to existing node IDs
 * 2. Exactly one entry node (no incoming `next` references)
 * 3. No orphaned nodes (every non-entry node must be reachable from entry)
 * 4. All node types are registered in the executor registry (if provided)
 */
export function validateDefinition(
  def: WorkflowDefinition,
  registry?: ExecutorRegistry,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const nodeIds = new Set(def.nodes.map((n) => n.id));

  // 1. Check all next refs point to existing nodes
  for (const node of def.nodes) {
    if (!node.next) continue;
    if (typeof node.next === "string") {
      if (!nodeIds.has(node.next)) {
        errors.push(`Node "${node.id}" references non-existent next target "${node.next}"`);
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
      if (typeof node.next === "string") {
        queue.push(node.next);
      } else {
        queue.push(...Object.values(node.next));
      }
    }
    for (const node of def.nodes) {
      if (!reachable.has(node.id)) {
        errors.push(`Node "${node.id}" is unreachable from the entry node`);
      }
    }
  }

  // 4. Check all node types are registered (if registry provided)
  if (registry) {
    for (const node of def.nodes) {
      if (!registry.has(node.type)) {
        errors.push(`Node "${node.id}" uses unregistered executor type "${node.type}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
