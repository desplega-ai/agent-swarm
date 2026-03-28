import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition, WorkflowDefinitionPatch } from "../types";
import { applyDefinitionPatch } from "../workflows/definition";

// ─── Helper ──────────────────────────────────────────────────

function makeDef(
  nodes: WorkflowDefinition["nodes"],
  onNodeFailure?: "fail" | "continue",
): WorkflowDefinition {
  return { nodes, onNodeFailure: onNodeFailure ?? "fail" };
}

// ─── applyDefinitionPatch() unit tests ──────────────────────

describe("applyDefinitionPatch", () => {
  const baseDef = makeDef([
    { id: "a", type: "agent-task", config: { template: "Hello" }, next: "b" },
    { id: "b", type: "agent-task", config: { template: "World" } },
  ]);

  // --- Delete ---

  test("delete removes nodes", () => {
    const patch: WorkflowDefinitionPatch = { delete: ["b"] };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toEqual([]);
    expect(result.definition.nodes).toHaveLength(1);
    expect(result.definition.nodes[0]!.id).toBe("a");
  });

  test("delete returns error for non-existent node", () => {
    const patch: WorkflowDefinitionPatch = { delete: ["nonexistent"] };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("non-existent");
    expect(result.errors[0]).toContain("nonexistent");
  });

  // --- Create ---

  test("create adds nodes", () => {
    const patch: WorkflowDefinitionPatch = {
      create: [{ id: "c", type: "agent-task", config: { template: "New" } }],
    };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toEqual([]);
    expect(result.definition.nodes).toHaveLength(3);
    expect(result.definition.nodes[2]!.id).toBe("c");
  });

  test("create returns error for duplicate ID", () => {
    const patch: WorkflowDefinitionPatch = {
      create: [{ id: "a", type: "agent-task", config: { template: "Dup" } }],
    };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("duplicate");
    expect(result.errors[0]).toContain('"a"');
  });

  // --- Update ---

  test("update merges fields (shallow)", () => {
    const patch: WorkflowDefinitionPatch = {
      update: [{ nodeId: "b", node: { label: "Updated", config: { template: "Changed" } } }],
    };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toEqual([]);
    const updated = result.definition.nodes.find((n) => n.id === "b");
    expect(updated!.label).toBe("Updated");
    expect(updated!.config).toEqual({ template: "Changed" });
    expect(updated!.type).toBe("agent-task"); // preserved
  });

  test("update returns error for non-existent node", () => {
    const patch: WorkflowDefinitionPatch = {
      update: [{ nodeId: "nonexistent", node: { label: "Nope" } }],
    };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("non-existent");
    expect(result.errors[0]).toContain('"nonexistent"');
  });

  // --- Combined operations ---

  test("delete → create → update ordering works in single patch", () => {
    const patch: WorkflowDefinitionPatch = {
      delete: ["b"],
      create: [{ id: "c", type: "script", config: {} }],
      update: [{ nodeId: "a", node: { next: "c" } }],
    };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toEqual([]);
    expect(result.definition.nodes).toHaveLength(2);
    const nodeA = result.definition.nodes.find((n) => n.id === "a");
    expect(nodeA!.next).toBe("c");
    expect(result.definition.nodes.find((n) => n.id === "b")).toBeUndefined();
    expect(result.definition.nodes.find((n) => n.id === "c")).toBeDefined();
  });

  test("delete + create same ID in one patch works (delete runs first)", () => {
    const patch: WorkflowDefinitionPatch = {
      delete: ["b"],
      create: [{ id: "b", type: "script", config: { template: "Replacement" } }],
    };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toEqual([]);
    const nodeB = result.definition.nodes.find((n) => n.id === "b");
    expect(nodeB).toBeDefined();
    expect(nodeB!.type).toBe("script");
    expect(nodeB!.config).toEqual({ template: "Replacement" });
  });

  // --- Multiple errors ---

  test("collects multiple errors in one patch", () => {
    const patch: WorkflowDefinitionPatch = {
      delete: ["nonexistent1"],
      create: [{ id: "a", type: "script", config: {} }], // duplicate
      update: [{ nodeId: "nonexistent2", node: { label: "Nope" } }],
    };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toHaveLength(3);
  });

  // --- onNodeFailure ---

  test("preserves onNodeFailure when not patched", () => {
    const def = makeDef([{ id: "a", type: "agent-task", config: {} }], "continue");
    const patch: WorkflowDefinitionPatch = {
      update: [{ nodeId: "a", node: { label: "Labeled" } }],
    };
    const result = applyDefinitionPatch(def, patch);
    expect(result.errors).toEqual([]);
    expect(result.definition.onNodeFailure).toBe("continue");
  });

  test("patches onNodeFailure when provided", () => {
    const patch: WorkflowDefinitionPatch = { onNodeFailure: "continue" };
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toEqual([]);
    expect(result.definition.onNodeFailure).toBe("continue");
  });

  // --- Empty patch ---

  test("empty patch returns definition unchanged with no errors", () => {
    const patch: WorkflowDefinitionPatch = {};
    const result = applyDefinitionPatch(baseDef, patch);
    expect(result.errors).toEqual([]);
    expect(result.definition.nodes).toEqual(baseDef.nodes);
    expect(result.definition.onNodeFailure).toBe(baseDef.onNodeFailure);
  });

  // --- Immutability ---

  test("does not mutate original definition", () => {
    const original = makeDef([{ id: "a", type: "agent-task", config: { template: "Hello" } }]);
    const originalNodes = [...original.nodes];
    const patch: WorkflowDefinitionPatch = {
      create: [{ id: "b", type: "script", config: {} }],
    };
    applyDefinitionPatch(original, patch);
    expect(original.nodes).toEqual(originalNodes);
    expect(original.nodes).toHaveLength(1);
  });
});
