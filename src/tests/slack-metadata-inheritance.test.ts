import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb } from "../be/db";
import { slackContextKey } from "../tasks/context-key";

const TEST_DB_PATH = "./test-slack-metadata-inheritance.sqlite";

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
    // ignore if files don't exist
  }
});

/** Helper to set a task to in_progress status (simulates runner picking it up) */
async function setTaskInProgress(taskId: string): Promise<void> {
  await getDbClient().run(
    "UPDATE agent_tasks SET status = 'in_progress', lastUpdatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    [taskId],
  );
}

describe("Slack metadata auto-inheritance via sourceTaskId", () => {
  const lead = { name: "inherit-lead", isLead: true, status: "idle" as const, capabilities: [] };
  const worker = {
    name: "inherit-worker",
    isLead: false,
    status: "idle" as const,
    capabilities: [],
  };

  let leadAgent: Awaited<ReturnType<typeof createAgent>>;
  let workerAgent: Awaited<ReturnType<typeof createAgent>>;

  beforeAll(async () => {
    leadAgent = await createAgent(lead);
    workerAgent = await createAgent(worker);
  });

  test("direct Slack trigger timestamps round trip but never inherit", async () => {
    const parentTask = await createTaskExtended("direct Slack ask", {
      agentId: leadAgent.id,
      source: "slack",
      slackChannelId: "C_TRIGGER_METADATA",
      slackThreadTs: "900.1",
      slackTriggerMessageTs: "900.2",
      slackUserId: "U_TRIGGER",
    });
    const childTask = await createTaskExtended("delegated child", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      parentTaskId: parentTask.id,
      sourceTaskId: parentTask.id,
    });

    expect(parentTask.slackTriggerMessageTs).toBe("900.2");
    expect(
      await getDbClient().get<{ slackTriggerMessageTs: string }>(
        "SELECT slackTriggerMessageTs FROM agent_tasks WHERE id = ?",
        [parentTask.id],
      ),
    ).toEqual({
      slackTriggerMessageTs: "900.2",
    });
    expect(childTask.slackChannelId).toBe("C_TRIGGER_METADATA");
    expect(childTask.slackThreadTs).toBe("900.1");
    expect(childTask.slackTriggerMessageTs).toBeUndefined();
  });

  test("sourceTaskId provided → inherits from that task's Slack metadata", async () => {
    // Lead has an in-progress task with Slack metadata
    const leadTask = await createTaskExtended("lead task with slack", {
      agentId: leadAgent.id,
      slackChannelId: "C_SOURCE",
      slackThreadTs: "1000.0001",
      slackUserId: "U_TARAS",
    });
    await setTaskInProgress(leadTask.id);

    // Create a child task using sourceTaskId
    const childTask = await createTaskExtended("child task", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: leadTask.id,
    });

    expect(childTask.slackChannelId).toBe("C_SOURCE");
    expect(childTask.slackThreadTs).toBe("1000.0001");
    expect(childTask.slackUserId).toBe("U_TARAS");
  });

  test("sourceTaskId picks the correct task even with multiple in-progress tasks", async () => {
    // Lead has TWO in-progress tasks with different Slack metadata
    const taskA = await createTaskExtended("lead task A", {
      agentId: leadAgent.id,
      slackChannelId: "C_TASK_A",
      slackThreadTs: "2000.0001",
      slackUserId: "U_USER_A",
    });
    await setTaskInProgress(taskA.id);

    const taskB = await createTaskExtended("lead task B", {
      agentId: leadAgent.id,
      slackChannelId: "C_TASK_B",
      slackThreadTs: "3000.0001",
      slackUserId: "U_USER_B",
    });
    await setTaskInProgress(taskB.id);

    // sourceTaskId = taskA → should inherit from A, not B (which is more recent)
    const childFromA = await createTaskExtended("child from A", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: taskA.id,
    });

    expect(childFromA.slackChannelId).toBe("C_TASK_A");
    expect(childFromA.slackThreadTs).toBe("2000.0001");
    expect(childFromA.slackUserId).toBe("U_USER_A");
  });

  test("sourceTaskId not provided → no inheritance (no heuristic fallback)", async () => {
    // Create a fresh agent to avoid interference from other tests
    const freshLead = await createAgent({
      name: "fallback-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const leadTask = await createTaskExtended("fallback lead task", {
      agentId: freshLead.id,
      slackChannelId: "C_FALLBACK",
      slackThreadTs: "4000.0001",
      slackUserId: "U_FALLBACK",
    });
    await setTaskInProgress(leadTask.id);

    // No sourceTaskId → no inheritance (adapters must provide sourceTaskId deterministically)
    const childTask = await createTaskExtended("child no sourceTaskId", {
      agentId: workerAgent.id,
      creatorAgentId: freshLead.id,
    });

    expect(childTask.slackChannelId).toBeFalsy();
    expect(childTask.slackThreadTs).toBeFalsy();
    expect(childTask.slackUserId).toBeFalsy();
  });

  test("explicit Slack params take priority over sourceTaskId inheritance", async () => {
    const leadTask = await createTaskExtended("lead explicit test", {
      agentId: leadAgent.id,
      slackChannelId: "C_LEAD_EXPLICIT",
      slackThreadTs: "5000.0001",
      slackUserId: "U_LEAD_EXPLICIT",
    });
    await setTaskInProgress(leadTask.id);

    // Explicit params should override sourceTaskId inheritance
    const childTask = await createTaskExtended("child explicit", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: leadTask.id,
      slackChannelId: "C_EXPLICIT",
      slackThreadTs: "6000.0001",
      slackUserId: "U_EXPLICIT",
    });

    expect(childTask.slackChannelId).toBe("C_EXPLICIT");
    expect(childTask.slackThreadTs).toBe("6000.0001");
    expect(childTask.slackUserId).toBe("U_EXPLICIT");
  });

  test("parentTaskId inheritance takes priority over sourceTaskId", async () => {
    const parentTask = await createTaskExtended("parent task", {
      agentId: workerAgent.id,
      slackChannelId: "C_PARENT",
      slackThreadTs: "7000.0001",
      slackUserId: "U_PARENT",
    });

    const leadTask = await createTaskExtended("lead with different slack", {
      agentId: leadAgent.id,
      slackChannelId: "C_LEAD_DIFFERENT",
      slackThreadTs: "8000.0001",
      slackUserId: "U_LEAD_DIFFERENT",
    });
    await setTaskInProgress(leadTask.id);

    // parentTaskId sets Slack metadata first, so sourceTaskId doesn't override
    const childTask = await createTaskExtended("child with parent", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: leadTask.id,
      parentTaskId: parentTask.id,
    });

    expect(childTask.slackChannelId).toBe("C_PARENT");
    expect(childTask.slackThreadTs).toBe("7000.0001");
    expect(childTask.slackUserId).toBe("U_PARENT");
  });

  test("no in-progress task and no sourceTaskId → no inheritance", async () => {
    const freshLead = await createAgent({
      name: "no-task-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    // No tasks for this agent at all
    const childTask = await createTaskExtended("orphan child", {
      agentId: workerAgent.id,
      creatorAgentId: freshLead.id,
    });

    expect(childTask.slackChannelId).toBeFalsy();
    expect(childTask.slackThreadTs).toBeFalsy();
    expect(childTask.slackUserId).toBeFalsy();
  });

  test("creator task has no Slack metadata → no inheritance", async () => {
    const leadTask = await createTaskExtended("lead task no slack", {
      agentId: leadAgent.id,
      // No Slack metadata on this task
    });
    await setTaskInProgress(leadTask.id);

    const childTask = await createTaskExtended("child no slack inherit", {
      agentId: workerAgent.id,
      creatorAgentId: leadAgent.id,
      sourceTaskId: leadTask.id,
    });

    expect(childTask.slackChannelId).toBeFalsy();
    expect(childTask.slackThreadTs).toBeFalsy();
    expect(childTask.slackUserId).toBeFalsy();
  });

  test("sourceTaskId pointing to non-existent task → no inheritance (no heuristic fallback)", async () => {
    const freshLead = await createAgent({
      name: "nonexist-lead",
      isLead: true,
      status: "idle",
      capabilities: [],
    });

    const leadTask = await createTaskExtended("fallback task for nonexist", {
      agentId: freshLead.id,
      slackChannelId: "C_NONEXIST_FALLBACK",
      slackThreadTs: "9000.0001",
      slackUserId: "U_NONEXIST",
    });
    await setTaskInProgress(leadTask.id);

    const childTask = await createTaskExtended("child with bad sourceTaskId", {
      agentId: workerAgent.id,
      creatorAgentId: freshLead.id,
      sourceTaskId: "00000000-0000-0000-0000-000000000000", // non-existent
    });

    // No fallback — sourceTaskId is the only path, and it points to a non-existent task
    expect(childTask.slackChannelId).toBeFalsy();
    expect(childTask.slackThreadTs).toBeFalsy();
  });
});

describe("Slack-routing coherence guard: createTaskExtended normalization (Phase 3)", () => {
  const lead = {
    name: "routing-norm-lead",
    isLead: true,
    status: "idle" as const,
    capabilities: [],
  };
  const worker = {
    name: "routing-norm-worker",
    isLead: false,
    status: "idle" as const,
    capabilities: [],
  };

  let leadAgent: Awaited<ReturnType<typeof createAgent>>;
  let workerAgent: Awaited<ReturnType<typeof createAgent>>;

  beforeAll(async () => {
    leadAgent = await createAgent(lead);
    workerAgent = await createAgent(worker);
  });

  test("frankenstein-prevention: explicit foreign channel does not pull in the parent's threadTs/userId", async () => {
    const parentTask = await createTaskExtended("parent with slack unit", {
      agentId: leadAgent.id,
      slackChannelId: "C_PARENT",
      slackThreadTs: "1000.0001",
      slackUserId: "U_PARENT",
    });

    const childTask = await createTaskExtended("child with foreign channel", {
      agentId: workerAgent.id,
      parentTaskId: parentTask.id,
      slackChannelId: "C_FOREIGN",
    });

    expect(childTask.slackChannelId).toBe("C_FOREIGN");
    // Parent's threadTs/userId belong to a DIFFERENT channel — must not inherit.
    expect(childTask.slackThreadTs).toBeFalsy();
    expect(childTask.slackUserId).toBeFalsy();
  });

  test("matching explicit channel still fills in threadTs/userId from the parent (per-field, unaffected)", async () => {
    const parentTask = await createTaskExtended("parent with slack unit b", {
      agentId: leadAgent.id,
      slackChannelId: "C_MATCH",
      slackThreadTs: "2000.0001",
      slackUserId: "U_MATCH",
    });

    const childTask = await createTaskExtended("child with matching channel", {
      agentId: workerAgent.id,
      parentTaskId: parentTask.id,
      slackChannelId: "C_MATCH",
    });

    expect(childTask.slackChannelId).toBe("C_MATCH");
    expect(childTask.slackThreadTs).toBe("2000.0001");
    expect(childTask.slackUserId).toBe("U_MATCH");
  });

  test("contextKey backfill: slack-family contextKey with no Slack fields populates slackChannelId/slackThreadTs", async () => {
    const contextKey = slackContextKey({ channelId: "C_BACKFILL", threadTs: "3000.0001" });

    const childTask = await createTaskExtended("child from contextKey only", {
      agentId: workerAgent.id,
      contextKey,
    });

    expect(childTask.slackChannelId).toBe("C_BACKFILL");
    expect(childTask.slackThreadTs).toBe("3000.0001");
    // Backfill deliberately does not populate slackUserId — the key doesn't encode it.
    expect(childTask.slackUserId).toBeFalsy();
  });

  test("contextKey backfill does not override an explicit slackChannelId that agrees with it", async () => {
    const contextKey = slackContextKey({ channelId: "C_KEY", threadTs: "4000.0001" });

    const childTask = await createTaskExtended("child with explicit channel matching the key", {
      agentId: workerAgent.id,
      contextKey,
      slackChannelId: "C_KEY",
      slackThreadTs: "4000.0001",
    });

    expect(childTask.slackChannelId).toBe("C_KEY");
    expect(childTask.slackThreadTs).toBe("4000.0001");
  });

  test("overrideSlackContext: true retains a deliberately divergent explicit slackChannelId against the contextKey", async () => {
    const contextKey = slackContextKey({ channelId: "C_KEY", threadTs: "4000.0001" });

    const childTask = await createTaskExtended(
      "child with explicit channel and different key, override set",
      {
        agentId: workerAgent.id,
        contextKey,
        slackChannelId: "C_EXPLICIT_OVERRIDE",
        slackThreadTs: "5000.0001",
        overrideSlackContext: true,
      },
    );

    expect(childTask.slackChannelId).toBe("C_EXPLICIT_OVERRIDE");
    expect(childTask.slackThreadTs).toBe("5000.0001");
  });

  test("residual-mismatch guard: normalizes slackChannelId (and slackThreadTs) to the contextKey when it disagrees, without throwing", async () => {
    const contextKey = slackContextKey({ channelId: "C_KEY_MISMATCH", threadTs: "6000.0001" });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const childTask = await createTaskExtended("child with mismatched channel and key", {
      agentId: workerAgent.id,
      contextKey,
      slackChannelId: "C_DIFFERENT",
      slackThreadTs: "7000.0001",
    });

    // The durable contextKey wins — a non-override caller cannot persist a
    // channel mismatch (delivery reads slackChannelId/slackThreadTs directly).
    expect(childTask?.slackChannelId).toBe("C_KEY_MISMATCH");
    expect(childTask?.slackThreadTs).toBe("6000.0001");
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes("[slack-routing] MISMATCH"),
    );
    expect(warned).toBe(true);

    warnSpy.mockRestore();
  });

  test("residual-mismatch guard: overrideSlackContext: true keeps a divergent channel against the contextKey", async () => {
    const contextKey = slackContextKey({
      channelId: "C_KEY_MISMATCH_OVERRIDE",
      threadTs: "6100.0001",
    });

    const childTask = await createTaskExtended(
      "child with mismatched channel and key, override set",
      {
        agentId: workerAgent.id,
        contextKey,
        slackChannelId: "C_DIFFERENT_OVERRIDE",
        slackThreadTs: "7100.0001",
        overrideSlackContext: true,
      },
    );

    expect(childTask.slackChannelId).toBe("C_DIFFERENT_OVERRIDE");
    expect(childTask.slackThreadTs).toBe("7100.0001");
  });

  test("channel matches contextKey + missing thread → thread gets backfilled from contextKey", async () => {
    const contextKey = slackContextKey({ channelId: "C_THREAD_BACKFILL", threadTs: "8000.0001" });

    const childTask = await createTaskExtended("child with matching channel but no thread", {
      agentId: workerAgent.id,
      contextKey,
      slackChannelId: "C_THREAD_BACKFILL",
    });

    expect(childTask.slackChannelId).toBe("C_THREAD_BACKFILL");
    expect(childTask.slackThreadTs).toBe("8000.0001");
  });

  test("channel matches + explicit thread diverges from contextKey → normalized to the contextKey's thread, no throw", async () => {
    const contextKey = slackContextKey({ channelId: "C_THREAD_DIVERGE", threadTs: "9000.0001" });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const childTask = await createTaskExtended("child with matching channel but diverging thread", {
      agentId: workerAgent.id,
      contextKey,
      slackChannelId: "C_THREAD_DIVERGE",
      slackThreadTs: "9999.9999",
    });

    // A non-override caller cannot persist a thread mismatch either — the
    // contextKey's thread wins.
    expect(childTask?.slackChannelId).toBe("C_THREAD_DIVERGE");
    expect(childTask?.slackThreadTs).toBe("9000.0001");
    const warned = warnSpy.mock.calls.some((call) =>
      String(call[0]).includes("[slack-routing] MISMATCH"),
    );
    expect(warned).toBe(true);

    warnSpy.mockRestore();
  });

  test("channel matches + explicit thread diverges, overrideSlackContext: true → explicit thread retained", async () => {
    const contextKey = slackContextKey({
      channelId: "C_THREAD_DIVERGE_OVERRIDE",
      threadTs: "9200.0001",
    });

    const childTask = await createTaskExtended(
      "child with matching channel but diverging thread, override set",
      {
        agentId: workerAgent.id,
        contextKey,
        slackChannelId: "C_THREAD_DIVERGE_OVERRIDE",
        slackThreadTs: "9999.0002",
        overrideSlackContext: true,
      },
    );

    expect(childTask.slackChannelId).toBe("C_THREAD_DIVERGE_OVERRIDE");
    expect(childTask.slackThreadTs).toBe("9999.0002");
  });

  test("parentTaskId inheritance + explicit contextKey mismatch → normalized to the contextKey, not the parent (non-override callers cannot persist route/contextKey divergence)", async () => {
    const parentTask = await createTaskExtended("parent with slack channel A", {
      agentId: leadAgent.id,
      slackChannelId: "C_INHERIT_MISMATCH_PARENT",
      slackThreadTs: "10000.0001",
    });

    const contextKeyB = slackContextKey({
      channelId: "C_INHERIT_MISMATCH_KEY",
      threadTs: "20000.0002",
    });
    const childTask = await createTaskExtended(
      "child inheriting the parent's Slack unit but carrying a different contextKey",
      {
        agentId: workerAgent.id,
        parentTaskId: parentTask.id,
        contextKey: contextKeyB,
      },
    );

    // This is exactly the POST /api/tasks shape (client-supplied parentTaskId
    // + contextKey): the parent-inherited Slack unit must not silently win
    // over the durable contextKey.
    expect(childTask.slackChannelId).toBe("C_INHERIT_MISMATCH_KEY");
    expect(childTask.slackThreadTs).toBe("20000.0002");
  });

  test("parentTaskId inheritance + contextKey mismatch, overrideSlackContext: true → parent-inherited Slack unit retained", async () => {
    const parentTask = await createTaskExtended("parent with slack channel A (override case)", {
      agentId: leadAgent.id,
      slackChannelId: "C_OVERRIDE_INHERIT_PARENT",
      slackThreadTs: "30000.0003",
    });

    const contextKeyB = slackContextKey({
      channelId: "C_OVERRIDE_INHERIT_KEY",
      threadTs: "40000.0004",
    });
    const childTask = await createTaskExtended("child with deliberate override", {
      agentId: workerAgent.id,
      parentTaskId: parentTask.id,
      contextKey: contextKeyB,
      overrideSlackContext: true,
    });

    expect(childTask.slackChannelId).toBe("C_OVERRIDE_INHERIT_PARENT");
    expect(childTask.slackThreadTs).toBe("30000.0003");
  });

  test("non-slack contextKey → no backfill, no telemetry", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const childTask = await createTaskExtended("child with linear contextKey", {
      agentId: workerAgent.id,
      contextKey: "task:trackers:linear:DES-99",
    });

    expect(childTask.slackChannelId).toBeFalsy();
    expect(childTask.slackThreadTs).toBeFalsy();
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
