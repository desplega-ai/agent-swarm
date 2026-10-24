// Claim-time resolution of model profiles: a task's own `profile`, the agent's
// default (MODEL_PROFILE), and how both sit in the precedence next to a raw
// `model` and a `modelTier`. Drives the real `/api/poll` handler.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createSwarmRepo,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { createModelProfile, getAgentDefaultProfileName } from "../be/db/model-profiles";
import { checkProfileForAgent } from "../be/model-profile-check";
import { recordClaimModelResolution } from "../be/model-tier-resolution";
import { upsertRuntimeInstance } from "../be/multi-runtime";
import {
  bindAgentToPool,
  createRuntimeController,
  createRuntimePool,
} from "../be/runtime-pools/db";
import { routePoolTasks } from "../be/runtime-pools/routing";
import { mintRuntimeToken } from "../be/users";
import { handlePoll } from "../http/poll";
import { taskModelPin } from "../tasks/model-pin";
import { inheritedModelSelection } from "../tasks/worker-follow-up";
import { registerPollTaskTool } from "../tools/poll-task";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-profile-claim.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type Trigger = { type: string; taskId: string; task: Record<string, unknown> };

async function callPoll(
  agentId: string,
  runtimeId?: string,
  auth: "runtime-token" | "shared-key" = "runtime-token",
): Promise<Trigger | null> {
  let bodyStr = "";
  const req = {
    method: "GET",
    url: "/api/poll",
    headers: {
      "x-agent-id": agentId,
      ...(runtimeId ? { "x-runtime-instance-id": runtimeId } : {}),
    },
  } as unknown as Parameters<typeof handlePoll>[0];
  // A runtime-token poll, as a pooled worker's runtime makes it; a shared-key
  // runtime authenticates as the operator.
  if (runtimeId && auth === "shared-key") {
    setRequestAuth(req, { kind: "operator", fingerprint: "shared-key" });
  } else if (runtimeId) {
    setRequestAuth(req, {
      kind: "agent",
      agentId,
      taskId: null,
      runtimeId,
      tokenId: "runtime-token",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
  }
  const res = {
    setHeader() {},
    writeHead() {},
    end(body?: string) {
      bodyStr = body ?? "";
    },
  } as unknown as Parameters<typeof handlePoll>[1];
  await handlePoll(req, res, ["api", "poll"], new URLSearchParams(), agentId);
  return (JSON.parse(bodyStr) as { trigger: Trigger | null }).trigger;
}

async function claimRecord(id: string) {
  return await getDbClient().get<{
    resolvedModel: string | null;
    modelSource: string | null;
    resolvedProfile: string | null;
  }>("SELECT resolvedModel, modelSource, resolvedProfile FROM agent_tasks WHERE id = ?", [id]);
}

async function worker(name: string, harnessProvider: "claude" | "codex", maxTasks = 1) {
  return await createAgent({ name, isLead: false, status: "idle", maxTasks, harnessProvider });
}

async function setDefault(agentId: string, profile: string): Promise<void> {
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agentId,
    key: "MODEL_PROFILE",
    value: profile,
    exportToEnv: false,
  });
}

type PollTaskHandler = (args: unknown, extra: unknown) => Promise<unknown>;
const mcpHandlers = new Map<string, PollTaskHandler>();

/** MCP poll-task as a worker runtime calls it; onNotify runs between passes. */
async function pollTaskAs(agentId: string, runtimeId: string, onNotify: () => Promise<void>) {
  const handler = mcpHandlers.get("poll-task");
  if (!handler) throw new Error("poll-task not registered");
  return (await handler(
    {},
    {
      sessionId: "test-session",
      requestInfo: { headers: { "x-agent-id": agentId, "x-runtime-instance-id": runtimeId } },
      sendNotification: onNotify,
    },
  )) as { structuredContent?: { task?: { id?: string } } };
}

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  const mcp = {
    registerTool(name: string, _config: unknown, handler: PollTaskHandler) {
      mcpHandlers.set(name, handler);
      return { name };
    },
  };
  registerPollTaskTool(mcp as unknown as Parameters<typeof registerPollTaskTool>[0]);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

beforeEach(async () => {
  const client = getDbClient();
  // References first: migration 220's triggers refuse deleting a named profile.
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM swarm_config WHERE scope IN ('agent', 'repo')");
  await client.run("DELETE FROM swarm_repos");
  await client.run("DELETE FROM agents");
  await client.run("DELETE FROM model_profiles");
  await createModelProfile({
    name: "claude-opus-high",
    harness: "claude",
    model: "opus",
    effort: "high",
  });
  await createModelProfile({ name: "claude-haiku", harness: "claude", model: "haiku" });
  await createModelProfile({
    name: "codex-sol",
    harness: "codex",
    model: "gpt-5.6-sol",
    effort: "xhigh",
  });
});

describe("a task's own profile", () => {
  test("claim stamps the profile and hands its model and effort to the worker", async () => {
    const w = await worker("p-task", "claude");
    const task = await createTaskExtended("work", { agentId: w.id, profile: "claude-opus-high" });
    const trigger = await callPoll(w.id);

    expect(trigger?.task).toMatchObject({
      resolvedModel: "opus",
      modelSource: "profile:task",
      resolvedProfile: "claude-opus-high",
      effort: "high",
    });
    expect(await claimRecord(task.id)).toEqual({
      resolvedModel: "opus",
      modelSource: "profile:task",
      resolvedProfile: "claude-opus-high",
    });
    // The profile's effort rides on the trigger only; the row keeps the creator's ask.
    expect((await getTaskById(task.id))?.effort).toBeUndefined();
  });

  test("the task's own effort wins over the profile's", async () => {
    const w = await worker("p-effort", "claude");
    await createTaskExtended("work", { agentId: w.id, profile: "claude-opus-high", effort: "low" });
    expect((await callPoll(w.id))?.task.effort).toBe("low");
  });

  test("a profile beats the agent default", async () => {
    const w = await worker("p-beats-default", "claude");
    await setDefault(w.id, "claude-haiku");
    const task = await createTaskExtended("work", { agentId: w.id, profile: "claude-opus-high" });
    await callPoll(w.id);
    expect((await claimRecord(task.id))?.resolvedProfile).toBe("claude-opus-high");
  });

  test("a directed task with another harness's profile fails fast without a spawn", async () => {
    const w = await worker("p-mismatch", "claude");
    await createTaskExtended("work", { agentId: w.id, profile: "codex-sol" });
    const trigger = await callPoll(w.id);
    expect(String(trigger?.task.modelUnsupported)).toContain("[model-harness-mismatch]");
  });

  test("a task naming a missing profile fails fast with a tagged reason", async () => {
    // Migration 220's triggers keep such a row from existing; the claim still
    // refuses one rather than run a model nobody picked.
    const w = await worker("p-missing", "claude");
    const task = await createTaskExtended("work", { agentId: w.id });
    const fields = await recordClaimModelResolution(
      { id: task.id, profile: "claude-gone" },
      { id: w.id, harnessProvider: "claude" },
    );
    expect(String(fields.modelUnsupported)).toContain("[model-profile-missing]");
  });

  test("a pool task waits for a worker on the profile's harness", async () => {
    const codex = await worker("p-pool-codex", "codex");
    const claude = await worker("p-pool-claude", "claude");
    const task = await createTaskExtended("pool work", { profile: "claude-opus-high" });

    expect(await callPoll(codex.id)).toBeNull();
    const trigger = await callPoll(claude.id);
    expect(trigger?.taskId).toBe(task.id);
    expect(trigger?.task.resolvedProfile).toBe("claude-opus-high");
  });

  test("a pool task waits for a worker that passes the profile check", async () => {
    await createModelProfile({
      name: "claude-pinned-key",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["22222"] },
    });
    const a = await worker("p-check-fail", "claude");
    const b = await worker("p-check-pass", "claude");
    for (const [agentId, value] of [
      [a.id, "sk-ant-oat01-key-a-11111"],
      [b.id, "sk-ant-oat01-key-b-22222"],
    ] as const) {
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: agentId,
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value,
        exportToEnv: true,
      });
    }
    // Two tasks on one profile: A judges it once per poll and skips both.
    const first = await createTaskExtended("pool work", { profile: "claude-pinned-key" });
    await createTaskExtended("pool work", { profile: "claude-pinned-key" });

    expect(await callPoll(a.id)).toBeNull();
    expect((await getTaskById(first.id))?.status).toBe("unassigned");
    const trigger = await callPoll(b.id);
    expect(trigger?.taskId).toBe(first.id);
    expect(trigger?.task.resolvedProfile).toBe("claude-pinned-key");
  });

  test("a pool task's repo-scoped key counts, and one poll judges each repo apart", async () => {
    await createModelProfile({
      name: "claude-repo-key",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["22222"] },
    });
    const w = await worker("p-repo", "claude");
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: w.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-key-a-11111",
      exportToEnv: true,
    });
    const repo = await createSwarmRepo({ url: "https://github.com/acme/widgets", name: "widgets" });
    await upsertSwarmConfig({
      scope: "repo",
      scopeId: repo.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-key-b-22222",
      exportToEnv: true,
    });
    // The repo-less task is scanned first and fails on the agent's key; the
    // repo task must not inherit that verdict.
    const bare = await createTaskExtended("pool work", { profile: "claude-repo-key" });
    await Bun.sleep(5);
    const scoped = await createTaskExtended("pool work", {
      profile: "claude-repo-key",
      vcsRepo: "acme/widgets",
    });

    const trigger = await callPoll(w.id);
    expect(trigger?.taskId).toBe(scoped.id);
    expect((await getTaskById(bare.id))?.status).toBe("unassigned");
  });

  test("automatic pool routing skips a worker that fails the profile check", async () => {
    await createModelProfile({
      name: "claude-routed-key",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["22222"] },
    });
    const a = await worker("p-route-fail", "claude");
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: a.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-key-a-11111",
      exportToEnv: true,
    });
    const task = await createTaskExtended("pool work", { profile: "claude-routed-key" });
    expect((await checkProfileForAgent(a.id, "claude-routed-key"))?.ok).toBe(false);

    expect(await routePoolTasks()).toEqual([]);
    expect(await callPoll(a.id)).toBeNull();
    expect((await getTaskById(task.id))?.status).toBe("unassigned");

    const b = await worker("p-route-pass", "claude");
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: b.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat01-key-b-22222",
      exportToEnv: true,
    });
    expect(await routePoolTasks()).toEqual([{ taskId: task.id, agentId: b.id }]);
    const trigger = await callPoll(b.id);
    expect(trigger?.taskId).toBe(task.id);
    expect(trigger?.task.resolvedProfile).toBe("claude-routed-key");
  });

  test("pool routing judges a runtime worker on the config its runtime token reads", async () => {
    const saved = {
      RUNTIME_POOLS_ENABLED: process.env.RUNTIME_POOLS_ENABLED,
      MULTI_RUNTIME_ENABLED: process.env.MULTI_RUNTIME_ENABLED,
    };
    process.env.RUNTIME_POOLS_ENABLED = "true";
    process.env.MULTI_RUNTIME_ENABLED = "true";
    try {
      await createModelProfile({
        name: "claude-secret-repo-key",
        harness: "claude",
        model: "opus",
        credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["22222"] },
      });
      const w = await worker("p-route-runtime", "claude");
      const runtimeId = crypto.randomUUID();
      await upsertRuntimeInstance({ id: runtimeId, agentId: w.id, reportedSlots: 1 });
      await mintRuntimeToken(w.id, runtimeId);
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: w.id,
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "sk-ant-oat01-key-a-11111",
        exportToEnv: true,
      });
      const repo = await createSwarmRepo({
        url: "https://github.com/acme/widgets",
        name: "widgets",
      });
      // A non-lead runtime token does not read secret repo rows, so this worker's
      // env keeps the agent's 11111 key.
      await upsertSwarmConfig({
        scope: "repo",
        scopeId: repo.id,
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "sk-ant-oat01-key-b-22222",
        isSecret: true,
        exportToEnv: true,
      });
      const task = await createTaskExtended("pool work", {
        profile: "claude-secret-repo-key",
        vcsRepo: "acme/widgets",
      });

      expect(await routePoolTasks()).toEqual([]);
      expect(await callPoll(w.id, runtimeId)).toBeNull();
      expect((await getTaskById(task.id))?.status).toBe("unassigned");

      // Control: the same key as a plain repo row reaches the runtime, and routes.
      await upsertSwarmConfig({
        scope: "repo",
        scopeId: repo.id,
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "sk-ant-oat01-key-b-22222",
        isSecret: false,
        exportToEnv: true,
      });
      expect(await routePoolTasks()).toEqual([{ taskId: task.id, agentId: w.id }]);
      const trigger = await callPoll(w.id, runtimeId);
      expect(trigger?.taskId).toBe(task.id);
      expect(trigger?.task.resolvedProfile).toBe("claude-secret-repo-key");
    } finally {
      await getDbClient().run("DELETE FROM runtime_instances");
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  describe("pool routing by runtime authentication", () => {
    let saved: Record<string, string | undefined>;
    beforeEach(() => {
      saved = {
        RUNTIME_POOLS_ENABLED: process.env.RUNTIME_POOLS_ENABLED,
        MULTI_RUNTIME_ENABLED: process.env.MULTI_RUNTIME_ENABLED,
      };
      process.env.RUNTIME_POOLS_ENABLED = "true";
      process.env.MULTI_RUNTIME_ENABLED = "true";
    });
    afterEach(async () => {
      await getDbClient().run("DELETE FROM runtime_instances");
      await getDbClient().run("UPDATE agents SET runtime_pool_id = NULL");
      await getDbClient().run("DELETE FROM runtime_pools");
      await getDbClient().run("DELETE FROM runtime_controllers");
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    // Agent key 11111, secret repo override 22222, and one profile per key.
    async function keyedWorker(name: string) {
      await createModelProfile({
        name: `${name}-key-a`,
        harness: "claude",
        model: "opus",
        credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["11111"] },
      });
      await createModelProfile({
        name: `${name}-key-b`,
        harness: "claude",
        model: "opus",
        credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["22222"] },
      });
      const w = await worker(name, "claude");
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: w.id,
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "sk-ant-oat01-key-a-11111",
        exportToEnv: true,
      });
      const repo = await createSwarmRepo({
        url: "https://github.com/acme/widgets",
        name: "widgets",
      });
      await upsertSwarmConfig({
        scope: "repo",
        scopeId: repo.id,
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "sk-ant-oat01-key-b-22222",
        isSecret: true,
        exportToEnv: true,
      });
      return w;
    }

    test("a shared-key runtime is judged on the secret repo rows it reads", async () => {
      const w = await keyedWorker("p-route-shared");
      const runtimeId = crypto.randomUUID();
      await upsertRuntimeInstance({ id: runtimeId, agentId: w.id, reportedSlots: 1 });

      // Its operator config read carries the secret repo key 22222, not 11111.
      const keyA = await createTaskExtended("needs 11111", {
        profile: "p-route-shared-key-a",
        vcsRepo: "acme/widgets",
      });
      expect(await routePoolTasks()).toEqual([]);
      expect((await getTaskById(keyA.id))?.status).toBe("unassigned");

      const keyB = await createTaskExtended("needs 22222", {
        profile: "p-route-shared-key-b",
        vcsRepo: "acme/widgets",
      });
      expect(await routePoolTasks()).toEqual([{ taskId: keyB.id, agentId: w.id }]);
      const trigger = await callPoll(w.id, runtimeId, "shared-key");
      expect(trigger?.taskId).toBe(keyB.id);
      expect(trigger?.task.resolvedProfile).toBe("p-route-shared-key-b");
    });

    test("an agent with token and shared-key runtimes routes only when both pass", async () => {
      const w = await keyedWorker("p-route-mixed");
      const tokenRuntime = crypto.randomUUID();
      await upsertRuntimeInstance({ id: tokenRuntime, agentId: w.id, reportedSlots: 1 });
      await mintRuntimeToken(w.id, tokenRuntime);
      await upsertRuntimeInstance({ id: crypto.randomUUID(), agentId: w.id, reportedSlots: 1 });

      // The token runtime gets 11111 and the shared-key runtime 22222: either may
      // start the task, so neither single-key profile routes.
      const keyA = await createTaskExtended("needs 11111", {
        profile: "p-route-mixed-key-a",
        vcsRepo: "acme/widgets",
      });
      const keyB = await createTaskExtended("needs 22222", {
        profile: "p-route-mixed-key-b",
        vcsRepo: "acme/widgets",
      });
      expect(await routePoolTasks()).toEqual([]);

      // Control: once the token runtime also sees 22222, the 22222 task routes.
      const repoId = (await getDbClient().get<{ id: string }>("SELECT id FROM swarm_repos"))!.id;
      await upsertSwarmConfig({
        scope: "repo",
        scopeId: repoId,
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "sk-ant-oat01-key-b-22222",
        isSecret: false,
        exportToEnv: true,
      });
      expect(await routePoolTasks()).toEqual([{ taskId: keyB.id, agentId: w.id }]);
      expect((await getTaskById(keyA.id))?.status).toBe("unassigned");
    });

    test("a wake past the grace still judges the agent's live shared-key runtime", async () => {
      const w = await keyedWorker("p-route-wake");
      const controller = await createRuntimeController({ name: "p-wake-docker", kind: "docker" });
      const pool = await createRuntimePool({
        name: "p-wake-coders",
        kind: "docker",
        placements: [controller.id],
        image: "test-worker",
      });
      await bindAgentToPool(w.id, pool.id);
      await upsertRuntimeInstance({ id: crypto.randomUUID(), agentId: w.id, reportedSlots: 1 });

      // The live runtime reads 22222 and would poll the woken task before any
      // new runtime starts, so the 11111 task waits, before and after the grace.
      const task = await createTaskExtended("needs 11111", {
        profile: "p-route-wake-key-a",
        vcsRepo: "acme/widgets",
      });
      const afterGrace = new Date(Date.parse(task.createdAt) + 16000);
      expect(await routePoolTasks({ now: new Date(task.createdAt) })).toEqual([]);
      expect(await routePoolTasks({ now: afterGrace })).toEqual([]);
      expect((await getTaskById(task.id))?.status).toBe("unassigned");

      // Control: a fully cold wake is judged as the minted token, which reads 11111.
      await getDbClient().run("DELETE FROM runtime_instances");
      expect(await routePoolTasks({ now: afterGrace })).toEqual([
        { taskId: task.id, agentId: w.id },
      ]);
      expect((await getTaskById(task.id))?.poolWakeAt).toBe(afterGrace.toISOString());
    });

    test("a draining token runtime is still judged, since MCP poll-task can start work on it", async () => {
      const w = await keyedWorker("p-route-drain");
      await upsertRuntimeInstance({ id: crypto.randomUUID(), agentId: w.id, reportedSlots: 1 });
      const draining = crypto.randomUUID();
      await upsertRuntimeInstance({ id: draining, agentId: w.id, reportedSlots: 1 });
      await mintRuntimeToken(w.id, draining);
      await getDbClient().run("UPDATE runtime_instances SET draining = 1 WHERE id = ?", [draining]);

      // The shared-key sibling reads 22222, the draining token runtime 11111.
      const task = await createTaskExtended("needs 22222", {
        profile: "p-route-drain-key-b",
        vcsRepo: "acme/widgets",
      });
      await routePoolTasks();
      const result = await pollTaskAs(w.id, draining, async () => {
        // Retire the runtime so the long poll ends on its next pass.
        await getDbClient().run("DELETE FROM runtime_instances WHERE id = ?", [draining]);
      });
      expect(result.structuredContent?.task?.id ?? null).toBeNull();
      expect((await getTaskById(task.id))?.status).toBe("unassigned");

      // Control: once the token view also reads 22222, the task routes.
      const repoId = (await getDbClient().get<{ id: string }>("SELECT id FROM swarm_repos"))!.id;
      await upsertSwarmConfig({
        scope: "repo",
        scopeId: repoId,
        key: "CLAUDE_CODE_OAUTH_TOKEN",
        value: "sk-ant-oat01-key-b-22222",
        isSecret: false,
        exportToEnv: true,
      });
      expect(await routePoolTasks()).toEqual([{ taskId: task.id, agentId: w.id }]);
    });
  });
});

describe("the agent's default profile", () => {
  test("applies to a task with no model and no tier", async () => {
    const w = await worker("d-applies", "codex");
    await setDefault(w.id, "codex-sol");
    const task = await createTaskExtended("work", { agentId: w.id });
    const trigger = await callPoll(w.id);
    expect(trigger?.task).toMatchObject({
      resolvedModel: "gpt-5.6-sol",
      modelSource: "profile:agent-default",
      resolvedProfile: "codex-sol",
      effort: "xhigh",
    });
    expect((await claimRecord(task.id))?.modelSource).toBe("profile:agent-default");
  });

  test("a raw task model and a task tier both win over it", async () => {
    const w = await worker("d-loses", "claude", 2);
    await setDefault(w.id, "claude-opus-high");
    const pinned = await createTaskExtended("pinned", { agentId: w.id, model: "sonnet" });
    const tiered = await createTaskExtended("tiered", { agentId: w.id, modelTier: "smol" });
    await callPoll(w.id);
    await callPoll(w.id);
    expect(await claimRecord(pinned.id)).toEqual({
      resolvedModel: "sonnet",
      modelSource: "model",
      resolvedProfile: null,
    });
    expect(await claimRecord(tiered.id)).toEqual({
      resolvedModel: "haiku",
      modelSource: "tier-default",
      resolvedProfile: null,
    });
  });

  test("a default for another harness is ignored; a missing one cannot be stored", async () => {
    const w = await worker("d-ignored", "claude", 2);
    await setDefault(w.id, "codex-sol");
    const first = await createTaskExtended("work", { agentId: w.id });
    const trigger = await callPoll(w.id);
    expect(trigger?.task.modelUnsupported).toBeUndefined();
    expect(trigger?.task.resolvedModel).toBeUndefined();
    expect(await claimRecord(first.id)).toEqual({
      resolvedModel: null,
      modelSource: null,
      resolvedProfile: null,
    });

    await expect(setDefault(w.id, "gone")).rejects.toThrow("model-profile-missing");
    expect(await getAgentDefaultProfileName(w.id)).toBe("codex-sol");
  });
});

describe("re-runs", () => {
  test("a profile-filled model is not a pin, so a re-claim resolves the profile again", async () => {
    const w = await worker("r-rerun", "claude");
    await setDefault(w.id, "claude-opus-high");
    const task = await createTaskExtended("work", { agentId: w.id });
    await callPoll(w.id);
    // The session report writes the model it ran into `model`.
    await getDbClient().run(
      "UPDATE agent_tasks SET model = 'opus', claudeSessionId = 's1', status = 'pending' WHERE id = ?",
      [task.id],
    );
    const ran = await getTaskById(task.id);
    expect(ran && taskModelPin(ran)).toBeUndefined();

    // The default changes between runs; the re-claim follows it.
    await setDefault(w.id, "claude-haiku");
    const trigger = await callPoll(w.id);
    expect(trigger?.task).toMatchObject({
      resolvedModel: "haiku",
      resolvedProfile: "claude-haiku",
    });
    // Neither the previous run's model (no pin) nor its profile effort carries over.
    expect(trigger?.task.model).toBeUndefined();
    expect(trigger?.task.effort).toBeUndefined();
  });

  test("a resume carries the task's own profile, not an agent default", async () => {
    const a = await worker("r-resume-own", "claude");
    const b = await worker("r-resume-default", "claude");
    await setDefault(a.id, "claude-opus-high");
    await setDefault(b.id, "claude-opus-high");
    const own = await createTaskExtended("work", { agentId: a.id, profile: "claude-haiku" });
    const viaDefault = await createTaskExtended("work", { agentId: b.id });
    await callPoll(a.id);
    await callPoll(b.id);

    const ownRow = await getTaskById(own.id);
    const defaultRow = await getTaskById(viaDefault.id);
    expect(ownRow && inheritedModelSelection(ownRow)).toEqual({ profile: "claude-haiku" });
    expect(defaultRow?.resolvedProfile).toBe("claude-opus-high");
    expect(defaultRow && inheritedModelSelection(defaultRow)).toEqual({});
  });
});
