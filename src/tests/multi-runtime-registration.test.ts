/**
 * Multi-runtime registration and lifecycle, exercised through the real HTTP
 * handlers on both sides of MULTI_RUNTIME_ENABLED.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getActiveSessionForTask,
  getActiveTaskCount,
  getAgentById,
  getDb,
  getSwarmConfigs,
  getTaskById,
  hasCapacity,
  initDb,
  startTask,
  upsertSwarmConfig,
} from "../be/db";
import {
  AGENT_MAX_TASKS_CONFIG_KEY,
  countActiveRuntimeInstancesForAgent,
  expireStaleRuntimeInstances,
  getAgentMaxTasksConfig,
  getRuntimeInstanceById,
  hasReadyLiveRuntime,
} from "../be/multi-runtime";
import { retryBootStep } from "../commands/credential-wait";
import { sendCredStatusReport } from "../commands/provider-credentials";
import { runHeartbeatSweep } from "../heartbeat/heartbeat";
import { handleActiveSessions } from "../http/active-sessions";
import { handleAgentRegister, handleAgentsRest } from "../http/agents";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { handlePoll } from "../http/poll";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerPollTaskTool } from "../tools/poll-task";
import { registerSetConfigTool } from "../tools/swarm-config/set-config";
import { registerTaskActionTool } from "../tools/task-action";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-multi-runtime-registration.sqlite";
const TEST_PORT = 13113 + (process.pid % 1000);
const baseUrl = `http://localhost:${TEST_PORT}`;
const API_KEY = "test-multi-runtime-key";

const LEAD_ID = "44444444-4444-4444-4444-444444444444";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    const myAgentId = (req.headers["x-agent-id"] as string | undefined) ?? undefined;

    // /ping and /close run through the real handleCore (its bearer auth gate
    // included) — the runtime-aware semantics under test live there.
    if (req.url === "/ping" || req.url === "/close") {
      const handled = await handleCore(req, res, myAgentId, API_KEY);
      if (handled) return;
    }

    if (req.url?.includes("/credential-status")) {
      const handled = await handleAgentsRest(
        req,
        res,
        getPathSegments(req.url),
        parseQueryParams(req.url),
        myAgentId,
      );
      if (handled) return;
    }

    if (req.url?.startsWith("/api/active-sessions")) {
      const handled = await handleActiveSessions(
        req,
        res,
        getPathSegments(req.url),
        parseQueryParams(req.url),
        myAgentId,
      );
      if (handled) return;
    }

    if (req.url?.startsWith("/api/poll")) {
      const handled = await handlePoll(
        req,
        res,
        getPathSegments(req.url),
        parseQueryParams(req.url),
        myAgentId,
      );
      if (handled) return;
    }

    // Production requests pass handleCore's auth first; this mock bypasses it
    // for the register/config routes, so simulate the operator principal the
    // config RBAC gate short-circuits on.
    setRequestAuth(req, { kind: "operator", fingerprint: "test" });
    const pathSegments = getPathSegments(req.url || "");
    const queryParams = parseQueryParams(req.url || "");
    try {
      if (await handleAgentRegister(req, res, pathSegments, myAgentId)) return;
      if (await handleConfig(req, res, pathSegments, queryParams)) return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

async function register(
  agentId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; agent: { maxTasks?: number } }> {
  const res = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
    body: JSON.stringify({ name: "mr-test-agent", ...body }),
  });
  return { status: res.status, agent: (await res.json()) as { maxTasks?: number } };
}

async function putAgentMaxTasks(agentId: string, value: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scope: "agent",
      scopeId: agentId,
      key: AGENT_MAX_TASKS_CONFIG_KEY,
      value,
    }),
  });
  // Drain the body so the socket is released between sequential requests.
  await res.text();
  return res.status;
}

async function pingAgent(agentId: string, runtimeInstanceId?: string): Promise<number> {
  const headers: Record<string, string> = {
    "X-Agent-ID": agentId,
    Authorization: `Bearer ${API_KEY}`,
  };
  if (runtimeInstanceId) headers["X-Runtime-Instance-ID"] = runtimeInstanceId;
  const res = await fetch(`${baseUrl}/ping`, { method: "POST", headers });
  await res.text();
  return res.status;
}

async function closeRuntime(agentId: string, runtimeInstanceId?: string): Promise<number> {
  const headers: Record<string, string> = {
    "X-Agent-ID": agentId,
    Authorization: `Bearer ${API_KEY}`,
  };
  if (runtimeInstanceId) headers["X-Runtime-Instance-ID"] = runtimeInstanceId;
  const res = await fetch(`${baseUrl}/close`, { method: "POST", headers });
  await res.text();
  return res.status;
}

async function pollAgent(
  agentId: string,
  runtimeInstanceId?: string,
): Promise<{ trigger?: { type?: string } } | null> {
  const headers: Record<string, string> = {
    "X-Agent-ID": agentId,
    Authorization: `Bearer ${API_KEY}`,
  };
  if (runtimeInstanceId) headers["X-Runtime-Instance-ID"] = runtimeInstanceId;
  const res = await fetch(`${baseUrl}/api/poll`, { headers });
  const text = await res.text();
  try {
    return JSON.parse(text) as { trigger?: { type?: string } };
  } catch {
    return null;
  }
}

function makeAgent(maxTasks: number): string {
  const id = crypto.randomUUID();
  createAgent({
    id,
    name: "mr-existing",
    isLead: false,
    status: "idle",
    capabilities: [],
    maxTasks,
  });
  return id;
}

/** Runtime rows for an agent, ordered as created (test-local: no production reader). */
function runtimeInstancesFor(agentId: string) {
  return getDb()
    .prepare<{ id: string; status: string; reported_slots: number }, [string]>(
      "SELECT id, status, reported_slots FROM runtime_instances WHERE agent_id = ? ORDER BY created_at ASC, id ASC",
    )
    .all(agentId)
    .map((r) => ({ id: r.id, status: r.status, reportedSlots: r.reported_slots }));
}

async function startSessionFor(agentId: string, taskId: string, runtimeInstanceId: string) {
  const res = await fetch(`${baseUrl}/api/active-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
    body: JSON.stringify({ agentId, taskId, triggerType: "task_assigned", runtimeInstanceId }),
  });
  await res.text();
  return res.status;
}

async function startupCleanupFor(agentId: string) {
  const res = await fetch(`${baseUrl}/api/active-sessions/cleanup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
    body: JSON.stringify({ agentId }),
  });
  await res.text();
  return res.status;
}

/** Backdate a session's heartbeat, as a dead process's session would be. */
function makeSessionStale(taskId: string, minutesAgo = 30): void {
  const when = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  getDb()
    .prepare("UPDATE active_sessions SET lastHeartbeatAt = ? WHERE taskId = ?")
    .run(when, taskId);
}

/** Backdate a runtime's last ping so liveness checks treat it as stale. */
function makeRuntimeStale(runtimeInstanceId: string, minutesAgo = 30): void {
  const when = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  getDb()
    .prepare("UPDATE runtime_instances SET last_seen_at = ? WHERE id = ?")
    .run(when, runtimeInstanceId);
}

// ─── Minimal MCP server mock (same shape as swarm-config-reserved-keys) ─────
type ToolHandler = (args: unknown, meta: unknown) => Promise<unknown> | unknown;

class MockMcpServer {
  handlers = new Map<string, ToolHandler>();

  registerTool(name: string, _config: unknown, handler: ToolHandler) {
    this.handlers.set(name, handler);
    return { name };
  }
}

function makeRequestInfo(agentId = LEAD_ID) {
  return {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": agentId } },
  };
}

let server: Server;
const mcpServer = new MockMcpServer();
const originalFlag = process.env.MULTI_RUNTIME_ENABLED;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  registerSetConfigTool(mcpServer as unknown as Parameters<typeof registerSetConfigTool>[0]);
  registerPollTaskTool(mcpServer as unknown as Parameters<typeof registerPollTaskTool>[0]);
  registerTaskActionTool(mcpServer as unknown as Parameters<typeof registerTaskActionTool>[0]);
  server = createTestServer();
  await new Promise<void>((resolve) => {
    server.listen(TEST_PORT, () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  if (originalFlag === undefined) delete process.env.MULTI_RUNTIME_ENABLED;
  else process.env.MULTI_RUNTIME_ENABLED = originalFlag;
});

beforeEach(() => {
  delete process.env.MULTI_RUNTIME_ENABLED;
  getDb().prepare("DELETE FROM runtime_instances").run();
  getDb().prepare("DELETE FROM active_sessions").run();
  // Pool sweeps cap how many tasks they assign per tick, so leftovers from an
  // earlier test would starve the one under test.
  getDb().prepare("DELETE FROM agent_tasks").run();
  getDb().prepare("DELETE FROM agents").run();
  getDb().prepare("DELETE FROM swarm_config").run();
  // set-config is lead-gated; the MCP mirror tests call it as this lead.
  createAgent({ id: LEAD_ID, name: "mr-lead", isLead: true, status: "idle", capabilities: [] });
});

// ─── Migration 131 ──────────────────────────────────────────────────────────

describe("migration 132_multi_runtime_instances", () => {
  test("runtime_instances table exists with the expected columns", () => {
    const cols = getDb()
      .prepare<{ name: string }, []>("PRAGMA table_info(runtime_instances)")
      .all()
      .map((r) => r.name);
    for (const col of [
      "id",
      "agent_id",
      "status",
      "reported_slots",
      "metadata",
      "last_seen_at",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
    ]) {
      expect(cols).toContain(col);
    }
  });

  test("active_sessions carries runtime ownership", () => {
    const cols = getDb()
      .prepare<{ name: string }, []>("PRAGMA table_info(active_sessions)")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("runtimeInstanceId");
  });
});

describe("legacy mode (flag off)", () => {
  test("registration creates the agent with the reported maxTasks", async () => {
    const id = crypto.randomUUID();
    const { status, agent } = await register(id, { maxTasks: 2 });
    expect(status).toBe(201);
    expect(agent.maxTasks).toBe(2);
    expect(getAgentById(id)?.maxTasks).toBe(2);
  });

  test("re-registration writes the reported value through to agents.maxTasks", async () => {
    const id = makeAgent(3);
    const { status } = await register(id, { maxTasks: 5 });
    expect(status).toBe(200);
    expect(getAgentById(id)?.maxTasks).toBe(5);
  });

  test("no runtime-instance rows and no policy config rows are written, even when the worker sends a runtimeInstanceId", async () => {
    const id = crypto.randomUUID();
    await register(id, { maxTasks: 2, runtimeInstanceId: crypto.randomUUID() });
    await register(id, { maxTasks: 4, runtimeInstanceId: crypto.randomUUID() });
    expect(runtimeInstancesFor(id)).toHaveLength(0);
    expect(getAgentMaxTasksConfig(id)).toBeNull();
    expect(getAgentById(id)?.maxTasks).toBe(4);
  });
});

describe("multi-runtime mode: registration vs logical policy", () => {
  test("two runtimes with different capacities never touch the persisted policy", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";

    const r1 = crypto.randomUUID();
    const r2 = crypto.randomUUID();
    await register(id, { maxTasks: 5, runtimeInstanceId: r1 });
    await register(id, { maxTasks: 7, runtimeInstanceId: r2 });

    expect(getAgentById(id)?.maxTasks).toBe(3);
    expect(getAgentMaxTasksConfig(id)?.value).toBe("3");
    expect(getRuntimeInstanceById(r1)?.reportedSlots).toBe(5);
    expect(getRuntimeInstanceById(r2)?.reportedSlots).toBe(7);
  });

  test("a brand-new agent's first registration establishes the logical policy", async () => {
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const id = crypto.randomUUID();
    const rt = crypto.randomUUID();
    const { status, agent } = await register(id, { maxTasks: 7, runtimeInstanceId: rt });
    expect(status).toBe(201);
    expect(agent.maxTasks).toBe(7);
    expect(getAgentMaxTasksConfig(id)?.value).toBe("7");
    expect(getRuntimeInstanceById(rt)?.reportedSlots).toBe(7);
  });
});

describe("multi-runtime mode: operator value survives runtime registrations", () => {
  test("registrations after an operator update leave the policy untouched", async () => {
    const id = makeAgent(3);
    expect(await putAgentMaxTasks(id, "4")).toBe(200);
    expect(getAgentById(id)?.maxTasks).toBe(4);

    process.env.MULTI_RUNTIME_ENABLED = "true";
    await register(id, { maxTasks: 10, runtimeInstanceId: crypto.randomUUID() });
    await register(id, { maxTasks: 20, runtimeInstanceId: crypto.randomUUID() });

    expect(getAgentById(id)?.maxTasks).toBe(4);
    expect(getAgentMaxTasksConfig(id)?.value).toBe("4");
    const rows = getSwarmConfigs({ scope: "agent", scopeId: id, key: AGENT_MAX_TASKS_CONFIG_KEY });
    expect(rows).toHaveLength(1);
  });
});

describe("multi-runtime mode: enablement seeding", () => {
  test("first registration seeds AGENT_MAX_TASKS from the persisted agents.maxTasks", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";

    await register(id, { maxTasks: 9, runtimeInstanceId: crypto.randomUUID() });
    let rows = getSwarmConfigs({ scope: "agent", scopeId: id, key: AGENT_MAX_TASKS_CONFIG_KEY });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("3");

    await register(id, { maxTasks: 12, runtimeInstanceId: crypto.randomUUID() });
    rows = getSwarmConfigs({ scope: "agent", scopeId: id, key: AGENT_MAX_TASKS_CONFIG_KEY });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("3");
  });
});

describe("multi-runtime mode: existing config preserved", () => {
  test("registration keeps the pre-existing row and repairs the mirror from it", async () => {
    const id = makeAgent(3);
    upsertSwarmConfig({
      scope: "agent",
      scopeId: id,
      key: AGENT_MAX_TASKS_CONFIG_KEY,
      value: "9",
    });

    process.env.MULTI_RUNTIME_ENABLED = "true";
    await register(id, { maxTasks: 5, runtimeInstanceId: crypto.randomUUID() });

    expect(getAgentMaxTasksConfig(id)?.value).toBe("9");
    // The column converges to the config row, not the runtime's report.
    expect(getAgentById(id)?.maxTasks).toBe(9);
  });

  test("a config row written before the agent exists is applied when the agent registers", async () => {
    const id = crypto.randomUUID();
    upsertSwarmConfig({
      scope: "agent",
      scopeId: id,
      key: AGENT_MAX_TASKS_CONFIG_KEY,
      value: "6",
    });

    process.env.MULTI_RUNTIME_ENABLED = "true";
    await register(id, { maxTasks: 5, runtimeInstanceId: crypto.randomUUID() });

    expect(getAgentMaxTasksConfig(id)?.value).toBe("6");
    expect(getAgentById(id)?.maxTasks).toBe(6);
  });
});

describe("operator updates mirror into agents.maxTasks", () => {
  test("PUT /api/config updates the enforcement mirror atomically", async () => {
    const id = makeAgent(2);
    expect(await putAgentMaxTasks(id, "6")).toBe(200);
    expect(getAgentMaxTasksConfig(id)?.value).toBe("6");
    expect(getAgentById(id)?.maxTasks).toBe(6);
  });

  test("invalid values are rejected and leave both sides untouched", async () => {
    const id = makeAgent(2);
    for (const bad of ["0", "-1", "abc", "101", "2.5"]) {
      expect(await putAgentMaxTasks(id, bad)).toBe(400);
    }
    expect(getAgentMaxTasksConfig(id)).toBeNull();
    expect(getAgentById(id)?.maxTasks).toBe(2);
  });

  test("the MCP set-config tool mirrors the same way", async () => {
    const id = makeAgent(2);
    const handler = mcpServer.handlers.get("set-config");
    expect(handler).toBeDefined();
    const result = (await handler?.(
      {
        scope: "agent",
        scopeId: id,
        key: AGENT_MAX_TASKS_CONFIG_KEY,
        value: "8",
      },
      makeRequestInfo(),
    )) as { isError?: boolean };
    expect(result?.isError).toBeFalsy();
    expect(getAgentMaxTasksConfig(id)?.value).toBe("8");
    expect(getAgentById(id)?.maxTasks).toBe(8);
  });

  test("global-scope writes of other keys are untouched by the mirror wrapper", async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "global", key: "STEERING_ENABLED", value: "true" }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(getSwarmConfigs({ scope: "global", key: "STEERING_ENABLED" })[0]?.value).toBe("true");
  });
});

describe("disable / legacy restoration", () => {
  test("after the flag is turned off, write-through resumes and the config row is left alone", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    await register(id, { maxTasks: 5, runtimeInstanceId: crypto.randomUUID() });
    expect(getAgentById(id)?.maxTasks).toBe(3);
    expect(getAgentMaxTasksConfig(id)?.value).toBe("3");

    delete process.env.MULTI_RUNTIME_ENABLED;
    const { status } = await register(id, { maxTasks: 8 });
    expect(status).toBe(200);
    expect(getAgentById(id)?.maxTasks).toBe(8);
    // The seeded row persists but no longer gates registration.
    expect(getAgentMaxTasksConfig(id)?.value).toBe("3");
  });
});

describe("runtime instances", () => {
  test("two instances serving one agent keep independent capacities", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const r1 = crypto.randomUUID();
    const r2 = crypto.randomUUID();
    await register(id, { maxTasks: 2, runtimeInstanceId: r1 });
    await register(id, { maxTasks: 6, runtimeInstanceId: r2 });

    const instances = runtimeInstancesFor(id);
    expect(instances).toHaveLength(2);
    const byId = new Map(instances.map((i) => [i.id, i]));
    expect(byId.get(r1)?.reportedSlots).toBe(2);
    expect(byId.get(r2)?.reportedSlots).toBe(6);
    for (const instance of instances) {
      expect(instance.status).toBe("active");
    }
  });

  test("a re-registration from the same runtime refreshes its row in place", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 2, runtimeInstanceId: rt });
    await register(id, { maxTasks: 4, runtimeInstanceId: rt });

    const instances = runtimeInstancesFor(id);
    expect(instances).toHaveLength(1);
    expect(instances[0]?.id).toBe(rt);
    expect(instances[0]?.reportedSlots).toBe(4);
  });

  test("re-registering a closed runtime makes it active again", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 2, runtimeInstanceId: rt });
    await closeRuntime(id, rt);
    expect(getRuntimeInstanceById(rt)?.status).toBe("offline");

    // Registration is the only path that may restore `active`.
    await register(id, { maxTasks: 3, runtimeInstanceId: rt });
    expect(getRuntimeInstanceById(rt)?.status).toBe("active");
    expect(getRuntimeInstanceById(rt)?.reportedSlots).toBe(3);
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("a runtime id belonging to another agent is rejected and never reassigned", async () => {
    const owner = makeAgent(3);
    const other = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(owner, { maxTasks: 2, runtimeInstanceId: rt });

    const { status } = await register(other, { maxTasks: 9, runtimeInstanceId: rt });
    expect(status).toBe(400);

    const instance = getRuntimeInstanceById(rt);
    expect(instance?.agentId).toBe(owner);
    expect(instance?.reportedSlots).toBe(2);
    expect(runtimeInstancesFor(other)).toHaveLength(0);
  });

  test("registration without a runtimeInstanceId is rejected with 400 when the flag is on", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { status } = await register(id, { maxTasks: 5 });
    expect(status).toBe(400);
    expect(getAgentById(id)?.maxTasks).toBe(3);
    expect(getAgentMaxTasksConfig(id)).toBeNull();
    expect(runtimeInstancesFor(id)).toHaveLength(0);
  });

  test("an unknown agent registering without a runtimeInstanceId is rejected and never created", async () => {
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const id = crypto.randomUUID();
    const { status } = await register(id, { maxTasks: 5 });
    expect(status).toBe(400);
    expect(getAgentById(id)).toBeNull();
  });
});

// ─── Runtime-aware close ────────────────────────────────────────────────────

describe("runtime-aware close", () => {
  test("one of two active runtimes closing leaves the agent available and the sibling untouched", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    const rB = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    await register(id, { maxTasks: 2, runtimeInstanceId: rB });
    const bBefore = getRuntimeInstanceById(rB);

    expect(await closeRuntime(id, rA)).toBe(204);

    expect(getRuntimeInstanceById(rA)?.status).toBe("offline");
    expect(getAgentById(id)?.status).toBe("idle");
    const bAfter = getRuntimeInstanceById(rB);
    expect(bAfter?.status).toBe("active");
    expect(bAfter?.reportedSlots).toBe(2);
    expect(bAfter?.lastSeenAt).toBe(bBefore?.lastSeenAt ?? "");
    expect(bAfter?.updatedAt).toBe(bBefore?.updatedAt ?? "");
  });

  test("the last active runtime closing takes the agent offline", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    const rB = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    await register(id, { maxTasks: 2, runtimeInstanceId: rB });

    await closeRuntime(id, rA);
    expect(getAgentById(id)?.status).toBe("idle");

    expect(await closeRuntime(id, rB)).toBe(204);
    expect(getRuntimeInstanceById(rB)?.status).toBe("offline");
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("legacy close (flag off) preserves legacy semantics", async () => {
    const id = makeAgent(3);
    expect(await closeRuntime(id)).toBe(204);
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("with the flag off, a runtime-identified close still takes the legacy path", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });

    delete process.env.MULTI_RUNTIME_ENABLED;
    expect(await closeRuntime(id, rA)).toBe(204);
    // Runtime rows stay inert while the flag is off.
    expect(getAgentById(id)?.status).toBe("offline");
    expect(getRuntimeInstanceById(rA)?.status).toBe("active");
  });

  test("a multi-runtime close without a runtime id fails closed with 400 and mutates nothing", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    const before = getRuntimeInstanceById(rA);

    // Unlike ping, an anonymous close must not fall back to legacy semantics.
    expect(await closeRuntime(id)).toBe(400);
    expect(getAgentById(id)?.status).toBe("idle");
    const after = getRuntimeInstanceById(rA);
    expect(after?.status).toBe("active");
    expect(after?.updatedAt).toBe(before?.updatedAt ?? "");
    expect(after?.lastSeenAt).toBe(before?.lastSeenAt ?? "");
  });

  test("registration and close share the same identity requirement while the mode is on", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { status: registerStatus } = await register(id, { maxTasks: 5 });
    expect(registerStatus).toBe(400);
    expect(await closeRuntime(id)).toBe(400);
    expect(getAgentById(id)?.status).toBe("idle");
    expect(getAgentById(id)?.maxTasks).toBe(3);
    expect(runtimeInstancesFor(id)).toHaveLength(0);
  });

  test("transition: a pre-enablement worker's id-less close cannot take the agent offline", async () => {
    const id = makeAgent(3);
    const { status: legacyStatus } = await register(id, { maxTasks: 2 });
    expect(legacyStatus).toBe(200);
    expect(getAgentById(id)?.maxTasks).toBe(2);

    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rY = crypto.randomUUID();
    await register(id, { maxTasks: 2, runtimeInstanceId: rY });
    expect(getRuntimeInstanceById(rY)?.status).toBe("active");

    // The old worker's shutdown must not retire the agent Y still serves.
    expect(await closeRuntime(id)).toBe(400);
    expect(getRuntimeInstanceById(rY)?.status).toBe("active");
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("a close cannot mark another agent's runtime offline", async () => {
    const id1 = makeAgent(3);
    const id2 = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const r1 = crypto.randomUUID();
    const r2 = crypto.randomUUID();
    await register(id1, { maxTasks: 1, runtimeInstanceId: r1 });
    await register(id2, { maxTasks: 1, runtimeInstanceId: r2 });

    // Agent 2 presents agent 1's runtime id.
    expect(await closeRuntime(id2, r1)).toBe(204);
    expect(getRuntimeInstanceById(r1)?.status).toBe("active");
    expect(getRuntimeInstanceById(r2)?.status).toBe("active");
    expect(getAgentById(id2)?.status).toBe("idle");
  });
});

// ─── Runtime liveness via the worker ping ───────────────────────────────────

describe("runtime liveness via ping", () => {
  test("a ping refreshes only the pinging runtime's last_seen_at", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    const rB = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    await register(id, { maxTasks: 2, runtimeInstanceId: rB });
    const aBefore = getRuntimeInstanceById(rA);
    const bBefore = getRuntimeInstanceById(rB);

    await Bun.sleep(10);
    expect(await pingAgent(id, rB)).toBe(204);

    const aAfter = getRuntimeInstanceById(rA);
    const bAfter = getRuntimeInstanceById(rB);
    expect(bAfter && bBefore && bAfter.lastSeenAt > bBefore.lastSeenAt).toBe(true);
    expect(aAfter?.lastSeenAt).toBe(aBefore?.lastSeenAt ?? "");
  });

  test("a ping without the runtime header is an accepted no-op", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    const before = getRuntimeInstanceById(rA);

    await Bun.sleep(10);
    // Accepted so pre-flag workers keep running, but mutates nothing.
    expect(await pingAgent(id)).toBe(204);
    expect(getRuntimeInstanceById(rA)?.lastSeenAt).toBe(before?.lastSeenAt ?? "");
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("an id-less ping does not stomp a busy agent's status", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    await register(id, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });
    getDb().prepare("UPDATE agents SET status = 'busy' WHERE id = ?").run(id);

    expect(await pingAgent(id)).toBe(204);
    expect(getAgentById(id)?.status).toBe("busy");
  });

  test("with the flag off, a runtime-identified ping is inert", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    const before = getRuntimeInstanceById(rA);

    delete process.env.MULTI_RUNTIME_ENABLED;
    await Bun.sleep(10);
    expect(await pingAgent(id, rA)).toBe(204);
    expect(getRuntimeInstanceById(rA)?.lastSeenAt).toBe(before?.lastSeenAt ?? "");
  });

  test("an id-less ping cannot revive an agent that has zero active runtimes", async () => {
    const id = makeAgent(3);
    await register(id, { maxTasks: 2 });

    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rY = crypto.randomUUID();
    await register(id, { maxTasks: 2, runtimeInstanceId: rY });
    await closeRuntime(id, rY);
    expect(getAgentById(id)?.status).toBe("offline");

    // An anonymous ping must not make the agent look available again.
    expect(await pingAgent(id)).toBe(204);
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("a closed runtime's ping neither reactivates it nor revives the agent", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    await closeRuntime(id, rA);
    expect(getAgentById(id)?.status).toBe("offline");
    const closed = getRuntimeInstanceById(rA);

    await Bun.sleep(10);
    expect(await pingAgent(id, rA)).toBe(204);
    expect(getRuntimeInstanceById(rA)?.status).toBe("offline");
    expect(getRuntimeInstanceById(rA)?.lastSeenAt).toBe(closed?.lastSeenAt ?? "");
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("an unknown runtime id leaves agent status untouched", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    await closeRuntime(id, rA);
    expect(getAgentById(id)?.status).toBe("offline");

    expect(await pingAgent(id, crypto.randomUUID())).toBe(204);
    expect(getAgentById(id)?.status).toBe("offline");
    expect(runtimeInstancesFor(id)).toHaveLength(1);
  });

  test("a foreign runtime id cannot drive the presenting agent's status", async () => {
    const id1 = makeAgent(3);
    const id2 = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const r1 = crypto.randomUUID();
    const r2 = crypto.randomUUID();
    await register(id1, { maxTasks: 1, runtimeInstanceId: r1 });
    await register(id2, { maxTasks: 1, runtimeInstanceId: r2 });
    await closeRuntime(id2, r2);
    expect(getAgentById(id2)?.status).toBe("offline");
    const before = getRuntimeInstanceById(r1);

    await Bun.sleep(10);
    expect(await pingAgent(id2, r1)).toBe(204);
    expect(getAgentById(id2)?.status).toBe("offline");
    expect(getRuntimeInstanceById(r1)?.lastSeenAt).toBe(before?.lastSeenAt ?? "");
  });

  test("a ping cannot touch another agent's runtime row", async () => {
    const id1 = makeAgent(3);
    const id2 = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const r1 = crypto.randomUUID();
    await register(id1, { maxTasks: 1, runtimeInstanceId: r1 });
    await register(id2, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });
    const before = getRuntimeInstanceById(r1);

    await Bun.sleep(10);
    expect(await pingAgent(id2, r1)).toBe(204);
    expect(getRuntimeInstanceById(r1)?.lastSeenAt).toBe(before?.lastSeenAt ?? "");
  });
});

// ─── End-to-end multi-runtime lifecycle ─────────────────────────────────────

describe("end-to-end multi-runtime lifecycle", () => {
  test("policy, capacity, close, and liveness compose across two runtimes", async () => {
    const coder = makeAgent(2);
    expect(await putAgentMaxTasks(coder, "4")).toBe(200);
    expect(getAgentById(coder)?.maxTasks).toBe(4);

    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    const rB = crypto.randomUUID();
    await register(coder, { maxTasks: 1, runtimeInstanceId: rA });
    await register(coder, { maxTasks: 2, runtimeInstanceId: rB });

    expect(getRuntimeInstanceById(rA)?.reportedSlots).toBe(1);
    expect(getRuntimeInstanceById(rB)?.reportedSlots).toBe(2);
    expect(getRuntimeInstanceById(rA)?.status).toBe("active");
    expect(getRuntimeInstanceById(rB)?.status).toBe("active");
    expect(getAgentById(coder)?.maxTasks).toBe(4);
    expect(getAgentMaxTasksConfig(coder)?.value).toBe("4");

    await closeRuntime(coder, rA);
    expect(getRuntimeInstanceById(rA)?.status).toBe("offline");
    expect(getRuntimeInstanceById(rB)?.status).toBe("active");
    expect(getAgentById(coder)?.status).toBe("idle");
    expect(getAgentById(coder)?.maxTasks).toBe(4);

    const aSeen = getRuntimeInstanceById(rA)?.lastSeenAt;
    const bSeen = getRuntimeInstanceById(rB)?.lastSeenAt;
    await Bun.sleep(10);
    await pingAgent(coder, rB);
    expect(getRuntimeInstanceById(rA)?.lastSeenAt).toBe(aSeen ?? "");
    const bSeenAfter = getRuntimeInstanceById(rB)?.lastSeenAt;
    expect(bSeenAfter && bSeen && bSeenAfter > bSeen).toBe(true);

    await closeRuntime(coder, rB);
    expect(getRuntimeInstanceById(rB)?.status).toBe("offline");
    expect(getAgentById(coder)?.status).toBe("offline");
    expect(getAgentById(coder)?.maxTasks).toBe(4);
    expect(getAgentMaxTasksConfig(coder)?.value).toBe("4");
  });
});

describe("stale runtime liveness", () => {
  test("a crashed runtime stops counting once its ping goes stale", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    expect(countActiveRuntimeInstancesForAgent(id)).toBe(1);

    makeRuntimeStale(rA);
    expect(countActiveRuntimeInstancesForAgent(id)).toBe(0);
  });

  test("a stale runtime does not keep the agent available when its sibling closes", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const crashed = crypto.randomUUID();
    const live = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: crashed });
    await register(id, { maxTasks: 1, runtimeInstanceId: live });

    // The crashed process never reaches /close.
    makeRuntimeStale(crashed);
    expect(getAgentById(id)?.status).toBe("idle");

    await closeRuntime(id, live);
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("a live sibling keeps the agent available while another is stale", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const crashed = crypto.randomUUID();
    const live = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: crashed });
    await register(id, { maxTasks: 1, runtimeInstanceId: live });
    makeRuntimeStale(crashed);

    expect(countActiveRuntimeInstancesForAgent(id)).toBe(1);
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("the sweep retires stale runtimes and offlines agents with none left", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });
    makeRuntimeStale(rA);

    const result = expireStaleRuntimeInstances();
    expect(result.expired).toBe(1);
    expect(result.agentsOffline).toBe(1);
    // Retired runtimes are pruned rather than accumulating one row per boot.
    expect(getRuntimeInstanceById(rA)).toBeNull();
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("the sweep leaves healthy runtimes and their agents alone", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });

    const result = expireStaleRuntimeInstances();
    expect(result.expired).toBe(0);
    expect(getRuntimeInstanceById(rA)?.status).toBe("active");
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("a row left active by a flag-off close does not revive the agent when the flag returns", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });

    // Flag off: close takes the legacy path and leaves the row active.
    delete process.env.MULTI_RUNTIME_ENABLED;
    await closeRuntime(id, rA);
    expect(getRuntimeInstanceById(rA)?.status).toBe("active");
    expect(getAgentById(id)?.status).toBe("offline");

    // Re-enabled later, that stale row must not count as a live runtime.
    process.env.MULTI_RUNTIME_ENABLED = "true";
    makeRuntimeStale(rA);
    expect(countActiveRuntimeInstancesForAgent(id)).toBe(0);
  });
});

describe("logical capacity across runtimes", () => {
  test("reviewing tasks consume a slot", () => {
    const id = makeAgent(1);
    const task = createTaskExtended("t", { offeredTo: id });
    getDb()
      .prepare("UPDATE agent_tasks SET agentId = ?, status = 'reviewing' WHERE id = ?")
      .run(id, task.id);
    expect(getActiveTaskCount(id)).toBe(1);
    expect(hasCapacity(id)).toBe(false);
  });

  test("maxTasks=1 admits only one of two concurrent polls", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rtA = crypto.randomUUID();
    const rtB = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rtA });
    await register(id, { maxTasks: 1, runtimeInstanceId: rtB });
    createTaskExtended("offered-1", { offeredTo: id });
    createTaskExtended("offered-2", { offeredTo: id });

    // Two runtimes of the same agent polling at once.
    const [a, b] = await Promise.all([pollAgent(id, rtA), pollAgent(id, rtB)]);
    const admitted = [a, b].filter((t) => t?.trigger?.type === "task_offered");
    expect(admitted).toHaveLength(1);
    expect(getActiveTaskCount(id)).toBe(1);
  });

  test("maxTasks=2 admits two concurrent polls", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rtA = crypto.randomUUID();
    const rtB = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rtA });
    await register(id, { maxTasks: 1, runtimeInstanceId: rtB });
    createTaskExtended("offered-1", { offeredTo: id });
    createTaskExtended("offered-2", { offeredTo: id });

    const [a, b] = await Promise.all([pollAgent(id, rtA), pollAgent(id, rtB)]);
    const admitted = [a, b].filter((t) => t?.trigger?.type === "task_offered");
    expect(admitted).toHaveLength(2);
  });

  test("finishing a task restores capacity", async () => {
    const id = makeAgent(1);
    const task = createTaskExtended("t", { offeredTo: id });
    const first = await pollAgent(id);
    expect(first?.trigger?.type).toBe("task_offered");
    expect(hasCapacity(id)).toBe(false);

    completeTask(task.id, "done");
    expect(hasCapacity(id)).toBe(true);
  });

  test("capacity is enforced the same way with the flag off", async () => {
    const id = makeAgent(1);
    createTaskExtended("offered-1", { offeredTo: id });
    createTaskExtended("offered-2", { offeredTo: id });

    const [a, b] = await Promise.all([pollAgent(id), pollAgent(id)]);
    expect([a, b].filter((t) => t?.trigger?.type === "task_offered")).toHaveLength(1);
  });
});

describe("logical policy seeding", () => {
  test("a new lead keeps its reported default instead of being forced to one", async () => {
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const id = crypto.randomUUID();
    await register(id, { isLead: true, maxTasks: 2, runtimeInstanceId: crypto.randomUUID() });
    expect(getAgentById(id)?.maxTasks).toBe(2);
    expect(getAgentMaxTasksConfig(id)?.value).toBe("2");
  });

  test("deleting the policy row clears the enforcement mirror", async () => {
    const id = makeAgent(2);
    expect(await putAgentMaxTasks(id, "7")).toBe(200);
    expect(getAgentById(id)?.maxTasks).toBe(7);

    const row = getAgentMaxTasksConfig(id);
    expect(row).not.toBeNull();
    const res = await fetch(`${baseUrl}/api/config/${row?.id}`, { method: "DELETE" });
    await res.text();
    expect(res.status).toBe(200);

    expect(getAgentMaxTasksConfig(id)).toBeNull();
    expect(getAgentById(id)?.maxTasks).toBe(1);
  });
});

describe("sibling runtime session safety", () => {
  const startSession = startSessionFor;
  const startupCleanup = startupCleanupFor;

  test("starting a second runtime leaves the first runtime's live session and task alone", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });

    const task = createTaskExtended("work", { agentId: id });
    startTask(task.id);
    expect(await startSession(id, task.id, rA)).toBe(201);

    // Runtime B boots and runs its startup cleanup.
    const rB = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rB });
    expect(await startupCleanup(id)).toBe(200);

    // A's session survives, so its task is not orphaned back to the pool.
    expect(getActiveSessionForTask(task.id)).not.toBeNull();
    expect(getTaskById(task.id)?.status).toBe("in_progress");
    expect(getRuntimeInstanceById(rB)?.status).toBe("active");
  });

  test("startup cleanup preserves an activation-window session it cannot prove dead", async () => {
    // A flag-off worker keeps executing with no runtime row at all; its
    // session may be quiet past the runtime cutoff (tool-activity heartbeats
    // only). A sibling booting right after activation must not kill it.
    const id = makeAgent(3);
    const task = createTaskExtended("work", { agentId: id });
    startTask(task.id);
    await startSession(id, task.id, crypto.randomUUID());
    makeSessionStale(task.id, 7);

    process.env.MULTI_RUNTIME_ENABLED = "true";
    await register(id, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });
    expect(await startupCleanup(id)).toBe(200);

    expect(getActiveSessionForTask(task.id)).not.toBeNull();
    expect(getTaskById(task.id)?.status).toBe("in_progress");
  });

  test("a crashed predecessor's work is reclaimed by the classifier, not boot cleanup", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const crashed = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: crashed });

    const task = createTaskExtended("work", { agentId: id });
    startTask(task.id);
    await startSession(id, task.id, crashed);
    // The crashed process stopped its runtime ping, its session heartbeat,
    // and its task progress.
    makeRuntimeStale(crashed);
    makeSessionStale(task.id, 30);
    getDb()
      .prepare("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * 60000).toISOString(), task.id);

    const replacement = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: replacement });
    // Boot cleanup deletes nothing in multi-runtime mode — it has no evidence
    // stronger than the classifier's.
    expect(await startupCleanup(id)).toBe(200);
    expect(getActiveSessionForTask(task.id)).not.toBeNull();

    // The sweep's classifier reclaims the work and its session.
    await runHeartbeatSweep();
    expect(getTaskById(task.id)?.status).not.toBe("in_progress");
    expect(getActiveSessionForTask(task.id)).toBeNull();
  });

  test("with the flag off, startup cleanup still clears every session for the agent", async () => {
    const id = makeAgent(3);
    const task = createTaskExtended("work", { agentId: id });
    startTask(task.id);
    await startSession(id, task.id, crypto.randomUUID());

    expect(await startupCleanup(id)).toBe(200);
    expect(getActiveSessionForTask(task.id)).toBeNull();
  });
});

describe("rollback to legacy mode", () => {
  test("stale runtime state is inert while the flag is off", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });

    // Operator rolls back; workers stop refreshing their rows.
    delete process.env.MULTI_RUNTIME_ENABLED;
    makeRuntimeStale(rA);

    const result = expireStaleRuntimeInstances();
    expect(result.expired).toBe(0);
    expect(getRuntimeInstanceById(rA)).not.toBeNull();
    // The agent keeps running under legacy semantics.
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("a legacy agent with leftover runtime rows stays assignable", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rA = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rA });

    delete process.env.MULTI_RUNTIME_ENABLED;
    makeRuntimeStale(rA);
    expireStaleRuntimeInstances();
    expect(getAgentById(id)?.status).toBe("idle");
  });
});

describe("runtime expiry retires the runtime, the classifier reclaims its work", () => {
  test("a crashed runtime's task is recovered by stall remediation while a sibling's survives", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const crashed = crypto.randomUUID();
    const live = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: crashed });
    await register(id, { maxTasks: 1, runtimeInstanceId: live });

    const crashedTask = createTaskExtended("crashed-work", { agentId: id });
    startTask(crashedTask.id);
    await startSessionFor(id, crashedTask.id, crashed);

    const liveTask = createTaskExtended("live-work", { agentId: id });
    startTask(liveTask.id);
    await startSessionFor(id, liveTask.id, live);

    // A replacement booting before the crash is noticed must not drop either.
    expect(await startupCleanupFor(id)).toBe(200);
    expect(getActiveSessionForTask(crashedTask.id)).not.toBeNull();
    expect(getActiveSessionForTask(liveTask.id)).not.toBeNull();

    // A genuinely crashed process stops both its runtime ping and its
    // session heartbeat — and its task stops progressing.
    makeRuntimeStale(crashed);
    makeSessionStale(crashedTask.id, 30);
    getDb()
      .prepare("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * 60000).toISOString(), crashedTask.id);

    // Expiry only retires the runtime — the session is evidence the stall
    // classifier owns, and it removes it when it remediates in the same sweep.
    const result = expireStaleRuntimeInstances();
    expect(result.expired).toBe(1);
    expect(getActiveSessionForTask(crashedTask.id)).not.toBeNull();

    await runHeartbeatSweep();

    expect(getTaskById(crashedTask.id)?.status).not.toBe("in_progress");
    expect(getActiveSessionForTask(crashedTask.id)).toBeNull();
    // The sibling's work is untouched throughout.
    expect(getActiveSessionForTask(liveTask.id)).not.toBeNull();
    expect(getTaskById(liveTask.id)?.status).toBe("in_progress");
    expect(getAgentById(id)?.status).toBe("busy");
  });
});

describe("flag re-enable cycle preserves live sessions", () => {
  test("a frozen runtime row does not kill a still-heartbeating session on re-enable", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    const task = createTaskExtended("in-flight-work", { agentId: id });
    startTask(task.id);
    await startSessionFor(id, task.id, rt);

    // Operator disables the flag: nothing refreshes runtime rows, but the
    // worker keeps executing and heartbeating its session.
    delete process.env.MULTI_RUNTIME_ENABLED;
    makeRuntimeStale(rt);

    // Re-enable past the stale window; the first sweep runs expiry.
    process.env.MULTI_RUNTIME_ENABLED = "true";
    await runHeartbeatSweep();

    // The frozen row is retired, but the live session and its task survive —
    // no supersede, no requeue, no duplicate execution.
    expect(getRuntimeInstanceById(rt)).toBeNull();
    expect(getActiveSessionForTask(task.id)).not.toBeNull();
    const after = getTaskById(task.id);
    expect(after?.status).toBe("in_progress");
    expect(after?.agentId).toBe(id);
    // The agent needs its next re-registration before it gets NEW work —
    // safety over availability; registration is the runtime revival path.
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("a quiet-but-healthy session survives the cycle even past the runtime cutoff", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    const task = createTaskExtended("quiet-work", { agentId: id });
    startTask(task.id);
    await startSessionFor(id, task.id, rt);

    delete process.env.MULTI_RUNTIME_ENABLED;
    makeRuntimeStale(rt);
    // Sessions heartbeat on tool activity only: a long model call or shell
    // command can be quiet past the runtime cutoff while the worker is fine.
    makeSessionStale(task.id, 7);

    process.env.MULTI_RUNTIME_ENABLED = "true";
    await runHeartbeatSweep();

    expect(getRuntimeInstanceById(rt)).toBeNull();
    expect(getActiveSessionForTask(task.id)).not.toBeNull();
    expect(getTaskById(task.id)?.status).toBe("in_progress");
    // No resume/supersede sibling was minted for the in-flight task.
    expect(getDb().prepare<{ c: number }, []>("SELECT COUNT(*) c FROM agent_tasks").get()?.c).toBe(
      1,
    );
  });

  test("a stale session heartbeat alone does not fail a task that is still progressing", async () => {
    // Guards against collapsing the classifier into "heartbeat older than N":
    // Case B requires the TASK to be stale too before remediation.
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    const task = createTaskExtended("progressing-work", { agentId: id });
    startTask(task.id);
    await startSessionFor(id, task.id, rt);

    delete process.env.MULTI_RUNTIME_ENABLED;
    makeRuntimeStale(rt);
    makeSessionStale(task.id, 20);
    // The task itself progressed recently (store-progress traffic).
    getDb()
      .prepare("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 10 * 60000).toISOString(), task.id);

    process.env.MULTI_RUNTIME_ENABLED = "true";
    await runHeartbeatSweep();

    expect(getActiveSessionForTask(task.id)).not.toBeNull();
    expect(getTaskById(task.id)?.status).toBe("in_progress");
  });

  test("a genuinely dead worker is still recovered across the same cycle", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    const task = createTaskExtended("dead-work", { agentId: id });
    startTask(task.id);
    await startSessionFor(id, task.id, rt);

    delete process.env.MULTI_RUNTIME_ENABLED;
    makeRuntimeStale(rt);
    // The process died: session heartbeat AND task progress both went stale.
    makeSessionStale(task.id, 30);
    getDb()
      .prepare("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * 60000).toISOString(), task.id);

    process.env.MULTI_RUNTIME_ENABLED = "true";
    await runHeartbeatSweep();

    // The classifier (not runtime expiry) reclaimed the work and its session.
    expect(getTaskById(task.id)?.status).not.toBe("in_progress");
    expect(getActiveSessionForTask(task.id)).toBeNull();
    expect(getRuntimeInstanceById(rt)).toBeNull();
  });

  test("while the flag stays off, expiry touches neither row nor session", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    const task = createTaskExtended("legacy-work", { agentId: id });
    startTask(task.id);
    await startSessionFor(id, task.id, rt);

    delete process.env.MULTI_RUNTIME_ENABLED;
    makeRuntimeStale(rt);

    const result = expireStaleRuntimeInstances();
    expect(result.expired).toBe(0);
    expect(getRuntimeInstanceById(rt)).not.toBeNull();
    expect(getActiveSessionForTask(task.id)).not.toBeNull();
  });
});

describe("runtime row retention", () => {
  test("repeated boot/retire cycles do not accumulate rows", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";

    for (let boot = 0; boot < 5; boot++) {
      const rt = crypto.randomUUID();
      await register(id, { maxTasks: 1, runtimeInstanceId: rt });
      await closeRuntime(id, rt);
      makeRuntimeStale(rt);
      expireStaleRuntimeInstances();
    }

    expect(runtimeInstancesFor(id)).toHaveLength(0);
  });

  test("a gracefully closed runtime is pruned once it goes stale", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await closeRuntime(id, rt);
    // Closed rows linger only until they age out of the liveness window.
    expect(getRuntimeInstanceById(rt)).not.toBeNull();

    makeRuntimeStale(rt);
    expireStaleRuntimeInstances();
    expect(getRuntimeInstanceById(rt)).toBeNull();
  });
});

describe("heartbeat ordering vs auto-assignment", () => {
  test("a dead runtime's agent is retired before pool assignment, leaving the task queued", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });

    // The worker dies without /close, so the agent still looks idle.
    makeRuntimeStale(rt);
    expect(getAgentById(id)?.status).toBe("idle");

    const task = createTaskExtended("pool-work");
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    await runHeartbeatSweep();

    // Expiry ran first, so the sweep never handed the task to a dead agent.
    expect(getAgentById(id)?.status).toBe("offline");
    expect(getTaskById(task.id)?.status).toBe("unassigned");
    expect(getTaskById(task.id)?.agentId ?? null).toBeNull();
  });
});

describe("sweep coverage and rollback inertness", () => {
  test("a cleanup-only tick still retires a dead runtime", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    makeRuntimeStale(rt);

    // No in-progress work and no queued pool task: the preflight gate treats
    // this tick as "nothing actionable", but expiry must still run.
    await runHeartbeatSweep();

    expect(getRuntimeInstanceById(rt)).toBeNull();
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("with the flag off, leftover runtime rows do not block pool assignment", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });

    // Rolled back; the legacy worker stops refreshing its retained row.
    delete process.env.MULTI_RUNTIME_ENABLED;
    makeRuntimeStale(rt);
    const task = createTaskExtended("pool-work-legacy");

    await runHeartbeatSweep();

    // The healthy legacy worker still receives the task.
    expect(getAgentById(id)?.status).not.toBe("offline");
    expect(getTaskById(task.id)?.agentId).toBe(id);
  });
});

describe("enabling the flag while workers are running", () => {
  test("a live session survives cleanup before its runtime has re-registered", async () => {
    const id = makeAgent(3);
    // Worker registered while the flag was off, so it has no runtime row, but
    // its sessions already carry the id it generated at boot.
    await register(id, { maxTasks: 2 });
    const runningRuntime = crypto.randomUUID();
    const task = createTaskExtended("in-flight-work", { agentId: id });
    startTask(task.id);

    process.env.MULTI_RUNTIME_ENABLED = "true";
    await startSessionFor(id, task.id, runningRuntime);

    // A sibling boots and runs startup cleanup before the original worker's
    // next re-registration materializes its runtime row.
    await register(id, { maxTasks: 2, runtimeInstanceId: crypto.randomUUID() });
    expect(await startupCleanupFor(id)).toBe(200);

    expect(getActiveSessionForTask(task.id)).not.toBeNull();
    expect(getTaskById(task.id)?.status).toBe("in_progress");
  });
});

describe("dispatch requires a live runtime", () => {
  test("a retired runtime is given no work while its replacement is", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const retired = crypto.randomUUID();
    const live = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: retired });
    await register(id, { maxTasks: 1, runtimeInstanceId: live });
    createTaskExtended("dispatch-work", { offeredTo: id });

    // The retired process reconnects after its row aged out.
    makeRuntimeStale(retired);
    const stalePoll = await pollAgent(id, retired);
    expect(stalePoll?.trigger ?? null).toBeNull();

    // Its replacement still gets the work.
    const livePoll = await pollAgent(id, live);
    expect(livePoll?.trigger?.type).toBe("task_offered");
  });

  test("polling without a runtime identity yields no work while the flag is on", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    await register(id, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });
    createTaskExtended("dispatch-work", { offeredTo: id });

    expect((await pollAgent(id))?.trigger ?? null).toBeNull();
  });
});

describe("capacity attribution for offers", () => {
  test("a lead's own capacity is not consumed by offers it created for a worker", () => {
    const lead = makeAgent(2);
    getDb().prepare("UPDATE agents SET isLead = 1 WHERE id = ?").run(lead);
    const worker = makeAgent(1);

    // POST /api/tasks records the creating lead in agentId while offering to
    // the worker; the review must count against the worker only.
    const task = createTaskExtended("offer", { offeredTo: worker });
    getDb()
      .prepare("UPDATE agent_tasks SET agentId = ?, status = 'reviewing' WHERE id = ?")
      .run(lead, task.id);

    expect(getActiveTaskCount(worker)).toBe(1);
    expect(getActiveTaskCount(lead)).toBe(0);
    expect(hasCapacity(lead)).toBe(true);
  });
});

describe("pool eligibility during activation", () => {
  test("an agent that has not re-registered since the flag was enabled is not assigned work", async () => {
    const id = makeAgent(2);
    // Registered while the flag was off, so it has no runtime row yet.
    await register(id, { maxTasks: 1 });

    process.env.MULTI_RUNTIME_ENABLED = "true";
    const task = createTaskExtended("pool-work");

    await runHeartbeatSweep();

    // Its polls return nothing until it re-registers, so assigning would
    // strand the task on it.
    expect(getTaskById(task.id)?.agentId ?? null).toBeNull();
    expect(getTaskById(task.id)?.status).toBe("unassigned");
  });

  test("once it re-registers with a runtime, it becomes eligible again", async () => {
    const id = makeAgent(2);
    await register(id, { maxTasks: 1 });

    process.env.MULTI_RUNTIME_ENABLED = "true";
    await register(id, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });
    const task = createTaskExtended("pool-work");

    await runHeartbeatSweep();
    expect(getTaskById(task.id)?.agentId).toBe(id);
  });
});

describe("readiness after a credential wait", () => {
  test("re-registering the same runtime id revives a runtime that expired during the wait", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    // Boot registration, then a long credential wait: the worker is not usable
    // capacity, so its runtime is allowed to expire and be pruned.
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    makeRuntimeStale(rt);
    expireStaleRuntimeInstances();
    expect(getRuntimeInstanceById(rt)).toBeNull();

    // Credentials arrive; the worker re-registers before polling, reusing the
    // per-boot identity rather than minting a new one.
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });

    expect(getRuntimeInstanceById(rt)?.status).toBe("active");
    expect(runtimeInstancesFor(id)).toHaveLength(1);
    expect(countActiveRuntimeInstancesForAgent(id)).toBe(1);
  });

  test("the revived runtime can immediately receive work", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    makeRuntimeStale(rt);
    expireStaleRuntimeInstances();

    // Before re-registration the gate correctly withholds work.
    createTaskExtended("post-credential-work", { offeredTo: id });
    expect((await pollAgent(id, rt))?.trigger ?? null).toBeNull();

    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    expect((await pollAgent(id, rt))?.trigger?.type).toBe("task_offered");
  });

  test("re-register then report recovers readiness on a runtime that went stale waiting", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    expect(await reportReady(id, rt, false)).toBe(200);
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");

    // The credential wait outlives the stale window; the sweep has not
    // pruned the row yet.
    makeRuntimeStale(rt);

    // The runner's post-wait sequence: revive the same per-boot identity
    // FIRST, then report readiness against the now-live row.
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    expect(await reportReady(id, rt, true)).toBe(200);

    expect(runtimeInstancesFor(id)).toHaveLength(1);
    expect(getRuntimeInstanceById(rt)?.credentialReady).toBe(true);
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("the recovered agent reports busy when it still holds active work", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await reportReady(id, rt, false);
    const task = createTaskExtended("held-work", { agentId: id });
    startTask(task.id);
    makeRuntimeStale(rt);

    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await reportReady(id, rt, true);

    expect(getRuntimeInstanceById(rt)?.credentialReady).toBe(true);
    expect(getAgentById(id)?.status).toBe("busy");
  });

  test("a transient registration failure delays but does not drop the recovery", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await reportReady(id, rt, false);
    makeRuntimeStale(rt);

    // The runner's recovery: retry the strict registration of the SAME
    // per-boot identity until it succeeds, and only then report ready.
    let attempts = 0;
    await retryBootStep(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("transient network failure");
        await register(id, { maxTasks: 1, runtimeInstanceId: rt });
      },
      { sleep: async () => {}, log: () => {} },
    );
    expect(await reportReady(id, rt, true)).toBe(200);

    expect(attempts).toBe(2);
    expect(runtimeInstancesFor(id)).toHaveLength(1);
    expect(getRuntimeInstanceById(rt)?.credentialReady).toBe(true);
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("recovery after several transient failures still ends busy with active work", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await reportReady(id, rt, false);
    const task = createTaskExtended("held-work", { agentId: id });
    startTask(task.id);
    makeRuntimeStale(rt);

    let attempts = 0;
    await retryBootStep(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient network failure");
        await register(id, { maxTasks: 1, runtimeInstanceId: rt });
      },
      { sleep: async () => {}, log: () => {} },
    );
    await reportReady(id, rt, true);

    expect(attempts).toBe(3);
    expect(runtimeInstancesFor(id)).toHaveLength(1);
    expect(getRuntimeInstanceById(rt)?.credentialReady).toBe(true);
    expect(getAgentById(id)?.status).toBe("busy");
  });

  test("persistent registration failure leaves the runtime unrecovered and undispatchable", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await reportReady(id, rt, false);
    makeRuntimeStale(rt);

    await expect(
      retryBootStep(
        async () => {
          throw new Error("registration endpoint down");
        },
        { attempts: 3, sleep: async () => {}, log: () => {} },
      ),
    ).rejects.toThrow("registration endpoint down");

    // Nothing was revived: the ready report still targets a stale row and the
    // dispatch gate still withholds work — polling has not resumed as if
    // recovery succeeded (the runner exits instead of entering the loop).
    await reportReady(id, rt, true);
    expect(getRuntimeInstanceById(rt)?.credentialReady).toBe(false);
    createTaskExtended("unreachable-work", { offeredTo: id });
    expect((await pollAgent(id, rt))?.trigger ?? null).toBeNull();
  });

  test("the boot readiness write retries through a transient failure", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await reportReady(id, rt, false);
    makeRuntimeStale(rt);

    // The runner's recovery sequence: registration first, then the readiness
    // write — BOTH retried, because after a stale revival the write is the
    // only transition out of waiting_for_credentials.
    await retryBootStep(() => register(id, { maxTasks: 1, runtimeInstanceId: rt }).then(() => {}), {
      sleep: async () => {},
      log: () => {},
    });
    let attempts = 0;
    await retryBootStep(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error("transient network failure");
        await sendCredStatusReport(baseUrl, API_KEY, id, rt, { ready: true, missing: [] });
      },
      { sleep: async () => {}, log: () => {} },
    );

    expect(attempts).toBe(2);
    expect(getRuntimeInstanceById(rt)?.credentialReady).toBe(true);
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("a rejected readiness write surfaces instead of being swallowed", async () => {
    // Multi-runtime mode 400s a report without runtime identity; the strict
    // sender must propagate that instead of reporting success.
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await reportReady(id, rt, false);

    await expect(
      sendCredStatusReport(baseUrl, API_KEY, id, undefined, { ready: true, missing: [] }),
    ).rejects.toThrow("credential-status report failed: 400");
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");
  });

  test("a ready report against a stale row is dropped and revival preserves the waiting state", async () => {
    // Pins the server contract behind the runner's ordering: reporting
    // BEFORE re-registering loses the recovery.
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await reportReady(id, rt, false);
    makeRuntimeStale(rt);

    // Wrong order: the report matches no live row and drops silently.
    await reportReady(id, rt, true);
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });

    expect(getRuntimeInstanceById(rt)?.credentialReady).toBe(false);
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");
  });

  test("re-registering before any expiry is idempotent and adds no second row", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    const before = getRuntimeInstanceById(rt);

    const { status } = await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    expect(status).toBe(200);
    expect(runtimeInstancesFor(id)).toHaveLength(1);
    expect(getRuntimeInstanceById(rt)?.status).toBe("active");
    expect(getRuntimeInstanceById(rt)?.createdAt).toBe(before?.createdAt ?? "");
  });

  test("with the flag off, the same re-registration writes no runtime rows", async () => {
    const id = makeAgent(2);
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 3, runtimeInstanceId: rt });
    await register(id, { maxTasks: 3, runtimeInstanceId: rt });

    expect(runtimeInstancesFor(id)).toHaveLength(0);
    expect(getAgentById(id)?.maxTasks).toBe(3);
  });
});

async function reportReady(
  agentId: string,
  runtimeInstanceId: string | undefined,
  ready: boolean,
): Promise<number> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": agentId,
    Authorization: `Bearer ${API_KEY}`,
  };
  if (runtimeInstanceId) headers["X-Runtime-Instance-ID"] = runtimeInstanceId;
  const res = await fetch(`${baseUrl}/api/agents/${agentId}/credential-status`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ready, missing: ready ? [] : ["ANTHROPIC_API_KEY"] }),
  });
  await res.text();
  return res.status;
}

describe("credential readiness is per runtime", () => {
  async function twoRuntimes(id: string) {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: a });
    await register(id, { maxTasks: 1, runtimeInstanceId: b });
    return { a, b };
  }

  test("a waiting runtime does not disable its ready sibling", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { a, b } = await twoRuntimes(id);

    expect(await reportReady(id, a, true)).toBe(200);
    expect(await reportReady(id, b, false)).toBe(200);

    expect(hasReadyLiveRuntime(id)).toBe(true);
    expect(getAgentById(id)?.status).not.toBe("waiting_for_credentials");
    // A can still be handed work.
    createTaskExtended("work", { offeredTo: id });
    expect((await pollAgent(id, a))?.trigger?.type).toBe("task_offered");
  });

  test("a ready report does not pull a busy agent back to idle", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { a, b } = await twoRuntimes(id);
    await reportReady(id, a, true);

    const task = createTaskExtended("work", { agentId: id });
    startTask(task.id);
    getDb().prepare("UPDATE agents SET status = 'busy' WHERE id = ?").run(id);

    await reportReady(id, b, true);
    expect(getAgentById(id)?.status).toBe("busy");
  });

  test("all live runtimes waiting parks the agent", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { a, b } = await twoRuntimes(id);
    await reportReady(id, a, false);
    await reportReady(id, b, false);

    expect(hasReadyLiveRuntime(id)).toBe(false);
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");
  });

  test("losing the only ready runtime falls back to the waiting sibling's state", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { a, b } = await twoRuntimes(id);
    await reportReady(id, a, true);
    await reportReady(id, b, false);
    expect(getAgentById(id)?.status).not.toBe("waiting_for_credentials");

    await closeRuntime(id, a);
    expect(hasReadyLiveRuntime(id)).toBe(false);
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");
  });

  test("a stale ready runtime stops counting toward readiness", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { a, b } = await twoRuntimes(id);
    await reportReady(id, a, true);
    await reportReady(id, b, false);

    makeRuntimeStale(a);
    expect(hasReadyLiveRuntime(id)).toBe(false);
  });

  test("losing the last runtime leaves the agent offline regardless of readiness", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { a, b } = await twoRuntimes(id);
    await reportReady(id, a, true);
    await reportReady(id, b, true);

    await closeRuntime(id, a);
    await closeRuntime(id, b);
    expect(getAgentById(id)?.status).toBe("offline");
    expect(hasReadyLiveRuntime(id)).toBe(false);
  });

  test("a runtime that never reports counts as ready (credential checks opted out)", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    await register(id, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });
    expect(hasReadyLiveRuntime(id)).toBe(true);
  });

  test("a readiness report without runtime identity is rejected and corrupts nothing", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { a } = await twoRuntimes(id);
    await reportReady(id, a, true);

    expect(await reportReady(id, undefined, false)).toBe(400);
    expect(hasReadyLiveRuntime(id)).toBe(true);
    expect(getAgentById(id)?.status).not.toBe("waiting_for_credentials");
  });

  test("a foreign runtime id cannot change this agent's readiness", async () => {
    const owner = makeAgent(2);
    const other = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { a } = await twoRuntimes(owner);
    await reportReady(owner, a, true);
    await register(other, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });

    expect(await reportReady(other, a, false)).toBe(200);
    expect(hasReadyLiveRuntime(owner)).toBe(true);
  });

  test("with the flag off, credential reporting keeps legacy semantics", async () => {
    const id = makeAgent(2);
    expect(await reportReady(id, undefined, false)).toBe(200);
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");
    expect(await reportReady(id, undefined, true)).toBe(200);
    expect(getAgentById(id)?.status).toBe("idle");
  });
});

describe("remediation respects runtime liveness", () => {
  test("recovering a stale task leaves a zero-runtime agent offline", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });

    const task = createTaskExtended("crashed-work", { agentId: id });
    startTask(task.id);
    await startSessionFor(id, task.id, rt);
    getDb()
      .prepare("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * 60000).toISOString(), task.id);
    // A crashed process stops both its runtime ping and its session heartbeat.
    makeRuntimeStale(rt);
    makeSessionStale(task.id);

    await runHeartbeatSweep();

    // The task recovers, but nothing is left to serve the agent.
    expect(getTaskById(task.id)?.status).not.toBe("in_progress");
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("a live sibling keeps the agent available through remediation", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const dead = crypto.randomUUID();
    const live = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: dead });
    await register(id, { maxTasks: 1, runtimeInstanceId: live });

    const task = createTaskExtended("crashed-work", { agentId: id });
    startTask(task.id);
    await startSessionFor(id, task.id, dead);
    getDb()
      .prepare("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * 60000).toISOString(), task.id);
    // A crashed process stops both its runtime ping and its session heartbeat.
    makeRuntimeStale(dead);
    makeSessionStale(task.id);

    await runHeartbeatSweep();
    expect(getAgentById(id)?.status).not.toBe("offline");
  });

  test("with the flag off, remediation restores idle as before", async () => {
    const id = makeAgent(2);
    const task = createTaskExtended("crashed-work", { agentId: id });
    startTask(task.id);
    getDb()
      .prepare("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 30 * 60000).toISOString(), task.id);

    await runHeartbeatSweep();
    expect(getAgentById(id)?.status).toBe("idle");
  });
});

describe("poll refreshes runtime liveness", () => {
  test("polling advances last_seen_at", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    const before = getRuntimeInstanceById(rt);

    await Bun.sleep(10);
    await pollAgent(id, rt);
    const after = getRuntimeInstanceById(rt);
    expect(after && before && after.lastSeenAt > before.lastSeenAt).toBe(true);
  });

  test("a worker polling keeps itself live under a short stale threshold", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    process.env.RUNTIME_STALE_THRESHOLD_MIN = "1";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });

    // Almost past the cutoff, then a poll — as the inner loop would do.
    makeRuntimeStale(rt, 0.9);
    await pollAgent(id, rt);
    expect(expireStaleRuntimeInstances().expired).toBe(0);
    expect(countActiveRuntimeInstancesForAgent(id)).toBe(1);
    delete process.env.RUNTIME_STALE_THRESHOLD_MIN;
  });

  test("polling cannot revive an expired runtime", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    makeRuntimeStale(rt);

    expect((await pollAgent(id, rt))?.trigger ?? null).toBeNull();
    // Still stale: the refresh only matches an already-live row.
    expect(countActiveRuntimeInstancesForAgent(id)).toBe(0);
    expireStaleRuntimeInstances();
    expect(getRuntimeInstanceById(rt)).toBeNull();
    expect((await pollAgent(id, rt))?.trigger ?? null).toBeNull();
    expect(getRuntimeInstanceById(rt)).toBeNull();
  });

  test("a foreign runtime id refreshes nothing", async () => {
    const id1 = makeAgent(2);
    const id2 = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const r1 = crypto.randomUUID();
    await register(id1, { maxTasks: 1, runtimeInstanceId: r1 });
    await register(id2, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });
    const before = getRuntimeInstanceById(r1);

    await Bun.sleep(10);
    await pollAgent(id2, r1);
    expect(getRuntimeInstanceById(r1)?.lastSeenAt).toBe(before?.lastSeenAt ?? "");
  });
});

/** Invoke MCP poll-task the way a worker process would, via request context. */
async function pollTask(agentId: string, runtimeInstanceId?: string, onNotify?: () => void) {
  const handler = mcpServer.handlers.get("poll-task");
  if (!handler) throw new Error("poll-task not registered");
  const headers: Record<string, string> = { "x-agent-id": agentId };
  if (runtimeInstanceId) headers["x-runtime-instance-id"] = runtimeInstanceId;
  return (await handler(
    {},
    {
      sessionId: "test-session",
      requestInfo: { headers },
      // Fires between dispatch attempts — tests use it to mutate state
      // mid-long-poll.
      sendNotification: async () => {
        onNotify?.();
      },
    },
  )) as { structuredContent?: { task?: { id?: string } } };
}

function startedTaskId(result: { structuredContent?: { task?: { id?: string } } }) {
  return result?.structuredContent?.task?.id ?? null;
}

describe("expiry reconciles the surviving runtime set", () => {
  async function readyAndWaiting(id: string) {
    const ready = crypto.randomUUID();
    const waiting = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: ready });
    await register(id, { maxTasks: 1, runtimeInstanceId: waiting });
    await reportReady(id, ready, true);
    await reportReady(id, waiting, false);
    return { ready, waiting };
  }

  test("expiring the only ready runtime parks the agent", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { ready } = await readyAndWaiting(id);
    expect(getAgentById(id)?.status).not.toBe("waiting_for_credentials");

    makeRuntimeStale(ready);
    expireStaleRuntimeInstances();
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");
  });

  test("expiring a waiting runtime leaves a ready sibling available", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { waiting } = await readyAndWaiting(id);

    makeRuntimeStale(waiting);
    expireStaleRuntimeInstances();
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("a busy agent stays busy when a waiting runtime expires", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { waiting } = await readyAndWaiting(id);
    const task = createTaskExtended("work", { agentId: id });
    startTask(task.id);

    makeRuntimeStale(waiting);
    expireStaleRuntimeInstances();
    expect(getAgentById(id)?.status).toBe("busy");
  });

  test("expiring the last runtime is still offline", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { ready, waiting } = await readyAndWaiting(id);
    makeRuntimeStale(ready);
    makeRuntimeStale(waiting);
    expireStaleRuntimeInstances();
    expect(getAgentById(id)?.status).toBe("offline");
  });

  test("the sweep does not assign pool work when only a waiting runtime survives", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { ready } = await readyAndWaiting(id);
    makeRuntimeStale(ready);
    const task = createTaskExtended("pool-work");

    await runHeartbeatSweep();
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");
    expect(getTaskById(task.id)?.agentId ?? null).toBeNull();
  });
});

describe("registration reconciles the agent", () => {
  test("a new runtime lifts a waiting agent out of waiting", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const waiting = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: waiting });
    await reportReady(id, waiting, false);
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");

    // Credential checks disabled on the newcomer: never reports, counts ready.
    await register(id, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("registration does not force idle over active work", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const waiting = crypto.randomUUID();
    await register(id, { maxTasks: 2, runtimeInstanceId: waiting });
    await reportReady(id, waiting, false);
    const task = createTaskExtended("work", { agentId: id });
    startTask(task.id);

    await register(id, { maxTasks: 2, runtimeInstanceId: crypto.randomUUID() });
    expect(getAgentById(id)?.status).toBe("busy");
  });

  test("registering another waiting runtime keeps the agent parked", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: a });
    await register(id, { maxTasks: 1, runtimeInstanceId: b });
    await reportReady(id, a, false);
    await reportReady(id, b, false);
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");

    await register(id, { maxTasks: 1, runtimeInstanceId: b });
    expect(getAgentById(id)?.status).toBe("waiting_for_credentials");
    expect(runtimeInstancesFor(id)).toHaveLength(2);
  });

  test("an offline agent comes back when a runtime registers", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await closeRuntime(id, rt);
    expect(getAgentById(id)?.status).toBe("offline");

    await register(id, { maxTasks: 1, runtimeInstanceId: crypto.randomUUID() });
    expect(getAgentById(id)?.status).toBe("idle");
  });

  test("with the flag off, registration does not touch status", async () => {
    const id = makeAgent(2);
    getDb().prepare("UPDATE agents SET status = 'busy' WHERE id = ?").run(id);
    await register(id, { maxTasks: 2, runtimeInstanceId: crypto.randomUUID() });
    expect(getAgentById(id)?.status).toBe("busy");
  });
});

describe("MCP poll-task requires a live runtime", () => {
  test("with the flag off it dispatches as before", async () => {
    const id = makeAgent(1);
    const task = createTaskExtended("mcp-work", { agentId: id });
    expect(startedTaskId(await pollTask(id))).toBe(task.id);
  });

  test("a valid live runtime can dispatch", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    const task = createTaskExtended("mcp-work", { agentId: id });
    expect(startedTaskId(await pollTask(id, rt))).toBe(task.id);
  });

  test("missing, unknown and foreign runtime identities get no work", async () => {
    const id = makeAgent(1);
    const other = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await register(other, { maxTasks: 1, runtimeInstanceId: foreign });
    const task = createTaskExtended("mcp-work", { agentId: id });

    expect(startedTaskId(await pollTask(id))).toBeNull();
    expect(startedTaskId(await pollTask(id, crypto.randomUUID()))).toBeNull();
    expect(startedTaskId(await pollTask(id, foreign))).toBeNull();
    expect(getTaskById(task.id)?.status).toBe("pending");
  });

  test("an expired runtime cannot dispatch and is not revived", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    createTaskExtended("mcp-work", { agentId: id });
    makeRuntimeStale(rt);

    expect(startedTaskId(await pollTask(id, rt))).toBeNull();
    expect(countActiveRuntimeInstancesForAgent(id)).toBe(0);
    expireStaleRuntimeInstances();
    expect(startedTaskId(await pollTask(id, rt))).toBeNull();
    expect(getRuntimeInstanceById(rt)).toBeNull();
  });

  test("a retired process cannot work beside its replacement", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const oldRt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: oldRt });
    makeRuntimeStale(oldRt);
    expireStaleRuntimeInstances();
    const newRt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: newRt });
    const task = createTaskExtended("mcp-work", { agentId: id });

    expect(startedTaskId(await pollTask(id, oldRt))).toBeNull();
    expect(startedTaskId(await pollTask(id, newRt))).toBe(task.id);
  });

  test("a poll-task call refreshes its runtime's liveness", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    // A task makes the call return immediately instead of entering the wait.
    createTaskExtended("mcp-work", { agentId: id });
    const before = getRuntimeInstanceById(rt);

    await Bun.sleep(10);
    await pollTask(id, rt);
    const after = getRuntimeInstanceById(rt);
    expect(after && before && after.lastSeenAt > before.lastSeenAt).toBe(true);
  });
});

describe("logical capacity is shared across dispatch entrypoints", () => {
  test("maxTasks=1 admits one task across concurrent HTTP and MCP polls", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const httpRt = crypto.randomUUID();
    const mcpRt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: httpRt });
    await register(id, { maxTasks: 1, runtimeInstanceId: mcpRt });
    // One task per entrypoint's preferred shape, both against the same limit.
    createTaskExtended("offered-work", { offeredTo: id });
    createTaskExtended("pending-work", { agentId: id });

    const [httpResult, mcpResult] = await Promise.all([pollAgent(id, httpRt), pollTask(id, mcpRt)]);

    const admitted = (httpResult?.trigger?.type ? 1 : 0) + (startedTaskId(mcpResult) ? 1 : 0);
    expect(admitted).toBe(1);
    expect(getActiveTaskCount(id)).toBe(1);
  });

  test("maxTasks=1 admits one pending task across concurrent MCP polls", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rtA = crypto.randomUUID();
    const rtB = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rtA });
    await register(id, { maxTasks: 1, runtimeInstanceId: rtB });
    // Two already-pending assignments: both runtimes pass the liveness gate,
    // so only the in-transaction capacity check keeps the second one out.
    const first = createTaskExtended("pending-one", { agentId: id });
    const second = createTaskExtended("pending-two", { agentId: id });

    const [a, b] = await Promise.all([pollTask(id, rtA), pollTask(id, rtB)]);

    const started = [startedTaskId(a), startedTaskId(b)].filter(Boolean);
    expect(started).toHaveLength(1);
    expect(getActiveTaskCount(id)).toBe(1);
    // The blocked task stays pending for whenever capacity frees up.
    const statuses = [getTaskById(first.id)?.status, getTaskById(second.id)?.status].sort();
    expect(statuses).toEqual(["in_progress", "pending"]);
  });

  test("maxTasks=2 lets two live runtimes start both pending tasks", async () => {
    const id = makeAgent(2);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rtA = crypto.randomUUID();
    const rtB = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rtA });
    await register(id, { maxTasks: 1, runtimeInstanceId: rtB });
    createTaskExtended("pending-one", { agentId: id });
    createTaskExtended("pending-two", { agentId: id });

    const [a, b] = await Promise.all([pollTask(id, rtA), pollTask(id, rtB)]);

    expect(startedTaskId(a)).not.toBeNull();
    expect(startedTaskId(b)).not.toBeNull();
    expect(startedTaskId(a)).not.toBe(startedTaskId(b));
    expect(getActiveTaskCount(id)).toBe(2);
  });
});

describe("MCP poll-task revalidates the runtime at dispatch", () => {
  test("a runtime retired mid-poll cannot start work that appears later; a live sibling can", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rtA = crypto.randomUUID();
    const rtB = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rtA });
    await register(id, { maxTasks: 1, runtimeInstanceId: rtB });

    // A enters the long poll with nothing to do; while it waits, its runtime
    // is retired and a pending task appears.
    let taskId: string | undefined;
    let mutated = false;
    const result = await pollTask(id, rtA, () => {
      if (mutated) return;
      mutated = true;
      makeRuntimeStale(rtA);
      taskId = createTaskExtended("mid-poll-work", { agentId: id }).id;
    });

    // The retired poller exits without acquiring the task and without
    // advancing the empty-poll exit counter.
    expect(startedTaskId(result)).toBeNull();
    expect(taskId && getTaskById(taskId)?.status).toBe("pending");
    expect(getAgentById(id)?.emptyPollCount ?? 0).toBe(0);

    // The live sibling picks it up normally.
    expect(taskId && startedTaskId(await pollTask(id, rtB))).toBe(taskId);
    expect(getActiveTaskCount(id)).toBe(1);
  });

  test("a runtime closed mid-poll is not revived by the in-flight call", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });

    let taskId: string | undefined;
    let mutated = false;
    const result = await pollTask(id, rt, () => {
      if (mutated) return;
      mutated = true;
      getDb().prepare("UPDATE runtime_instances SET status = 'offline' WHERE id = ?").run(rt);
      taskId = createTaskExtended("post-close-work", { agentId: id }).id;
    });

    expect(startedTaskId(result)).toBeNull();
    expect(taskId && getTaskById(taskId)?.status).toBe("pending");
    // Still offline — the dispatch revalidation cannot resurrect it.
    expect(getRuntimeInstanceById(rt)?.status).toBe("offline");
  });
});

describe("MCP task-action claim requires a live runtime", () => {
  async function claim(agentId: string, taskId: string, runtimeInstanceId?: string) {
    const handler = mcpServer.handlers.get("task-action");
    if (!handler) throw new Error("task-action not registered");
    const headers: Record<string, string> = { "x-agent-id": agentId };
    if (runtimeInstanceId) headers["x-runtime-instance-id"] = runtimeInstanceId;
    return (await handler(
      { action: "claim", taskId },
      {
        sessionId: "test-session",
        requestInfo: { headers },
        sendNotification: async () => {},
      },
    )) as { isError?: boolean };
  }

  test("an expired runtime cannot claim, a live one can", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const dead = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: dead });
    makeRuntimeStale(dead);
    expireStaleRuntimeInstances();
    const task = createTaskExtended("pool-claim");

    await claim(id, task.id, dead);
    expect(getTaskById(task.id)?.agentId ?? null).toBeNull();

    const live = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: live });
    await claim(id, task.id, live);
    expect(getTaskById(task.id)?.agentId).toBe(id);
  });

  test("with the flag off, claiming works without runtime identity", async () => {
    const id = makeAgent(1);
    const task = createTaskExtended("pool-claim");
    await claim(id, task.id);
    expect(getTaskById(task.id)?.agentId).toBe(id);
  });
});

describe("MCP task-action accept requires a live runtime", () => {
  async function accept(agentId: string, taskId: string, runtimeInstanceId?: string) {
    const handler = mcpServer.handlers.get("task-action");
    if (!handler) throw new Error("task-action not registered");
    const headers: Record<string, string> = { "x-agent-id": agentId };
    if (runtimeInstanceId) headers["x-runtime-instance-id"] = runtimeInstanceId;
    return (await handler(
      { action: "accept", taskId },
      {
        sessionId: "test-session",
        requestInfo: { headers },
        sendNotification: async () => {},
      },
    )) as { isError?: boolean };
  }

  test("an expired runtime cannot accept and is not revived", async () => {
    const id = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const dead = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: dead });
    makeRuntimeStale(dead);
    expireStaleRuntimeInstances();
    const task = createTaskExtended("offered-work", { offeredTo: id });

    await accept(id, task.id, dead);
    expect(getTaskById(task.id)?.status).toBe("offered");
    expect(getRuntimeInstanceById(dead)).toBeNull();
  });

  test("missing and foreign runtime identities cannot accept; the owning live one can", async () => {
    const id = makeAgent(1);
    const other = makeAgent(1);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: rt });
    await register(other, { maxTasks: 1, runtimeInstanceId: foreign });
    const task = createTaskExtended("offered-work", { offeredTo: id });

    await accept(id, task.id);
    expect(getTaskById(task.id)?.status).toBe("offered");
    await accept(id, task.id, foreign);
    expect(getTaskById(task.id)?.status).toBe("offered");

    await accept(id, task.id, rt);
    expect(getTaskById(task.id)?.status).toBe("pending");
    expect(getTaskById(task.id)?.agentId).toBe(id);
  });

  test("with the flag off, accepting works without runtime identity", async () => {
    const id = makeAgent(1);
    const task = createTaskExtended("offered-work", { offeredTo: id });
    await accept(id, task.id);
    expect(getTaskById(task.id)?.status).toBe("pending");
    expect(getTaskById(task.id)?.agentId).toBe(id);
  });
});
