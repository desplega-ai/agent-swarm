import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import pkg from "../../package.json";
import {
  closeDb,
  createAgent,
  createTask,
  createTaskExtended,
  getDb,
  getTaskById,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-task-swarm-version.sqlite";

describe("Task swarmVersion tracking", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {}
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("createTaskExtended stamps pkg.version on new tasks", () => {
    const agent = createAgent({
      id: "swarm-version-agent-1",
      name: "Swarm Version Agent",
      isLead: false,
      status: "idle",
    });

    const task = createTaskExtended("extended task", { agentId: agent.id });

    expect(task.swarmVersion).toBe(pkg.version);

    const reloaded = getTaskById(task.id);
    expect(reloaded?.swarmVersion).toBe(pkg.version);
  });

  test("createTask stamps pkg.version on new tasks", () => {
    const agent = createAgent({
      id: "swarm-version-agent-2",
      name: "Swarm Version Agent 2",
      isLead: false,
      status: "idle",
    });

    const task = createTask(agent.id, "basic task");

    expect(task.swarmVersion).toBe(pkg.version);

    const reloaded = getTaskById(task.id);
    expect(reloaded?.swarmVersion).toBe(pkg.version);
  });

  test("column exists and is indexed", () => {
    const db = getDb();
    const columns = db
      .prepare<{ name: string }, []>("PRAGMA table_info(agent_tasks)")
      .all()
      .map((c) => c.name);
    expect(columns).toContain("swarmVersion");

    const indexes = db
      .prepare<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_tasks'",
      )
      .all()
      .map((i) => i.name);
    expect(indexes).toContain("idx_agent_tasks_swarmVersion");
  });
});
