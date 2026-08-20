import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  checkoutPromptTemplate,
  closeDb,
  createScriptRun,
  createTaskExtended,
  createWorkflow,
  getDbClient,
  getScriptRun,
  getWorkflow,
  initDb,
  updateScriptRun,
  updateScriptRunIfNotTerminal,
  upsertPromptTemplate,
  upsertSwarmConfig,
} from "../be/db";
import type { WorkflowDefinition } from "../types";
import { patchWorkflowDefinition } from "../workflows/patch-definition";

// Guard-then-write races that the async DB seam opened: each helper below
// reads a guard, awaits (releasing the FIFO lock), then writes. The tests fire
// two callers concurrently in one process, which is exactly the interleaving
// production hits (two Linear webhook deliveries, two config saves, a cancel
// racing a status post, two node patches).

const TEST_DB_PATH = "./test-asyncdb-guard-races.sqlite";

async function clearDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {}
  }
}

beforeAll(async () => {
  await clearDb();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await clearDb();
});

describe("createTaskExtended tracker dedup", () => {
  test("two concurrent creations for one Linear contextKey create one task", async () => {
    const contextKey = `task:trackers:linear:RACE-${crypto.randomUUID().slice(0, 8)}`;
    const [a, b] = await Promise.all([
      createTaskExtended("handle the linear issue", { contextKey }),
      createTaskExtended("handle the linear issue (prompted)", { contextKey }),
    ]);

    const rows = await getDbClient().query<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE contextKey = ?",
      [contextKey],
    );
    expect(rows.length).toBe(1);
    // The loser gets the winner's task back, not a second one.
    expect(a.id).toBe(b.id);
  });

  test("bypassTrackerContextDedup still creates a second task", async () => {
    const contextKey = `task:trackers:linear:RACE-${crypto.randomUUID().slice(0, 8)}`;
    const first = await createTaskExtended("first", { contextKey });
    const second = await createTaskExtended("second", {
      contextKey,
      bypassTrackerContextDedup: true,
    });
    expect(second.id).not.toBe(first.id);
  });
});

describe("upsertSwarmConfig global scope", () => {
  test("two concurrent saves of one global key keep a single row", async () => {
    const key = `RACE_CONFIG_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await Promise.all([
      upsertSwarmConfig({ scope: "global", key, value: "first" }),
      upsertSwarmConfig({ scope: "global", key, value: "second" }),
    ]);

    const rows = await getDbClient().query<{ id: string; value: string }>(
      "SELECT id, value FROM swarm_config WHERE scope = 'global' AND scopeId IS NULL AND key = ?",
      [key],
    );
    // A duplicate row is permanent: env injection reads the last one while
    // every later save updates the first.
    expect(rows.length).toBe(1);
  });
});

describe("updateScriptRunIfNotTerminal", () => {
  test("cancel racing the harness's final status: exactly one claims", async () => {
    const { run } = await createScriptRun({
      id: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      source: "test",
      args: null,
    });
    await updateScriptRun(run.id, { status: "running" });

    const finishedAt = new Date().toISOString();
    const [cancelled, completed] = await Promise.all([
      updateScriptRunIfNotTerminal(run.id, { status: "cancelled", pid: null, finishedAt }),
      updateScriptRunIfNotTerminal(run.id, { status: "completed", pid: null, finishedAt }),
    ]);
    expect([cancelled, completed].filter(Boolean).length).toBe(1);

    const after = await getScriptRun(run.id);
    expect(after?.status).toBe(cancelled ? "cancelled" : "completed");
  });

  test("an already-terminal run is not rewritten", async () => {
    const { run } = await createScriptRun({
      id: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      source: "test",
      args: null,
    });
    await updateScriptRun(run.id, { status: "completed" });
    expect(await updateScriptRunIfNotTerminal(run.id, { status: "cancelled" })).toBe(false);
    expect((await getScriptRun(run.id))?.status).toBe("completed");
  });
});

describe("patchWorkflowDefinition", () => {
  const def: WorkflowDefinition = {
    nodes: [
      { id: "a", type: "script", config: {}, next: "b" },
      { id: "b", type: "script", config: {} },
    ],
  };

  test("concurrent patches of two nodes keep both edits", async () => {
    const workflow = await createWorkflow({
      name: `race-patch-${crypto.randomUUID()}`,
      definition: def,
    });

    await Promise.all([
      patchWorkflowDefinition({
        id: workflow.id,
        patch: { update: [{ nodeId: "a", node: { label: "A edited" } }] },
      }),
      patchWorkflowDefinition({
        id: workflow.id,
        patch: { update: [{ nodeId: "b", node: { label: "B edited" } }] },
      }),
    ]);

    const after = await getWorkflow(workflow.id);
    const nodes = after?.definition.nodes ?? [];
    // A blind read-merge-write drops whichever edit committed first.
    expect(nodes.find((n) => n.id === "a")?.label).toBe("A edited");
    expect(nodes.find((n) => n.id === "b")?.label).toBe("B edited");
  });

  test("a patch error leaves the definition untouched", async () => {
    const workflow = await createWorkflow({
      name: `race-patch-invalid-${crypto.randomUUID()}`,
      definition: def,
    });
    const result = await patchWorkflowDefinition({
      id: workflow.id,
      patch: { update: [{ nodeId: "ghost", node: { label: "nope" } }] },
    });
    expect(result.ok).toBe(false);
    const after = await getWorkflow(workflow.id);
    expect(after?.definition.nodes.find((n) => n.id === "a")?.label).toBeUndefined();
  });
});

describe("checkoutPromptTemplate", () => {
  test("two concurrent checkouts take distinct versions", async () => {
    const eventType = `race.checkout.${crypto.randomUUID().slice(0, 8)}`;
    const created = upsertPromptTemplate({ eventType, scope: "global", body: "v1" });
    upsertPromptTemplate({ eventType, scope: "global", body: "v2" });

    await Promise.all([
      checkoutPromptTemplate(created.id, 1),
      checkoutPromptTemplate(created.id, 2),
    ]);

    const history = await getDbClient().query<{ version: number }>(
      "SELECT version FROM prompt_template_history WHERE templateId = ? ORDER BY version",
      [created.id],
    );
    const versions = history.map((row) => row.version);
    // Duplicate versions make a later restore pick an arbitrary body: no
    // UNIQUE(templateId, version) exists to reject them.
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([1, 2, 3, 4]);
  });
});
