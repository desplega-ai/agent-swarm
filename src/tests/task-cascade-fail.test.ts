import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  cancelTask,
  cascadeFailDependents,
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  failTask,
  getDb,
  getDependentTasks,
  getTaskById,
  initDb,
  startTask,
  supersedeTask,
} from "../be/db";

const TEST_DB_PATH = "./test-task-cascade-fail.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore
  }
});

describe("getDependentTasks", () => {
  test("finds tasks that depend on a given parent", () => {
    const agent = createAgent({
      name: "dep-lookup-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const parent = createTaskExtended("Parent task", { agentId: agent.id });
    const child = createTaskExtended("Child task", {
      agentId: agent.id,
      dependsOn: [parent.id],
    });

    const deps = getDependentTasks(parent.id, { includeTerminal: true });
    expect(deps.length).toBeGreaterThanOrEqual(1);
    expect(deps.some((d) => d.id === child.id)).toBe(true);
  });

  test("filters out terminal tasks by default", () => {
    const agent = createAgent({
      name: "dep-lookup-worker-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const parent = createTaskExtended("Parent task 2", { agentId: agent.id });
    const child1 = createTaskExtended("Child completed", {
      agentId: agent.id,
      dependsOn: [parent.id],
    });
    const child2 = createTaskExtended("Child pending", {
      agentId: agent.id,
      dependsOn: [parent.id],
    });

    startTask(child1.id, agent.id);
    completeTask(child1.id, "done");

    const nonTerminalDeps = getDependentTasks(parent.id);
    expect(nonTerminalDeps.some((d) => d.id === child1.id)).toBe(false);
    expect(nonTerminalDeps.some((d) => d.id === child2.id)).toBe(true);

    const allDeps = getDependentTasks(parent.id, { includeTerminal: true });
    expect(allDeps.some((d) => d.id === child1.id)).toBe(true);
    expect(allDeps.some((d) => d.id === child2.id)).toBe(true);
  });

  test("returns empty array when no dependents exist", () => {
    const agent = createAgent({
      name: "dep-lookup-worker-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const task = createTaskExtended("Lonely task", { agentId: agent.id });
    const deps = getDependentTasks(task.id);
    expect(deps).toEqual([]);
  });
});

describe("cascadeFailDependents", () => {
  test("single-level cascade: failing parent fails its dependent", () => {
    const agent = createAgent({
      name: "cascade-worker-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const parent = createTaskExtended("Parent A", { agentId: agent.id });
    const child = createTaskExtended("Child of A", {
      agentId: agent.id,
      dependsOn: [parent.id],
    });

    startTask(parent.id, agent.id);
    failTask(parent.id, "parent failed");

    const childAfter = getTaskById(child.id);
    expect(childAfter!.status).toBe("failed");
    expect(childAfter!.failureReason).toContain("Blocked dependency");
    expect(childAfter!.failureReason).toContain("was failed");
  });

  test("multi-level recursive cascade: A→B→C all fail", () => {
    const agent = createAgent({
      name: "cascade-worker-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const taskA = createTaskExtended("Task A (root)", { agentId: agent.id });
    const taskB = createTaskExtended("Task B (depends on A)", {
      agentId: agent.id,
      dependsOn: [taskA.id],
    });
    const taskC = createTaskExtended("Task C (depends on B)", {
      agentId: agent.id,
      dependsOn: [taskB.id],
    });

    startTask(taskA.id, agent.id);
    failTask(taskA.id, "root failure");

    const bAfter = getTaskById(taskB.id);
    expect(bAfter!.status).toBe("failed");
    expect(bAfter!.failureReason).toContain("Blocked dependency");

    const cAfter = getTaskById(taskC.id);
    expect(cAfter!.status).toBe("failed");
    expect(cAfter!.failureReason).toContain("Blocked dependency");
  });

  test("cycle-safety: A↔B does not infinite-loop", () => {
    const agent = createAgent({
      name: "cascade-worker-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Create tasks with a dependency cycle: A depends on B, B depends on A
    const taskA = createTaskExtended("Cycle A", { agentId: agent.id });
    const taskB = createTaskExtended("Cycle B", {
      agentId: agent.id,
      dependsOn: [taskA.id],
    });
    // Manually update taskA to depend on taskB (creating a cycle)
    getDb().run("UPDATE agent_tasks SET dependsOn = ? WHERE id = ?", [
      JSON.stringify([taskB.id]),
      taskA.id,
    ]);

    // This should not infinite-loop — the visited set protects us
    startTask(taskA.id, agent.id);
    const results = cascadeFailDependents(taskA.id, "failed");

    // taskB should be cascade-failed
    const bAfter = getTaskById(taskB.id);
    expect(bAfter!.status).toBe("failed");

    // results should include taskB but NOT loop infinitely
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.taskId === taskB.id)).toBe(true);
  });

  test("already-completed dependent is left untouched", () => {
    const agent = createAgent({
      name: "cascade-worker-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const parent = createTaskExtended("Parent D", { agentId: agent.id });
    const child = createTaskExtended("Child D (completed)", {
      agentId: agent.id,
      dependsOn: [parent.id],
    });

    startTask(child.id, agent.id);
    completeTask(child.id, "finished before parent failed");

    startTask(parent.id, agent.id);
    failTask(parent.id, "parent failed late");

    const childAfter = getTaskById(child.id);
    expect(childAfter!.status).toBe("completed");
    expect(childAfter!.output).toBe("finished before parent failed");
  });

  test("cancelTask cascades to dependents", () => {
    const agent = createAgent({
      name: "cascade-worker-5",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const parent = createTaskExtended("Parent cancel", { agentId: agent.id });
    const child = createTaskExtended("Child of cancelled", {
      agentId: agent.id,
      dependsOn: [parent.id],
    });

    cancelTask(parent.id, "no longer needed");

    const childAfter = getTaskById(child.id);
    expect(childAfter!.status).toBe("failed");
    expect(childAfter!.failureReason).toContain("was cancelled");
  });

  test("supersedeTask cascades to dependents", () => {
    const agent = createAgent({
      name: "cascade-worker-6",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const parent = createTaskExtended("Parent supersede", { agentId: agent.id });
    const child = createTaskExtended("Child of superseded", {
      agentId: agent.id,
      dependsOn: [parent.id],
    });

    startTask(parent.id, agent.id);
    supersedeTask(parent.id, { reason: "context limit", resumeTaskId: null });

    const childAfter = getTaskById(child.id);
    expect(childAfter!.status).toBe("failed");
    expect(childAfter!.failureReason).toContain("was superseded");
  });

  test("wide fan-out: multiple dependents all cascade-failed", () => {
    const agent = createAgent({
      name: "cascade-worker-7",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const parent = createTaskExtended("Parent wide", { agentId: agent.id });
    const children = Array.from({ length: 5 }, (_, i) =>
      createTaskExtended(`Child ${i}`, {
        agentId: agent.id,
        dependsOn: [parent.id],
      }),
    );

    startTask(parent.id, agent.id);
    failTask(parent.id, "parent gone");

    for (const child of children) {
      const after = getTaskById(child.id);
      expect(after!.status).toBe("failed");
      expect(after!.failureReason).toContain("Blocked dependency");
    }
  });

  test("diamond dependency: C depends on both A and B, only A fails", () => {
    const agent = createAgent({
      name: "cascade-worker-8",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const taskA = createTaskExtended("Diamond A", { agentId: agent.id });
    const taskB = createTaskExtended("Diamond B", { agentId: agent.id });
    const taskC = createTaskExtended("Diamond C (depends on A and B)", {
      agentId: agent.id,
      dependsOn: [taskA.id, taskB.id],
    });

    startTask(taskA.id, agent.id);
    failTask(taskA.id, "A failed");

    // C should be cascade-failed because one of its dependencies failed
    const cAfter = getTaskById(taskC.id);
    expect(cAfter!.status).toBe("failed");
    expect(cAfter!.failureReason).toContain("Blocked dependency");
  });
});
