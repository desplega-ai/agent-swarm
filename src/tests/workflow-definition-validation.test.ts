import { describe, expect, test } from "bun:test";
import type { WorkflowDefinition } from "../types";
import { isUpstream, validateDefinition } from "../workflows/definition";

// ─── Helper ──────────────────────────────────────────────────

function makeDef(nodes: WorkflowDefinition["nodes"]): WorkflowDefinition {
  return { nodes };
}

// ─── isUpstream() unit tests ─────────────────────────────────

describe("isUpstream", () => {
  test("direct predecessor is upstream", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      { id: "B", type: "script", config: {} },
    ]);
    expect(isUpstream(def, "A", "B")).toBe(true);
  });

  test("transitive predecessor is upstream", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      { id: "B", type: "script", config: {}, next: "C" },
      { id: "C", type: "script", config: {} },
    ]);
    expect(isUpstream(def, "A", "C")).toBe(true);
  });

  test("downstream node is not upstream", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      { id: "B", type: "script", config: {} },
    ]);
    expect(isUpstream(def, "B", "A")).toBe(false);
  });

  test("parallel sibling is not upstream", () => {
    // A → B, A → C (B and C are siblings, not upstream of each other)
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: { left: "B", right: "C" } },
      { id: "B", type: "script", config: {} },
      { id: "C", type: "script", config: {} },
    ]);
    expect(isUpstream(def, "B", "C")).toBe(false);
    expect(isUpstream(def, "C", "B")).toBe(false);
  });

  test("self is not upstream", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      { id: "B", type: "script", config: {} },
    ]);
    expect(isUpstream(def, "A", "A")).toBe(false);
  });

  test("complex DAG — multiple paths", () => {
    // A → B, A → C, B → D, C → D
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: { left: "B", right: "C" } },
      { id: "B", type: "script", config: {}, next: "D" },
      { id: "C", type: "script", config: {}, next: "D" },
      { id: "D", type: "script", config: {} },
    ]);
    expect(isUpstream(def, "A", "D")).toBe(true);
    expect(isUpstream(def, "B", "D")).toBe(true);
    expect(isUpstream(def, "C", "D")).toBe(true);
    expect(isUpstream(def, "D", "A")).toBe(false);
  });

  test("non-existent node returns false", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      { id: "B", type: "script", config: {} },
    ]);
    expect(isUpstream(def, "Z", "B")).toBe(false);
  });
});

// ─── validateDefinition() input mapping checks ──────────────

describe("validateDefinition — input mapping validation", () => {
  test("input references existing upstream node → valid", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      {
        id: "B",
        type: "script",
        config: {},
        inputs: { result: "A.output" },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test("input references non-existent node → error with node name", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      {
        id: "B",
        type: "script",
        config: {},
        inputs: { result: "ghost.output" },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("ghost");
    expect(errors[0]).toContain("non-existent");
    expect(errors[0]).toContain('Node "B"');
  });

  test("input references downstream node → error", () => {
    const def = makeDef([
      {
        id: "A",
        type: "script",
        config: {},
        next: "B",
        inputs: { future: "B.output" },
      },
      { id: "B", type: "script", config: {} },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not upstream");
    expect(errors[0]).toContain('Node "A"');
  });

  test("input references parallel sibling → error", () => {
    // A → B, A → C; C tries to reference B (sibling, not upstream)
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: { left: "B", right: "C" } },
      { id: "B", type: "script", config: {} },
      {
        id: "C",
        type: "script",
        config: {},
        inputs: { data: "B.output" },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("not upstream");
    expect(errors[0]).toContain('"B"');
  });

  test("input references trigger.* → valid (built-in source)", () => {
    const def = makeDef([
      {
        id: "A",
        type: "script",
        config: {},
        inputs: { repo: "trigger.repo", msg: "trigger.message" },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test("input references input.* → valid (built-in source)", () => {
    const def = makeDef([
      {
        id: "A",
        type: "script",
        config: {},
        inputs: { key: "input.API_KEY" },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test("no inputs field → no data flow errors", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      { id: "B", type: "script", config: {} },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test("complex DAG with multiple paths — upstream detection works", () => {
    // A → B, A → C, B → D, C → D, D → E
    // E references A (deeply upstream) → valid
    // E references B (upstream via D) → valid
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: { left: "B", right: "C" } },
      { id: "B", type: "script", config: {}, next: "D" },
      { id: "C", type: "script", config: {}, next: "D" },
      { id: "D", type: "script", config: {}, next: "E" },
      {
        id: "E",
        type: "script",
        config: {},
        inputs: {
          fromA: "A.output",
          fromB: "B.result",
          fromD: "D.data",
        },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test("self-referencing node → error", () => {
    const def = makeDef([
      {
        id: "A",
        type: "script",
        config: {},
        inputs: { self: "A.output" },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("not upstream"))).toBe(true);
    expect(errors.some((e) => e.includes('"A"'))).toBe(true);
  });

  test("multiple input errors reported together", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      {
        id: "B",
        type: "script",
        config: {},
        inputs: {
          ghost: "nonexistent.output",
          self: "B.output",
        },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(false);
    // One error for non-existent, one for self-reference (not upstream)
    const inputErrors = errors.filter(
      (e) => e.includes("non-existent") || e.includes("not upstream"),
    );
    expect(inputErrors).toHaveLength(2);
  });

  test("mixed valid and invalid inputs — only invalid produce errors", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      {
        id: "B",
        type: "script",
        config: {},
        inputs: {
          ok: "A.output",
          triggerOk: "trigger.data",
          bad: "nonexistent.value",
        },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(false);
    // Only the "bad" input should produce an error
    const inputErrors = errors.filter((e) => e.includes("input"));
    expect(inputErrors).toHaveLength(1);
    expect(inputErrors[0]).toContain("nonexistent");
  });

  test("empty inputs object → no errors", () => {
    const def = makeDef([
      { id: "A", type: "script", config: {}, next: "B" },
      {
        id: "B",
        type: "script",
        config: {},
        inputs: {},
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });
});

// ─── Fan-out (array next) tests ─────────────────────────────

describe("fan-out with array next", () => {
  test("single entry fans out to 3 parallel nodes → valid", () => {
    const def = makeDef([
      { id: "start", type: "script", config: {}, next: ["review-a", "review-b", "review-c"] },
      { id: "review-a", type: "script", config: {}, next: "merge" },
      { id: "review-b", type: "script", config: {}, next: "merge" },
      { id: "review-c", type: "script", config: {}, next: "merge" },
      {
        id: "merge",
        type: "script",
        config: {},
        inputs: { a: "review-a", b: "review-b", c: "review-c" },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test("fan-out targets that don't exist → error", () => {
    const def = makeDef([
      { id: "start", type: "script", config: {}, next: ["a", "b", "nonexistent"] },
      { id: "a", type: "script", config: {} },
      { id: "b", type: "script", config: {} },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes("nonexistent"))).toBe(true);
  });

  test("fan-out nodes are not entry nodes", () => {
    const def = makeDef([
      { id: "start", type: "script", config: {}, next: ["a", "b"] },
      { id: "a", type: "script", config: {} },
      { id: "b", type: "script", config: {} },
    ]);
    const { valid, errors } = validateDefinition(def);
    // Only "start" is entry node — a and b are targets
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test("isUpstream works with fan-out", () => {
    const def = makeDef([
      { id: "start", type: "script", config: {}, next: ["a", "b", "c"] },
      { id: "a", type: "script", config: {}, next: "merge" },
      { id: "b", type: "script", config: {}, next: "merge" },
      { id: "c", type: "script", config: {}, next: "merge" },
      { id: "merge", type: "script", config: {} },
    ]);
    expect(isUpstream(def, "start", "a")).toBe(true);
    expect(isUpstream(def, "start", "merge")).toBe(true);
    expect(isUpstream(def, "a", "merge")).toBe(true);
    expect(isUpstream(def, "merge", "start")).toBe(false);
  });

  test("fan-out node inputs from parallel siblings → valid (all upstream via start)", () => {
    const def = makeDef([
      { id: "start", type: "script", config: {}, next: ["a", "b"] },
      { id: "a", type: "script", config: {}, next: "merge" },
      { id: "b", type: "script", config: {}, next: "merge" },
      {
        id: "merge",
        type: "script",
        config: {},
        inputs: { fromA: "a.output", fromB: "b.output" },
      },
    ]);
    const { valid, errors } = validateDefinition(def);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });
});
