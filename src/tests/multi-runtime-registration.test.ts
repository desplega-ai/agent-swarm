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
} from "../be/multi-runtime";
import { runHeartbeatSweep } from "../heartbeat/heartbeat";
import { handleActiveSessions } from "../http/active-sessions";
import { handleAgentRegister } from "../http/agents";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
import { handlePoll } from "../http/poll";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { registerSetConfigTool } from "../tools/swarm-config/set-config";
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

  test("a stale runtime's abandoned session is still cleared on the next startup", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const crashed = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: crashed });

    const task = createTaskExtended("work", { agentId: id });
    startTask(task.id);
    await startSession(id, task.id, crashed);
    // The crashed process stopped both its runtime ping and its session
    // heartbeat.
    makeRuntimeStale(crashed);
    makeSessionStale(task.id);

    const replacement = crypto.randomUUID();
    await register(id, { maxTasks: 1, runtimeInstanceId: replacement });
    expect(await startupCleanup(id)).toBe(200);

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

describe("runtime expiry releases what the runtime held", () => {
  test("an expired runtime's session is removed while a sibling's is kept", async () => {
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

    makeRuntimeStale(crashed);
    const result = expireStaleRuntimeInstances();
    expect(result.sessionsCleaned).toBe(1);

    // Only the dead runtime's session goes; its task is now visible to the
    // normal orphan/stall recovery paths.
    expect(getActiveSessionForTask(crashedTask.id)).toBeNull();
    expect(getActiveSessionForTask(liveTask.id)).not.toBeNull();
    expect(getTaskById(liveTask.id)?.status).toBe("in_progress");
    expect(getAgentById(id)?.status).toBe("idle");
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
