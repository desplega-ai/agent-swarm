/**
 * Multi-runtime registration and lifecycle, exercised through the real HTTP
 * handlers on both sides of MULTI_RUNTIME_ENABLED.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  AGENT_MAX_TASKS_CONFIG_KEY,
  closeDb,
  createAgent,
  getAgentById,
  getAgentMaxTasksConfig,
  getDb,
  getRuntimeInstanceById,
  getRuntimeInstancesForAgent,
  getSwarmConfigs,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { handleAgentRegister } from "../http/agents";
import { handleConfig } from "../http/config";
import { handleCore } from "../http/core";
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
  getDb().prepare("DELETE FROM agents").run();
  getDb().prepare("DELETE FROM swarm_config").run();
  // set-config is lead-gated; the MCP mirror tests call it as this lead.
  createAgent({ id: LEAD_ID, name: "mr-lead", isLead: true, status: "idle", capabilities: [] });
});

// ─── Migration 131 ──────────────────────────────────────────────────────────

describe("migration 131_runtime_instances", () => {
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
    expect(getRuntimeInstancesForAgent(id)).toHaveLength(0);
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

  test("a brand-new agent starts at the default policy, not the first runtime's capacity", async () => {
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const id = crypto.randomUUID();
    const rt = crypto.randomUUID();
    const { status, agent } = await register(id, { maxTasks: 7, runtimeInstanceId: rt });
    expect(status).toBe(201);
    expect(agent.maxTasks).toBe(1);
    expect(getAgentById(id)?.maxTasks).toBe(1);
    expect(getAgentMaxTasksConfig(id)?.value).toBe("1");
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

    const instances = getRuntimeInstancesForAgent(id);
    expect(instances).toHaveLength(2);
    const byId = new Map(instances.map((i) => [i.id, i]));
    expect(byId.get(r1)?.reportedSlots).toBe(2);
    expect(byId.get(r2)?.reportedSlots).toBe(6);
    for (const instance of instances) {
      expect(instance.agentId).toBe(id);
      expect(instance.status).toBe("active");
    }
  });

  test("a re-registration from the same runtime refreshes its row in place", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const rt = crypto.randomUUID();
    await register(id, { maxTasks: 2, runtimeInstanceId: rt });
    await register(id, { maxTasks: 4, runtimeInstanceId: rt });

    const instances = getRuntimeInstancesForAgent(id);
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
    expect(getRuntimeInstancesForAgent(other)).toHaveLength(0);
  });

  test("registration without a runtimeInstanceId is rejected with 400 when the flag is on", async () => {
    const id = makeAgent(3);
    process.env.MULTI_RUNTIME_ENABLED = "true";
    const { status } = await register(id, { maxTasks: 5 });
    expect(status).toBe(400);
    expect(getAgentById(id)?.maxTasks).toBe(3);
    expect(getAgentMaxTasksConfig(id)).toBeNull();
    expect(getRuntimeInstancesForAgent(id)).toHaveLength(0);
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
    expect(getRuntimeInstancesForAgent(id)).toHaveLength(0);
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
    expect(getRuntimeInstancesForAgent(id)).toHaveLength(1);
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
