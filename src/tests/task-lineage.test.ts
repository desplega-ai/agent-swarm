import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskLineage,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-task-lineage.sqlite";

async function removeDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

describe("getTaskLineage", () => {
  let agentId: string;

  beforeAll(async () => {
    await removeDb();
    initDb(TEST_DB_PATH);
    const agent = await createAgent({
      id: crypto.randomUUID(),
      name: "Lineage Test Agent",
      isLead: false,
      status: "idle",
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    closeDb();
    await removeDb();
  });

  test("unknown task: null", async () => {
    expect(await getTaskLineage("no-such-task")).toBeNull();
  });

  test("from a grandchild: walks up to the root, then the whole tree", async () => {
    const root = await createTaskExtended("root", { agentId });
    const childA = await createTaskExtended("child a", { agentId, parentTaskId: root.id });
    const childB = await createTaskExtended("child b", { agentId, parentTaskId: root.id });
    const grandchild = await createTaskExtended("grandchild", {
      agentId,
      parentTaskId: childA.id,
    });
    const greatGrandchild = await createTaskExtended("great-grandchild", {
      agentId,
      parentTaskId: grandchild.id,
    });
    const unrelated = await createTaskExtended("unrelated", { agentId });

    const lineage = await getTaskLineage(grandchild.id);
    expect(lineage).not.toBeNull();
    expect(lineage!.rootTaskId).toBe(root.id);
    expect(lineage!.truncated).toBe(false);
    expect(lineage!.tasks[0]!.id).toBe(root.id);
    const ids = new Set(lineage!.tasks.map((t) => t.id));
    expect(ids).toEqual(
      new Set([root.id, childA.id, childB.id, grandchild.id, greatGrandchild.id]),
    );
    expect(ids.has(unrelated.id)).toBe(false);
    expect(lineage!.tasks.find((t) => t.id === childA.id)!.parentTaskId).toBe(root.id);
  });

  test("a node cap keeps the path to the task and its own subtree, and says it cut", async () => {
    const root = await createTaskExtended("wide root", { agentId });
    const children = [];
    for (let i = 0; i < 6; i++) {
      children.push(await createTaskExtended(`fan-out ${i}`, { agentId, parentTaskId: root.id }));
    }
    const last = children[children.length - 1]!;
    const leaf = await createTaskExtended("leaf under the last child", {
      agentId,
      parentTaskId: last.id,
    });

    const lineage = await getTaskLineage(last.id, { maxNodes: 3 });
    expect(lineage!.truncated).toBe(true);
    const ids = new Set(lineage!.tasks.map((t) => t.id));
    expect(ids.has(root.id)).toBe(true);
    expect(ids.has(last.id)).toBe(true);
    expect(ids.has(leaf.id)).toBe(true);
    expect(lineage!.tasks.length).toBeLessThanOrEqual(2 * 3 + 2);
  });

  test("a depth cap stops the walk down", async () => {
    const root = await createTaskExtended("deep root", { agentId });
    let parent = root;
    for (let i = 0; i < 5; i++) {
      parent = await createTaskExtended(`level ${i + 1}`, { agentId, parentTaskId: parent.id });
    }
    const lineage = await getTaskLineage(root.id, { maxDepth: 2 });
    expect(lineage!.tasks).toHaveLength(3);
  });

  test("a parentTaskId cycle ends at the ancestor cap instead of looping", async () => {
    const a = await createTaskExtended("cycle a", { agentId });
    const b = await createTaskExtended("cycle b", { agentId, parentTaskId: a.id });
    await getDbClient().run("UPDATE agent_tasks SET parentTaskId = ? WHERE id = ?", [b.id, a.id]);

    const lineage = await getTaskLineage(a.id, { maxAncestors: 5, maxDepth: 4 });
    expect(lineage!.truncated).toBe(true);
    expect(new Set(lineage!.tasks.map((t) => t.id))).toEqual(new Set([a.id, b.id]));
  });
});
