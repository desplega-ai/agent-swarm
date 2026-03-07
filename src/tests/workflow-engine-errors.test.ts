import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";

const TEST_DB_PATH = "./test-workflow-engine-errors.sqlite";

describe("Workflow Engine Error Paths", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {
        // File may not exist
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Cycle guard: visited nodes are skipped
  // ---------------------------------------------------------------------------
  describe("cycle guard", () => {
    test("stops traversal when a node would be visited twice", async () => {
      // Build a DAG with a cycle: t1 → pm1 → ct1 → pm1 (back edge)
      // The engine should visit pm1 only once due to the cycle guard
      const def: WorkflowDefinition = {
        nodes: [
          { id: "t1", type: "trigger-webhook", config: {} },
          {
            id: "pm1",
            type: "property-match",
            config: { conditions: [{ field: "trigger.x", op: "eq", value: "y" }] },
          },
          {
            id: "sm1",
            type: "send-message",
            config: { template: "cycle test" },
          },
        ],
        edges: [
          { id: "e1", source: "t1", sourcePort: "default", target: "pm1" },
          { id: "e2", source: "pm1", sourcePort: "true", target: "sm1" },
          // Back edge from sm1 → pm1 (creates cycle)
          { id: "e3", source: "sm1", sourcePort: "default", target: "pm1" },
        ],
      };

      const workflow = createWorkflow({ name: "cycle-test", definition: def });
      const runId = await startWorkflowExecution(workflow, { x: "y" });

      // Should complete without infinite loop
      const run = getWorkflowRun(runId);
      expect(run?.status).toBe("completed");

      // pm1 should appear only once in steps
      const steps = getWorkflowRunStepsByRunId(runId);
      const pm1Steps = steps.filter((s) => s.nodeId === "pm1");
      expect(pm1Steps).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Unknown node type: marks run as failed
  // ---------------------------------------------------------------------------
  describe("unknown node type", () => {
    test("marks run and step as failed with descriptive error", async () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "t1", type: "trigger-webhook", config: {} },
          // Cast to bypass TypeScript - simulating bad data
          { id: "bad1", type: "totally-unknown-type" as "property-match", config: {} },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "bad1" }],
      };

      const workflow = createWorkflow({ name: "unknown-node-test", definition: def });
      const runId = await startWorkflowExecution(workflow, {});

      const run = getWorkflowRun(runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain("Unknown node type");

      const steps = getWorkflowRunStepsByRunId(runId);
      const badStep = steps.find((s) => s.nodeId === "bad1");
      expect(badStep).toBeDefined();
      expect(badStep?.status).toBe("failed");
      expect(badStep?.error).toContain("Unknown node type");
    });
  });

  // ---------------------------------------------------------------------------
  // Node executor throws: marks run and step as failed
  // ---------------------------------------------------------------------------
  describe("node executor throws", () => {
    test("code-match throwing marks run as failed", async () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "t1", type: "trigger-webhook", config: {} },
          {
            id: "cm1",
            type: "code-match",
            config: {
              code: "(input) => { throw new Error('user code boom'); }",
              outputPorts: ["true", "false"],
            },
          },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "cm1" }],
      };

      const workflow = createWorkflow({ name: "node-throw-test", definition: def });
      const runId = await startWorkflowExecution(workflow, {});

      const run = getWorkflowRun(runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain("user code boom");

      const steps = getWorkflowRunStepsByRunId(runId);
      const cmStep = steps.find((s) => s.nodeId === "cm1");
      expect(cmStep?.status).toBe("failed");
      expect(cmStep?.error).toContain("user code boom");
    });

    test("code-match returning invalid port marks run as failed", async () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "t1", type: "trigger-webhook", config: {} },
          {
            id: "cm1",
            type: "code-match",
            config: {
              code: "(input) => 'invalid-port'",
              outputPorts: ["true", "false"],
            },
          },
        ],
        edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "cm1" }],
      };

      const workflow = createWorkflow({ name: "invalid-port-test", definition: def });
      const runId = await startWorkflowExecution(workflow, {});

      const run = getWorkflowRun(runId);
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain("not in outputPorts");
    });
  });

  // ---------------------------------------------------------------------------
  // Multi-branch DAG: both branches execute
  // ---------------------------------------------------------------------------
  describe("multi-branch DAG", () => {
    test("executes both branches when trigger has two successors", async () => {
      const def: WorkflowDefinition = {
        nodes: [
          { id: "t1", type: "trigger-webhook", config: {} },
          { id: "sm1", type: "send-message", config: { template: "branch-A" } },
          { id: "sm2", type: "send-message", config: { template: "branch-B" } },
        ],
        edges: [
          { id: "e1", source: "t1", sourcePort: "default", target: "sm1" },
          { id: "e2", source: "t1", sourcePort: "default", target: "sm2" },
        ],
      };

      const workflow = createWorkflow({ name: "multi-branch-test", definition: def });
      const runId = await startWorkflowExecution(workflow, {});

      const run = getWorkflowRun(runId);
      expect(run?.status).toBe("completed");

      const steps = getWorkflowRunStepsByRunId(runId);
      const nodeIds = steps.map((s) => s.nodeId);
      expect(nodeIds).toContain("sm1");
      expect(nodeIds).toContain("sm2");
    });
  });
});
