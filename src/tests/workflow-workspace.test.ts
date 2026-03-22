import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { unlink } from "node:fs/promises";
import * as db from "../be/db";
import {
  closeDb,
  createAgent,
  createWorkflow,
  getWorkflow,
  initDb,
  listWorkflows,
  updateWorkflow,
} from "../be/db";
import { WorkflowSchema } from "../types";
import { startWorkflowExecution } from "../workflows/engine";
import { createExecutorRegistry } from "../workflows/executors/registry";

const TEST_DB_PATH = "./test-wf-workspace.sqlite";

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {
    // Ignore
  }
  initDb(TEST_DB_PATH);

  // Create a test agent for task assignment
  createAgent({ name: "test-workspace-agent", isLead: false, status: "idle" });
});

afterAll(async () => {
  closeDb();
  try {
    await unlink(TEST_DB_PATH);
    await unlink(`${TEST_DB_PATH}-wal`);
    await unlink(`${TEST_DB_PATH}-shm`);
  } catch {
    // Ignore
  }
});

describe("Workflow dir/vcsRepo persistence", () => {
  test("workflow dir and vcsRepo persist through create/get cycle", () => {
    const wf = createWorkflow({
      name: "wf-with-workspace",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
      dir: "/tmp/test-workspace",
      vcsRepo: "desplega-ai/landing",
    });

    expect(wf.dir).toBe("/tmp/test-workspace");
    expect(wf.vcsRepo).toBe("desplega-ai/landing");

    const fetched = getWorkflow(wf.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.dir).toBe("/tmp/test-workspace");
    expect(fetched!.vcsRepo).toBe("desplega-ai/landing");
  });

  test("workflow without dir/vcsRepo returns undefined", () => {
    const wf = createWorkflow({
      name: "wf-no-workspace",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
    });

    expect(wf.dir).toBeUndefined();
    expect(wf.vcsRepo).toBeUndefined();
  });

  test("updateWorkflow can set dir and vcsRepo", () => {
    const wf = createWorkflow({
      name: "wf-update-workspace",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
    });

    const updated = updateWorkflow(wf.id, {
      dir: "/tmp/updated-workspace",
      vcsRepo: "org/repo",
    });

    expect(updated).not.toBeNull();
    expect(updated!.dir).toBe("/tmp/updated-workspace");
    expect(updated!.vcsRepo).toBe("org/repo");
  });

  test("updateWorkflow can clear dir and vcsRepo with null", () => {
    const wf = createWorkflow({
      name: "wf-clear-workspace",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
      dir: "/tmp/clear-me",
      vcsRepo: "org/clear-me",
    });

    const updated = updateWorkflow(wf.id, {
      dir: null,
      vcsRepo: null,
    });

    expect(updated).not.toBeNull();
    expect(updated!.dir).toBeUndefined();
    expect(updated!.vcsRepo).toBeUndefined();
  });

  test("listWorkflows includes dir and vcsRepo", () => {
    const wf = createWorkflow({
      name: "wf-list-workspace",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
      dir: "/tmp/list-test",
      vcsRepo: "org/list-test",
    });

    const workflows = listWorkflows();
    const found = workflows.find((w) => w.id === wf.id);
    expect(found).not.toBeNull();
    expect(found!.dir).toBe("/tmp/list-test");
    expect(found!.vcsRepo).toBe("org/list-test");
  });

  test("Workflow type validates dir must start with /", () => {
    const result = WorkflowSchema.shape.dir.safeParse("relative/path");
    expect(result.success).toBe(false);

    const validResult = WorkflowSchema.shape.dir.safeParse("/absolute/path");
    expect(validResult.success).toBe(true);
  });
});

describe("Agent-task executor workspace inheritance", () => {
  test("agent-task inherits workflow dir when node config omits it", async () => {
    const wf = createWorkflow({
      name: "wf-inherit-dir",
      definition: {
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: { template: "Do something" },
          },
        ],
      },
      dir: "/tmp/inherited-workspace",
      vcsRepo: "desplega-ai/inherited",
    });

    const eventBus = new EventEmitter();
    const registry = createExecutorRegistry({
      db,
      eventBus,
      interpolate: (t) => t,
    });

    const runId = await startWorkflowExecution(wf, {}, registry);

    // The workflow run should have been created
    const run = db.getWorkflowRun(runId);
    expect(run).not.toBeNull();
    expect(run!.status).toBe("waiting"); // agent-task is async

    // Find the task created by the executor
    const steps = db.getWorkflowRunStepsByRunId(runId);
    expect(steps.length).toBe(1);

    const task = db.getTaskByWorkflowRunStepId(steps[0]!.id);
    expect(task).not.toBeNull();
    expect(task!.dir).toBe("/tmp/inherited-workspace");
    expect(task!.vcsRepo).toBe("desplega-ai/inherited");
  });

  test("node-level dir overrides workflow-level dir", async () => {
    const wf = createWorkflow({
      name: "wf-override-dir",
      definition: {
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: {
              template: "Do something",
              dir: "/tmp/node-specific",
              vcsRepo: "org/node-specific",
            },
          },
        ],
      },
      dir: "/tmp/workflow-level",
      vcsRepo: "org/workflow-level",
    });

    const eventBus = new EventEmitter();
    const registry = createExecutorRegistry({
      db,
      eventBus,
      interpolate: (t) => t,
    });

    const runId = await startWorkflowExecution(wf, {}, registry);
    const steps = db.getWorkflowRunStepsByRunId(runId);
    const task = db.getTaskByWorkflowRunStepId(steps[0]!.id);

    expect(task).not.toBeNull();
    expect(task!.dir).toBe("/tmp/node-specific");
    expect(task!.vcsRepo).toBe("org/node-specific");
  });

  test("workflow without dir/vcsRepo doesn't affect agent-task nodes", async () => {
    const wf = createWorkflow({
      name: "wf-no-inherit",
      definition: {
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: { template: "Do something" },
          },
        ],
      },
    });

    const eventBus = new EventEmitter();
    const registry = createExecutorRegistry({
      db,
      eventBus,
      interpolate: (t) => t,
    });

    const runId = await startWorkflowExecution(wf, {}, registry);
    const steps = db.getWorkflowRunStepsByRunId(runId);
    const task = db.getTaskByWorkflowRunStepId(steps[0]!.id);

    expect(task).not.toBeNull();
    expect(task!.dir).toBeFalsy();
    expect(task!.vcsRepo).toBeFalsy();
  });
});

describe("Workflow interpolation context", () => {
  test("{{workflow.dir}} and {{workflow.vcsRepo}} are available in context", async () => {
    const wf = createWorkflow({
      name: "wf-interpolation",
      definition: {
        nodes: [
          {
            id: "task1",
            type: "agent-task",
            config: {
              template: "Work in {{workflow.dir}} on repo {{workflow.vcsRepo}}",
            },
          },
        ],
      },
      dir: "/tmp/interp-test",
      vcsRepo: "org/interp-repo",
    });

    const eventBus = new EventEmitter();
    const registry = createExecutorRegistry({
      db,
      eventBus,
      interpolate: (t) => t,
    });

    const runId = await startWorkflowExecution(wf, {}, registry);
    const steps = db.getWorkflowRunStepsByRunId(runId);
    const task = db.getTaskByWorkflowRunStepId(steps[0]!.id);

    expect(task).not.toBeNull();
    // The template should have been interpolated with workflow context
    expect(task!.task).toContain("/tmp/interp-test");
    expect(task!.task).toContain("org/interp-repo");
  });
});
