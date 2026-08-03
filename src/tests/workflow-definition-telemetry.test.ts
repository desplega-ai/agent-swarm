import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createWorkflow, deleteWorkflow, initDb } from "../be/db";
import { telemetry } from "../telemetry";

const TEST_DB_PATH = "./test-workflow-definition-telemetry.sqlite";

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File does not exist.
    }
  }
}

describe("workflow definition telemetry", () => {
  let workflowSpy: ReturnType<typeof spyOn>;
  let calls: Array<{
    event: string;
    props: Parameters<typeof telemetry.workflow>[1];
  }>;

  beforeEach(async () => {
    closeDb();
    await removeTestDb();
    initDb(TEST_DB_PATH);

    calls = [];
    workflowSpy = spyOn(telemetry, "workflow").mockImplementation((event, props) => {
      calls.push({ event, props });
    });
  });

  afterEach(async () => {
    workflowSpy.mockRestore();
    closeDb();
    await removeTestDb();
  });

  test("emits workflow.created with definition size and known source", () => {
    const workflow = createWorkflow(
      {
        name: "created telemetry",
        definition: {
          nodes: [
            { id: "first", type: "transform", config: {} },
            { id: "second", type: "transform", config: {} },
          ],
        },
      },
      "api",
    );

    expect(calls).toEqual([
      {
        event: "created",
        props: {
          workflowId: workflow.id,
          nodeCount: 2,
          source: "api",
        },
      },
    ]);
  });

  test("emits workflow.deleted only after a workflow is deleted", () => {
    const workflow = createWorkflow(
      {
        name: "deleted telemetry",
        definition: { nodes: [] },
      },
      "mcp",
    );
    calls = [];

    expect(deleteWorkflow(workflow.id, "mcp")).toBe(true);
    expect(deleteWorkflow(workflow.id, "mcp")).toBe(false);

    expect(calls).toEqual([
      {
        event: "deleted",
        props: {
          workflowId: workflow.id,
          source: "mcp",
        },
      },
    ]);
  });

  test("omits source for direct internal workflow mutations", () => {
    const workflow = createWorkflow({
      name: "internal telemetry",
      definition: { nodes: [] },
    });

    expect(calls).toEqual([
      {
        event: "created",
        props: {
          workflowId: workflow.id,
          nodeCount: 0,
        },
      },
    ]);
  });
});
