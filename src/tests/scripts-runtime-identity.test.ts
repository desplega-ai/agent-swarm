/**
 * Runtime identity through the script path: MCP script tools → /api/scripts/run
 * → SwarmConfigPayload (system context) → swarm SDK headers → the same
 * work-acquisition gates the worker's own MCP/HTTP calls hit. Identity is
 * process context end to end — scripts never supply or override it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getActiveTaskCount,
  getDbClient,
  getTaskById,
  initDb,
} from "../be/db";
import { upsertRuntimeInstance } from "../be/multi-runtime";
import { handleMcpBridge } from "../http/mcp-bridge";
import { handlePoll } from "../http/poll";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { runScript } from "../scripts-runtime/loader";
import { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";
import { proxyScriptsApi } from "../tools/script-common";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-scripts-runtime-identity.sqlite";
let baseUrl = "";
const API_KEY = "scripts-runtime-identity-key-1234567890";
const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);

const savedEnv = { ...process.env };
const originalFetch = globalThis.fetch;
let server: Server;

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

/** Test server exposing the two real handlers the script SDK dispatches through. */
function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    const myAgentId = (req.headers["x-agent-id"] as string | undefined) ?? undefined;
    const segments = getPathSegments(req.url ?? "");
    const query = parseQueryParams(req.url ?? "");
    if (req.url?.startsWith("/api/poll")) {
      if (await handlePoll(req, res, segments, query, myAgentId)) return;
    }
    if (req.url?.startsWith("/api/mcp-bridge")) {
      if (await handleMcpBridge(req, res, segments, query, myAgentId)) return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

async function makeAgent(maxTasks = 1): Promise<string> {
  const id = crypto.randomUUID();
  await createAgent({
    id,
    name: "sri-agent",
    isLead: false,
    status: "idle",
    capabilities: [],
    maxTasks,
  });
  return id;
}

async function registerRuntime(agentId: string): Promise<string> {
  const rt = crypto.randomUUID();
  await upsertRuntimeInstance({ id: rt, agentId, reportedSlots: 1 });
  return rt;
}

async function makeRuntimeStale(runtimeInstanceId: string, minutesAgo = 30): Promise<void> {
  const when = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  await getDbClient().run("UPDATE runtime_instances SET last_seen_at = ? WHERE id = ?", [
    when,
    runtimeInstanceId,
  ]);
}

function sdkFor(agentId: string, runtimeInstanceId?: string) {
  return createSwarmSdk(
    new SwarmConfig({
      system: {
        apiKey: { value: API_KEY, isSecret: true },
        agentId: { value: agentId, isSecret: false },
        mcpBaseUrl: { value: baseUrl, isSecret: false },
        ...(runtimeInstanceId
          ? { runtimeInstanceId: { value: runtimeInstanceId, isSecret: false as const } }
          : {}),
      },
      user: {},
    }),
  );
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = createTestServer();
  const port = await listenOnFreePort(server);
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
});

// Full env restore — a leaked AGENT_SWARM_API_KEY outranks the legacy API_KEY
// that other suites' spawned servers authenticate with.
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("script-run proxy forwards runtime identity", () => {
  test("X-Runtime-Instance-ID from the MCP request context reaches the scripts API", async () => {
    let captured: Record<string, string> | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captured = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    await proxyScriptsApi({
      method: "POST",
      path: "/api/scripts/run",
      body: { name: "x" },
      requestInfo: {
        sessionId: "s",
        agentId: "agent-1",
        runtimeInstanceId: "rt-proxy-1",
        sourceTaskId: "task-1",
        contextKey: undefined,
        callOrigin: "mcp",
      },
      successMessage: () => "ok",
    });

    expect(captured?.["X-Agent-ID"]).toBe("agent-1");
    expect(captured?.["X-Runtime-Instance-ID"]).toBe("rt-proxy-1");
  });

  test("no runtime identity in the request context → no header", async () => {
    let captured: Record<string, string> | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      captured = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;

    await proxyScriptsApi({
      method: "GET",
      path: "/api/scripts",
      requestInfo: {
        sessionId: "s",
        agentId: "agent-1",
        runtimeInstanceId: undefined,
        sourceTaskId: undefined,
        contextKey: undefined,
        callOrigin: "mcp",
      },
      successMessage: () => "ok",
    });

    expect(captured?.["X-Runtime-Instance-ID"]).toBeUndefined();
  });
});

describe("swarm SDK emits the runtime header", () => {
  test("task_poll and the generic MCP bridge both carry X-Runtime-Instance-ID", async () => {
    const seen: Array<{ path: string; runtime: string | null }> = [];
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, runtime: req.headers.get("x-runtime-instance-id") });
        return Response.json({ trigger: null });
      },
    });
    try {
      const sdk = createSwarmSdk(
        new SwarmConfig({
          system: {
            apiKey: { value: API_KEY, isSecret: true },
            agentId: { value: "agent-sdk", isSecret: false },
            mcpBaseUrl: { value: `http://127.0.0.1:${stub.port}`, isSecret: false },
            runtimeInstanceId: { value: "rt-sdk-1", isSecret: false },
          },
          user: {},
        }),
      );
      await sdk.task_poll();
      await sdk.task_action({ action: "claim", taskId: crypto.randomUUID() });

      expect(seen).toEqual([
        { path: "/api/poll", runtime: "rt-sdk-1" },
        { path: "/api/mcp-bridge", runtime: "rt-sdk-1" },
      ]);
    } finally {
      stub.stop(true);
    }
  });

  test("without a runtime identity the SDK sends none (legacy compatibility)", async () => {
    const seen: Array<string | null> = [];
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("x-runtime-instance-id"));
        return Response.json({ trigger: null });
      },
    });
    try {
      const sdk = createSwarmSdk(
        new SwarmConfig({
          system: {
            apiKey: { value: API_KEY, isSecret: true },
            agentId: { value: "agent-sdk", isSecret: false },
            mcpBaseUrl: { value: `http://127.0.0.1:${stub.port}`, isSecret: false },
          },
          user: {},
        }),
      );
      await sdk.task_poll();
      expect(seen).toEqual([null]);
    } finally {
      stub.stop(true);
    }
  });
});

describe("script subprocess carries the invoking worker's identity", () => {
  const resources = { memoryMb: 2048, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 };

  spawnTest("ctx.swarm.task_poll() presents X-Runtime-Instance-ID from system config", async () => {
    const seen: Array<string | null> = [];
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("x-runtime-instance-id"));
        return Response.json({ trigger: null });
      },
    });
    try {
      const output = await runScript({
        agentId: "agent-sub",
        runtimeInstanceId: "rt-subprocess-1",
        mcpBaseUrl: `http://127.0.0.1:${stub.port}`,
        resources,
        source: `
          export default async (_args, ctx) => {
            await ctx.swarm.task_poll();
            return "polled";
          };
        `,
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toBe("polled");
      expect(seen).toEqual(["rt-subprocess-1"]);
    } finally {
      stub.stop(true);
    }
  });

  spawnTest("without a runtime identity the subprocess sends none", async () => {
    const seen: Array<string | null> = [];
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        seen.push(req.headers.get("x-runtime-instance-id"));
        return Response.json({ trigger: null });
      },
    });
    try {
      const output = await runScript({
        agentId: "agent-sub",
        mcpBaseUrl: `http://127.0.0.1:${stub.port}`,
        resources,
        source: `
          export default async (_args, ctx) => {
            await ctx.swarm.task_poll();
            return "polled";
          };
        `,
      });

      expect(output.error).toBeUndefined();
      expect(seen).toEqual([null]);
    } finally {
      stub.stop(true);
    }
  });
});

describe("script SDK dispatch hits the real runtime gates", () => {
  test("a live runtime acquires pending work through task_poll; a stale one does not", async () => {
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const agentId = await makeAgent(1);
    const live = await registerRuntime(agentId);
    const stale = await registerRuntime(agentId);
    await makeRuntimeStale(stale);
    const task = await createTaskExtended("script-poll-work", { agentId });

    const staleResult = (await sdkFor(agentId, stale).task_poll()) as {
      data: { trigger: { type?: string } | null };
    };
    expect(staleResult.data.trigger).toBeNull();
    expect((await getTaskById(task.id))?.status).toBe("pending");

    const liveResult = (await sdkFor(agentId, live).task_poll()) as {
      data: { trigger: { type?: string } | null };
    };
    expect(liveResult.data.trigger?.type).toBe("task_assigned");
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
    expect(await getActiveTaskCount(agentId)).toBe(1);
  });

  test("task_action claim through the bridge respects the live-runtime gate", async () => {
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const agentId = await makeAgent(1);
    const live = await registerRuntime(agentId);
    const stale = await registerRuntime(agentId);
    await makeRuntimeStale(stale);
    const task = await createTaskExtended("script-claim-work");

    await sdkFor(agentId, stale).task_action({ action: "claim", taskId: task.id });
    expect((await getTaskById(task.id))?.agentId ?? null).toBeNull();
    await sdkFor(agentId).task_action({ action: "claim", taskId: task.id });
    expect((await getTaskById(task.id))?.agentId ?? null).toBeNull();

    await sdkFor(agentId, live).task_action({ action: "claim", taskId: task.id });
    expect((await getTaskById(task.id))?.agentId).toBe(agentId);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("task_action accept through the bridge respects the live-runtime gate", async () => {
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const agentId = await makeAgent(1);
    const live = await registerRuntime(agentId);
    const stale = await registerRuntime(agentId);
    await makeRuntimeStale(stale);
    const task = await createTaskExtended("script-accept-work", { offeredTo: agentId });

    await sdkFor(agentId, stale).task_action({ action: "accept", taskId: task.id });
    expect((await getTaskById(task.id))?.status).toBe("offered");

    await sdkFor(agentId, live).task_action({ action: "accept", taskId: task.id });
    expect((await getTaskById(task.id))?.status).toBe("pending");
    expect((await getTaskById(task.id))?.agentId).toBe(agentId);
  });

  test("with the flag off, the SDK dispatches without runtime identity as before", async () => {
    delete process.env.MULTI_RUNTIME_ENABLED;
    const agentId = await makeAgent(1);
    const task = await createTaskExtended("legacy-claim-work");

    await sdkFor(agentId).task_action({ action: "claim", taskId: task.id });
    expect((await getTaskById(task.id))?.agentId).toBe(agentId);
  });
});
