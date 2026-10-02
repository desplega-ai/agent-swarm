/**
 * API drain, server side: the process-local state, the bounded wait for worker
 * handoffs, and the rule that a draining API dispatches no new work through any
 * of the three paths that start or claim a task (HTTP poll, MCP poll-task, MCP
 * task-action claim and accept).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  beginApiDrain,
  countStillInProgress,
  DEFAULT_API_DRAIN_MAX_MS,
  drainApi,
  isApiDraining,
  listLiveInFlightTaskIds,
  resetApiDrainForTesting,
  resolveApiDrainMaxMs,
} from "../be/api-drain";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  startTask,
} from "../be/db";
import { validateConfigValue } from "../be/swarm-config-guard";
import { handlePoll } from "../http/poll";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerPollTaskTool } from "../tools/poll-task";
import { registerTaskActionTool } from "../tools/task-action";
import { API_DRAIN_MAX_MS_LIMIT } from "../utils/api-drain";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-api-drain.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}

class MockMcpServer {
  handlers = new Map<string, (args: unknown, extra: unknown) => Promise<unknown>>();
  registerTool(
    name: string,
    _config: unknown,
    handler: (args: unknown, extra: unknown) => Promise<unknown>,
  ) {
    this.handlers.set(name, handler);
    return { name };
  }
}

let server: Server;
let baseUrl = "";
const mcp = new MockMcpServer();

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  registerPollTaskTool(mcp as unknown as Parameters<typeof registerPollTaskTool>[0]);
  registerTaskActionTool(mcp as unknown as Parameters<typeof registerTaskActionTool>[0]);
  server = createHttpServer(async (req, res) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    const handled = await handlePoll(
      req,
      res,
      getPathSegments(req.url || ""),
      parseQueryParams(req.url || ""),
      myAgentId,
    );
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles();
});

afterEach(() => {
  resetApiDrainForTesting();
});

async function makeAgent(opts: { isLead?: boolean; lastUpdatedAt?: string; status?: string } = {}) {
  const id = crypto.randomUUID();
  await createAgent({
    id,
    name: "drain-test-agent",
    isLead: opts.isLead ?? false,
    status: "idle",
    capabilities: [],
    maxTasks: 1,
  });
  if (opts.lastUpdatedAt || opts.status) {
    await getDbClient().run(
      "UPDATE agents SET lastUpdatedAt = COALESCE(?, lastUpdatedAt), status = COALESCE(?, status) WHERE id = ?",
      [opts.lastUpdatedAt ?? null, opts.status ?? null, id],
    );
  }
  return id;
}

async function poll(agentId: string) {
  const res = await fetch(`${baseUrl}/api/poll`, { headers: { "X-Agent-ID": agentId } });
  return (await res.json()) as { trigger: { type: string; taskId?: string } | null };
}

async function callTool(name: string, args: unknown, agentId: string) {
  const handler = mcp.handlers.get(name);
  if (!handler) throw new Error(`${name} not registered`);
  return (await handler(args, {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": agentId } },
    sendNotification: async () => {},
  })) as { isError?: boolean; content?: Array<{ text?: string }> };
}

describe("drain state", () => {
  test("starts not draining; begin is idempotent; reset clears it", () => {
    expect(isApiDraining()).toBe(false);
    expect(beginApiDrain()).toBe(true);
    expect(isApiDraining()).toBe(true);
    expect(beginApiDrain()).toBe(false);
    resetApiDrainForTesting();
    expect(isApiDraining()).toBe(false);
  });

  test("API_DRAIN_MAX_MS: default when unset or invalid, 0 disables", () => {
    expect(resolveApiDrainMaxMs({})).toBe(DEFAULT_API_DRAIN_MAX_MS);
    expect(resolveApiDrainMaxMs({ API_DRAIN_MAX_MS: "" })).toBe(DEFAULT_API_DRAIN_MAX_MS);
    expect(resolveApiDrainMaxMs({ API_DRAIN_MAX_MS: "abc" })).toBe(DEFAULT_API_DRAIN_MAX_MS);
    expect(resolveApiDrainMaxMs({ API_DRAIN_MAX_MS: "-5" })).toBe(DEFAULT_API_DRAIN_MAX_MS);
    expect(resolveApiDrainMaxMs({ API_DRAIN_MAX_MS: "0" })).toBe(0);
    expect(resolveApiDrainMaxMs({ API_DRAIN_MAX_MS: "5000" })).toBe(5000);
  });
});

describe("API_DRAIN_MAX_MS config", () => {
  test("the validator and the resolver share one range", () => {
    expect(validateConfigValue("API_DRAIN_MAX_MS", "0")).toBeNull();
    expect(validateConfigValue("API_DRAIN_MAX_MS", "30000")).toBeNull();
    expect(validateConfigValue("API_DRAIN_MAX_MS", String(API_DRAIN_MAX_MS_LIMIT))).toBeNull();
    expect(validateConfigValue("API_DRAIN_MAX_MS", String(API_DRAIN_MAX_MS_LIMIT + 1))).toContain(
      `between 0 and ${API_DRAIN_MAX_MS_LIMIT}`,
    );
    expect(validateConfigValue("API_DRAIN_MAX_MS", "-1")).not.toBeNull();
    expect(validateConfigValue("API_DRAIN_MAX_MS", "soon")).not.toBeNull();
    // A value past the limit would be clamped at shutdown, never silently honored.
    expect(resolveApiDrainMaxMs({ API_DRAIN_MAX_MS: "9999999" })).toBe(API_DRAIN_MAX_MS_LIMIT);
  });
});

describe("drainApi", () => {
  /** A fake clock: sleeping advances it, so the wait is deterministic. */
  function fakeClock() {
    let t = 1_000;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  test("disabled: does not enter the draining state and reads nothing", async () => {
    let reads = 0;
    const outcome = await drainApi({
      env: { API_DRAIN_MAX_MS: "0" },
      log: () => {},
      listInFlight: async () => {
        reads++;
        return [];
      },
    });
    expect(outcome.enabled).toBe(false);
    expect(isApiDraining()).toBe(false);
    expect(reads).toBe(0);
  });

  test("no in-flight tasks: drains at once without waiting", async () => {
    const clock = fakeClock();
    const outcome = await drainApi({
      ...clock,
      env: {},
      log: () => {},
      listInFlight: async () => [],
    });
    expect(isApiDraining()).toBe(true);
    expect(outcome).toMatchObject({ enabled: true, inFlight: 0, remaining: 0, timedOut: false });
    expect(clock.now()).toBe(1_000);
  });

  test("returns as soon as every in-flight task is handed off", async () => {
    const clock = fakeClock();
    const remainingByRead = [2, 1, 0];
    let reads = 0;
    const outcome = await drainApi({
      ...clock,
      env: { API_DRAIN_MAX_MS: "30000" },
      log: () => {},
      listInFlight: async () => ["a", "b"],
      countRemaining: async () => remainingByRead[reads++] ?? 0,
    });
    expect(outcome).toMatchObject({ inFlight: 2, remaining: 0, timedOut: false });
    expect(outcome.waitedMs).toBe(1_000);
    expect(isApiDraining()).toBe(true);
  });

  test("gives up at the cap and reports what was left", async () => {
    const clock = fakeClock();
    const outcome = await drainApi({
      ...clock,
      env: { API_DRAIN_MAX_MS: "3000" },
      log: () => {},
      listInFlight: async () => ["a", "b"],
      countRemaining: async () => 1,
    });
    expect(outcome).toMatchObject({ inFlight: 2, remaining: 1, timedOut: true });
    expect(outcome.waitedMs).toBe(3_000);
  });

  test("a failing read ends the wait instead of blocking shutdown", async () => {
    const lines: string[] = [];
    const clock = fakeClock();
    const outcome = await drainApi({
      ...clock,
      env: {},
      log: (line) => lines.push(line),
      listInFlight: async () => {
        throw new Error("database is locked");
      },
    });
    expect(outcome).toMatchObject({ enabled: true, inFlight: 0, timedOut: false });
    expect(lines.join("\n")).toContain("database is locked");
  });
});

describe("in-flight reads", () => {
  test("only in_progress tasks held by a worker that pinged recently count", async () => {
    const live = await makeAgent();
    const silent = await makeAgent({
      lastUpdatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    const offline = await makeAgent({ status: "offline" });
    const idleLive = await makeAgent();

    const liveTask = await createTaskExtended("live", { agentId: live });
    const silentTask = await createTaskExtended("silent", { agentId: silent });
    const offlineTask = await createTaskExtended("offline", { agentId: offline });
    const pendingTask = await createTaskExtended("pending", { agentId: idleLive });
    for (const task of [liveTask, silentTask, offlineTask]) await startTask(task.id);

    const ids = await listLiveInFlightTaskIds();
    expect(ids).toContain(liveTask.id);
    expect(ids).not.toContain(silentTask.id);
    expect(ids).not.toContain(offlineTask.id);
    expect(ids).not.toContain(pendingTask.id);
  });

  test("countStillInProgress drops a task once it leaves in_progress", async () => {
    const agent = await makeAgent();
    const task = await createTaskExtended("to-hand-off", { agentId: agent });
    await startTask(task.id);
    expect(await countStillInProgress([task.id])).toBe(1);
    expect(await countStillInProgress([])).toBe(0);
    await getDbClient().run("UPDATE agent_tasks SET status = 'superseded' WHERE id = ?", [task.id]);
    expect(await countStillInProgress([task.id])).toBe(0);
  });
});

describe("a draining API dispatches nothing", () => {
  test("HTTP poll starts no assigned task, then does once the drain ends", async () => {
    const agent = await makeAgent();
    const task = await createTaskExtended("assigned", { agentId: agent });
    beginApiDrain();

    expect((await poll(agent)).trigger).toBeNull();
    expect((await getTaskById(task.id))?.status).toBe("pending");

    resetApiDrainForTesting();
    const after = await poll(agent);
    expect(after.trigger?.type).toBe("task_assigned");
    expect(after.trigger?.taskId).toBe(task.id);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("HTTP poll claims no pool task while draining", async () => {
    const agent = await makeAgent();
    const task = await createTaskExtended("pool task");
    beginApiDrain();
    expect((await poll(agent)).trigger).toBeNull();
    expect((await getTaskById(task.id))?.agentId ?? null).toBeNull();
  });

  test("a poll still answers 404 for an unknown agent while draining", async () => {
    beginApiDrain();
    const res = await fetch(`${baseUrl}/api/poll`, {
      headers: { "X-Agent-ID": crypto.randomUUID() },
    });
    expect(res.status).toBe(404);
  });

  test("MCP poll-task starts no pending task while draining", async () => {
    const agent = await makeAgent();
    const task = await createTaskExtended("mcp-assigned", { agentId: agent });
    beginApiDrain();

    const result = await callTool("poll-task", {}, agent);
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).toContain("draining");
    expect((await getTaskById(task.id))?.status).toBe("pending");
  });

  test("MCP task-action claim is refused while draining", async () => {
    const agent = await makeAgent();
    const task = await createTaskExtended("mcp-pool");
    beginApiDrain();

    const result = await callTool("task-action", { action: "claim", taskId: task.id }, agent);
    expect(JSON.stringify(result)).toContain("draining");
    expect((await getTaskById(task.id))?.agentId ?? null).toBeNull();

    resetApiDrainForTesting();
    await callTool("task-action", { action: "claim", taskId: task.id }, agent);
    expect((await getTaskById(task.id))?.agentId).toBe(agent);
  });

  test("MCP task-action accept is refused while draining", async () => {
    const agent = await makeAgent();
    const task = await createTaskExtended("offered", { offeredTo: agent });
    beginApiDrain();

    const result = await callTool("task-action", { action: "accept", taskId: task.id }, agent);
    expect(JSON.stringify(result)).toContain("draining");
    expect((await getTaskById(task.id))?.status).toBe("offered");
  });
});
