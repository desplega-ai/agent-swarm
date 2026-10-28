import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskLineage,
  initDb,
  TASK_LINEAGE_LIMITS,
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

  /** A straight parentTaskId chain, root first. */
  async function createChain(label: string, length: number) {
    const chain = [await createTaskExtended(`${label} 0`, { agentId })];
    for (let i = 1; i < length; i++) {
      chain.push(
        await createTaskExtended(`${label} ${i}`, { agentId, parentTaskId: chain[i - 1]!.id }),
      );
    }
    return chain;
  }

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
    expect(lineage!.truncated).toBe(true);
  });

  test("a chain past the default depth cap says it cut", async () => {
    const chain = await createChain("default-depth", 32);
    const lineage = await getTaskLineage(chain[0]!.id);
    expect(lineage!.tasks).toHaveLength(TASK_LINEAGE_LIMITS.maxDepth + 1);
    expect(lineage!.truncated).toBe(true);
  });

  test("a chain that ends exactly at the depth cap is complete", async () => {
    const chain = await createChain("exact-depth", 3);
    const lineage = await getTaskLineage(chain[0]!.id, { maxDepth: 2 });
    expect(lineage!.tasks).toHaveLength(3);
    expect(lineage!.truncated).toBe(false);
  });

  test("every ancestor of the task survives a node cap of 1", async () => {
    const chain = await createChain("path-node-cap", 5);
    const leaf = chain[chain.length - 1]!;
    const lineage = await getTaskLineage(leaf.id, { maxNodes: 1 });
    expect(new Set(lineage!.tasks.map((t) => t.id))).toEqual(new Set(chain.map((t) => t.id)));
    // Nothing in the tree is left out, so the result is complete.
    expect(lineage!.truncated).toBe(false);
    const ids = new Set(lineage!.tasks.map((t) => t.id));
    for (const task of lineage!.tasks) {
      if (task.id !== lineage!.rootTaskId) expect(ids.has(task.parentTaskId!)).toBe(true);
    }
  });

  test("a deep focused path survives both caps, and a cut sibling still flags", async () => {
    const chain = await createChain("deep-focus", 8);
    const sibling = await createTaskExtended("off-path sibling", {
      agentId,
      parentTaskId: chain[1]!.id,
    });
    const leaf = chain[chain.length - 1]!;
    const lineage = await getTaskLineage(leaf.id, { maxNodes: 1, maxDepth: 1 });
    const ids = new Set(lineage!.tasks.map((t) => t.id));
    for (const task of chain) expect(ids.has(task.id)).toBe(true);
    expect(ids.has(sibling.id)).toBe(false);
    expect(lineage!.truncated).toBe(true);
  });

  test("a fan-out exactly at the node cap is complete; one more child cuts", async () => {
    const root = await createTaskExtended("cap root", { agentId });
    for (let i = 0; i < 3; i++) {
      await createTaskExtended(`cap child ${i}`, { agentId, parentTaskId: root.id });
    }
    const atCap = await getTaskLineage(root.id, { maxNodes: 4 });
    expect(atCap!.tasks).toHaveLength(4);
    expect(atCap!.truncated).toBe(false);
    const overCap = await getTaskLineage(root.id, { maxNodes: 3 });
    expect(overCap!.tasks).toHaveLength(3);
    expect(overCap!.truncated).toBe(true);
  });

  test("a parentTaskId cycle ends at the ancestor cap instead of looping", async () => {
    const a = await createTaskExtended("cycle a", { agentId });
    const b = await createTaskExtended("cycle b", { agentId, parentTaskId: a.id });
    // Product code never rewrites parentTaskId, and migration 253 guards it;
    // this cycle fixture needs the guard off.
    await getDbClient().run("DROP TRIGGER IF EXISTS session_task_parent_immutable");
    await getDbClient().run("UPDATE agent_tasks SET parentTaskId = ? WHERE id = ?", [b.id, a.id]);

    const lineage = await getTaskLineage(a.id, { maxAncestors: 5, maxDepth: 4 });
    expect(lineage!.truncated).toBe(true);
    expect(new Set(lineage!.tasks.map((t) => t.id))).toEqual(new Set([a.id, b.id]));
  });
});
