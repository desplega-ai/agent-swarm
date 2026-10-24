// `profile` on schedules (plan phase 6): create, update and patch validate it
// with the profile check when the target agent is known, profile and
// model/modelTier are exclusive (setting one clears the other), and a fired
// task carries the schedule's profile. HTTP and the MCP tools agree.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  getDbClient,
  getScheduledTaskById,
  initDb,
} from "../be/db";
import { updateAgentCredStatus } from "../be/db/agents";
import { createModelProfile, deleteModelProfile } from "../be/db/model-profiles";
import { reloadModelsCatalog } from "../be/model-catalog-store";
import { handleSchedules } from "../http/schedules";
import { registerCreateScheduleTool } from "../tools/schedules/create-schedule";
import { registerPatchScheduleTool } from "../tools/schedules/patch-schedule";
import { registerUpdateScheduleTool } from "../tools/schedules/update-schedule";
import type { AgentCredStatus } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-schedule-profile.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => undefined);
  }
}

const READY: AgentCredStatus = {
  ready: true,
  missing: [],
  satisfiedBy: "env",
  hint: null,
  liveTest: null,
  latestModel: null,
  reportedAt: Date.now(),
  reportKind: "boot",
  bedrock: null,
  acp: null,
};

let server: Server;
let baseUrl = "";
let claudeId = "";
let codexId = "";
let mcp: McpServer;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  await reloadModelsCatalog();
  claudeId = (
    await createAgent({
      name: "sp-claude",
      isLead: false,
      status: "idle",
      harnessProvider: "claude",
    })
  ).id;
  await updateAgentCredStatus(claudeId, READY);
  codexId = (
    await createAgent({ name: "sp-codex", isLead: false, status: "idle", harnessProvider: "codex" })
  ).id;
  await updateAgentCredStatus(codexId, READY);
  await createModelProfile({ name: "sp-claude-opus", harness: "claude", model: "opus" });
  await createModelProfile({ name: "sp-claude-held", harness: "claude", model: "sonnet" });

  server = createServer((req, res) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "schedule-profile-test" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    void (async () => {
      res.setHeader("Content-Type", "application/json");
      if (await handleSchedules(req, res, segments, url.searchParams, undefined)) return;
      res.writeHead(404);
      res.end("{}");
    })();
  });
  baseUrl = `http://localhost:${await listenOnFreePort(server)}`;

  mcp = new McpServer({ name: "schedule-profile-test", version: "1.0.0" });
  registerCreateScheduleTool(mcp);
  registerUpdateScheduleTool(mcp);
  registerPatchScheduleTool(mcp);
});

afterAll(async () => {
  server.close();
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

type ToolOutput = { success: boolean; message: string; schedule?: Record<string, any> };

async function tool(name: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const tools = (
    mcp as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: unknown, e: unknown) => Promise<CallToolResult> }
      >;
    }
  )._registeredTools;
  const result = await tools[name]!.handler(args, {
    sessionId: "schedule-profile-test",
    requestInfo: { headers: { "x-agent-id": claudeId } },
  });
  return result.structuredContent as ToolOutput;
}

let counter = 0;
function scheduleName(): string {
  counter++;
  return `sp-${counter}-${Date.now()}`;
}

function base(extra: Record<string, unknown> = {}) {
  return { name: scheduleName(), taskTemplate: "tick", intervalMs: 3_600_000, ...extra };
}

describe("HTTP create", () => {
  test("a profile on a passing agent saves, and the fired task carries it", async () => {
    const created = await api(
      "POST",
      "/api/schedules",
      base({ targetAgentId: claudeId, profile: "sp-claude-opus" }),
    );
    expect(created.status).toBe(201);
    expect(created.body.profile).toBe("sp-claude-opus");

    const fired = await api("POST", `/api/schedules/${created.body.id}/run`);
    expect(fired.status).toBe(200);
    expect(fired.body.task.profile).toBe("sp-claude-opus");
    const row = await getDbClient().get<{ profile: string | null }>(
      "SELECT profile FROM agent_tasks WHERE id = ?",
      [fired.body.task.id],
    );
    expect(row?.profile).toBe("sp-claude-opus");
  });

  test("a pool schedule takes a profile without an agent check", async () => {
    const created = await api("POST", "/api/schedules", base({ profile: "sp-claude-opus" }));
    expect(created.status).toBe(201);
    expect(created.body.profile).toBe("sp-claude-opus");
  });

  test("an agent that fails the check is a 400", async () => {
    const res = await api(
      "POST",
      "/api/schedules",
      base({ targetAgentId: codexId, profile: "sp-claude-opus" }),
    );
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('Model profile "sp-claude-opus" fails harness');
  });

  test("an unknown profile is a 400", async () => {
    const res = await api("POST", "/api/schedules", base({ profile: "sp-no-such-profile" }));
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('Unknown model profile "sp-no-such-profile"');
  });

  test("profile together with model or modelTier is a 400", async () => {
    for (const extra of [{ model: "opus" }, { modelTier: "smart" }]) {
      const res = await api(
        "POST",
        "/api/schedules",
        base({ targetAgentId: claudeId, profile: "sp-claude-opus", ...extra }),
      );
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain("not both");
    }
  });
});

describe("HTTP update and patch", () => {
  test("setting profile clears model and modelTier; setting modelTier clears profile", async () => {
    for (const method of ["PUT", "PATCH"]) {
      const created = await api(
        "POST",
        "/api/schedules",
        base({ targetAgentId: claudeId, modelTier: "smart" }),
      );
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      const set = await api(method, `/api/schedules/${id}`, { profile: "sp-claude-opus" });
      expect(set.status).toBe(200);
      expect(set.body.profile).toBe("sp-claude-opus");
      expect(set.body.modelTier).toBeUndefined();
      expect(set.body.model).toBeUndefined();

      const back = await api(method, `/api/schedules/${id}`, { modelTier: "regular" });
      expect(back.status).toBe(200);
      expect(back.body.modelTier).toBe("regular");
      expect(back.body.profile).toBeUndefined();
    }
  });

  test("setting model clears profile, and null clears it", async () => {
    const created = await api(
      "POST",
      "/api/schedules",
      base({ targetAgentId: claudeId, profile: "sp-claude-opus" }),
    );
    const id = created.body.id as string;
    const model = await api("PATCH", `/api/schedules/${id}`, { model: "sonnet" });
    expect(model.status).toBe(200);
    expect(model.body.profile).toBeUndefined();

    await api("PATCH", `/api/schedules/${id}`, { model: null, profile: "sp-claude-opus" });
    const cleared = await api("PATCH", `/api/schedules/${id}`, { profile: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.profile).toBeUndefined();
  });

  test("profile and model in one body is a 400", async () => {
    const created = await api("POST", "/api/schedules", base({ targetAgentId: claudeId }));
    const id = created.body.id as string;
    for (const method of ["PUT", "PATCH"]) {
      const res = await api(method, `/api/schedules/${id}`, {
        profile: "sp-claude-opus",
        modelTier: "smart",
      });
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain("not both");
    }
  });

  test("a new profile, or a move to an agent that fails it, is re-checked", async () => {
    const created = await api("POST", "/api/schedules", base({ targetAgentId: codexId }));
    const codexSchedule = created.body.id as string;
    const refused = await api("PUT", `/api/schedules/${codexSchedule}`, {
      profile: "sp-claude-opus",
    });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toContain("fails harness");

    const profiled = await api(
      "POST",
      "/api/schedules",
      base({ targetAgentId: claudeId, profile: "sp-claude-opus" }),
    );
    const id = profiled.body.id as string;
    for (const method of ["PUT", "PATCH"]) {
      const moved = await api(method, `/api/schedules/${id}`, { targetAgentId: codexId });
      expect(moved.status).toBe(400);
      expect(String(moved.body.error)).toContain("fails harness");
    }
    const unrelated = await api("PATCH", `/api/schedules/${id}`, { description: "still claude" });
    expect(unrelated.status).toBe(200);
    expect(unrelated.body.profile).toBe("sp-claude-opus");
  });

  test("an unknown profile on update is a 400", async () => {
    const created = await api("POST", "/api/schedules", base());
    const res = await api("PATCH", `/api/schedules/${created.body.id}`, {
      profile: "sp-no-such-profile",
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("Unknown model profile");
  });
});

describe("schedule reference guard", () => {
  test("a profile a schedule names cannot be deleted", async () => {
    await createScheduledTask({
      name: scheduleName(),
      intervalMs: 3_600_000,
      taskTemplate: "tick",
      profile: "sp-claude-held",
    });
    expect(await deleteModelProfile("sp-claude-held")).toBe("in-use");
  });
});

describe("MCP tool parity", () => {
  test("create-schedule: passing agent saves, failing agent and profile+model refuse", async () => {
    const ok = await tool("create-schedule", {
      ...base({ targetAgentId: claudeId, profile: "sp-claude-opus" }),
    });
    expect(ok.success).toBe(true);
    expect(ok.schedule?.profile).toBe("sp-claude-opus");

    const failing = await tool("create-schedule", {
      ...base({ targetAgentId: codexId, profile: "sp-claude-opus" }),
    });
    expect(failing.success).toBe(false);
    expect(failing.message).toContain("fails harness");

    const both = await tool("create-schedule", {
      ...base({ targetAgentId: claudeId, profile: "sp-claude-opus", modelTier: "smart" }),
    });
    expect(both.success).toBe(false);
    expect(both.message).toContain("not both");
  });

  for (const name of ["update-schedule", "patch-schedule"]) {
    test(`${name}: setting profile clears modelTier, the reverse clears profile, a fail refuses`, async () => {
      const schedule = await createScheduledTask({
        name: scheduleName(),
        intervalMs: 3_600_000,
        taskTemplate: "tick",
        targetAgentId: claudeId,
        modelTier: "smart",
        createdByAgentId: claudeId,
      });
      const set = await tool(name, { scheduleId: schedule.id, profile: "sp-claude-opus" });
      expect(set.success).toBe(true);
      let row = await getScheduledTaskById(schedule.id);
      expect(row?.profile).toBe("sp-claude-opus");
      expect(row?.modelTier).toBeUndefined();

      const both = await tool(name, {
        scheduleId: schedule.id,
        profile: "sp-claude-opus",
        model: "opus",
      });
      expect(both.success).toBe(false);
      expect(both.message).toContain("not both");

      const moved = await tool(name, { scheduleId: schedule.id, targetAgentId: codexId });
      expect(moved.success).toBe(false);
      expect(moved.message).toContain("fails harness");

      const back = await tool(name, { scheduleId: schedule.id, modelTier: "regular" });
      expect(back.success).toBe(true);
      row = await getScheduledTaskById(schedule.id);
      expect(row?.modelTier).toBe("regular");
      expect(row?.profile).toBeUndefined();
    });
  }
});
