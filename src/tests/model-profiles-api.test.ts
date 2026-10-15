// Model profiles over HTTP: CRUD and its RBAC gate, the agent default set through
// PATCH /api/agents/{id}/runtime, and the harness check on task creation.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  getDbClient,
  getTaskById,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { createModelProfile, taskProfileError } from "../be/db/model-profiles";
import { handleAgentsRest } from "../http/agents";
import { handleModelProfiles } from "../http/model-profiles";
import { handleTasks } from "../http/tasks";
import type { User } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-model-profiles-api.sqlite";
const LEAD_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_ID = "22222222-2222-4222-8222-222222222222";
const CODEX_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "33333333-3333-4333-8333-333333333333";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  await getDbClient().run(
    "INSERT INTO users (id, name, createdAt, lastUpdatedAt) VALUES (?, 'Profile User', '2026-01-01', '2026-01-01')",
    [USER_ID],
  );
  await createAgent({ id: LEAD_ID, name: "mp-lead", isLead: true, status: "idle" });
  await createAgent({
    id: CLAUDE_ID,
    name: "mp-claude",
    isLead: false,
    status: "idle",
    harnessProvider: "claude",
  });
  await createAgent({
    id: CODEX_ID,
    name: "mp-codex",
    isLead: false,
    status: "idle",
    harnessProvider: "codex",
  });

  server = createServer((req, res) => {
    const kind = req.headers["x-test-auth"];
    if (kind === "operator") setRequestAuth(req, { kind: "operator", fingerprint: "test" });
    if (kind === "user") {
      setRequestAuth(req, { kind: "user", userId: USER_ID, user: { id: USER_ID } as User });
    }
    const header = req.headers["x-agent-id"];
    const agentId = Array.isArray(header) ? header[0] : header;
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    void (async () => {
      for (const handle of [handleModelProfiles, handleAgentsRest, handleTasks]) {
        if (await handle(req, res, segments, url.searchParams, agentId)) return;
      }
      res.statusCode = 404;
      res.end("{}");
    })();
  });
  baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  server.close();
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM model_profiles");
  await getDbClient().run("DELETE FROM swarm_config WHERE key = 'MODEL_PROFILE'");
});

function call(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = { "x-test-auth": "operator" },
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function modelProfileConfig(agentId: string) {
  return await getDbClient().get<{ value: string; exportToEnv: number }>(
    "SELECT value, exportToEnv FROM swarm_config WHERE scope = 'agent' AND scopeId = ? AND key = 'MODEL_PROFILE'",
    [agentId],
  );
}

describe("profile CRUD", () => {
  test("operator creates, reads, lists, updates and deletes a profile", async () => {
    const created = await call("POST", "/api/model-profiles", {
      name: "claude-gateway-high",
      harness: "claude",
      model: "my-gateway-model",
      effort: null,
      allowCustomModel: true,
      description: "Gateway model",
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: "claude-gateway-high",
      harness: "claude",
      model: "my-gateway-model",
      effort: null,
      allowCustomModel: true,
      seededFrom: null,
    });

    const listed = await call("GET", "/api/model-profiles?harness=claude", undefined);
    const { profiles } = (await listed.json()) as { profiles: { name: string }[] };
    expect(profiles.map((p) => p.name)).toEqual(["claude-gateway-high"]);
    const codexOnly = await call("GET", "/api/model-profiles?harness=codex", undefined);
    expect(((await codexOnly.json()) as { profiles: unknown[] }).profiles).toEqual([]);

    const patched = await call("PATCH", "/api/model-profiles/claude-gateway-high", {
      model: "my-gateway-model-2",
      description: null,
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ model: "my-gateway-model-2", description: null });

    const deleted = await call("DELETE", "/api/model-profiles/claude-gateway-high", undefined);
    expect(deleted.status).toBe(200);
    expect((await call("GET", "/api/model-profiles/claude-gateway-high", undefined)).status).toBe(
      404,
    );
  });

  test("dashboard users may write; agents, the lead included, may not", async () => {
    const body = { name: "devin-any", harness: "devin", model: "devin" };
    expect(
      (await call("POST", "/api/model-profiles", body, { "x-agent-id": LEAD_ID })).status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/model-profiles", body, { "x-agent-id": CLAUDE_ID })).status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/model-profiles", body, { "x-test-auth": "user" })).status,
    ).toBe(201);
    // Reads stay open to agents.
    expect(
      (await call("GET", "/api/model-profiles", undefined, { "x-agent-id": CLAUDE_ID })).status,
    ).toBe(200);
  });

  test("a taken name is 409, a bad name or an unsupported effort is 400", async () => {
    const body = { name: "devin-any", harness: "devin", model: "devin" };
    expect((await call("POST", "/api/model-profiles", body)).status).toBe(201);
    expect((await call("POST", "/api/model-profiles", body)).status).toBe(409);
    expect(
      (await call("POST", "/api/model-profiles", { ...body, name: "Has Spaces" })).status,
    ).toBe(400);
    // Devin takes no reasoning effort, the same rule the adapter applies at spawn.
    const effort = await call("POST", "/api/model-profiles", {
      ...body,
      name: "devin-high",
      effort: "high",
    });
    expect(effort.status).toBe(400);
    expect(((await effort.json()) as { error: string }).error).toContain("not supported");
  });

  test("a tier seed and a profile in use cannot be deleted", async () => {
    await createModelProfile({
      name: "claude-smart",
      harness: "claude",
      model: "opus",
      seededFrom: "tier:smart",
    });
    expect((await call("DELETE", "/api/model-profiles/claude-smart", undefined)).status).toBe(409);

    await createModelProfile({ name: "claude-mine", harness: "claude", model: "opus" });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: CLAUDE_ID,
      key: "MODEL_PROFILE",
      value: "claude-mine",
      exportToEnv: false,
    });
    const inUse = await call("DELETE", "/api/model-profiles/claude-mine", undefined);
    expect(inUse.status).toBe(409);
    expect(((await inUse.json()) as { error: string }).error).toContain("1 agent(s)");
  });
});

describe("agent default via PATCH /api/agents/{id}/runtime", () => {
  test("sets MODEL_PROFILE with exportToEnv off, and null clears it", async () => {
    await createModelProfile({
      name: "claude-opus-high",
      harness: "claude",
      model: "opus",
      effort: "high",
    });
    const set = await call("PATCH", `/api/agents/${CLAUDE_ID}/runtime`, {
      harness_provider: "claude",
      profile: "claude-opus-high",
    });
    expect(set.status).toBe(200);
    expect(await modelProfileConfig(CLAUDE_ID)).toEqual({
      value: "claude-opus-high",
      exportToEnv: 0,
    });

    const cleared = await call("PATCH", `/api/agents/${CLAUDE_ID}/runtime`, {
      harness_provider: "claude",
      profile: null,
    });
    expect(cleared.status).toBe(200);
    expect(await modelProfileConfig(CLAUDE_ID)).toBeNull();
  });

  test("an unknown profile, another harness's profile, or profile with model is 400", async () => {
    await createModelProfile({ name: "codex-sol", harness: "codex", model: "gpt-5.6-sol" });
    for (const body of [
      { harness_provider: "claude", profile: "nope" },
      { harness_provider: "claude", profile: "codex-sol" },
      { harness_provider: "codex", profile: "codex-sol", model: "gpt-5.6-sol" },
    ]) {
      expect((await call("PATCH", `/api/agents/${CODEX_ID}/runtime`, body)).status).toBe(400);
    }
    expect(await modelProfileConfig(CODEX_ID)).toBeNull();
  });

  test("setting model clears the default, so a stale profile never beats a fresh override", async () => {
    await createModelProfile({
      name: "claude-opus-high",
      harness: "claude",
      model: "opus",
      effort: "high",
    });
    await call("PATCH", `/api/agents/${CLAUDE_ID}/runtime`, {
      harness_provider: "claude",
      profile: "claude-opus-high",
    });
    expect(await modelProfileConfig(CLAUDE_ID)).not.toBeNull();
    const res = await call("PATCH", `/api/agents/${CLAUDE_ID}/runtime`, {
      harness_provider: "claude",
      model: "sonnet",
      allow_custom_model: true,
    });
    expect(res.status).toBe(200);
    expect(await modelProfileConfig(CLAUDE_ID)).toBeNull();
  });

  test("changing MODEL_OVERRIDE or REASONING_EFFORT_OVERRIDE through config clears the default", async () => {
    await createModelProfile({
      name: "claude-opus-high",
      harness: "claude",
      model: "opus",
      effort: "high",
    });
    for (const key of ["MODEL_OVERRIDE", "REASONING_EFFORT_OVERRIDE"]) {
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: CLAUDE_ID,
        key: "MODEL_PROFILE",
        value: "claude-opus-high",
        exportToEnv: false,
      });
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: CLAUDE_ID,
        key,
        value: key === "MODEL_OVERRIDE" ? "haiku" : "low",
      });
      expect(await modelProfileConfig(CLAUDE_ID)).toBeNull();
    }
    // Re-saving the same value is not a change: the default stays.
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: CLAUDE_ID,
      key: "MODEL_PROFILE",
      value: "claude-opus-high",
      exportToEnv: false,
    });
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: CLAUDE_ID,
      key: "MODEL_OVERRIDE",
      value: "haiku",
    });
    expect(await modelProfileConfig(CLAUDE_ID)).not.toBeNull();
  });
});

describe("task creation with a profile", () => {
  test("POST /api/tasks stores the profile; another harness's profile is 400", async () => {
    await createModelProfile({ name: "claude-opus", harness: "claude", model: "opus" });
    const ok = await call("POST", "/api/tasks", {
      task: "profile work",
      agentId: CLAUDE_ID,
      routingReason: "continuity",
      profile: "claude-opus",
    });
    expect(ok.status).toBe(201);
    const { id } = (await ok.json()) as { id: string };
    expect((await getTaskById(id))?.profile).toBe("claude-opus");

    const wrong = await call("POST", "/api/tasks", {
      task: "profile work",
      agentId: CODEX_ID,
      routingReason: "continuity",
      profile: "claude-opus",
    });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toContain(
      "runs on the claude harness",
    );
  });

  test("taskProfileError: unknown, mixed with model or tier, and pooled (no agent) cases", async () => {
    await createModelProfile({ name: "claude-opus", harness: "claude", model: "opus" });
    expect(await taskProfileError({ profile: "nope" })).toContain("Unknown model profile");
    expect(await taskProfileError({ profile: "claude-opus", model: "opus" })).toContain("not both");
    expect(await taskProfileError({ profile: "claude-opus", modelTier: "smart" })).toContain(
      "not both",
    );
    expect(await taskProfileError({ profile: "claude-opus" })).toBeNull();
    expect(await taskProfileError({ profile: "claude-opus", agentId: CLAUDE_ID })).toBeNull();
    expect(await taskProfileError({})).toBeNull();
  });
});
