import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createWorkflow, deleteWorkflow, getDbClient, initDb } from "../be/db";
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

async function flushAfterCommit(): Promise<void> {
  // Workflow telemetry runs through DbClient.afterCommit, which queues behind the client lock.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
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

  test("emits workflow.created with definition size and known source", async () => {
    const workflow = await createWorkflow(
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
    await flushAfterCommit();

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

  test("emits workflow.deleted only after a workflow is deleted", async () => {
    const workflow = await createWorkflow(
      {
        name: "deleted telemetry",
        definition: { nodes: [] },
      },
      "mcp",
    );
    await flushAfterCommit();
    calls = [];

    expect(await deleteWorkflow(workflow.id, "mcp")).toBe(true);
    expect(await deleteWorkflow(workflow.id, "mcp")).toBe(false);
    await flushAfterCommit();

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

  test("omits source for direct internal workflow mutations", async () => {
    const workflow = await createWorkflow({
      name: "internal telemetry",
      definition: { nodes: [] },
    });
    await flushAfterCommit();

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

  test("emits nothing when the caller's transaction rolls back", async () => {
    const kept = await createWorkflow({ name: "kept", definition: { nodes: [] } });
    await flushAfterCommit();
    calls = [];

    await expect(
      getDbClient().transaction(async () => {
        await createWorkflow({ name: "rolled back", definition: { nodes: [] } }, "api");
        await deleteWorkflow(kept.id, "api");
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    await flushAfterCommit();

    expect(calls).toEqual([]);
  });
});
