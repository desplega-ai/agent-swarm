import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import { closeDb, initDb } from "../be/db";
import type { ExecutorMeta, WorkflowDefinition } from "../types";
import {
  findEntryNodes,
  generateEdges,
  getSuccessors,
  validateDefinition,
} from "../workflows/definition";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorInput,
  type ExecutorResult,
} from "../workflows/executors/base";
import { ExecutorRegistry } from "../workflows/executors/registry";

const TEST_DB_PATH = "./test-workflow-registry.sqlite";

// ─── Test Executor Implementations ───────────────────────────

class TestInstantExecutor extends BaseExecutor<
  typeof TestInstantExecutor.schema,
  typeof TestInstantExecutor.outSchema
> {
  static readonly schema = z.object({ message: z.string() });
  static readonly outSchema = z.object({ result: z.string() });

  readonly type = "test-instant";
  readonly mode = "instant" as const;
  readonly configSchema = TestInstantExecutor.schema;
  readonly outputSchema = TestInstantExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof TestInstantExecutor.schema>,
    _context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof TestInstantExecutor.outSchema>>> {
    return {
      status: "success",
      output: { result: `processed: ${config.message}` },
    };
  }
}

class TestBranchExecutor extends BaseExecutor<
  typeof TestBranchExecutor.schema,
  typeof TestBranchExecutor.outSchema
> {
  static readonly schema = z.object({ value: z.number() });
  static readonly outSchema = z.object({ passed: z.boolean() });

  readonly type = "test-branch";
  readonly mode = "instant" as const;
  readonly configSchema = TestBranchExecutor.schema;
  readonly outputSchema = TestBranchExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof TestBranchExecutor.schema>,
    _context: Readonly<Record<string, unknown>>,
    _meta: ExecutorMeta,
  ): Promise<ExecutorResult<z.infer<typeof TestBranchExecutor.outSchema>>> {
    const passed = config.value > 0;
    return {
      status: "success",
      output: { passed },
      nextPort: passed ? "true" : "false",
    };
  }
}

// ─── Mock Dependencies ───────────────────────────────────────

const mockDeps: ExecutorDependencies = {
  db: {} as typeof import("../be/db"),
  eventBus: { emit: () => {}, on: () => {}, off: () => {} },
  interpolate: (t: string) => t,
};

const mockMeta: ExecutorMeta = {
  runId: "00000000-0000-0000-0000-000000000001",
  stepId: "00000000-0000-0000-0000-000000000002",
  nodeId: "test-node",
  workflowId: "00000000-0000-0000-0000-000000000003",
  dryRun: false,
};

// ─── Tests ───────────────────────────────────────────────────

describe("Workflow Registry & Definition (Phase 1)", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  // ---------------------------------------------------------------------------
  // ExecutorRegistry
  // ---------------------------------------------------------------------------
  describe("ExecutorRegistry", () => {
    test("registers and retrieves an executor", () => {
      const registry = new ExecutorRegistry();
      const executor = new TestInstantExecutor(mockDeps);
      registry.register(executor);

      expect(registry.has("test-instant")).toBe(true);
      expect(registry.get("test-instant")).toBe(executor);
    });

    test("types() returns registered type names", () => {
      const registry = new ExecutorRegistry();
      registry.register(new TestInstantExecutor(mockDeps));
      registry.register(new TestBranchExecutor(mockDeps));

      const types = registry.types();
      expect(types).toContain("test-instant");
      expect(types).toContain("test-branch");
      expect(types).toHaveLength(2);
    });

    test("get() throws for unknown executor type", () => {
      const registry = new ExecutorRegistry();
      expect(() => registry.get("nonexistent")).toThrow("Unknown executor type: nonexistent");
    });

    test("has() returns false for unknown type", () => {
      const registry = new ExecutorRegistry();
      expect(registry.has("nonexistent")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // BaseExecutor
  // ---------------------------------------------------------------------------
  describe("BaseExecutor", () => {
    test("validates config and returns result", async () => {
      const executor = new TestInstantExecutor(mockDeps);
      const input: ExecutorInput = {
        config: { message: "hello" },
        context: {},
        meta: mockMeta,
      };
      const result = await executor.run(input);
      expect(result.status).toBe("success");
      expect(result.output).toEqual({ result: "processed: hello" });
    });

    test("fails on invalid config", async () => {
      const executor = new TestInstantExecutor(mockDeps);
      const input: ExecutorInput = {
        config: { wrong_field: 123 },
        context: {},
        meta: mockMeta,
      };
      const result = await executor.run(input);
      expect(result.status).toBe("failed");
      expect(result.error).toContain("Input validation failed");
    });

    test("branch executor returns correct port", async () => {
      const executor = new TestBranchExecutor(mockDeps);

      const positiveResult = await executor.run({
        config: { value: 5 },
        context: {},
        meta: mockMeta,
      });
      expect(positiveResult.nextPort).toBe("true");

      const negativeResult = await executor.run({
        config: { value: -1 },
        context: {},
        meta: mockMeta,
      });
      expect(negativeResult.nextPort).toBe("false");
    });
  });

  // ---------------------------------------------------------------------------
  // generateEdges()
  // ---------------------------------------------------------------------------
  describe("generateEdges()", () => {
    test("generates edges from string next refs", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {}, next: "b" },
          { id: "b", type: "test", config: {} },
        ],
      };
      const edges = generateEdges(def);
      expect(edges).toHaveLength(1);
      expect(edges[0].source).toBe("a");
      expect(edges[0].target).toBe("b");
      expect(edges[0].sourcePort).toBe("default");
    });

    test("generates edges from port-based next refs", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {}, next: { true: "b", false: "c" } },
          { id: "b", type: "test", config: {} },
          { id: "c", type: "test", config: {} },
        ],
      };
      const edges = generateEdges(def);
      expect(edges).toHaveLength(2);
      const trueEdge = edges.find((e) => e.sourcePort === "true");
      const falseEdge = edges.find((e) => e.sourcePort === "false");
      expect(trueEdge?.target).toBe("b");
      expect(falseEdge?.target).toBe("c");
    });

    test("terminal nodes produce no edges", () => {
      const def: WorkflowDefinition = {
        nodes: [{ id: "a", type: "test", config: {} }],
      };
      const edges = generateEdges(def);
      expect(edges).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // findEntryNodes()
  // ---------------------------------------------------------------------------
  describe("findEntryNodes()", () => {
    test("finds the single entry node", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {}, next: "b" },
          { id: "b", type: "test", config: {} },
        ],
      };
      const entries = findEntryNodes(def);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("a");
    });

    test("identifies multiple entry nodes", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {} },
          { id: "b", type: "test", config: {} },
        ],
      };
      const entries = findEntryNodes(def);
      expect(entries).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // getSuccessors()
  // ---------------------------------------------------------------------------
  describe("getSuccessors()", () => {
    test("returns successor for string next", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {}, next: "b" },
          { id: "b", type: "test", config: {} },
        ],
      };
      const successors = getSuccessors(def, "a", "default");
      expect(successors).toHaveLength(1);
      expect(successors[0].id).toBe("b");
    });

    test("returns correct successor for port-based next", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {}, next: { true: "b", false: "c" } },
          { id: "b", type: "test", config: {} },
          { id: "c", type: "test", config: {} },
        ],
      };
      const trueSuccessors = getSuccessors(def, "a", "true");
      expect(trueSuccessors).toHaveLength(1);
      expect(trueSuccessors[0].id).toBe("b");

      const falseSuccessors = getSuccessors(def, "a", "false");
      expect(falseSuccessors).toHaveLength(1);
      expect(falseSuccessors[0].id).toBe("c");
    });

    test("returns empty for terminal node", () => {
      const def: WorkflowDefinition = {
        nodes: [{ id: "a", type: "test", config: {} }],
      };
      expect(getSuccessors(def, "a")).toHaveLength(0);
    });

    test("returns all targets when no port specified on record next", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {}, next: { x: "b", y: "c" } },
          { id: "b", type: "test", config: {} },
          { id: "c", type: "test", config: {} },
        ],
      };
      const all = getSuccessors(def, "a");
      expect(all).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // validateDefinition()
  // ---------------------------------------------------------------------------
  describe("validateDefinition()", () => {
    test("valid linear workflow passes", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test-instant", config: {}, next: "b" },
          { id: "b", type: "test-instant", config: {} },
        ],
      };
      const result = validateDefinition(def);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("detects missing next target", () => {
      const def: WorkflowDefinition = {
        nodes: [{ id: "a", type: "test", config: {}, next: "nonexistent" }],
      };
      const result = validateDefinition(def);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.stringContaining("non-existent next target"));
    });

    test("detects missing port-based target", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {}, next: { true: "b", false: "missing" } },
          { id: "b", type: "test", config: {} },
        ],
      };
      const result = validateDefinition(def);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('"missing"'))).toBe(true);
    });

    test("detects multiple entry nodes", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {} },
          { id: "b", type: "test", config: {} },
        ],
      };
      const result = validateDefinition(def);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.stringContaining("Multiple entry nodes"));
    });

    test("detects orphaned nodes", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {}, next: "b" },
          { id: "b", type: "test", config: {} },
          { id: "orphan", type: "test", config: {} },
        ],
      };
      const result = validateDefinition(def);
      expect(result.valid).toBe(false);
      // Should have both "multiple entry nodes" and potentially orphan error
      const hasOrphanOrMultiEntry = result.errors.some(
        (e) => e.includes("orphan") || e.includes("Multiple entry"),
      );
      expect(hasOrphanOrMultiEntry).toBe(true);
    });

    test("detects unregistered executor types when registry provided", () => {
      const def: WorkflowDefinition = {
        nodes: [{ id: "a", type: "unknown-type", config: {} }],
      };
      const registry = new ExecutorRegistry();
      registry.register(new TestInstantExecutor(mockDeps));

      const result = validateDefinition(def, registry);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('unregistered executor type "unknown-type"'),
      );
    });

    test("passes with registered types", () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test-instant", config: {}, next: "b" },
          { id: "b", type: "test-branch", config: {} },
        ],
      };
      const registry = new ExecutorRegistry();
      registry.register(new TestInstantExecutor(mockDeps));
      registry.register(new TestBranchExecutor(mockDeps));

      const result = validateDefinition(def, registry);
      expect(result.valid).toBe(true);
    });

    test("single-node workflow is valid", () => {
      const def: WorkflowDefinition = {
        nodes: [{ id: "only", type: "test", config: {} }],
      };
      const result = validateDefinition(def);
      expect(result.valid).toBe(true);
    });

    test("cycle is allowed (directed graph, not DAG)", () => {
      // Both reference each other: a→b, b→a. Neither is unreferenced.
      // This means no entry node — which IS an error.
      const fullCycle: WorkflowDefinition = {
        nodes: [
          { id: "a", type: "test", config: {}, next: "b" },
          { id: "b", type: "test", config: {}, next: "a" },
        ],
      };
      const fullCycleResult = validateDefinition(fullCycle);
      expect(fullCycleResult.valid).toBe(false);
      expect(fullCycleResult.errors).toContainEqual(expect.stringContaining("No entry node"));

      // But a self-referencing cycle with an entry is fine:
      const defWithEntry: WorkflowDefinition = {
        nodes: [
          { id: "start", type: "test", config: {}, next: "loop" },
          { id: "loop", type: "test", config: {}, next: "loop" },
        ],
      };
      const result = validateDefinition(defWithEntry);
      expect(result.valid).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // DB integration (schemas round-trip)
  // ---------------------------------------------------------------------------
  describe("DB integration", () => {
    test("creates and retrieves a workflow with new fields", async () => {
      const db = await import("../be/db");
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing env var input syntax
      const envVarRef = "${API_KEY}";
      const workflow = db.createWorkflow({
        name: "test-workflow-registry",
        description: "Test workflow for registry",
        definition: {
          nodes: [
            { id: "a", type: "script", config: { runtime: "bash", script: "echo hi" }, next: "b" },
            { id: "b", type: "notify", config: { channel: "swarm", template: "done" } },
          ],
        },
        triggers: [{ type: "webhook", hmacSecret: "test-secret" }],
        cooldown: { hours: 1 },
        input: { apiKey: envVarRef },
      });

      expect(workflow.id).toBeDefined();
      expect(workflow.triggers).toHaveLength(1);
      expect(workflow.triggers[0].type).toBe("webhook");
      expect(workflow.cooldown).toEqual({ hours: 1 });
      expect(workflow.input).toEqual({ apiKey: envVarRef });

      // Retrieve and verify
      const fetched = db.getWorkflow(workflow.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.triggers).toHaveLength(1);
      expect(fetched!.definition.nodes).toHaveLength(2);

      // Update with new fields
      const updated = db.updateWorkflow(workflow.id, {
        cooldown: { minutes: 30 },
        triggers: [],
      });
      expect(updated!.cooldown).toEqual({ minutes: 30 });
      expect(updated!.triggers).toEqual([]);

      // Clean up
      db.deleteWorkflow(workflow.id);
    });

    test("creates and retrieves workflow versions", async () => {
      const db = await import("../be/db");
      const workflow = db.createWorkflow({
        name: "test-versioned-workflow",
        definition: {
          nodes: [{ id: "a", type: "test", config: {} }],
        },
      });

      // Create version snapshot
      const version = db.createWorkflowVersion({
        workflowId: workflow.id,
        version: 1,
        snapshot: {
          name: workflow.name,
          definition: workflow.definition,
          triggers: workflow.triggers,
          enabled: workflow.enabled,
        },
      });
      expect(version.version).toBe(1);
      expect(version.snapshot.name).toBe("test-versioned-workflow");

      // Create another version
      db.createWorkflowVersion({
        workflowId: workflow.id,
        version: 2,
        snapshot: {
          name: "updated-name",
          definition: workflow.definition,
          triggers: [],
          enabled: true,
        },
      });

      // List versions
      const versions = db.getWorkflowVersions(workflow.id);
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(2); // DESC order

      // Get specific version
      const v1 = db.getWorkflowVersion(workflow.id, 1);
      expect(v1).not.toBeNull();
      expect(v1!.snapshot.name).toBe("test-versioned-workflow");

      // Clean up
      db.deleteWorkflow(workflow.id);
    });

    test("retry-related step queries work", async () => {
      const db = await import("../be/db");
      const workflow = db.createWorkflow({
        name: "test-retry-queries",
        definition: {
          nodes: [{ id: "a", type: "test", config: {} }],
        },
      });

      const run = db.createWorkflowRun({
        id: crypto.randomUUID(),
        workflowId: workflow.id,
      });

      const step = db.createWorkflowRunStep({
        id: crypto.randomUUID(),
        runId: run.id,
        nodeId: "a",
        nodeType: "test",
      });

      // Update with retry fields
      db.updateWorkflowRunStep(step.id, {
        status: "completed",
        idempotencyKey: `${run.id}:a`,
        finishedAt: new Date().toISOString(),
      });

      // Test getCompletedStepNodeIds
      const completed = db.getCompletedStepNodeIds(run.id);
      expect(completed).toContain("a");

      // Test getStepByIdempotencyKey
      const found = db.getStepByIdempotencyKey(`${run.id}:a`);
      expect(found).not.toBeNull();
      expect(found!.nodeId).toBe("a");

      // Test getLastSuccessfulRun
      db.updateWorkflowRun(run.id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
      });
      const lastSuccess = db.getLastSuccessfulRun(workflow.id);
      expect(lastSuccess).not.toBeNull();
      expect(lastSuccess!.id).toBe(run.id);

      // Clean up
      db.deleteWorkflow(workflow.id);
    });
  });
});
