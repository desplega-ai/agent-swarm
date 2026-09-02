import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createTaskExtended, initDb } from "../be/db";
import { buildAskClosure, closureState } from "../slack/closure";

const TEST_DB_PATH = "./test-slack-closure.sqlite";

async function removeDbFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
}

beforeEach(async () => {
  closeDb();
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
});

describe("buildAskClosure", () => {
  test("walks a 3-level chain including a superseded -> resume link, and excludes a second ask's own subtree", async () => {
    const lead = await createAgent({ name: "Closure Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Closure Worker", isLead: false, status: "idle" });
    const ask = await createTaskExtended("root ask", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C_CLOSURE",
      slackThreadTs: "1.1",
    });
    const child = await createTaskExtended("child work", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const supersededChild = await createTaskExtended("grandchild work", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: child.id,
      followUpConfig: { disabled: true },
    });
    const resumeChild = await createTaskExtended("resume of grandchild work", {
      agentId: worker.id,
      source: "mcp",
      taskType: "resume",
      parentTaskId: supersededChild.id,
      followUpConfig: { disabled: true },
    });
    const secondAsk = await createTaskExtended("second ask", {
      agentId: lead.id,
      source: "slack",
      parentTaskId: resumeChild.id,
      slackChannelId: "C_CLOSURE",
      slackThreadTs: "1.1",
    });
    const secondAskChild = await createTaskExtended("second ask's own child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: secondAsk.id,
      followUpConfig: { disabled: true },
    });

    const threadTasks = [ask, child, supersededChild, resumeChild, secondAsk, secondAskChild].map(
      (task) =>
        task.id === supersededChild.id ? { ...task, status: "superseded" as const } : task,
    );

    const closure = buildAskClosure(ask, threadTasks);
    expect(closure.map((task) => task.id).sort()).toEqual(
      [child.id, supersededChild.id, resumeChild.id].sort(),
    );
    expect(closure.some((task) => task.id === secondAsk.id)).toBe(false);
    expect(closure.some((task) => task.id === secondAskChild.id)).toBe(false);
  });

  test("returns an empty closure for an ask with no descendants", async () => {
    const lead = await createAgent({ name: "Lonely Lead", isLead: true, status: "idle" });
    const ask = await createTaskExtended("solo ask", { agentId: lead.id, source: "slack" });
    expect(buildAskClosure(ask, [ask])).toEqual([]);
  });
});

describe("closureState", () => {
  const settleSec = 10;
  const timeoutMin = 240;

  test("is open while a member is non-terminal and within the timeout window", async () => {
    const lead = await createAgent({ name: "Open Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Open Worker", isLead: false, status: "idle" });
    const ask = await createTaskExtended("open ask", { agentId: lead.id, source: "slack" });
    const child = await createTaskExtended("open child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const now = new Date();
    const state = closureState(
      { ...ask, status: "completed", lastUpdatedAt: now.toISOString() },
      [{ ...child, status: "in_progress", lastUpdatedAt: now.toISOString() }],
      now,
      settleSec,
      timeoutMin,
    );
    expect(state).toBe("open");
  });

  test("is settled once every member is terminal and quiet past the settle window", async () => {
    const lead = await createAgent({ name: "Settled Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Settled Worker", isLead: false, status: "idle" });
    const ask = await createTaskExtended("settled ask", { agentId: lead.id, source: "slack" });
    const child = await createTaskExtended("settled child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const now = new Date();
    const quiet = new Date(now.getTime() - (settleSec + 5) * 1_000).toISOString();
    const state = closureState(
      { ...ask, status: "completed", lastUpdatedAt: quiet },
      [{ ...child, status: "completed", lastUpdatedAt: quiet }],
      now,
      settleSec,
      timeoutMin,
    );
    expect(state).toBe("settled");
  });

  test("stays open when every member is terminal but still inside the settle window", async () => {
    const lead = await createAgent({ name: "Quiet Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Quiet Worker", isLead: false, status: "idle" });
    const ask = await createTaskExtended("just-finished ask", {
      agentId: lead.id,
      source: "slack",
    });
    const child = await createTaskExtended("just-finished child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const now = new Date();
    const justNow = new Date(now.getTime() - 2_000).toISOString();
    const state = closureState(
      { ...ask, status: "completed", lastUpdatedAt: justNow },
      [{ ...child, status: "completed", lastUpdatedAt: justNow }],
      now,
      settleSec,
      timeoutMin,
    );
    expect(state).toBe("open");
  });

  test("is timedOut when a member stays non-terminal past the timeout window", async () => {
    const lead = await createAgent({ name: "Timeout Lead", isLead: true, status: "idle" });
    const worker = await createAgent({ name: "Timeout Worker", isLead: false, status: "idle" });
    const ask = await createTaskExtended("timed out ask", { agentId: lead.id, source: "slack" });
    const child = await createTaskExtended("timed out child", {
      agentId: worker.id,
      source: "mcp",
      parentTaskId: ask.id,
      followUpConfig: { disabled: true },
    });
    const now = new Date();
    const stale = new Date(now.getTime() - (timeoutMin + 5) * 60_000).toISOString();
    const state = closureState(
      { ...ask, status: "completed", lastUpdatedAt: stale },
      [{ ...child, status: "in_progress", lastUpdatedAt: stale }],
      now,
      settleSec,
      timeoutMin,
    );
    expect(state).toBe("timedOut");
  });
});
