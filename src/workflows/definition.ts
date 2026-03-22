import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "../types";
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

  // 4. Check all node types are registered (if registry provided)
  if (registry) {
    for (const node of def.nodes) {
      if (!registry.has(node.type)) {
        errors.push(`Node "${node.id}" uses unregistered executor type "${node.type}"`);
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
      if (sourceNodeId === "trigger" || sourceNodeId === "input") continue;

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
