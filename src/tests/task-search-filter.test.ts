import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createTask, getAllTasks, getTasksCount, initDb } from "../be/db";

const TEST_DB_PATH = "./test-task-search-filter.sqlite";

describe("getAllTasks search filter", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    await initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("matches by id prefix and substring, plus description", async () => {
    const agent = await createAgent({
      id: "search-filter-agent",
      name: "Search Filter Agent",
      isLead: false,
      status: "idle",
    });

    const taskA = await createTask(agent.id, "implement partial id search");
    const taskB = await createTask(agent.id, "fix navbar styling");

    // Description-search still works
    const byDescription = await getAllTasks({ search: "partial id" });
    expect(byDescription.map((t) => t.id)).toContain(taskA.id);
    expect(byDescription.map((t) => t.id)).not.toContain(taskB.id);

    // First 8 chars of UUID match the task with that ID
    const idPrefix = taskA.id.slice(0, 8);
    const byPrefix = await getAllTasks({ search: idPrefix });
    expect(byPrefix.map((t) => t.id)).toContain(taskA.id);
    expect(byPrefix.map((t) => t.id)).not.toContain(taskB.id);

    // Arbitrary substring of UUID also matches
    const idMid = taskB.id.slice(9, 17);
    const byMid = await getAllTasks({ search: idMid });
    expect(byMid.map((t) => t.id)).toContain(taskB.id);
    expect(byMid.map((t) => t.id)).not.toContain(taskA.id);

    // Count query honors the same filter
    expect(await getTasksCount({ search: idPrefix })).toBe(1);
  });
});
