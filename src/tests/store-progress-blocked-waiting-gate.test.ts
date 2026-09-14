/**
 * Regression coverage for the `store-progress` blocked-waiting nudge gate
 * (src/tools/store-progress.ts). Two swarm-review findings on PR #1472:
 *
 * 1. The terminal gate only checked `existingTask.status` (the state BEFORE
 *    this call), never the incoming `status` argument. A completing call
 *    (`status: "completed"`) whose progress text happened to match the
 *    blocked-waiting pattern (e.g. "awaiting review") still set
 *    `blockedWaitingElapsedMs`, nudging the agent to `defer-task` on the very
 *    turn it finished.
 * 2. `blockedWaitingElapsedMs` had no floor, so two check-ins seconds apart
 *    could fire "under a minute since your last update — call defer-task",
 *    which buys nothing over just checking in again shortly.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb, startTask } from "../be/db";
import { registerStoreProgressTool } from "../tools/store-progress";

const TEST_DB_PATH = "./test-store-progress-blocked-waiting-gate.sqlite";

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

type StoreProgressResult = {
  structuredContent: {
    success: boolean;
    blockedWaitingElapsedMs?: number;
  };
};

function buildServer() {
  const server = new McpServer({
    name: "store-progress-blocked-waiting-gate-test",
    version: "1.0.0",
  });
  registerStoreProgressTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["store-progress"];
  if (!tool) throw new Error("store-progress tool not registered");
  return tool;
}

describe("store-progress handler — blocked-waiting nudge gate", () => {
  let agentId: string;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    const agent = await createAgent({
      name: "Blocked Waiting Gate Worker",
      description: "Agent for blocked-waiting gate regression tests",
      role: "worker",
      isLead: false,
      status: "busy",
      maxTasks: 1,
      capabilities: [],
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  function buildMeta() {
    return { requestInfo: { headers: { "x-agent-id": agentId } } };
  }

  async function ageLastUpdate(taskId: string, msAgo: number) {
    await getDbClient().run("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?", [
      new Date(Date.now() - msAgo).toISOString(),
      taskId,
    ]);
  }

  test("a completing call with blocked-waiting-shaped text does not nudge", async () => {
    const task = await createTaskExtended("completing call with awaiting text", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    await startTask(task.id);
    // Old enough that, absent the fix, this would clear the elapsed-time floor.
    await ageLastUpdate(task.id, 10 * 60_000);

    const tool = buildServer();
    const result = (await tool.handler(
      {
        taskId: task.id,
        status: "completed",
        output: "done",
        progress: "awaiting review",
      },
      buildMeta(),
    )) as StoreProgressResult;

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.blockedWaitingElapsedMs).toBeUndefined();
  });

  test("elapsed time below the 3-minute floor does not nudge", async () => {
    const task = await createTaskExtended("progress call under the floor", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    await startTask(task.id);
    await ageLastUpdate(task.id, 30_000);

    const tool = buildServer();
    const result = (await tool.handler(
      { taskId: task.id, progress: "still waiting on the API team" },
      buildMeta(),
    )) as StoreProgressResult;

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.blockedWaitingElapsedMs).toBeUndefined();
  });

  test("a non-terminal call past the floor with matching text still nudges (baseline)", async () => {
    const task = await createTaskExtended("progress call past the floor", {
      agentId,
      source: "mcp",
      priority: 50,
    });
    await startTask(task.id);
    await ageLastUpdate(task.id, 5 * 60_000);

    const tool = buildServer();
    const result = (await tool.handler(
      { taskId: task.id, progress: "still waiting on the API team" },
      buildMeta(),
    )) as StoreProgressResult;

    expect(result.structuredContent.success).toBe(true);
    expect(result.structuredContent.blockedWaitingElapsedMs).toBeGreaterThanOrEqual(3 * 60_000);
  });
});
