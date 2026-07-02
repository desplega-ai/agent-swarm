import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createWorkflow,
  getWorkflowsByScheduleId,
  initDb,
  updateWorkflow,
} from "../be/db";

const TEST_DB_PATH = "./test-wf-schedule-trigger.sqlite";

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {
    // Ignore
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
    // Ignore
  }
});

describe("getWorkflowsByScheduleId", () => {
  const scheduleId1 = crypto.randomUUID();
  const scheduleId2 = crypto.randomUUID();
  const scheduleIdUnlinked = crypto.randomUUID();

  beforeAll(() => {
    // Workflow linked to scheduleId1
    createWorkflow({
      name: "wf-linked-1",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
      triggers: [{ type: "schedule", scheduleId: scheduleId1 }],
    });

    // Second workflow also linked to scheduleId1 (multiple workflows same schedule)
    createWorkflow({
      name: "wf-linked-2",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
      triggers: [{ type: "schedule", scheduleId: scheduleId1 }],
    });

    // Workflow linked to scheduleId2
    createWorkflow({
      name: "wf-linked-other",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
      triggers: [{ type: "schedule", scheduleId: scheduleId2 }],
    });

    // Disabled workflow linked to scheduleId1 — should NOT be returned
    const disabled = createWorkflow({
      name: "wf-disabled",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
      triggers: [{ type: "schedule", scheduleId: scheduleId1 }],
    });
    updateWorkflow(disabled.id, { enabled: false });

    // Workflow with webhook trigger only (no schedule) — should NOT match
    createWorkflow({
      name: "wf-webhook-only",
      definition: { nodes: [{ id: "n1", type: "agent-task", config: { template: "test" } }] },
      triggers: [{ type: "webhook" }],
    });
  });

  test("returns workflows with matching schedule trigger", () => {
    const results = getWorkflowsByScheduleId(scheduleId1);
    expect(results.length).toBe(2);
    const names = results.map((w) => w.name).sort();
    expect(names).toEqual(["wf-linked-1", "wf-linked-2"]);
  });

  test("returns empty when no workflows match", () => {
    const results = getWorkflowsByScheduleId(scheduleIdUnlinked);
    expect(results.length).toBe(0);
  });

  test("ignores disabled workflows", () => {
    const results = getWorkflowsByScheduleId(scheduleId1);
    const names = results.map((w) => w.name);
    expect(names).not.toContain("wf-disabled");
  });

  test("multiple workflows can reference the same schedule", () => {
    const results = getWorkflowsByScheduleId(scheduleId1);
    expect(results.length).toBe(2);
  });

  test("returns correct workflow for different schedule", () => {
    const results = getWorkflowsByScheduleId(scheduleId2);
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("wf-linked-other");
  });
});
