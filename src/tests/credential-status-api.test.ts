import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, initDb } from "../be/db";
import { handleAgentsRest } from "../http/agents";
import { getPathSegments, parseQueryParams } from "../http/utils";

/**
 * Phase 4 of the worker credential safe-loop plan
 * (thoughts/taras/plans/2026-05-06-worker-credential-safe-loop.md).
 *
 * Verifies the three new endpoints from src/http/agents.ts:
 *
 *   PUT /api/agents/:id/credential-status   — worker self-report
 *   GET /api/agents/:id/credential-status   — single-agent dashboard read
 *   GET /api/agents/credential-status       — bulk dashboard read (with optional ?status= filter)
 *
 * The bulk route ordering matters — it MUST match before the single-agent
 * route or the literal `credential-status` would be parsed as an agent id.
 */

const TEST_DB_PATH = "./test-credential-status-api.sqlite";
const TEST_PORT = 13041 + (process.pid % 1000);

function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    const url = req.url || "/";
    const pathSegments = getPathSegments(url);
    const queryParams = parseQueryParams(url);

    const handled = await handleAgentsRest(req, res, pathSegments, queryParams, undefined);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
}

describe("Phase 4 — credential-status HTTP endpoints", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;
  const readyAgentName = "api-ready";
  const blockedAgentName = "api-blocked";
  let readyAgentId = "";
  let blockedAgentId = "";

  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // first run
    }
    initDb(TEST_DB_PATH);

    // Seed two agents — one will stay idle, one will be flipped to
    // waiting_for_credentials via the PUT endpoint below.
    readyAgentId = createAgent({
      name: readyAgentName,
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 1,
    }).id;
    blockedAgentId = createAgent({
      name: blockedAgentName,
      isLead: false,
      status: "idle",
      capabilities: [],
      maxTasks: 1,
    }).id;

    server = createTestServer();
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDb();
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // best-effort
    }
  });

  test("PUT /api/agents/:id/credential-status (ready=false) parks the agent", async () => {
    const resp = await fetch(`${baseUrl}/api/agents/${blockedAgentId}/credential-status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ready: false, missing: ["CLAUDE_CODE_OAUTH_TOKEN"] }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { id: string; status: string; credentialMissing: string[] };
    expect(body.status).toBe("waiting_for_credentials");
    expect(body.credentialMissing).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  test("GET /api/agents/:id/credential-status returns the single-agent payload", async () => {
    const resp = await fetch(`${baseUrl}/api/agents/${blockedAgentId}/credential-status`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      agentId: string;
      name: string;
      status: string;
      missing: string[];
      lastCheckedAt: string;
    };
    expect(body.agentId).toBe(blockedAgentId);
    expect(body.name).toBe(blockedAgentName);
    expect(body.status).toBe("waiting_for_credentials");
    expect(body.missing).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(typeof body.lastCheckedAt).toBe("string");
  });

  test("GET /api/agents/credential-status (bulk) returns every agent", async () => {
    const resp = await fetch(`${baseUrl}/api/agents/credential-status`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      agents: Array<{ agentId: string; status: string; missing: string[] }>;
    };
    expect(body.agents.length).toBeGreaterThanOrEqual(2);
    const ids = body.agents.map((a) => a.agentId);
    expect(ids).toContain(readyAgentId);
    expect(ids).toContain(blockedAgentId);
  });

  test("GET /api/agents/credential-status?status=waiting_for_credentials filters to blocked agents only", async () => {
    const resp = await fetch(
      `${baseUrl}/api/agents/credential-status?status=waiting_for_credentials`,
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      agents: Array<{ agentId: string; status: string; missing: string[] }>;
    };
    const ids = body.agents.map((a) => a.agentId);
    expect(ids).toContain(blockedAgentId);
    expect(ids).not.toContain(readyAgentId);
    for (const a of body.agents) {
      expect(a.status).toBe("waiting_for_credentials");
    }
  });

  test("PUT /api/agents/:id/credential-status (ready=true) clears the missing list", async () => {
    const resp = await fetch(`${baseUrl}/api/agents/${blockedAgentId}/credential-status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ready: true }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      status: string;
      credentialMissing: string[] | null;
    };
    expect(body.status).toBe("idle");
    expect(body.credentialMissing).toBeNull();

    // Bulk endpoint should now report this agent as idle, not waiting.
    const bulk = await fetch(`${baseUrl}/api/agents/credential-status`);
    const bulkBody = (await bulk.json()) as {
      agents: Array<{ agentId: string; status: string }>;
    };
    const blocked = bulkBody.agents.find((a) => a.agentId === blockedAgentId);
    expect(blocked!.status).toBe("idle");
  });

  test("GET single-agent endpoint returns 404 for unknown id", async () => {
    const resp = await fetch(`${baseUrl}/api/agents/does-not-exist/credential-status`);
    expect(resp.status).toBe(404);
  });

  test("PUT 404 for unknown id", async () => {
    const resp = await fetch(`${baseUrl}/api/agents/does-not-exist/credential-status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ready: false, missing: ["X"] }),
    });
    expect(resp.status).toBe(404);
  });

  // Migration 055 — round-trip the new `cred_status` field.
  test("PUT /credential-status round-trips a cred_status snapshot", async () => {
    const snapshot = {
      ready: true,
      missing: [],
      satisfiedBy: "env" as const,
      hint: null,
      liveTest: { ok: true, error: null, latency_ms: 91, testedAt: Date.now() },
      reportedAt: Date.now(),
      reportKind: "boot" as const,
    };
    const put = await fetch(`${baseUrl}/api/agents/${readyAgentId}/credential-status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ready: true, missing: [], cred_status: snapshot }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${baseUrl}/api/agents/${readyAgentId}/credential-status`);
    const body = (await get.json()) as {
      credStatus: typeof snapshot | null;
    };
    expect(body.credStatus).toMatchObject({
      ready: true,
      satisfiedBy: "env",
      reportKind: "boot",
      liveTest: { ok: true, latency_ms: 91 },
    });
  });

  test("PUT rejects a malformed cred_status payload (Zod validation)", async () => {
    const resp = await fetch(`${baseUrl}/api/agents/${readyAgentId}/credential-status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ready: true,
        cred_status: { ready: "not-a-boolean", reportedAt: Date.now() }, // bad shape
      }),
    });
    expect(resp.status).toBe(400);
  });

  test("PUT /credential-status merges latest_model without clobbering readiness", async () => {
    const snapshot = {
      ready: true,
      missing: [],
      satisfiedBy: "env" as const,
      hint: null,
      liveTest: { ok: true, error: null, latency_ms: 45, testedAt: Date.now() },
      reportedAt: Date.now(),
      reportKind: "boot" as const,
    };
    await fetch(`${baseUrl}/api/agents/${readyAgentId}/credential-status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ready: true, missing: [], cred_status: snapshot }),
    });

    const modelReport = {
      model: "gpt-5.4",
      source: "agent_config" as const,
      taskId: "task-123",
      harnessProvider: "codex" as const,
      reportedAt: Date.now(),
    };
    const put = await fetch(`${baseUrl}/api/agents/${readyAgentId}/credential-status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latest_model: modelReport }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${baseUrl}/api/agents/${readyAgentId}/credential-status`);
    const body = (await get.json()) as {
      credStatus: typeof snapshot & { latestModel?: typeof modelReport };
    };
    expect(body.credStatus.ready).toBe(true);
    expect(body.credStatus.liveTest).toMatchObject({ ok: true, latency_ms: 45 });
    expect(body.credStatus.latestModel).toMatchObject({ model: "gpt-5.4", source: "agent_config" });
  });
});
