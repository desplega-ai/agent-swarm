import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { z } from "zod";
import {
  closeDb,
  createWorkflow,
  getWorkflowRun,
  getWorkflowRunStepsByRunId,
  initDb,
} from "../be/db";
import type { Workflow, WorkflowDefinition } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { workflowEventBus } from "../workflows/event-bus";
import {
  BaseExecutor,
  type ExecutorDependencies,
  type ExecutorResult,
} from "../workflows/executors/base";
import { PropertyMatchExecutor } from "../workflows/executors/property-match";
import { ExecutorRegistry } from "../workflows/executors/registry";
import { interpolate } from "../workflows/template";

const TEST_DB_PATH = "./test-workflow-validation-port-routing.sqlite";

// ─── Test Executors ──────────────────────────────────────────

/**
 * Executor that returns a configurable object as output.
 * Used to produce output that property-match can validate.
 */
class ObjectOutputExecutor extends BaseExecutor<
  typeof ObjectOutputExecutor.schema,
  typeof ObjectOutputExecutor.outSchema
> {
  static readonly schema = z.object({ approved: z.boolean() });
  static readonly outSchema = z.object({ approved: z.boolean() });

  readonly type = "object-output";
  readonly mode = "instant" as const;
  readonly configSchema = ObjectOutputExecutor.schema;
  readonly outputSchema = ObjectOutputExecutor.outSchema;

  protected async execute(
    config: z.infer<typeof ObjectOutputExecutor.schema>,
  ): Promise<ExecutorResult<z.infer<typeof ObjectOutputExecutor.outSchema>>> {
    return { status: "success", output: { approved: config.approved } };
  }
}

/**
 * Terminal executor that just succeeds. Used for leaf nodes.
 */
class NoopExecutor extends BaseExecutor<typeof NoopExecutor.schema, typeof NoopExecutor.outSchema> {
  static readonly schema = z.object({});
  static readonly outSchema = z.object({ done: z.boolean() });

  readonly type = "noop";
  readonly mode = "instant" as const;
  readonly configSchema = NoopExecutor.schema;
  readonly outputSchema = NoopExecutor.outSchema;

  protected async execute(): Promise<ExecutorResult<z.infer<typeof NoopExecutor.outSchema>>> {
    return { status: "success", output: { done: true } };
  }
}

// ─── Mock Dependencies ───────────────────────────────────────

import * as db from "../be/db";

const mockDeps: ExecutorDependencies = {
  db: db as typeof import("../be/db"),
  eventBus: workflowEventBus,
  interpolate: (template, ctx) => interpolate(template, ctx).result,
};

function createTestRegistry(): ExecutorRegistry {
  const registry = new ExecutorRegistry();
  registry.register(new ObjectOutputExecutor(mockDeps));
  registry.register(new NoopExecutor(mockDeps));
  registry.register(new PropertyMatchExecutor(mockDeps));
  return registry;
}

let workflowCounter = 0;

function makeWorkflow(def: WorkflowDefinition): Workflow {
  workflowCounter++;
  return createWorkflow({
    name: `test-val-port-routing-${workflowCounter}-${Date.now()}`,
    definition: def,
  });
}

// ─── Setup / Teardown ────────────────────────────────────────

let registry: ExecutorRegistry;

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
  registry = createTestRegistry();
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

// ─── Tests ───────────────────────────────────────────────────

describe("Validation Port Routing", () => {
  /**
   * Regression test for: when a node has record-based `next` (pass/fail ports)
   * and validation with `mustPass: false`, only the matching port should be activated.
   * Previously, all ports were activated because `result.nextPort` was never set.
   */

  function makePortRoutingWorkflow(approved: boolean): WorkflowDefinition {
    return {
      nodes: [
        {
          id: "check",
          type: "object-output",
          config: { approved },
          next: { pass: "on-pass", fail: "on-fail" },
          validation: {
            executor: "property-match",
            config: {
              conditions: [{ field: "check.approved", op: "eq", value: true }],
            },
            mustPass: false,
          },
        },
        {
          id: "on-pass",
          type: "noop",
          config: {},
        },
        {
          id: "on-fail",
          type: "noop",
          config: {},
        },
      ],
    };
  }

  test("validation passes → only 'pass' port successor is created", async () => {
    const workflow = makeWorkflow(makePortRoutingWorkflow(true));
    const runId = await startWorkflowExecution(workflow, {}, registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const nodeIds = steps.map((s) => s.nodeId);

    // "check" should be completed, "on-pass" should exist, "on-fail" should NOT
    expect(nodeIds).toContain("check");
    expect(nodeIds).toContain("on-pass");
    expect(nodeIds).not.toContain("on-fail");

    const run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");
  });

  test("validation fails (mustPass: false) → only 'fail' port successor is created", async () => {
    const workflow = makeWorkflow(makePortRoutingWorkflow(false));
    const runId = await startWorkflowExecution(workflow, {}, registry);

    const steps = getWorkflowRunStepsByRunId(runId);
    const nodeIds = steps.map((s) => s.nodeId);

    // "check" should be completed, "on-fail" should exist, "on-pass" should NOT
    expect(nodeIds).toContain("check");
    expect(nodeIds).toContain("on-fail");
    expect(nodeIds).not.toContain("on-pass");

    const run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");
  });

  test("string-based next is unaffected by validation port routing", async () => {
    const workflow = makeWorkflow({
      nodes: [
        {
          id: "check",
          type: "object-output",
          config: { approved: false },
          next: "successor",
          validation: {
            executor: "property-match",
            config: {
              conditions: [{ field: "check.approved", op: "eq", value: true }],
            },
            mustPass: false,
          },
        },
        {
          id: "successor",
          type: "noop",
          config: {},
        },
      ],
    });

    const runId = await startWorkflowExecution(workflow, {}, registry);
    const steps = getWorkflowRunStepsByRunId(runId);
    const nodeIds = steps.map((s) => s.nodeId);

    expect(nodeIds).toContain("check");
    expect(nodeIds).toContain("successor");

    const run = getWorkflowRun(runId);
    expect(run!.status).toBe("completed");
  });
});
