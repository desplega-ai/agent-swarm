// Claim-time resolution of model profiles: a task's own `profile`, the agent's
// default (MODEL_PROFILE), and how both sit in the precedence next to a raw
// `model` and a `modelTier`. Drives the real `/api/poll` handler.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { createModelProfile, getAgentDefaultProfileName } from "../be/db/model-profiles";
import { recordClaimModelResolution } from "../be/model-tier-resolution";
import { handlePoll } from "../http/poll";
import { taskModelPin } from "../tasks/model-pin";
import { inheritedModelSelection } from "../tasks/worker-follow-up";

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

async function callPoll(agentId: string): Promise<Trigger | null> {
  let bodyStr = "";
  const req = {
    method: "GET",
    url: "/api/poll",
    headers: { "x-agent-id": agentId },
  } as unknown as Parameters<typeof handlePoll>[0];
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

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
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
