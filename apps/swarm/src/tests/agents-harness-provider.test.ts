/**
 * Phase 1.5 (cloud-personalization): per-agent harness_provider column +
 * worker registration push + PATCH /api/agents/:id/harness-provider.
 *
 * Coverage:
 *   - Migration applies cleanly (the test bootstrap runs `initDb` which
 *     applies all migrations forward-only; existence of the column is
 *     verified via PRAGMA below).
 *   - Worker registration with `harness_provider` writes the column.
 *   - Re-registration updates the column when the value changes.
 *   - `PATCH /api/agents/:id/harness-provider` updates the column.
 *   - Invalid provider names rejected with 400.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  deleteSwarmConfigByKey,
  getAgentById,
  getAgentHarnessProviders,
  getDb,
  getSwarmConfigs,
  initDb,
  setAgentHarnessProvider,
  upsertSwarmConfig,
} from "../be/db";
import { handleAgentRegister, handleAgentsRest } from "../http/agents";

const TEST_DB_PATH = "./test-agents-harness-provider.sqlite";
const TEST_PORT = 13059 + (process.pid % 1000);

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function makeTestServer(): Server {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const queryParams = url.searchParams;
    const myAgentId = (req.headers["x-agent-id"] as string | undefined) ?? undefined;

    try {
      if (await handleAgentRegister(req, res, pathSegments, myAgentId)) return;
      if (await handleAgentsRest(req, res, pathSegments, queryParams, myAgentId)) return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

let server: Server;
const baseUrl = `http://localhost:${TEST_PORT}`;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = makeTestServer();
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
});

beforeEach(() => {
  // Each test starts on an empty agents table.
  getDb().prepare("DELETE FROM agents").run();
  getDb().prepare("DELETE FROM swarm_config").run();
});

// ─── Migration: column exists ────────────────────────────────────────────────

describe("migration 054_agent_harness_provider", () => {
  test("`harness_provider` column exists on the `agents` table", () => {
    const cols = getDb()
      .prepare<{ name: string }, []>(`PRAGMA table_info(agents)`)
      .all()
      .map((r) => r.name);
    expect(cols).toContain("harness_provider");
  });

  test("existing agent rows default to NULL `harness_provider`", () => {
    const a = createAgent({
      name: "legacy-agent",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    expect(a.harnessProvider).toBeNull();
  });
});

// ─── DB helpers ──────────────────────────────────────────────────────────────

describe("DB helpers", () => {
  test("setAgentHarnessProvider writes and returns the updated row", () => {
    const a = createAgent({ name: "a1", isLead: false, status: "idle", capabilities: [] });
    expect(a.harnessProvider).toBeNull();

    const updated = setAgentHarnessProvider(a.id, "codex");
    expect(updated?.harnessProvider).toBe("codex");

    const fetched = getAgentById(a.id);
    expect(fetched?.harnessProvider).toBe("codex");
  });

  test("setAgentHarnessProvider can clear the column with null", () => {
    const a = createAgent({
      name: "a-clear",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "claude",
    });
    expect(a.harnessProvider).toBe("claude");

    const updated = setAgentHarnessProvider(a.id, null);
    expect(updated?.harnessProvider).toBeNull();
  });

  test("setAgentHarnessProvider returns null when agent not found", () => {
    const result = setAgentHarnessProvider("nonexistent-id", "claude");
    expect(result).toBeNull();
  });

  test("getAgentHarnessProviders aggregates by provider, excluding NULL", () => {
    createAgent({
      name: "x1",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "claude",
    });
    createAgent({
      name: "x2",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "claude",
    });
    createAgent({
      name: "x3",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "codex",
    });
    createAgent({ name: "x4", isLead: false, status: "idle", capabilities: [] }); // NULL — excluded

    const counts = getAgentHarnessProviders();
    expect(counts).toEqual([
      { provider: "claude", count: 2 },
      { provider: "codex", count: 1 },
    ]);
  });
});

// ─── Worker registration: HTTP path ──────────────────────────────────────────

describe("POST /api/agents — worker registration pushes harness_provider", () => {
  test("first-time register persists harness_provider", async () => {
    const agentId = "agent-register-1";
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
      body: JSON.stringify({
        name: "worker-fresh",
        isLead: false,
        harness_provider: "claude",
      }),
    });
    expect(res.status).toBe(201);

    const row = getAgentById(agentId);
    expect(row?.harnessProvider).toBe("claude");
  });

  test("re-register with a different harness_provider updates the column", async () => {
    const agentId = "agent-register-2";
    // First register with claude.
    await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
      body: JSON.stringify({ name: "worker-rotating", isLead: false, harness_provider: "claude" }),
    });

    // Re-register with codex.
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
      body: JSON.stringify({ name: "worker-rotating", isLead: false, harness_provider: "codex" }),
    });
    expect(res.status).toBe(200);

    const row = getAgentById(agentId);
    expect(row?.harnessProvider).toBe("codex");
  });

  test("registration WITHOUT harness_provider leaves an existing column value untouched", async () => {
    const agentId = "agent-register-3";
    // First register with claude.
    await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
      body: JSON.stringify({ name: "worker-quiet", isLead: false, harness_provider: "claude" }),
    });

    // Re-register without harness_provider (older worker).
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
      body: JSON.stringify({ name: "worker-quiet", isLead: false }),
    });
    expect(res.status).toBe(200);

    // Existing value preserved (so PATCH overrides aren't clobbered by
    // older workers re-registering without the field).
    const row = getAgentById(agentId);
    expect(row?.harnessProvider).toBe("claude");
  });

  test("rejects an unknown provider name with 400", async () => {
    const res = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agent-ID": "agent-bad" },
      body: JSON.stringify({
        name: "worker-bad-provider",
        isLead: false,
        harness_provider: "rogue-llm",
      }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── PATCH /api/agents/:id/harness-provider ─────────────────────────────────

describe("PATCH /api/agents/:id/harness-provider", () => {
  test("updates the column on a known agent", async () => {
    const a = createAgent({
      name: "patch-target-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/harness-provider`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "codex" }),
    });
    expect(res.status).toBe(200);

    const row = getAgentById(a.id);
    expect(row?.harnessProvider).toBe("codex");
  });

  test("rejects unknown provider names with 400", async () => {
    const a = createAgent({
      name: "patch-target-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/harness-provider`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "rogue" }),
    });
    expect(res.status).toBe(400);
  });

  test("returns 404 when agent does not exist", async () => {
    const res = await fetch(`${baseUrl}/api/agents/nonexistent-agent-id/harness-provider`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude" }),
    });
    expect(res.status).toBe(404);
  });

  test("PATCH also upserts swarm_config (scope=agent) so the worker reconciles", async () => {
    const a = createAgent({
      name: "patch-target-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/harness-provider`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "codex" }),
    });
    expect(res.status).toBe(200);

    const rows = getSwarmConfigs({ scope: "agent", scopeId: a.id });
    const harnessRow = rows.find((r) => r.key === "HARNESS_PROVIDER");
    expect(harnessRow?.value).toBe("codex");

    // Subsequent PATCH (different value) updates the row in place.
    const res2 = await fetch(`${baseUrl}/api/agents/${a.id}/harness-provider`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude" }),
    });
    expect(res2.status).toBe(200);

    const rows2 = getSwarmConfigs({ scope: "agent", scopeId: a.id });
    const harnessRow2 = rows2.find((r) => r.key === "HARNESS_PROVIDER");
    expect(harnessRow2?.value).toBe("claude");
    expect(rows2.filter((r) => r.key === "HARNESS_PROVIDER")).toHaveLength(1);
  });
});

describe("PATCH /api/agents/:id/runtime", () => {
  test("updates harness_provider and agent-scoped runtime config rows", async () => {
    const a = createAgent({
      name: "runtime-target-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "codex", model: "gpt-5.4" }),
    });
    expect(res.status).toBe(200);

    const row = getAgentById(a.id);
    expect(row?.harnessProvider).toBe("codex");

    const rows = getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "HARNESS_PROVIDER")?.value).toBe("codex");
    expect(rows.find((r) => r.key === "MODEL_OVERRIDE")?.value).toBe("gpt-5.4");
  });

  test("rejects non-local harnesses for runtime editing", async () => {
    const a = createAgent({
      name: "runtime-target-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "devin", model: "devin" }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── PATCH /api/agents/:id/runtime — reasoning_effort (Phase 2) ─────────────

describe("PATCH /api/agents/:id/runtime — reasoning_effort", () => {
  test("happy path: sets REASONING_EFFORT_OVERRIDE for a supported harness/model", async () => {
    const a = createAgent({
      name: "reasoning-target-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness_provider: "claude",
        model: "claude-opus-4-8",
        reasoning_effort: "high",
      }),
    });
    expect(res.status).toBe(200);

    const rows = getSwarmConfigs({ scope: "agent", scopeId: a.id });
    const effortRow = rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE");
    expect(effortRow?.value).toBe("high");
  });

  test("validation failure: rejects xhigh on a non-max Codex model with 400 + allowed array", async () => {
    const a = createAgent({
      name: "reasoning-target-2",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness_provider: "codex",
        model: "gpt-5.1-codex",
        reasoning_effort: "xhigh",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      harness: string;
      model: string;
      level: string;
      allowed: string[];
    };
    expect(body.harness).toBe("codex");
    expect(body.model).toBe("gpt-5.1-codex");
    expect(body.level).toBe("xhigh");
    expect(body.allowed).not.toContain("xhigh");

    // No row was written for the rejected value.
    const rows = getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE")).toBeUndefined();
  });

  test("clearing: reasoning_effort: null removes the REASONING_EFFORT_OVERRIDE row", async () => {
    const a = createAgent({
      name: "reasoning-target-3",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // First set it.
    const setRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness_provider: "claude",
        model: "claude-opus-4-8",
        reasoning_effort: "medium",
      }),
    });
    expect(setRes.status).toBe(200);
    expect(
      getSwarmConfigs({ scope: "agent", scopeId: a.id }).find(
        (r) => r.key === "REASONING_EFFORT_OVERRIDE",
      )?.value,
    ).toBe("medium");

    // Then clear it.
    const clearRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness_provider: "claude",
        model: "claude-opus-4-8",
        reasoning_effort: null,
      }),
    });
    expect(clearRes.status).toBe(200);

    const rows = getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE")).toBeUndefined();
  });

  test("symmetric fix: model: null removes the MODEL_OVERRIDE row (regression coverage)", async () => {
    const a = createAgent({
      name: "reasoning-target-4",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // First set MODEL_OVERRIDE.
    const setRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "codex", model: "gpt-5.4" }),
    });
    expect(setRes.status).toBe(200);
    expect(
      getSwarmConfigs({ scope: "agent", scopeId: a.id }).find((r) => r.key === "MODEL_OVERRIDE")
        ?.value,
    ).toBe("gpt-5.4");

    // Prior to this phase, there was no way to clear MODEL_OVERRIDE via the
    // API — `model` was required and non-empty. Confirm `model: null` now
    // clears it.
    const clearRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "codex", model: null }),
    });
    expect(clearRes.status).toBe(200);

    const rows = getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "MODEL_OVERRIDE")).toBeUndefined();
    // HARNESS_PROVIDER is untouched by the model clear.
    expect(rows.find((r) => r.key === "HARNESS_PROVIDER")?.value).toBe("codex");
  });

  test("omitted reasoning_effort leaves an existing override untouched", async () => {
    const a = createAgent({
      name: "reasoning-target-5",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness_provider: "claude",
        model: "claude-opus-4-8",
        reasoning_effort: "low",
      }),
    });

    // Re-PATCH without reasoning_effort at all (e.g. only changing the model).
    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude", model: "claude-opus-4-8" }),
    });
    expect(res.status).toBe(200);

    const rows = getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE")?.value).toBe("low");
  });

  test("reasoning_effort-only PATCH (model omitted) validates against the persisted MODEL_OVERRIDE, not an empty string", async () => {
    const a = createAgent({
      name: "reasoning-target-6",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    // Establish a model that supports "xhigh" first.
    const setModelRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "codex", model: "gpt-5.1-codex-max" }),
    });
    expect(setModelRes.status).toBe(200);

    // A reasoning_effort-only PATCH (model omitted) should validate against
    // the already-persisted MODEL_OVERRIDE (gpt-5.1-codex-max, which supports
    // xhigh) rather than falling back to "" and always rejecting.
    const effortOnlyRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "codex", reasoning_effort: "xhigh" }),
    });
    expect(effortOnlyRes.status).toBe(200);

    const rows = getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE")?.value).toBe("xhigh");
    // Model is unaffected since it was omitted.
    expect(rows.find((r) => r.key === "MODEL_OVERRIDE")?.value).toBe("gpt-5.1-codex-max");
  });
});

// ─── credential-status echo of reasoningEffort (Phase 2) ────────────────────

describe("PUT /api/agents/:id/credential-status — reasoningEffort echo", () => {
  test("latest_model.reasoningEffort merges into cred_status", async () => {
    const a = createAgent({
      name: "cred-status-reasoning-1",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const put = await fetch(`${baseUrl}/api/agents/${a.id}/credential-status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ready: true,
        missing: [],
        latest_model: {
          model: "claude-opus-4-8",
          source: "agent_config",
          taskId: null,
          harnessProvider: "claude",
          reportedAt: Date.now(),
          reasoningEffort: "high",
        },
      }),
    });
    expect(put.status).toBe(200);

    const get = await fetch(`${baseUrl}/api/agents/${a.id}/credential-status`);
    const body = (await get.json()) as {
      credStatus: { latestModel?: { reasoningEffort?: string } } | null;
    };
    expect(body.credStatus?.latestModel?.reasoningEffort).toBe("high");
  });
});

// ─── deleteSwarmConfigByKey helper (Phase 2) ────────────────────────────────

describe("deleteSwarmConfigByKey", () => {
  test("no-ops (returns false) when no matching row exists", () => {
    const result = deleteSwarmConfigByKey("agent", "no-such-agent", "REASONING_EFFORT_OVERRIDE");
    expect(result).toBe(false);
  });

  test("removes an existing row and returns true", () => {
    const a = createAgent({
      name: "delete-by-key-target",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: a.id,
      key: "REASONING_EFFORT_OVERRIDE",
      value: "medium",
      description: "test setup",
    });
    expect(
      getSwarmConfigs({ scope: "agent", scopeId: a.id }).find(
        (r) => r.key === "REASONING_EFFORT_OVERRIDE",
      ),
    ).toBeDefined();

    const result = deleteSwarmConfigByKey("agent", a.id, "REASONING_EFFORT_OVERRIDE");
    expect(result).toBe(true);

    expect(
      getSwarmConfigs({ scope: "agent", scopeId: a.id }).find(
        (r) => r.key === "REASONING_EFFORT_OVERRIDE",
      ),
    ).toBeUndefined();
  });

  test("global scope: removes a row looked up with scopeId ignored (NULL-safe)", () => {
    upsertSwarmConfig({
      scope: "global",
      key: "GLOBAL_TEST_DELETE_BY_KEY",
      value: "x",
      description: "test setup",
    });
    const result = deleteSwarmConfigByKey("global", "irrelevant", "GLOBAL_TEST_DELETE_BY_KEY");
    expect(result).toBe(true);
    expect(
      getSwarmConfigs({ scope: "global" }).find((r) => r.key === "GLOBAL_TEST_DELETE_BY_KEY"),
    ).toBeUndefined();
  });
});
