import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getPausedTasksForAgent,
  getTaskById,
  initDb,
  pauseTask,
  startTask,
} from "../be/db";
import { AgentTaskSchema } from "../types";

const TEST_DB_PATH = "./test-task-working-dir.sqlite";

describe("Task Working Directory", () => {
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
  // Schema validation (dir field on AgentTaskSchema)
  // ---------------------------------------------------------------------------
  describe("dir schema validation", () => {
    const dirSchema = AgentTaskSchema.shape.dir;

    test("accepts valid absolute paths", () => {
      expect(dirSchema.parse("/home/user/project")).toBe("/home/user/project");
      expect(dirSchema.parse("/tmp")).toBe("/tmp");
      expect(dirSchema.parse("/workspace/repos/agent-swarm")).toBe("/workspace/repos/agent-swarm");
    });

    test("accepts undefined (field is optional)", () => {
      expect(dirSchema.parse(undefined)).toBeUndefined();
    });

    test("rejects empty string", () => {
      expect(() => dirSchema.parse("")).toThrow();
    });

    test("rejects relative paths", () => {
      expect(() => dirSchema.parse("relative/path")).toThrow();
      expect(() => dirSchema.parse("./local")).toThrow();
      expect(() => dirSchema.parse("../parent")).toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // DB round-trip (dir field persists through create/read)
  // ---------------------------------------------------------------------------
  describe("DB round-trip", () => {
    test("task with dir is stored and retrieved correctly", () => {
      const agent = createAgent({
        id: "dir-test-agent-1",
        name: "Dir Test Agent",
        isLead: false,
        status: "idle",
      });

      const task = createTaskExtended("test task with dir", {
        agentId: agent.id,
        dir: "/workspace/repos/my-project",
      });

      expect(task.dir).toBe("/workspace/repos/my-project");

      const retrieved = getTaskById(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.dir).toBe("/workspace/repos/my-project");
    });

    test("task without dir has null/undefined dir", () => {
      const task = createTaskExtended("test task without dir", {
        agentId: "dir-test-agent-1",
      });

      const retrieved = getTaskById(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.dir).toBeFalsy();
    });

    test("task with vcsRepo and dir stores both", () => {
      const task = createTaskExtended("test task with both", {
        agentId: "dir-test-agent-1",
        dir: "/workspace/repos/agent-swarm",
        vcsRepo: "desplega-ai/agent-swarm",
      });

      const retrieved = getTaskById(task.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.dir).toBe("/workspace/repos/agent-swarm");
      expect(retrieved!.vcsRepo).toBe("desplega-ai/agent-swarm");
    });
  });

  // ---------------------------------------------------------------------------
  // Paused tasks include dir and vcsRepo
  // ---------------------------------------------------------------------------
  describe("paused tasks with dir/vcsRepo", () => {
    const agentId = "dir-test-agent-pause";

    beforeAll(() => {
      createAgent({
        id: agentId,
        name: "Dir Pause Agent",
        isLead: false,
        status: "idle",
      });
    });

    test("getPausedTasksForAgent returns dir field", () => {
      const task = createTaskExtended("pausable task with dir", {
        agentId,
        dir: "/workspace/repos/my-project",
      });

      // Move to in_progress then pause
      startTask(task.id);
      pauseTask(task.id);

      const paused = getPausedTasksForAgent(agentId);
      const found = paused.find((t) => t.id === task.id);
      expect(found).toBeDefined();
      expect(found!.dir).toBe("/workspace/repos/my-project");
    });

    test("getPausedTasksForAgent returns vcsRepo field", () => {
      const task = createTaskExtended("pausable task with vcsRepo", {
        agentId,
        vcsRepo: "desplega-ai/agent-swarm",
      });

      startTask(task.id);
      pauseTask(task.id);

      const paused = getPausedTasksForAgent(agentId);
      const found = paused.find((t) => t.id === task.id);
      expect(found).toBeDefined();
      expect(found!.vcsRepo).toBe("desplega-ai/agent-swarm");
    });

    test("getPausedTasksForAgent returns both dir and vcsRepo", () => {
      const task = createTaskExtended("pausable task with both", {
        agentId,
        dir: "/workspace/repos/agent-swarm",
        vcsRepo: "desplega-ai/agent-swarm",
      });

      startTask(task.id);
      pauseTask(task.id);

      const paused = getPausedTasksForAgent(agentId);
      const found = paused.find((t) => t.id === task.id);
      expect(found).toBeDefined();
      expect(found!.dir).toBe("/workspace/repos/agent-swarm");
      expect(found!.vcsRepo).toBe("desplega-ai/agent-swarm");
    });
  });
});
