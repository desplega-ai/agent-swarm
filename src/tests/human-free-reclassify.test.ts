import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createSessionCost,
  createTaskExtended,
  createUser,
  createWorkflow,
  createWorkflowRun,
  deleteUser,
  deleteWorkflow,
  getDbClient,
  getSessionCostSummary,
  initDb,
} from "../be/db";
import {
  drainHumanFreeReclassifyQueue,
  HUMAN_FREE_RECLASSIFY_BATCH,
  pendingHumanFreeReclassifications,
  reclassifyTaskHumanFree,
} from "../be/db/tasks/human-free";
import { completeTask, deleteTask } from "../be/db/tasks/write";
import { startHumanFreeDrain, stopHumanFreeDrain } from "../be/human-free-drain";
import { expectFlagsMatchLegacy, legacyHumanFreeIds, storedFlags } from "./human-free-oracle";

const TEST_DB_PATH = "./test-human-free-reclassify.sqlite";

// `agent_tasks.isHumanFree` is written when a task is created. Every mutation
// that rewrites a classifying input has to bring it back in line, or the usage
// reports drift from what the rule selects over the current rows (which is what
// the live recursive CTE returned before the column existed). After each
// mutation these tests compare the whole table against that CTE as an oracle.
async function expectStoredMatchesRule() {
  expectFlagsMatchLegacy(await storedFlags(), await legacyHumanFreeIds());
}

async function flag(taskId: string): Promise<boolean | undefined> {
  return (await storedFlags()).get(taskId);
}

async function task(text: string, options: Parameters<typeof createTaskExtended>[1] = {}) {
  return (await createTaskExtended(text, options)).id;
}

// How many subtree recomputations `fn` ran. Asserting on the flags alone cannot
// tell "skipped the walk" from "walked and found nothing to change", and the
// walk is the cost a deferral must not pay.
async function countSubtreeRecomputations(fn: () => Promise<unknown>): Promise<number> {
  const runSpy = spyOn(getDbClient(), "run");
  try {
    await fn();
    return runSpy.mock.calls.filter(([sql]) => String(sql).includes("WITH RECURSIVE affected"))
      .length;
  } finally {
    runSpy.mockRestore();
  }
}

describe("human-free flag stays correct when a classifying input changes", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  test("deleteUser without a replacement reclassifies requester-cleared tasks and their descendants", async () => {
    const user = await createUser({ name: "Reclassify Deleted Requester" });
    const other = await createUser({ name: "Reclassify Other Requester" });
    const agent = await createAgent({ name: "Reclassify Agent A", isLead: false, status: "idle" });

    const root = await task("scheduled by a person", {
      source: "schedule",
      requestedByUserId: user.id,
    });
    const child = await task("inherits the requester", { parentTaskId: root });
    const grandchild = await task("inherits it too", { parentTaskId: child });
    // An explicit handoff to someone else is independent and must stay attributed.
    const handoff = await task("handed to another person", {
      parentTaskId: root,
      requestedByUserId: other.id,
    });
    const belowHandoff = await task("below the handoff", { parentTaskId: handoff });
    // `system` follow-ups are free only while the parent has no requester.
    const systemChild = await task("system follow-up", { source: "system", parentTaskId: root });
    // A workflow root whose run was scheduled by this user: creator cleared with the user.
    const workflow = await createWorkflow({
      name: `reclassify-user-${crypto.randomUUID()}`,
      definition: { nodes: [] },
    });
    const schedule = await createScheduledTask({
      name: `reclassify-user-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: workflow.id,
      createdBy: user.id,
    });
    const run = await createWorkflowRun({
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      triggerType: "schedule",
      triggerData: { scheduleId: schedule.id },
      createdBy: user.id,
    });
    const workflowRoot = await task("workflow root", { source: "workflow", workflowRunId: run.id });
    const workflowChild = await task("workflow child", {
      source: "workflow",
      workflowRunId: run.id,
      parentTaskId: workflowRoot,
    });

    for (const [name, taskId] of [
      ["root", root],
      ["child", child],
    ] as const) {
      await createSessionCost({
        sessionId: `reclassify-${name}`,
        taskId,
        agentId: agent.id,
        totalCostUsd: 1,
        durationMs: 1000,
        numTurns: 1,
        model: "opus",
      });
    }

    const beforeFlags = await storedFlags();
    for (const taskId of [
      root,
      child,
      grandchild,
      handoff,
      belowHandoff,
      systemChild,
      workflowRoot,
      workflowChild,
    ]) {
      expect(beforeFlags.get(taskId)).toBe(false);
    }
    const before = (await getSessionCostSummary({ agentId: agent.id, groupBy: "day" })).totals;
    expect(before.excludedCostUsd).toBe(0);
    expect(before.excludedTaskCount).toBe(0);
    expect(before.attributableCostUsd).toBe(2);
    await expectStoredMatchesRule();

    expect(await deleteUser(user.id)).toBe(true);

    const after = await storedFlags();
    expect(
      Object.fromEntries(
        Object.entries({
          root,
          child,
          grandchild,
          handoff,
          belowHandoff,
          systemChild,
          workflowRoot,
          workflowChild,
        }).map(([name, taskId]) => [name, after.get(taskId)]),
      ),
    ).toEqual({
      root: true,
      child: true,
      grandchild: true,
      handoff: false,
      belowHandoff: false,
      systemChild: true,
      workflowRoot: true,
      workflowChild: true,
    });
    // The report the reviewer reproduced: both sessions leave the human denominator.
    const totals = (await getSessionCostSummary({ agentId: agent.id, groupBy: "day" })).totals;
    expect(totals.excludedCostUsd).toBe(2);
    expect(totals.excludedTaskCount).toBe(2);
    expect(totals.attributableCostUsd).toBe(0);
    await expectStoredMatchesRule();
  });

  test("deleteUser with a replacement leaves the classification alone", async () => {
    const user = await createUser({ name: "Reclassify Replaced Requester" });
    const replacement = await createUser({ name: "Reclassify Replacement" });
    const root = await task("scheduled by a person", {
      source: "schedule",
      requestedByUserId: user.id,
    });
    const child = await task("inherits the requester", { parentTaskId: root });

    expect(await deleteUser(user.id, replacement.id)).toBe(true);

    const row = await getDbClient().get<{ requestedByUserId: string | null }>(
      "SELECT requestedByUserId FROM agent_tasks WHERE id = ?",
      [child],
    );
    expect(row?.requestedByUserId).toBe(replacement.id);
    expect(await flag(root)).toBe(false);
    expect(await flag(child)).toBe(false);
    await expectStoredMatchesRule();
  });

  test("deleteWorkflow drops the flag from scheduled workflow roots whose run is gone", async () => {
    const workflow = await createWorkflow({
      name: `reclassify-workflow-${crypto.randomUUID()}`,
      definition: { nodes: [] },
    });
    const schedule = await createScheduledTask({
      name: `reclassify-workflow-${crypto.randomUUID()}`,
      intervalMs: 60_000,
      targetType: "workflow",
      workflowId: workflow.id,
    });
    const run = await createWorkflowRun({
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      triggerType: "schedule",
      triggerData: { scheduleId: schedule.id },
    });
    const root = await task("wf root", { source: "workflow", workflowRunId: run.id });
    const child = await task("wf child", {
      source: "workflow",
      workflowRunId: run.id,
      parentTaskId: root,
    });
    expect(await flag(root)).toBe(true);
    expect(await flag(child)).toBe(true);

    expect(await deleteWorkflow(workflow.id)).toBe(true);

    expect(await flag(root)).toBe(false);
    expect(await flag(child)).toBe(false);
    await expectStoredMatchesRule();
  });

  test("deleteWorkflow keeps flags that rest on other rules", async () => {
    const workflow = await createWorkflow({
      name: `reclassify-workflow-heartbeat-${crypto.randomUUID()}`,
      definition: { nodes: [] },
    });
    const run = await createWorkflowRun({
      id: crypto.randomUUID(),
      workflowId: workflow.id,
      triggerType: "schedule",
    });
    const heartbeat = await task("hb in a run", {
      taskType: "heartbeat",
      source: "workflow",
      workflowRunId: run.id,
    });
    const below = await task("below the heartbeat", { parentTaskId: heartbeat });
    expect(await flag(heartbeat)).toBe(true);

    expect(await deleteWorkflow(workflow.id)).toBe(true);

    expect(await flag(heartbeat)).toBe(true);
    expect(await flag(below)).toBe(true);
    await expectStoredMatchesRule();
  });

  test("deleteTask reclassifies children left with a dangling parent", async () => {
    const root = await task("scheduled root", { source: "schedule" });
    const child = await task("plain child", { parentTaskId: root });
    const grandchild = await task("plain grandchild", { parentTaskId: child });
    const systemChild = await task("system child", { source: "system", parentTaskId: root });
    const heartbeatChild = await task("heartbeat child", {
      taskType: "heartbeat",
      parentTaskId: root,
    });
    for (const taskId of [root, child, grandchild, systemChild, heartbeatChild]) {
      expect(await flag(taskId)).toBe(true);
    }

    expect(await deleteTask(root)).toBe(true);

    expect(await flag(child)).toBe(false);
    expect(await flag(grandchild)).toBe(false);
    expect(await flag(systemChild)).toBe(false);
    // Its own taskType still classifies it.
    expect(await flag(heartbeatChild)).toBe(true);
    await expectStoredMatchesRule();
  });

  test("completing a task with a heartbeat tag reclassifies it and its descendants", async () => {
    const root = await task("became a heartbeat");
    const child = await task("below it", { parentTaskId: root });
    expect(await flag(root)).toBe(false);
    expect(await flag(child)).toBe(false);

    await completeTask(root, "done", { addTags: ["deferred", "heartbeat"] });

    expect(await flag(root)).toBe(true);
    expect(await flag(child)).toBe(true);
    await expectStoredMatchesRule();
  });

  test("completing a task with an unrelated tag changes nothing", async () => {
    const root = await task("deferred work");
    const child = await task("below it", { parentTaskId: root });

    await completeTask(root, "done", { addTags: ["deferred"] });

    expect(await flag(root)).toBe(false);
    expect(await flag(child)).toBe(false);
    await expectStoredMatchesRule();
  });

  test("deferring a task does not recompute its subtree", async () => {
    const root = await task("about to be deferred");
    const child = await task("child", { parentTaskId: root });
    const grandchild = await task("grandchild", { parentTaskId: child });
    // Give the subtree a stored flag that disagrees with the rule. A deferral
    // that walked it would repair the flag; one that skips the walk leaves it.
    await getDbClient().run("UPDATE agent_tasks SET isHumanFree = 1 WHERE id = ?", [grandchild]);

    // The exact write `defer-task` makes when it completes the deferred task.
    const recomputations = await countSubtreeRecomputations(() =>
      completeTask(root, "deferred", {
        addTags: ["deferred"],
        deferredAt: new Date().toISOString(),
      }),
    );

    expect(recomputations).toBe(0);
    expect(await flag(grandchild)).toBe(true);
    const tags = await getDbClient().get<{ tags: string }>(
      "SELECT tags FROM agent_tasks WHERE id = ?",
      [root],
    );
    expect(JSON.parse(tags?.tags ?? "[]")).toContain("deferred");

    // Put the table back in line: an explicit reclassification repairs exactly
    // the flag the deferral left alone.
    expect(await reclassifyTaskHumanFree([root])).toBe(1);
    await expectStoredMatchesRule();
  });

  test("a tag write that changes no classifying tag skips the walk, one that does runs it once", async () => {
    // Already a heartbeat: re-adding the tag (with a deferral) flips nothing.
    const heartbeat = await task("already tagged", { tags: ["heartbeat"] });
    const heartbeatChild = await task("below it", { parentTaskId: heartbeat });
    expect(await flag(heartbeatChild)).toBe(true);
    await getDbClient().run("UPDATE agent_tasks SET isHumanFree = 0 WHERE id = ?", [
      heartbeatChild,
    ]);
    expect(
      await countSubtreeRecomputations(() =>
        completeTask(heartbeat, "done", { addTags: ["deferred", "heartbeat"] }),
      ),
    ).toBe(0);
    expect(await flag(heartbeatChild)).toBe(false);
    expect(await reclassifyTaskHumanFree([heartbeat])).toBe(1);
    expect(await flag(heartbeatChild)).toBe(true);

    // A tag that looks like the classifying one but is not it.
    const lookalike = await task("lookalike tag");
    expect(
      await countSubtreeRecomputations(() =>
        completeTask(lookalike, "done", { addTags: ["heartbeat-review", "not_heartbeat"] }),
      ),
    ).toBe(0);
    expect(await flag(lookalike)).toBe(false);

    // The classifying tag is matched case-insensitively by the SQL, so the
    // guard must not miss a case variant.
    const shouting = await task("uppercase tag");
    const shoutingChild = await task("below it", { parentTaskId: shouting });
    expect(
      await countSubtreeRecomputations(() =>
        completeTask(shouting, "done", { addTags: ["HEARTBEAT"] }),
      ),
    ).toBe(1);
    expect(await flag(shouting)).toBe(true);
    expect(await flag(shoutingChild)).toBe(true);
    await expectStoredMatchesRule();
  });

  test("reclassify handles seeds that descend from other seeds, in any order", async () => {
    const user = await createUser({ name: "Reclassify Ordering Requester" });
    const root = await task("root", { source: "schedule", requestedByUserId: user.id });
    const child = await task("child", { parentTaskId: root });
    const grandchild = await task("grandchild", { parentTaskId: child });
    const greatGrandchild = await task("great-grandchild", { parentTaskId: grandchild });
    for (const taskId of [root, child, grandchild, greatGrandchild]) {
      expect(await flag(taskId)).toBe(false);
    }

    // Clear the requester without going through deleteUser, then hand the seeds
    // over deepest-first so a seed reads its parent's stale stored flag.
    await getDbClient().run(
      "UPDATE agent_tasks SET requestedByUserId = NULL WHERE id IN (?, ?, ?, ?)",
      [root, child, grandchild, greatGrandchild],
    );
    const changed = await reclassifyTaskHumanFree([greatGrandchild, grandchild, child, root]);

    expect(changed).toBe(4);
    for (const taskId of [root, child, grandchild, greatGrandchild]) {
      expect(await flag(taskId)).toBe(true);
    }
    await expectStoredMatchesRule();

    // Nothing left to change.
    expect(await reclassifyTaskHumanFree([root])).toBe(0);
    expect(await reclassifyTaskHumanFree([])).toBe(0);
  });

  test("reclassify reaches descendants past 1,000 parent links", async () => {
    const agent = await createAgent({
      name: "Reclassify Deep Agent",
      isLead: false,
      status: "idle",
    });
    const root = await task("ordinary root");
    // Task creation has no depth limit, so a follow-up chain can outgrow any
    // fixed bound in the reclassification walk. 1,001 links put the leaf one
    // past the old cutoff, and past two batches of the current one.
    const chain: string[] = [root];
    for (let i = 0; i < 1_001; i++) {
      chain.push(await task(`link ${i}`, { parentTaskId: chain[chain.length - 1] }));
    }
    const leaf = chain[chain.length - 1];
    const lastWithinOldCutoff = chain[1_000];
    await createSessionCost({
      sessionId: "reclassify-deep-leaf",
      taskId: leaf,
      agentId: agent.id,
      totalCostUsd: 4,
      durationMs: 1000,
      numTurns: 1,
      model: "opus",
    });
    expect(await flag(leaf)).toBe(false);
    const before = (await getSessionCostSummary({ agentId: agent.id, groupBy: "day" })).totals;
    expect(before.attributableCostUsd).toBe(4);
    expect(before.excludedCostUsd).toBe(0);

    // Mixed with the "deferred" tag a deferral writes: the classifying tag
    // still triggers the walk, but only one batch of it runs in the request.
    const recomputations = await countSubtreeRecomputations(() =>
      completeTask(root, "done", { addTags: ["deferred", "heartbeat"] }),
    );

    expect(recomputations).toBe(1);
    expect(await flag(root)).toBe(true);
    expect(await flag(chain[HUMAN_FREE_RECLASSIFY_BATCH - 1])).toBe(true);
    expect(await flag(chain[HUMAN_FREE_RECLASSIFY_BATCH])).toBe(false);
    expect(await flag(leaf)).toBe(false);
    expect(await pendingHumanFreeReclassifications()).toBe(1);

    const drained = await drainHumanFreeReclassifyQueue();

    expect(drained.remaining).toBe(0);
    expect(await flag(lastWithinOldCutoff)).toBe(true);
    expect(await flag(leaf)).toBe(true);
    const after = (await getSessionCostSummary({ agentId: agent.id, groupBy: "day" })).totals;
    expect(after.attributableCostUsd).toBe(0);
    expect(after.excludedCostUsd).toBe(4);
    expect(after.excludedTaskCount).toBe(1);
    await expectStoredMatchesRule();
  }, 60_000);

  test("a tree larger than one batch is not walked in one request, and the rest drains", async () => {
    // Root, a chain, a wide parent, and a branch that stops propagation: every
    // shape the batch boundary can cut through.
    const owner = await createUser({ name: "Bounded Reclassify Owner" });
    const root = await task("bounded root");
    const chain: string[] = [root];
    for (let i = 0; i < 6; i++) chain.push(await task(`chain ${i}`, { parentTaskId: chain[i] }));
    const wide = await task("wide parent", { parentTaskId: root });
    const fans: string[] = [];
    for (let i = 0; i < 9; i++) fans.push(await task(`fan ${i}`, { parentTaskId: wide }));
    const fanChild = await task("below a fan", { parentTaskId: fans[4] });
    const handedOff = await task("explicitly attributed", {
      parentTaskId: wide,
      requestedByUserId: owner.id,
    });
    const belowHandedOff = await task("below the handoff", { parentTaskId: handedOff });
    const everyTask = [...chain, wide, ...fans, fanChild, handedOff, belowHandedOff];
    const treeSize = everyTask.length;
    const batchSize = 4;
    expect(treeSize).toBeGreaterThan(batchSize * 3);
    await getDbClient().run("UPDATE agent_tasks SET tags = ? WHERE id = ?", [
      JSON.stringify(["heartbeat"]),
      root,
    ]);

    const changedInline = await reclassifyTaskHumanFree([root], { batchSize });

    // One batch changed exactly `batchSize` flags and left work behind.
    expect(changedInline).toBe(batchSize);
    const flaggedInline = [...(await storedFlags())].filter(
      ([id, flagged]) => flagged && everyTask.includes(id),
    );
    expect(flaggedInline.length).toBe(batchSize);
    expect(await pendingHumanFreeReclassifications()).toBeGreaterThan(0);

    // Each drained batch is bounded the same way, and the queue empties.
    let totalChanged = changedInline;
    let passes = 0;
    while ((await pendingHumanFreeReclassifications()) > 0) {
      const pass = await drainHumanFreeReclassifyQueue({ batchSize, maxBatches: 1 });
      expect(pass.batches).toBe(1);
      expect(pass.changed).toBeLessThanOrEqual(batchSize);
      totalChanged += pass.changed;
      passes += 1;
      expect(passes).toBeLessThan(treeSize);
    }
    expect(passes).toBeGreaterThan(1);
    // Every task of the tree flipped exactly once, except the attributed branch.
    expect(totalChanged).toBe(treeSize - 2);
    for (const taskId of everyTask) {
      expect(await flag(taskId)).toBe(taskId !== handedOff && taskId !== belowHandedOff);
    }
    await expectStoredMatchesRule();
  });

  test("a wide parent queues one row, not one per child", async () => {
    const parent = await task("very wide parent", { tags: ["heartbeat"] });
    const children: string[] = [];
    for (let i = 0; i < 40; i++) children.push(await task(`child ${i}`, { parentTaskId: parent }));
    await getDbClient().run("UPDATE agent_tasks SET isHumanFree = 0 WHERE id = ?", [parent]);
    await getDbClient().run("UPDATE agent_tasks SET isHumanFree = 0 WHERE parentTaskId = ?", [
      parent,
    ]);

    await reclassifyTaskHumanFree([parent], { batchSize: 5 });

    expect(await pendingHumanFreeReclassifications()).toBe(1);
    const drained = await drainHumanFreeReclassifyQueue({ batchSize: 5 });
    expect(drained.remaining).toBe(0);
    // Paged five children at a time, none skipped or walked twice into a change.
    expect(drained.batches).toBeGreaterThanOrEqual(children.length / 5 - 1);
    for (const child of children) expect(await flag(child)).toBe(true);
    await expectStoredMatchesRule();
  });

  test("a seed list longer than one batch queues the overflow", async () => {
    const user = await createUser({ name: "Overflow Seed Requester" });
    const roots: string[] = [];
    for (let i = 0; i < 11; i++) {
      roots.push(await task(`scheduled ${i}`, { source: "schedule", requestedByUserId: user.id }));
    }
    const below = await task("below the first", { parentTaskId: roots[0] });
    for (const root of roots) {
      await getDbClient().run("UPDATE agent_tasks SET requestedByUserId = NULL WHERE id = ?", [
        root,
      ]);
    }

    const changedInline = await reclassifyTaskHumanFree(roots, { batchSize: 3 });

    expect(changedInline).toBeLessThanOrEqual(3);
    expect(await pendingHumanFreeReclassifications()).toBeGreaterThan(0);
    expect((await drainHumanFreeReclassifyQueue({ batchSize: 3 })).remaining).toBe(0);
    for (const taskId of [...roots, below]) expect(await flag(taskId)).toBe(true);
    await expectStoredMatchesRule();
  });

  test("a second mutation while work is queued restarts it and still converges", async () => {
    const root = await task("restarted root");
    const chain: string[] = [root];
    for (let i = 0; i < 12; i++) chain.push(await task(`link ${i}`, { parentTaskId: chain[i] }));
    const setTags = (tags: string[]) =>
      getDbClient().run("UPDATE agent_tasks SET tags = ? WHERE id = ?", [
        JSON.stringify(tags),
        root,
      ]);

    await setTags(["heartbeat"]);
    await reclassifyTaskHumanFree([root], { batchSize: 4 });
    await drainHumanFreeReclassifyQueue({ batchSize: 4, maxBatches: 1 });
    expect(await pendingHumanFreeReclassifications()).toBeGreaterThan(0);
    expect(await flag(chain[12])).toBe(false);

    // The tag is gone again before the first wave reached the leaf. The chain
    // holds a mix of new and old flags until the second wave finishes.
    await setTags([]);
    await reclassifyTaskHumanFree([root], { batchSize: 4 });
    expect((await drainHumanFreeReclassifyQueue({ batchSize: 4 })).remaining).toBe(0);

    for (const taskId of chain) expect(await flag(taskId)).toBe(false);
    await expectStoredMatchesRule();
  });

  test("the background drain finishes a queued subtree on its own", async () => {
    const root = await task("drained in the background");
    const chain: string[] = [root];
    for (let i = 0; i < HUMAN_FREE_RECLASSIFY_BATCH + 20; i++) {
      chain.push(await task(`link ${i}`, { parentTaskId: chain[chain.length - 1] }));
    }
    const leaf = chain[chain.length - 1];
    await completeTask(root, "done", { addTags: ["heartbeat"] });
    expect(await flag(leaf)).toBe(false);
    expect(await pendingHumanFreeReclassifications()).toBeGreaterThan(0);

    startHumanFreeDrain();
    try {
      const deadline = Date.now() + 10_000;
      while ((await pendingHumanFreeReclassifications()) > 0 && Date.now() < deadline) {
        await Bun.sleep(25);
      }
    } finally {
      stopHumanFreeDrain();
    }

    expect(await pendingHumanFreeReclassifications()).toBe(0);
    expect(await flag(leaf)).toBe(true);
    await expectStoredMatchesRule();
  });

  test("reclassify terminates on a parent cycle and matches the rule", async () => {
    const first = await task("cycle first");
    const second = await task("cycle second", { parentTaskId: first });
    const third = await task("cycle third", { parentTaskId: second });
    // Nothing in the product writes a cycle, but the rule (a UNION over ids)
    // is defined on one, so the reclassification must stay total on it.
    await getDbClient().run("UPDATE agent_tasks SET parentTaskId = ? WHERE id = ?", [third, first]);
    await getDbClient().run("UPDATE agent_tasks SET tags = ? WHERE id = ?", [
      JSON.stringify(["heartbeat"]),
      second,
    ]);

    expect(await reclassifyTaskHumanFree([first])).toBe(3);

    for (const taskId of [first, second, third]) {
      expect(await flag(taskId)).toBe(true);
    }
    await expectStoredMatchesRule();
  });

  test("a parent cycle longer than one batch stops re-queuing itself", async () => {
    const ring: string[] = [await task("ring 0")];
    for (let i = 1; i < 6; i++) ring.push(await task(`ring ${i}`, { parentTaskId: ring[i - 1] }));
    await getDbClient().run("UPDATE agent_tasks SET parentTaskId = ? WHERE id = ?", [
      ring[5],
      ring[0],
    ]);
    await getDbClient().run("UPDATE agent_tasks SET tags = ? WHERE id = ?", [
      JSON.stringify(["heartbeat"]),
      ring[2],
    ]);
    // Nothing in the product writes a cycle. One longer than a batch never
    // runs out of tree, so only the hop limit ends the drain.
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await reclassifyTaskHumanFree([ring[0]], { batchSize: 2 });
      const drained = await drainHumanFreeReclassifyQueue({ batchSize: 2 });

      expect(drained.remaining).toBe(0);
      expect(
        errorSpy.mock.calls.some(([message]) => String(message).includes("parent cycle")),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
    for (const taskId of ring) expect(await flag(taskId)).toBe(true);
  }, 60_000);
});
