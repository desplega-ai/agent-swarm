import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  closeDb,
  createAgent,
  createSteeringMessage,
  createTaskExtended,
  createUser,
  getChildTasks,
  getSteeringMessagesForTask,
  initDb,
  startTask,
} from "../be/db";
import { requestSteering, SteeringRequestError } from "../be/steering";
import { createSteeringDispatchState, pollAndDispatchSteering } from "../commands/runner";
import { handleCore } from "../http/core";
import { handleStats } from "../http/stats";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { createServer } from "../server";
import { createUserServer } from "../server-user";
import { requestSlackThreadSteering } from "../slack/steering";
import { bufferThreadMessage, instantFlush } from "../slack/thread-buffer";
import type { ProviderName } from "../types";
import { isSteeringEnabled } from "../utils/steering-enabled";

const TEST_DB_PATH = `/tmp/agent-swarm-steering-disable-${process.pid}.sqlite`;
const originalDatabasePath = process.env.DATABASE_PATH;
let server: Server;
let baseUrl: string;

type RegisteredTools = Record<string, unknown>;

function registeredTools(server: McpServer): RegisteredTools {
  return (server as unknown as { _registeredTools: RegisteredTools })._registeredTools;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * Steering is opt-in (disabled unless STEERING_ENABLED=true|1), so "disabled"
 * is simply the default: unset the flag for the duration of the callback.
 */
async function withSteeringDisabled<T>(run: () => Promise<T> | T): Promise<T> {
  const previous = process.env.STEERING_ENABLED;
  delete process.env.STEERING_ENABLED;
  try {
    return await run();
  } finally {
    restoreEnv("STEERING_ENABLED", previous);
  }
}

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // SQLite only creates sidecars after a write.
    }
  }
}

function createRunningTask(
  label: string,
  provider: ProviderName = "pi",
  slackContext?: { channelId: string; threadTs: string },
) {
  const agent = createAgent({
    name: `${label} agent`,
    isLead: true,
    status: "busy",
    maxTasks: 10,
    harnessProvider: provider,
  });
  const task = createTaskExtended(label, {
    agentId: agent.id,
    source: slackContext ? "slack" : "api",
    slackChannelId: slackContext?.channelId,
    slackThreadTs: slackContext?.threadTs,
  });
  expect(startTask(task.id)?.status).toBe("in_progress");
  return { agent, task };
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  agentId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  };
  if (agentId) headers["X-Agent-ID"] = agentId;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

const originalSteeringEnabled = process.env.STEERING_ENABLED;

beforeAll(async () => {
  // The "enabled" halves of these tests opt in explicitly (steering is off by
  // default); withSteeringDisabled() drops the flag to exercise the default.
  process.env.STEERING_ENABLED = "true";
  await removeTestDb();
  process.env.DATABASE_PATH = TEST_DB_PATH;
  initDb(TEST_DB_PATH);
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    const agentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, agentId, "test-key")) return;
    const pathSegments = getPathSegments(req.url ?? "");
    const queryParams = parseQueryParams(req.url ?? "");
    if (await handleStats(req, res, pathSegments, queryParams, agentId)) return;
    if (await handleTasks(req, res, pathSegments, queryParams, agentId)) return;
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  restoreEnv("STEERING_ENABLED", originalSteeringEnabled);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  restoreEnv("DATABASE_PATH", originalDatabasePath);
  await removeTestDb();
});

describe("STEERING_ENABLED opt-in", () => {
  test("steering is disabled by default (flag unset) and on falsy values", () => {
    expect(isSteeringEnabled({})).toBe(false);
    expect(isSteeringEnabled({ STEERING_ENABLED: "false" })).toBe(false);
    expect(isSteeringEnabled({ STEERING_ENABLED: "0" })).toBe(false);
    expect(isSteeringEnabled({ STEERING_ENABLED: "true" })).toBe(true);
    expect(isSteeringEnabled({ STEERING_ENABLED: "1" })).toBe(true);
  });

  test("rejects new requests with 403 before looking up or creating rows", async () => {
    await withSteeringDisabled(() => {
      const { task } = createRunningTask("disabled request");
      expect(getSteeringMessagesForTask(task.id)).toEqual([]);
      let thrown: unknown;
      try {
        requestSteering({ taskId: task.id, message: "do not create a row" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SteeringRequestError);
      expect(thrown).toMatchObject({
        message: "Steering is disabled on this server (set STEERING_ENABLED=true to enable)",
        statusCode: 403,
      });
      expect(getSteeringMessagesForTask(task.id)).toEqual([]);
    });
  });

  test("never leaks the steering flag on the unauthenticated health endpoint", async () => {
    // /health is public — server configuration must not be discoverable there.
    const enabled = await api("GET", "/health");
    expect(enabled.status).toBe(200);
    expect(enabled.body.steeringEnabled).toBeUndefined();
    await withSteeringDisabled(async () => {
      const disabled = await api("GET", "/health");
      expect(disabled.status).toBe(200);
      expect(disabled.body.steeringEnabled).toBeUndefined();
    });
  });

  test("reports the steering flag on the authenticated stats endpoint", async () => {
    const enabled = await api("GET", "/api/stats");
    expect(enabled.status).toBe(200);
    expect(enabled.body.steeringEnabled).toBe(true);
    await withSteeringDisabled(async () => {
      const disabled = await api("GET", "/api/stats");
      expect(disabled.status).toBe(200);
      expect(disabled.body.steeringEnabled).toBe(false);
    });
  });

  test("removes steering MCP tools when disabled and restores them when enabled", async () => {
    await withSteeringDisabled(() => {
      const serverTools = registeredTools(createServer({ fullSurface: true }));
      const userTools = registeredTools(createUserServer(createUser({ name: "disabled user" })));
      expect(serverTools["steer-task"]).toBeUndefined();
      expect(serverTools["accept-steer"]).toBeUndefined();
      expect(userTools["steer-task"]).toBeUndefined();
    });

    const serverTools = registeredTools(createServer({ fullSurface: true }));
    const userTools = registeredTools(createUserServer(createUser({ name: "enabled user" })));
    expect(serverTools["steer-task"]).toBeDefined();
    expect(serverTools["accept-steer"]).toBeDefined();
    expect(userTools["steer-task"]).toBeDefined();
  });

  test("registers steering tools with core capability alone (no task-pool)", () => {
    // Steering delivery works on directly-assigned tasks, so the acknowledge
    // path must not depend on the optional task-pool capability — otherwise
    // delivered messages could never reach `handled` on core-only deployments.
    const previous = process.env.CAPABILITIES;
    process.env.CAPABILITIES = "core";
    try {
      const serverTools = registeredTools(createServer());
      expect(serverTools["accept-steer"]).toBeDefined();
      expect(serverTools["steer-task"]).toBeDefined();
      expect(serverTools["task-action"]).toBeUndefined();
    } finally {
      restoreEnv("CAPABILITIES", previous);
    }
  });

  test("keeps history reads and all worker drain callbacks available", async () => {
    const { agent, task } = createRunningTask("disabled drain callbacks");
    const delivered = createSteeringMessage({
      taskId: task.id,
      body: "deliver this",
      mode: "queue",
      source: "api",
      createdByKind: "system",
    });
    const undeliverable = createSteeringMessage({
      taskId: task.id,
      body: "promote this",
      mode: "queue",
      source: "api",
      createdByKind: "system",
    });

    await withSteeringDisabled(async () => {
      const history = await api("GET", `/api/tasks/${task.id}/steering-messages`);
      expect(history.status).toBe(200);
      expect(history.body.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: delivered.id })]),
      );

      const pending = await api(
        "GET",
        `/api/steering-messages?taskId=${task.id}`,
        undefined,
        agent.id,
      );
      expect(pending.status).toBe(200);
      expect(pending.body.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: delivered.id })]),
      );

      expect(
        (
          await api(
            "POST",
            `/api/steering-messages/${delivered.id}/delivered`,
            { mode: "queue" },
            agent.id,
          )
        ).body.message,
      ).toEqual(expect.objectContaining({ status: "delivered" }));
      expect(
        (await api("POST", `/api/steering-messages/${delivered.id}/handled`, {}, agent.id)).body
          .message,
      ).toEqual(expect.objectContaining({ status: "handled" }));
      expect(
        (
          await api(
            "POST",
            `/api/steering-messages/${undeliverable.id}/undeliverable`,
            { reason: "disabled while in flight" },
            agent.id,
          )
        ).body.message,
      ).toEqual(expect.objectContaining({ status: "promoted" }));
    });
  });

  test("does not poll a live worker session while disabled", async () => {
    await withSteeringDisabled(async () => {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return Response.json({ messages: [] });
      }) as typeof fetch;
      await pollAndDispatchSteering(
        { apiUrl: "http://steering.test", apiKey: "key", agentId: "agent" },
        crypto.randomUUID(),
        {
          sessionId: "session",
          onEvent: () => {},
          waitForCompletion: async () => ({ exitCode: 0, isError: false }),
          abort: async () => {},
        },
        createSteeringDispatchState(),
        fetchImpl,
      );
      expect(calls).toBe(0);
    });
  });

  test("falls back to Slack follow-up task creation regardless of Slack steering mode", async () => {
    const previousMode = process.env.SLACK_THREAD_STEERING;
    const previousDeliveryMode = process.env.SLACK_THREAD_STEERING_MODE;
    process.env.SLACK_THREAD_STEERING = "lead";
    process.env.SLACK_THREAD_STEERING_MODE = "steer";
    try {
      const channelId = `C_DISABLED_${crypto.randomUUID()}`;
      const threadTs = "1.0001";
      const { task } = createRunningTask("disabled Slack steering", "pi", { channelId, threadTs });

      await withSteeringDisabled(async () => {
        expect(
          requestSlackThreadSteering({ channelId, threadTs, message: "take the fallback path" }),
        ).toBeNull();
        bufferThreadMessage(channelId, threadTs, "create the normal follow-up", "U1", "1.0002");
        await instantFlush(`${channelId}:${threadTs}`);
      });

      expect(getSteeringMessagesForTask(task.id)).toEqual([]);
      expect(getChildTasks(task.id)).toHaveLength(1);
    } finally {
      restoreEnv("SLACK_THREAD_STEERING", previousMode);
      restoreEnv("SLACK_THREAD_STEERING_MODE", previousDeliveryMode);
    }
  });
});
