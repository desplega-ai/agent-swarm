// Model profiles over HTTP: CRUD and its RBAC gate, the agent default set through
// PATCH /api/agents/{id}/runtime, and the harness check on task creation.

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createScheduledTask,
  createSwarmRepo,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  pauseTask,
  startTask,
  supersedeTask,
  upsertSwarmConfig,
} from "../be/db";
import * as profilesDb from "../be/db/model-profiles";
import { createModelProfile, taskProfileError } from "../be/db/model-profiles";
import { codeLevelTriage } from "../heartbeat/heartbeat";
import { handleAgentsRest } from "../http/agents";
import { handleModelProfiles } from "../http/model-profiles";
import { handleTasks } from "../http/tasks";
import * as followUps from "../tasks/worker-follow-up";
import { registerSendTaskTool } from "../tools/send-task";
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
  // References first: migration 220's triggers refuse deleting a named profile.
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM scheduled_tasks");
  await getDbClient().run(
    "DELETE FROM swarm_config WHERE key IN ('MODEL_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN')",
  );
  await getDbClient().run("DELETE FROM model_profiles");
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

  test("only the operator may write; dashboard users and agents, the lead included, may not", async () => {
    const body = { name: "devin-any", harness: "devin", model: "devin" };
    expect(
      (await call("POST", "/api/model-profiles", body, { "x-agent-id": LEAD_ID })).status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/model-profiles", body, { "x-agent-id": CLAUDE_ID })).status,
    ).toBe(403);
    expect(
      (await call("POST", "/api/model-profiles", body, { "x-test-auth": "user" })).status,
    ).toBe(403);
    // Nor edit one: a shared profile changes what other people's queued tasks run.
    expect(
      (
        await call(
          "PATCH",
          "/api/model-profiles/claude-regular",
          { model: "haiku" },
          { "x-test-auth": "user" },
        )
      ).status,
    ).toBe(403);
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

  test("a supported level with no transport effect (Opencode off) is accepted on POST and PATCH", async () => {
    const body = { harness: "opencode", model: "openai/gpt-5.6-sol" };
    const off = await call("POST", "/api/model-profiles", {
      ...body,
      name: "oc-off",
      effort: "off",
    });
    expect(off.status).toBe(201);
    expect(((await off.json()) as { effort: string }).effort).toBe("off");

    expect(
      (await call("POST", "/api/model-profiles", { ...body, name: "oc-low", effort: "low" }))
        .status,
    ).toBe(201);
    const patched = await call("PATCH", "/api/model-profiles/oc-low", { effort: "off" });
    expect(patched.status).toBe(200);
    // A PATCH that leaves `off` in place (a description edit) re-validates it too.
    expect(
      (await call("PATCH", "/api/model-profiles/oc-off", { description: "kept" })).status,
    ).toBe(200);

    // opencode passes the model's own declared efforts through, `max` included.
    expect(
      (await call("POST", "/api/model-profiles", { ...body, name: "oc-max", effort: "max" }))
        .status,
    ).toBe(201);

    // Control: a level this model does not list is still refused, on both verbs.
    // `openai/gpt-5.1-codex` declares low|medium|high, so it accepts no `max`.
    const noMax = { harness: "opencode", model: "openai/gpt-5.1-codex" };
    expect(
      (await call("POST", "/api/model-profiles", { ...noMax, name: "oc-nomax", effort: "max" }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/api/model-profiles", { ...noMax, name: "oc-capped", effort: "low" }))
        .status,
    ).toBe(201);
    expect((await call("PATCH", "/api/model-profiles/oc-capped", { effort: "max" })).status).toBe(
      400,
    );
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

  test("a paused task holding an agent default's profile keeps it, so its resume keeps the allowlist", async () => {
    await createModelProfile({
      name: "claude-keyed",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["aaaaa"] },
    });
    // Claimed under the agent default: resolvedProfile only, no task.profile.
    const task = await createTaskExtended("work", { agentId: CLAUDE_ID });
    await startTask(task.id);
    await getDbClient().run("UPDATE agent_tasks SET resolvedProfile = ? WHERE id = ?", [
      "claude-keyed",
      task.id,
    ]);
    expect(await pauseTask(task.id)).not.toBeNull();

    const inUse = await call("DELETE", "/api/model-profiles/claude-keyed", undefined);
    expect(inUse.status).toBe(409);
    expect(((await inUse.json()) as { error: string }).error).toContain("1 unfinished");
    const paused = await call("GET", "/api/paused-tasks", undefined, { "x-agent-id": CLAUDE_ID });
    const { tasks } = (await paused.json()) as {
      tasks: { id: string; credentialAllowlist?: Record<string, string[]> }[];
    };
    expect(tasks.find((t) => t.id === task.id)?.credentialAllowlist).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: ["aaaaa"],
    });

    // Control: once the task finishes, the profile is free to go.
    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [task.id]);
    expect((await call("DELETE", "/api/model-profiles/claude-keyed", undefined)).status).toBe(200);
  });
});

describe("profile credential allowlist", () => {
  const base = { harness: "claude", model: "opus" };

  test("POST and PATCH round-trip `credentials`; null clears it; duplicates collapse", async () => {
    const created = await call("POST", "/api/model-profiles", {
      ...base,
      name: "claude-pinned",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["abcde", "abcde", "fghij"] },
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { credentials: unknown }).credentials).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: ["abcde", "fghij"],
    });

    const patched = await call("PATCH", "/api/model-profiles/claude-pinned", {
      credentials: { ANTHROPIC_API_KEY: ["zzzzz"] },
    });
    expect(patched.status).toBe(200);
    const read = await call("GET", "/api/model-profiles/claude-pinned", undefined);
    expect(((await read.json()) as { credentials: unknown }).credentials).toEqual({
      ANTHROPIC_API_KEY: ["zzzzz"],
    });

    // A PATCH that leaves credentials out keeps them.
    const kept = await call("PATCH", "/api/model-profiles/claude-pinned", { description: "x" });
    expect(((await kept.json()) as { credentials: unknown }).credentials).toEqual({
      ANTHROPIC_API_KEY: ["zzzzz"],
    });

    const cleared = await call("PATCH", "/api/model-profiles/claude-pinned", {
      credentials: null,
    });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { credentials: unknown }).credentials).toBeNull();
    const row = await getDbClient().get<{ credentialAllowlist: string | null }>(
      "SELECT credentialAllowlist FROM model_profiles WHERE name = 'claude-pinned'",
    );
    expect(row?.credentialAllowlist).toBeNull();
  });

  test("an unknown var, a CODEX_OAUTH var, an empty list or a bad suffix is 400", async () => {
    const unknownVar = await call("POST", "/api/model-profiles", {
      ...base,
      name: "claude-bad-var",
      credentials: { OPENAI_API_KEY: ["abcde"] },
    });
    expect(unknownVar.status).toBe(400);
    expect(((await unknownVar.json()) as { error: string }).error).toContain("OPENAI_API_KEY");

    const codexOauth = await call("POST", "/api/model-profiles", {
      harness: "codex",
      model: "gpt-5.6-sol",
      name: "codex-oauth-pinned",
      credentials: { CODEX_OAUTH: ["abcde"] },
    });
    expect(codexOauth.status).toBe(400);
    expect(((await codexOauth.json()) as { error: string }).error).toContain("not supported in v1");

    const empty = await call("POST", "/api/model-profiles", {
      ...base,
      name: "claude-empty",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: [] },
    });
    expect(empty.status).toBe(400);

    const longSuffix = await call("POST", "/api/model-profiles", {
      ...base,
      name: "claude-long",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["abcdef"] },
    });
    expect(longSuffix.status).toBe(400);

    await createModelProfile({ ...base, name: "claude-plain", harness: "claude" });
    const patchBad = await call("PATCH", "/api/model-profiles/claude-plain", {
      credentials: { CODEX_OAUTH: ["abcde"] },
    });
    expect(patchBad.status).toBe(400);
  });

  test("a model-prefixed key var is accepted on harnesses that pick the key by model", async () => {
    const helm = await call("POST", "/api/model-profiles", {
      harness: "pi",
      model: "helmcode/deepseek-v4-flash",
      name: "pi-helm-pinned",
      credentials: { HELMCODE_API_KEY: ["abcde"] },
    });
    expect(helm.status).toBe(201);
  });

  test("a var the harness never loads for this model is 400, though the harness loads it for others", async () => {
    // pi drops OPENAI_API_KEY for a slash-qualified model (`getModelAwareCredentialVars`).
    const slash = {
      harness: "pi",
      model: "openrouter/google/gemini-3-flash-preview",
      allowCustomModel: true,
    };
    const openai = await call("POST", "/api/model-profiles", {
      ...slash,
      name: "pi-slash-openai",
      credentials: { OPENAI_API_KEY: ["abcde"] },
    });
    expect(openai.status).toBe(400);
    expect(((await openai.json()) as { error: string }).error).toContain("OPENAI_API_KEY");

    // Controls: a var this model loads, and the same var on a model that loads it.
    expect(
      (
        await call("POST", "/api/model-profiles", {
          ...slash,
          name: "pi-slash-openrouter",
          credentials: { OPENROUTER_API_KEY: ["abcde"] },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call("POST", "/api/model-profiles", {
          harness: "pi",
          model: "gpt-5.6-sol",
          allowCustomModel: true,
          name: "pi-bare-openai",
          credentials: { OPENAI_API_KEY: ["abcde"] },
        })
      ).status,
    ).toBe(201);
  });
});

describe("schedule profile references", () => {
  test("a profile named by a schedule cannot be deleted; the 409 names the schedule", async () => {
    await createModelProfile({ name: "claude-sched", harness: "claude", model: "opus" });
    const schedule = await createScheduledTask({
      name: "profile-sched",
      cronExpression: "0 * * * *",
      taskTemplate: "x",
      profile: "claude-sched",
    });
    expect(schedule.profile).toBe("claude-sched");

    const inUse = await call("DELETE", "/api/model-profiles/claude-sched", undefined);
    expect(inUse.status).toBe(409);
    const { error } = (await inUse.json()) as { error: string };
    expect(error).toContain("1 schedule(s)");
    expect(error).toContain(schedule.id);

    // The statement-level guard holds even past the reference count.
    expect(await profilesDb.deleteModelProfile("claude-sched")).toBe("in-use");

    await getDbClient().run("UPDATE scheduled_tasks SET profile = NULL WHERE id = ?", [
      schedule.id,
    ]);
    expect((await call("DELETE", "/api/model-profiles/claude-sched", undefined)).status).toBe(200);
  });

  test("a schedule naming a missing profile is refused by the trigger, on insert and update", async () => {
    let insertError: unknown;
    try {
      await createScheduledTask({
        name: "ghost-sched",
        cronExpression: "0 * * * *",
        taskTemplate: "x",
        profile: "no-such-profile",
      });
    } catch (error) {
      insertError = error;
    }
    expect(profilesDb.modelProfileRefError(insertError)).toBe("missing");

    const schedule = await createScheduledTask({
      name: "plain-sched",
      cronExpression: "0 * * * *",
      taskTemplate: "x",
    });
    let updateError: unknown;
    try {
      await getDbClient().run("UPDATE scheduled_tasks SET profile = 'nope' WHERE id = ?", [
        schedule.id,
      ]);
    } catch (error) {
      updateError = error;
    }
    expect(profilesDb.modelProfileRefError(updateError)).toBe("missing");
  });
});

describe("profile references and deletion are atomic", () => {
  const taskBody = {
    task: "racing work",
    agentId: CLAUDE_ID,
    routingReason: "continuity",
    profile: "claude-racy",
  };

  async function taskCount(): Promise<number> {
    return (
      (await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks"))?.n ?? 0
    );
  }

  test("a delete that lands after create validated the profile makes the create a 400", async () => {
    await createModelProfile({ name: "claude-racy", harness: "claude", model: "opus" });
    const validate = profilesDb.taskProfileError;
    let deleteStatus = 0;
    const spy = spyOn(profilesDb, "taskProfileError").mockImplementation(async (check) => {
      const error = await validate(check);
      deleteStatus = (await call("DELETE", "/api/model-profiles/claude-racy", undefined)).status;
      return error;
    });
    try {
      const created = await call("POST", "/api/tasks", taskBody);
      expect(deleteStatus).toBe(200);
      expect(created.status).toBe(400);
      expect(((await created.json()) as { error: string }).error).toContain("claude-racy");
      expect(await taskCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("a create that lands after delete counted references makes the delete a 409", async () => {
    await createModelProfile({ name: "claude-racy", harness: "claude", model: "opus" });
    const count = profilesDb.modelProfileReferences;
    let createStatus = 0;
    const spy = spyOn(profilesDb, "modelProfileReferences").mockImplementation(async (name) => {
      const refs = await count(name);
      createStatus = (await call("POST", "/api/tasks", taskBody)).status;
      return refs;
    });
    try {
      const deleted = await call("DELETE", "/api/model-profiles/claude-racy", undefined);
      expect(createStatus).toBe(201);
      expect(deleted.status).toBe(409);
      expect(await profilesDb.getModelProfileByName("claude-racy")).not.toBeNull();
      expect(await taskCount()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("a delete that lands after PATCH /runtime validated the default makes the PATCH a 400", async () => {
    await createModelProfile({ name: "claude-racy", harness: "claude", model: "opus" });
    const lookup = profilesDb.getModelProfileByName;
    let deleteStatus = 0;
    const spy = spyOn(profilesDb, "getModelProfileByName").mockImplementation(async (name) => {
      const profile = await lookup(name);
      if (!deleteStatus) {
        deleteStatus = -1;
        spy.mockImplementation(lookup);
        deleteStatus = (await call("DELETE", "/api/model-profiles/claude-racy", undefined)).status;
      }
      return profile;
    });
    try {
      const set = await call("PATCH", `/api/agents/${CLAUDE_ID}/runtime`, {
        harness_provider: "claude",
        profile: "claude-racy",
      });
      expect(deleteStatus).toBe(200);
      expect(set.status).toBe(400);
      expect(await modelProfileConfig(CLAUDE_ID)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test("every write path is held to it: tasks, agent defaults and deletes", async () => {
    await expect(
      createTaskExtended("work", { agentId: CLAUDE_ID, profile: "nope" }),
    ).rejects.toThrow("model-profile-missing");
    await expect(
      upsertSwarmConfig({
        scope: "agent",
        scopeId: CLAUDE_ID,
        key: "MODEL_PROFILE",
        value: "nope",
      }),
    ).rejects.toThrow("model-profile-missing");

    await createModelProfile({ name: "claude-racy", harness: "claude", model: "opus" });
    const task = await createTaskExtended("work", { agentId: CLAUDE_ID, profile: "claude-racy" });
    expect(await profilesDb.deleteModelProfile("claude-racy")).toBe("in-use");
    await expect(
      getDbClient().run("UPDATE agent_tasks SET profile = 'nope' WHERE id = ?", [task.id]),
    ).rejects.toThrow("model-profile-missing");

    // Control: a finished task no longer holds the profile.
    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [task.id]);
    expect(await profilesDb.deleteModelProfile("claude-racy")).toBe("deleted");
    expect(await profilesDb.deleteModelProfile("claude-racy")).toBe("missing");
  });
});

describe("a superseded task holds its profile until its resume exists", () => {
  // Supersede and resume creation are separate writes; the resume copies the
  // parent's profile, and after a restart the heartbeat's orphan repair makes it.
  async function supersededWithProfile(finishedAgoMs = 0): Promise<string> {
    await createModelProfile({ name: "claude-handoff", harness: "claude", model: "opus" });
    const task = await createTaskExtended("handoff work", {
      agentId: CLAUDE_ID,
      profile: "claude-handoff",
    });
    await startTask(task.id);
    expect(await supersedeTask(task.id, { reason: "crash_recovery", resumeTaskId: null })).not.toBe(
      null,
    );
    if (finishedAgoMs) {
      await getDbClient().run("UPDATE agent_tasks SET finishedAt = ? WHERE id = ?", [
        new Date(Date.now() - finishedAgoMs).toISOString(),
        task.id,
      ]);
    }
    return task.id;
  }

  async function resumeChildren(parentId: string) {
    return await getDbClient().query<{ id: string; profile: string | null }>(
      "SELECT id, profile FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'resume'",
      [parentId],
    );
  }

  test("a delete inside POST /supersede's handoff is a 409 and the resume keeps the profile", async () => {
    await createModelProfile({ name: "claude-handoff", harness: "claude", model: "opus" });
    const task = await createTaskExtended("handoff work", {
      agentId: CLAUDE_ID,
      profile: "claude-handoff",
    });
    await startTask(task.id);
    const create = followUps.createResumeFollowUp;
    let deleted: Response | null = null;
    const spy = spyOn(followUps, "createResumeFollowUp").mockImplementation(async (args) => {
      deleted = await call("DELETE", "/api/model-profiles/claude-handoff", undefined);
      return await create(args);
    });
    try {
      const superseded = await call(
        "POST",
        `/api/tasks/${task.id}/supersede`,
        { reason: "manual_supersede" },
        { "x-test-auth": "operator", "x-agent-id": CLAUDE_ID },
      );
      expect(deleted).not.toBeNull();
      const refused = deleted as unknown as Response;
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain("awaiting-resume");
      expect(superseded.status).toBe(200);
      const body = (await superseded.json()) as { kind: string; resumeTaskId: string | null };
      expect(body.kind).toBe("resumed");
      expect(await resumeChildren(task.id)).toEqual([
        { id: body.resumeTaskId!, profile: "claude-handoff" },
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("after a restart the profile survives until orphan repair makes the resume", async () => {
    const parentId = await supersededWithProfile(10 * 60 * 1000);
    expect(await profilesDb.deleteModelProfile("claude-handoff")).toBe("in-use");
    const refused = await call("DELETE", "/api/model-profiles/claude-handoff", undefined);
    expect(refused.status).toBe(409);

    await codeLevelTriage();
    const children = await resumeChildren(parentId);
    expect(children).toHaveLength(1);
    expect(children[0]?.profile).toBe("claude-handoff");
    // A second sweep finds nothing left to repair.
    await codeLevelTriage();
    expect(await resumeChildren(parentId)).toHaveLength(1);

    // The resume now holds it; once it finishes the profile can go.
    expect(await profilesDb.deleteModelProfile("claude-handoff")).toBe("in-use");
    await getDbClient().run("UPDATE agent_tasks SET status = 'completed' WHERE id = ?", [
      children[0]!.id,
    ]);
    expect(await profilesDb.deleteModelProfile("claude-handoff")).toBe("deleted");
  });

  test("control: a superseded task past the repair window, or with its resume, holds nothing", async () => {
    await supersededWithProfile(25 * 60 * 60 * 1000);
    expect(await profilesDb.modelProfileReferences("claude-handoff")).toEqual({
      agentIds: [],
      openTaskCount: 0,
      scheduleIds: [],
    });
    expect(await profilesDb.deleteModelProfile("claude-handoff")).toBe("deleted");

    const parentId = await supersededWithProfile();
    const resume = await followUps.createResumeFollowUp({
      parentId,
      reason: "crash_recovery",
    });
    expect(resume.kind).toBe("created");
    await getDbClient().run("UPDATE agent_tasks SET status = 'cancelled' WHERE parentTaskId = ?", [
      parentId,
    ]);
    expect(await profilesDb.deleteModelProfile("claude-handoff")).toBe("deleted");
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

describe("the profile check gates the agent default and task creation", () => {
  // CLAUDE_ID's pooled key ends 11111. The worker has not reported, so the
  // harness-credentials row is unverified and only the allowlist decides.
  async function poolOneKey(): Promise<void> {
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: CLAUDE_ID,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-pooled-key-11111",
      exportToEnv: true,
    });
  }

  test("PATCH runtime with an allowlist no pooled key matches is 400 naming the var", async () => {
    await poolOneKey();
    await createModelProfile({
      name: "claude-no-key",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["zzzzz"] },
    });
    const res = await call("PATCH", `/api/agents/${CLAUDE_ID}/runtime`, {
      harness_provider: "claude",
      profile: "claude-no-key",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; check: { ok: boolean } };
    expect(body.error).toContain("credential-allowlist");
    expect(body.error).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(body.error).not.toContain("pooled-key");
    expect(body.check.ok).toBe(false);
    expect(await modelProfileConfig(CLAUDE_ID)).toBeNull();
  });

  test("PATCH runtime with a warn-only profile is 200 and returns profileCheck", async () => {
    await poolOneKey();
    await createModelProfile({
      name: "claude-some-keys",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["11111", "zzzzz"] },
    });
    const res = await call("PATCH", `/api/agents/${CLAUDE_ID}/runtime`, {
      harness_provider: "claude",
      profile: "claude-some-keys",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      profileCheck: { ok: boolean; profiles: { checks: { check: string; state: string }[] }[] };
    };
    expect(body.id).toBe(CLAUDE_ID);
    expect(body.profileCheck.ok).toBe(true);
    expect(body.profileCheck.profiles[0]?.checks).toContainEqual(
      expect.objectContaining({ check: "credential-allowlist", state: "warn" }),
    );
    expect(await modelProfileConfig(CLAUDE_ID)).toEqual({
      value: "claude-some-keys",
      exportToEnv: 0,
    });
  });

  test("send-task to an agent that fails the check is a tool error listing the failing rows", async () => {
    await poolOneKey();
    await createModelProfile({
      name: "claude-no-key",
      harness: "claude",
      model: "gpt-5.6-sol",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["zzzzz"] },
    });
    const mcp = new McpServer({ name: "test-model-profiles-send-task", version: "1.0.0" });
    registerSendTaskTool(mcp);
    const tool = (
      mcp as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> }
        >;
      }
    )._registeredTools["send-task"];
    const result = await tool!.handler(
      {
        task: "profile work",
        agentId: CLAUDE_ID,
        routingReason: "human_pinned",
        routingNote: "This test pins the target",
        profile: "claude-no-key",
        allowDuplicate: true,
      },
      { sessionId: "test-session", requestInfo: { headers: { "x-agent-id": LEAD_ID } } },
    );
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])
      .map((part) => part.text)
      .join("\n");
    expect(text).toContain('Model profile "claude-no-key" fails model');
    expect(text).toContain('Model profile "claude-no-key" fails credential-allowlist');
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(
      await getDbClient().get("SELECT id FROM agent_tasks WHERE profile = 'claude-no-key'"),
    ).toBeNull();
  });
});

describe("a child judges the profile on the repo it inherits from its parent", () => {
  // CLAUDE_ID's own key ends 11111; the parent's repo pools 22222, the only key
  // the profile allows. createTaskExtended gives the child the parent's repo.
  async function parents(): Promise<{ inRepo: string; bare: string }> {
    await getDbClient().run("DELETE FROM swarm_repos");
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: CLAUDE_ID,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-agent-key-11111",
      exportToEnv: true,
    });
    const repo = await createSwarmRepo({ url: "https://github.com/acme/widgets", name: "widgets" });
    await upsertSwarmConfig({
      scope: "repo",
      scopeId: repo.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-repo-key-22222",
      exportToEnv: true,
    });
    await createModelProfile({
      name: "claude-repo-key",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["22222"] },
    });
    const inRepo = await createTaskExtended("parent", {
      agentId: LEAD_ID,
      creatorAgentId: LEAD_ID,
      vcsRepo: "acme/widgets",
    });
    const bare = await createTaskExtended("parent", { agentId: LEAD_ID, creatorAgentId: LEAD_ID });
    return { inRepo: inRepo.id, bare: bare.id };
  }

  test("POST /api/tasks", async () => {
    const { inRepo, bare } = await parents();
    const child = (parentTaskId: string) =>
      call("POST", "/api/tasks", {
        task: "child work",
        agentId: CLAUDE_ID,
        routingReason: "continuity",
        parentTaskId,
        profile: "claude-repo-key",
      });

    const ok = await child(inRepo);
    expect(ok.status).toBe(201);
    const { id } = (await ok.json()) as { id: string };
    expect(await getTaskById(id)).toMatchObject({
      vcsRepo: "acme/widgets",
      profile: "claude-repo-key",
    });
    // Control: a parent without a repo leaves the agent's own key, which fails.
    const refused = await child(bare);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("credential-allowlist");
  });

  test("send-task", async () => {
    const { inRepo, bare } = await parents();
    const mcp = new McpServer({ name: "test-model-profiles-inherited-repo", version: "1.0.0" });
    registerSendTaskTool(mcp);
    const tool = (
      mcp as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: unknown, extra: unknown) => Promise<CallToolResult> }
        >;
      }
    )._registeredTools["send-task"];
    const child = (parentTaskId: string) =>
      tool!.handler(
        {
          task: "child work",
          agentId: CLAUDE_ID,
          routingReason: "human_pinned",
          routingNote: "This test pins the target",
          parentTaskId,
          profile: "claude-repo-key",
          allowDuplicate: true,
        },
        { sessionId: "test-session", requestInfo: { headers: { "x-agent-id": LEAD_ID } } },
      );

    const ok = await child(inRepo);
    expect(ok.isError).toBeFalsy();
    expect(
      await getDbClient().get(
        "SELECT vcsRepo FROM agent_tasks WHERE parentTaskId = ? AND profile = 'claude-repo-key'",
        [inRepo],
      ),
    ).toEqual({ vcsRepo: "acme/widgets" });
    const refused = await child(bare);
    expect(refused.isError).toBe(true);
    expect(
      (refused.content as { type: string; text: string }[]).map((part) => part.text).join("\n"),
    ).toContain("credential-allowlist");
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
