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
  getDbClient,
  getSwarmConfigs,
  initDb,
  setAgentHarnessProvider,
  upsertSwarmConfig,
} from "../be/db";
import { handleAgentRegister, handleAgentsRest } from "../http/agents";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-agents-harness-provider.sqlite";

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
let baseUrl = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  server = makeTestServer();
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

beforeEach(async () => {
  // Each test starts on an empty agents table.
  await getDbClient().run("DELETE FROM agents");
  await getDbClient().run("DELETE FROM swarm_config");
});

// ─── Migration: column exists ────────────────────────────────────────────────

describe("migration 054_agent_harness_provider", () => {
  test("`harness_provider` column exists on the `agents` table", async () => {
    const cols = (await getDbClient().query<{ name: string }>(`PRAGMA table_info(agents)`)).map(
      (r) => r.name,
    );
    expect(cols).toContain("harness_provider");
  });

  test("existing agent rows default to NULL `harness_provider`", async () => {
    const a = await createAgent({
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
  test("setAgentHarnessProvider writes and returns the updated row", async () => {
    const a = await createAgent({ name: "a1", isLead: false, status: "idle", capabilities: [] });
    expect(a.harnessProvider).toBeNull();

    const updated = await setAgentHarnessProvider(a.id, "codex");
    expect(updated?.harnessProvider).toBe("codex");

    const fetched = await getAgentById(a.id);
    expect(fetched?.harnessProvider).toBe("codex");
  });

  test("setAgentHarnessProvider can clear the column with null", async () => {
    const a = await createAgent({
      name: "a-clear",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "claude",
    });
    expect(a.harnessProvider).toBe("claude");

    const updated = await setAgentHarnessProvider(a.id, null);
    expect(updated?.harnessProvider).toBeNull();
  });

  test("setAgentHarnessProvider returns null when agent not found", async () => {
    const result = await setAgentHarnessProvider("nonexistent-id", "claude");
    expect(result).toBeNull();
  });

  test("getAgentHarnessProviders aggregates by provider, excluding NULL", async () => {
    await createAgent({
      name: "x1",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "claude",
    });
    await createAgent({
      name: "x2",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "claude",
    });
    await createAgent({
      name: "x3",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "codex",
    });
    await createAgent({ name: "x4", isLead: false, status: "idle", capabilities: [] }); // NULL — excluded

    const counts = await getAgentHarnessProviders();
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

    const row = await getAgentById(agentId);
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

    const row = await getAgentById(agentId);
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
    const row = await getAgentById(agentId);
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
    const a = await createAgent({
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

    const row = await getAgentById(a.id);
    expect(row?.harnessProvider).toBe("codex");
  });

  test("rejects unknown provider names with 400", async () => {
    const a = await createAgent({
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
    const a = await createAgent({
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

    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    const harnessRow = rows.find((r) => r.key === "HARNESS_PROVIDER");
    expect(harnessRow?.value).toBe("codex");

    // Subsequent PATCH (different value) updates the row in place.
    const res2 = await fetch(`${baseUrl}/api/agents/${a.id}/harness-provider`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude" }),
    });
    expect(res2.status).toBe(200);

    const rows2 = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    const harnessRow2 = rows2.find((r) => r.key === "HARNESS_PROVIDER");
    expect(harnessRow2?.value).toBe("claude");
    expect(rows2.filter((r) => r.key === "HARNESS_PROVIDER")).toHaveLength(1);
  });
});

describe("PATCH /api/agents/:id/runtime", () => {
  test("updates harness_provider and agent-scoped runtime config rows", async () => {
    const a = await createAgent({
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

    const row = await getAgentById(a.id);
    expect(row?.harnessProvider).toBe("codex");

    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "HARNESS_PROVIDER")?.value).toBe("codex");
    expect(rows.find((r) => r.key === "MODEL_OVERRIDE")?.value).toBe("gpt-5.4");
  });

  test("rejects non-local harnesses for runtime editing", async () => {
    const a = await createAgent({
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

  test("accepts acp with omitted reasoning_effort", async () => {
    const a = await createAgent({
      name: "runtime-acp-omitted-effort",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "acp", model: null }),
    });
    expect(res.status).toBe(200);

    const row = await getAgentById(a.id);
    expect(row?.harnessProvider).toBe("acp");
    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((config) => config.key === "HARNESS_PROVIDER")?.value).toBe("acp");
    expect(rows.find((config) => config.key === "MODEL_OVERRIDE")).toBeUndefined();
  });

  test("accepts acp with null reasoning_effort", async () => {
    const a = await createAgent({
      name: "runtime-acp-null-effort",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: a.id,
      key: "REASONING_EFFORT_OVERRIDE",
      value: "high",
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness_provider: "acp",
        model: null,
        reasoning_effort: null,
      }),
    });
    expect(res.status).toBe(200);

    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((config) => config.key === "REASONING_EFFORT_OVERRIDE")).toBeUndefined();
  });

  test("persists OpenCode ACP target and protocol options with the model override", async () => {
    const a = await createAgent({
      name: "runtime-acp-opencode",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness_provider: "acp",
        model: "opencode/big-pickle",
        reasoning_effort: null,
        acp: {
          target: "opencode",
          options: { thought: "high", autoApprove: true },
        },
      }),
    });
    expect(res.status).toBe(200);

    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((config) => config.key === "ACP_TARGET")?.value).toBe("opencode");
    expect(rows.find((config) => config.key === "MODEL_OVERRIDE")?.value).toBe(
      "opencode/big-pickle",
    );
    expect(JSON.parse(rows.find((config) => config.key === "ACP_CONFIG_OPTIONS")!.value)).toEqual({
      thought: "high",
      autoApprove: true,
    });
  });

  test("persists custom ACP launch settings and rejects them for another harness", async () => {
    const a = await createAgent({
      name: "runtime-acp-custom",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    const acp = {
      target: "custom",
      command: "my-agent",
      args: ["--acp"],
      envKeys: ["MY_AGENT_TOKEN"],
      modelEnvKey: "MY_AGENT_MODEL",
    };

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "acp", model: "model-1", acp }),
    });
    expect(res.status).toBe(200);
    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((config) => config.key === "ACP_TARGET_COMMAND")?.value).toBe("my-agent");
    expect(rows.find((config) => config.key === "ACP_TARGET_ARGS")?.value).toBe('["--acp"]');
    expect(rows.find((config) => config.key === "ACP_TARGET_ENV_KEYS")?.value).toBe(
      '["MY_AGENT_TOKEN"]',
    );
    expect(rows.find((config) => config.key === "ACP_MODEL_ENV_KEY")?.value).toBe("MY_AGENT_MODEL");

    const invalid = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "codex", model: "gpt-5.4", acp }),
    });
    expect(invalid.status).toBe(400);
  });

  test("rejects acp with non-null reasoning_effort and reports no allowed levels", async () => {
    const a = await createAgent({
      name: "runtime-acp-invalid-effort",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        harness_provider: "acp",
        model: null,
        reasoning_effort: "high",
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Unsupported reasoning_effort for this harness/model",
      harness: "acp",
      model: null,
      level: "high",
      allowed: [],
    });

    expect((await getAgentById(a.id))?.harnessProvider).toBeNull();
    expect(await getSwarmConfigs({ scope: "agent", scopeId: a.id })).toHaveLength(0);
  });

  test("sets, preserves, and clears the Claude transport override", async () => {
    const a = await createAgent({
      name: "runtime-claude-transport",
      isLead: false,
      status: "idle",
      capabilities: [],
    });

    const setRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude", claude: { transport: "sdk" } }),
    });
    expect(setRes.status).toBe(200);
    expect(
      (await getSwarmConfigs({ scope: "agent", scopeId: a.id })).find(
        (config) => config.key === "CLAUDE_TRANSPORT",
      )?.value,
    ).toBe("sdk");

    const switchRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "codex" }),
    });
    expect(switchRes.status).toBe(200);
    expect(
      (await getSwarmConfigs({ scope: "agent", scopeId: a.id })).find(
        (config) => config.key === "CLAUDE_TRANSPORT",
      )?.value,
    ).toBe("sdk");

    const clearRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude", claude: { transport: null } }),
    });
    expect(clearRes.status).toBe(200);
    expect(
      (await getSwarmConfigs({ scope: "agent", scopeId: a.id })).find(
        (config) => config.key === "CLAUDE_TRANSPORT",
      ),
    ).toBeUndefined();
  });

  test("reports explicit, effective, and inherited Claude transports without credentials", async () => {
    const a = await createAgent({
      name: "runtime-claude-metadata",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    await upsertSwarmConfig({ scope: "global", key: "CLAUDE_TRANSPORT", value: "sdk" });
    await upsertSwarmConfig({
      scope: "global",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "secret-test-token",
      isSecret: true,
    });

    const inheritedRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`);
    expect(inheritedRes.status).toBe(200);
    const inheritedBody = await inheritedRes.json();
    expect(inheritedBody).toEqual({
      claude: {
        transport: null,
        effectiveTransport: "sdk",
        inheritedTransport: "sdk",
        bridgeEffective: false,
      },
    });
    expect(JSON.stringify(inheritedBody)).not.toContain("secret-test-token");

    const setRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude", claude: { transport: "cli" } }),
    });
    expect(setRes.status).toBe(200);

    const explicitRes = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`);
    expect(await explicitRes.json()).toEqual({
      claude: {
        transport: "cli",
        effectiveTransport: "cli",
        inheritedTransport: "sdk",
        bridgeEffective: false,
      },
    });
  });

  test("rejects SDK when configured Claude Bridge is effective and rolls back the PATCH", async () => {
    const a = await createAgent({
      name: "runtime-claude-bridge-conflict",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_USE_CLAUDE_BRIDGE", value: "true" });
    await upsertSwarmConfig({
      scope: "global",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "secret-test-token",
      isSecret: true,
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude", claude: { transport: "sdk" } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "SDK transport cannot run while Claude Bridge is active. Choose CLI, or disable the bridge configuration.",
    });
    expect((await getAgentById(a.id))?.harnessProvider).toBeNull();
    expect(await getSwarmConfigs({ scope: "agent", scopeId: a.id })).toHaveLength(0);
  });

  test("rejects an omitted Claude transport when the effective SDK setting conflicts with Bridge", async () => {
    const a = await createAgent({
      name: "runtime-claude-existing-conflict",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: a.id,
      key: "CLAUDE_TRANSPORT",
      value: "sdk",
    });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_USE_CLAUDE_BRIDGE", value: "true" });
    await upsertSwarmConfig({
      scope: "global",
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "secret-test-token",
      isSecret: true,
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude", model: "claude-opus-4-8" }),
    });
    expect(res.status).toBe(400);
    expect((await getAgentById(a.id))?.harnessProvider).toBeNull();
    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((config) => config.key === "CLAUDE_TRANSPORT")?.value).toBe("sdk");
    expect(rows.find((config) => config.key === "MODEL_OVERRIDE")).toBeUndefined();
  });

  test("uses repository scope when validating an inherited Claude transport", async () => {
    const a = await createAgent({
      name: "runtime-claude-repo-conflict",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    await upsertSwarmConfig({ scope: "global", key: "CLAUDE_TRANSPORT", value: "cli" });
    await upsertSwarmConfig({
      scope: "repo",
      scopeId: "repo-runtime",
      key: "CLAUDE_TRANSPORT",
      value: "sdk",
    });
    await upsertSwarmConfig({
      scope: "repo",
      scopeId: "repo-runtime",
      key: "CLAUDE_BINARY",
      value: "claude-bridge",
    });

    const res = await fetch(`${baseUrl}/api/agents/${a.id}/runtime?repoId=repo-runtime`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ harness_provider: "claude", claude: { transport: null } }),
    });
    expect(res.status).toBe(400);
    expect((await getAgentById(a.id))?.harnessProvider).toBeNull();
    expect(await getSwarmConfigs({ scope: "agent", scopeId: a.id })).toHaveLength(0);
  });
});

// ─── PATCH /api/agents/:id/runtime — reasoning_effort (Phase 2) ─────────────

describe("PATCH /api/agents/:id/runtime — reasoning_effort", () => {
  test("happy path: sets REASONING_EFFORT_OVERRIDE for a supported harness/model", async () => {
    const a = await createAgent({
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

    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    const effortRow = rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE");
    expect(effortRow?.value).toBe("high");
  });

  test("validation failure: rejects xhigh on a non-max Codex model with 400 + allowed array", async () => {
    const a = await createAgent({
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
    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE")).toBeUndefined();
  });

  test("clearing: reasoning_effort: null removes the REASONING_EFFORT_OVERRIDE row", async () => {
    const a = await createAgent({
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
      (await getSwarmConfigs({ scope: "agent", scopeId: a.id })).find(
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

    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE")).toBeUndefined();
  });

  test("symmetric fix: model: null removes the MODEL_OVERRIDE row (regression coverage)", async () => {
    const a = await createAgent({
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
      (await getSwarmConfigs({ scope: "agent", scopeId: a.id })).find(
        (r) => r.key === "MODEL_OVERRIDE",
      )?.value,
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

    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "MODEL_OVERRIDE")).toBeUndefined();
    // HARNESS_PROVIDER is untouched by the model clear.
    expect(rows.find((r) => r.key === "HARNESS_PROVIDER")?.value).toBe("codex");
  });

  test("omitted reasoning_effort leaves an existing override untouched", async () => {
    const a = await createAgent({
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

    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE")?.value).toBe("low");
  });

  test("reasoning_effort-only PATCH (model omitted) validates against the persisted MODEL_OVERRIDE, not an empty string", async () => {
    const a = await createAgent({
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

    const rows = await getSwarmConfigs({ scope: "agent", scopeId: a.id });
    expect(rows.find((r) => r.key === "REASONING_EFFORT_OVERRIDE")?.value).toBe("xhigh");
    // Model is unaffected since it was omitted.
    expect(rows.find((r) => r.key === "MODEL_OVERRIDE")?.value).toBe("gpt-5.1-codex-max");
  });
});

// ─── credential-status echo of reasoningEffort (Phase 2) ────────────────────

describe("PUT /api/agents/:id/credential-status — reasoningEffort echo", () => {
  test("latest_model.reasoningEffort merges into cred_status", async () => {
    const a = await createAgent({
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
  test("no-ops (returns false) when no matching row exists", async () => {
    const result = await deleteSwarmConfigByKey(
      "agent",
      "no-such-agent",
      "REASONING_EFFORT_OVERRIDE",
    );
    expect(result).toBe(false);
  });

  test("removes an existing row and returns true", async () => {
    const a = await createAgent({
      name: "delete-by-key-target",
      isLead: false,
      status: "idle",
      capabilities: [],
    });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: a.id,
      key: "REASONING_EFFORT_OVERRIDE",
      value: "medium",
      description: "test setup",
    });
    expect(
      (await getSwarmConfigs({ scope: "agent", scopeId: a.id })).find(
        (r) => r.key === "REASONING_EFFORT_OVERRIDE",
      ),
    ).toBeDefined();

    const result = await deleteSwarmConfigByKey("agent", a.id, "REASONING_EFFORT_OVERRIDE");
    expect(result).toBe(true);

    expect(
      (await getSwarmConfigs({ scope: "agent", scopeId: a.id })).find(
        (r) => r.key === "REASONING_EFFORT_OVERRIDE",
      ),
    ).toBeUndefined();
  });

  test("global scope: removes a row looked up with scopeId ignored (NULL-safe)", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "GLOBAL_TEST_DELETE_BY_KEY",
      value: "x",
      description: "test setup",
    });
    const result = await deleteSwarmConfigByKey(
      "global",
      "irrelevant",
      "GLOBAL_TEST_DELETE_BY_KEY",
    );
    expect(result).toBe(true);
    expect(
      (await getSwarmConfigs({ scope: "global" })).find(
        (r) => r.key === "GLOBAL_TEST_DELETE_BY_KEY",
      ),
    ).toBeUndefined();
  });
});

// ─── GET /api/agents — effective Claude transport on list rows ───────────────

describe("GET /api/agents claudeTransport", () => {
  test("Claude agents carry the effective transport; other harnesses omit it", async () => {
    const claudeInherit = await createAgent({
      name: "transport-claude-inherit",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "claude",
    });
    const claudeOverride = await createAgent({
      name: "transport-claude-override",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "claude",
    });
    const codex = await createAgent({
      name: "transport-codex",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "codex",
    });
    await upsertSwarmConfig({ scope: "global", key: "CLAUDE_TRANSPORT", value: "sdk" });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: claudeOverride.id,
      key: "CLAUDE_TRANSPORT",
      value: "cli",
    });

    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: { id: string; claudeTransport?: "cli" | "sdk" }[];
    };
    const byId = new Map(body.agents.map((agent) => [agent.id, agent]));
    expect(byId.get(claudeInherit.id)?.claudeTransport).toBe("sdk");
    expect(byId.get(claudeOverride.id)?.claudeTransport).toBe("cli");
    expect(byId.get(codex.id)?.claudeTransport).toBeUndefined();

    const single = await fetch(`${baseUrl}/api/agents/${claudeInherit.id}`);
    expect(single.status).toBe(200);
    expect(((await single.json()) as { claudeTransport?: string }).claudeTransport).toBe("sdk");
  });

  test("an invalid stored transport omits the field instead of failing the list", async () => {
    const a = await createAgent({
      name: "transport-claude-invalid",
      isLead: false,
      status: "idle",
      capabilities: [],
      harnessProvider: "claude",
    });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: a.id,
      key: "CLAUDE_TRANSPORT",
      value: "bogus",
    });

    const res = await fetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: { id: string; claudeTransport?: string }[] };
    expect(body.agents.find((agent) => agent.id === a.id)?.claudeTransport).toBeUndefined();
  });
});
