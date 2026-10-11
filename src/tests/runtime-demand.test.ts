import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  claimMentions,
  closeDb,
  completeTask,
  createAgent,
  createChannel,
  createTaskExtended,
  getDbClient,
  initDb,
  postMessage,
} from "../be/db";
import { type AgentDemand, computeDesired, pendingWorkForAgent } from "../be/runtime-pools/demand";

const dbPath = "./test-runtime-demand.sqlite";
beforeAll(() => {
  initDb(dbPath);
});
afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(dbPath + suffix)
      .delete()
      .catch(() => {});
});
beforeEach(async () => {
  for (const table of [
    "channel_read_state",
    "channel_messages",
    "channels",
    "agent_tasks",
    "agents",
  ])
    await getDbClient().run(`DELETE FROM ${table}`);
});

async function agent() {
  return await createAgent({
    name: "demand",
    isLead: true,
    status: "offline",
    capabilities: [],
    maxTasks: 8,
  });
}

test("pending demand includes only ready dependencies, offers, and unclaimed mention channels", async () => {
  const lead = await agent();
  const dependency = await createTaskExtended("dependency", { agentId: lead.id });
  const blocked = await createTaskExtended("blocked", {
    agentId: lead.id,
    dependsOn: [dependency.id],
    priority: 100,
  });
  await createTaskExtended("offer", { offeredTo: lead.id });
  const channel = await createChannel("mentions");
  await postMessage(channel.id, null, "hello", { mentions: [lead.id] });
  await postMessage(channel.id, null, "hello again", { mentions: [lead.id] });
  expect((await pendingWorkForAgent(lead.id)).work).toBe(3);
  await claimMentions(lead.id);
  expect((await pendingWorkForAgent(lead.id)).work).toBe(2);
  await completeTask(dependency.id, "done");
  const pending = await pendingWorkForAgent(lead.id);
  expect(pending.work).toBe(2);
  expect(pending.topTask?.id).toBe(blocked.id);
});

test("read mentions do not create demand", async () => {
  const lead = await agent();
  const channel = await createChannel("read");
  await postMessage(channel.id, null, "read", { mentions: [lead.id] });
  await getDbClient().run(
    "INSERT INTO channel_read_state (agentId, channelId, lastReadAt) VALUES (?, ?, ?)",
    [lead.id, channel.id, new Date(Date.now() + 1000).toISOString()],
  );
  expect(await pendingWorkForAgent(lead.id)).toEqual({ work: 0, topTask: null });
});

describe("computeDesired", () => {
  const pool = { slotsPerRuntime: 2, minRuntimes: 0, maxRuntimes: null };
  const base: AgentDemand = {
    agentId: "a",
    maxTasks: 8,
    work: 0,
    current: 0,
    freeSlots: 0,
    provisioning: 0,
  };
  for (const [name, input, expected] of [
    ["empty", {}, 0],
    ["ceil uncovered slots", { work: 3 }, 2],
    ["live free capacity", { current: 1, freeSlots: 2, work: 2 }, 1],
    ["busy runtime plus demand", { current: 1, work: 3 }, 3],
    ["provisioning reserves work", { current: 1, provisioning: 1, work: 2 }, 1],
    ["logical capacity rounds down", { maxTasks: 3, work: 9 }, 1],
    ["too few logical slots", { maxTasks: 1, work: 9 }, 0],
  ] as const) {
    test(name, () => {
      expect(computeDesired(pool, [{ ...base, ...input }]).get("a")).toBe(expected);
    });
  }
  test("warm floor respects logical capacity", () => {
    expect(computeDesired({ ...pool, minRuntimes: 2 }, [base]).get("a")).toBe(2);
    expect(computeDesired({ ...pool, minRuntimes: 2 }, [{ ...base, maxTasks: 3 }]).get("a")).toBe(
      1,
    );
  });
  test("pool cap reserves existing runtimes across agents", () => {
    const agents = [
      { ...base, work: 6 },
      { ...base, agentId: "b", current: 1, freeSlots: 2 },
    ];
    expect([...computeDesired({ ...pool, maxRuntimes: 2 }, agents)]).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect([...computeDesired({ ...pool, maxRuntimes: 0 }, [base])]).toEqual([["a", 0]]);
  });
});
