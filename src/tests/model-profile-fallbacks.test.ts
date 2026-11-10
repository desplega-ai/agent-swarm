// Model profile fallbacks (runbooks/model-tiers.md § Fallbacks on provider
// errors): the save rule, the delete guard, the check rows, the server-side
// pick (another key of the same profile first, then the next profile), and
// the supersede route that resumes the work.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  getTaskById,
  initDb,
  markKeyRateLimited,
  recordKeyUsage,
  startTask,
  upsertSwarmConfig,
} from "../be/db";
import * as profilesDb from "../be/db/model-profiles";
import { createModelProfile } from "../be/db/model-profiles";
import { checkProfileForAgent } from "../be/model-profile-check";
import { recordClaimModelResolution } from "../be/model-tier-resolution";
import { handleModelProfiles } from "../http/model-profiles";
import { handleTasks } from "../http/tasks";
import {
  getNextResumeGeneration,
  nextFallback,
  RESUME_GENERATION_TAG_PREFIX,
} from "../tasks/worker-follow-up";
import type { AgentTask } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-model-profile-fallbacks.sqlite";
const LEAD_ID = "51111111-1111-4111-8111-111111111111";
const CLAUDE_ID = "52222222-2222-4222-8222-222222222222";

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
  await createAgent({ id: LEAD_ID, name: "fb-lead", isLead: true, status: "idle" });
  await createAgent({
    id: CLAUDE_ID,
    name: "fb-claude",
    isLead: false,
    status: "idle",
    harnessProvider: "claude",
    maxTasks: 2,
  });
  server = createServer((req, res) => {
    if (req.headers["x-test-auth"] === "operator") {
      setRequestAuth(req, { kind: "operator", fingerprint: "test" });
    }
    const header = req.headers["x-agent-id"];
    const agentId = Array.isArray(header) ? header[0] : header;
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    void (async () => {
      for (const handle of [handleModelProfiles, handleTasks]) {
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
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run(
    "DELETE FROM swarm_config WHERE key IN ('MODEL_PROFILE', 'CLAUDE_CODE_OAUTH_TOKEN')",
  );
  await getDbClient().run("DELETE FROM model_profiles");
  await getDbClient().run("DELETE FROM api_key_status");
  // Agent heartbeat: the resume pin reads it.
  await getDbClient().run("UPDATE agents SET status = 'idle', lastActivityAt = ? WHERE id = ?", [
    new Date().toISOString(),
    CLAUDE_ID,
  ]);
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

async function errorText(res: Response): Promise<string> {
  return ((await res.json()) as { error?: string }).error ?? "";
}

/** Three claude profiles and one codex profile; `claude-a` falls back to b, then c. */
async function seedChain(): Promise<void> {
  await createModelProfile({ name: "claude-c", harness: "claude", model: "sonnet" });
  await createModelProfile({ name: "claude-b", harness: "claude", model: "opus" });
  await createModelProfile({
    name: "claude-a",
    harness: "claude",
    model: "opus",
    fallbacks: ["claude-b", "claude-c"],
  });
  await createModelProfile({ name: "codex-x", harness: "codex", model: "gpt-5" });
}

/** An in-progress task on the claude agent whose claim applied `profile`. */
async function runningTask(profile: string, extra: { workflow?: boolean } = {}) {
  const task = await createTaskExtended("fallback work", { agentId: CLAUDE_ID, profile });
  await recordClaimModelResolution(
    { id: task.id, profile },
    { id: CLAUDE_ID, harnessProvider: "claude" },
  );
  await startTask(task.id);
  if (extra.workflow) {
    // The route only reads that the step id is set; skip building a real run.
    await getDbClient().run("PRAGMA foreign_keys = OFF");
    await getDbClient().run("UPDATE agent_tasks SET workflowRunStepId = ? WHERE id = ?", [
      crypto.randomUUID(),
      task.id,
    ]);
    await getDbClient().run("PRAGMA foreign_keys = ON");
  }
  return (await getTaskById(task.id)) as AgentTask;
}

const KEY_TYPE = "CLAUDE_CODE_OAUTH_TOKEN";

/** The claude agent's pool: one key per 5-character suffix, in order. */
async function seedPool(suffixes: string[]): Promise<void> {
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: CLAUDE_ID,
    key: KEY_TYPE,
    value: suffixes.map((suffix) => `token-${suffix}`).join(","),
  });
}

/** Stamp the key the run drew on the task, as the worker's usage report does. */
async function onKey(task: AgentTask, suffix: string): Promise<AgentTask> {
  await recordKeyUsage(KEY_TYPE, suffix, 0, task.id);
  return (await getTaskById(task.id)) as AgentTask;
}

/** Bench a key, as the worker's key-wide rate-limit report does. */
async function bench(suffix: string): Promise<void> {
  await markKeyRateLimited(KEY_TYPE, suffix, 0, new Date(Date.now() + 3_600_000).toISOString());
}

function supersede(taskId: string, body: Record<string, unknown>): Promise<Response> {
  return call("POST", `/api/tasks/${taskId}/supersede`, body, { "x-agent-id": CLAUDE_ID });
}

async function resumeOf(parentId: string): Promise<AgentTask | null> {
  const row = await getDbClient().get<{ id: string }>(
    "SELECT id FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'resume'",
    [parentId],
  );
  return row ? await getTaskById(row.id) : null;
}

describe("save rule", () => {
  test("a valid same-harness list saves and reads back", async () => {
    await seedChain();
    const res = await call("POST", "/api/model-profiles", {
      name: "claude-d",
      harness: "claude",
      model: "opus",
      fallbacks: ["claude-c"],
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { fallbacks: string[] }).fallbacks).toEqual(["claude-c"]);
    const list = (await (await call("GET", "/api/model-profiles", undefined)).json()) as {
      profiles: { name: string; fallbacks: string[] }[];
    };
    expect(list.profiles.find((p) => p.name === "claude-a")?.fallbacks).toEqual([
      "claude-b",
      "claude-c",
    ]);
    // Control: a profile with no fallbacks reads back an empty list.
    expect(list.profiles.find((p) => p.name === "claude-c")?.fallbacks).toEqual([]);
  });

  test("cross-harness, unknown, self and repeated fallbacks are refused", async () => {
    await seedChain();
    const cases: [unknown[], string][] = [
      [["codex-x"], "runs on codex, not claude"],
      [["claude-nope"], 'Unknown fallback profile "claude-nope"'],
      [["claude-d"], "cannot list itself"],
      [["claude-c", "claude-c"], "listed twice"],
    ];
    for (const [fallbacks, message] of cases) {
      const res = await call("POST", "/api/model-profiles", {
        name: "claude-d",
        harness: "claude",
        model: "opus",
        fallbacks,
      });
      expect(res.status).toBe(400);
      expect(await errorText(res)).toContain(message);
    }
    expect(await profilesDb.getModelProfileByName("claude-d")).toBeNull();
  });

  test("an update that closes a cycle is refused; the stored list stays", async () => {
    await seedChain();
    const res = await call("PATCH", "/api/model-profiles/claude-c", { fallbacks: ["claude-a"] });
    expect(res.status).toBe(400);
    expect(await errorText(res)).toContain("cycle: claude-c → claude-a → claude-c");
    expect((await profilesDb.getModelProfileByName("claude-c"))?.fallbacks).toEqual([]);
    // Control: a non-cyclic edit to the same profile saves, and [] empties it.
    const ok = await call("PATCH", "/api/model-profiles/claude-b", { fallbacks: ["claude-c"] });
    expect(ok.status).toBe(200);
    const cleared = await call("PATCH", "/api/model-profiles/claude-a", { fallbacks: [] });
    expect(((await cleared.json()) as { fallbacks: string[] }).fallbacks).toEqual([]);
  });

  test("deleting a profile another lists as a fallback is a 409, in the route and the statement", async () => {
    await seedChain();
    const res = await call("DELETE", "/api/model-profiles/claude-c", undefined);
    expect(res.status).toBe(409);
    expect(await errorText(res)).toContain("a fallback of 1 profile(s) (claude-a)");
    expect(await profilesDb.deleteModelProfile("claude-c")).toBe("in-use");
    // Control: once no list names it, it deletes.
    await call("PATCH", "/api/model-profiles/claude-a", { fallbacks: ["claude-b"] });
    expect((await call("DELETE", "/api/model-profiles/claude-c", undefined)).status).toBe(200);
  });
});

describe("check", () => {
  test("fallbacks get their own rows; ok judges the primary only", async () => {
    await seedChain();
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: CLAUDE_ID,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "token-aaaaa",
    });
    await profilesDb.updateModelProfile("claude-b", {
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["zzzzz"] },
    });
    const result = await checkProfileForAgent(CLAUDE_ID, "claude-a");
    expect(result?.ok).toBe(true);
    expect(result?.profiles.map((p) => [p.name, p.ok])).toEqual([
      ["claude-a", true],
      ["claude-b", false],
      ["claude-c", true],
    ]);
  });
});

describe("nextFallback", () => {
  test("picks the first fallback that passes and records the ones it skips", async () => {
    await seedChain();
    await upsertSwarmConfig({
      scope: "agent",
      scopeId: CLAUDE_ID,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "token-aaaaa",
    });
    await profilesDb.updateModelProfile("claude-b", {
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["zzzzz"] },
    });
    const pick = await nextFallback(await runningTask("claude-a"), "rate_limit");
    expect(pick.kind).toBe("picked");
    if (pick.kind !== "picked") return;
    expect(pick.profile).toBe("claude-c");
    expect(pick.hop).toMatchObject({
      from: "claude-a",
      profile: "claude-c",
      errorClass: "rate_limit",
    });
    expect(pick.hop.skipped?.[0]?.profile).toBe("claude-b");
    expect(pick.hop.skipped?.[0]?.reason).toContain("credential-allowlist");
  });

  test("never picks a profile the work already ran on, and names the chain when it ends", async () => {
    await seedChain();
    const task = await runningTask("claude-c");
    const hopped = {
      ...task,
      fallbackHops: [
        { from: "claude-a", profile: "claude-b", errorClass: "rate_limit" as const, at: "t1" },
        { from: "claude-b", profile: "claude-c", errorClass: "overloaded" as const, at: "t2" },
      ],
    };
    expect(await nextFallback(hopped, "seat")).toEqual({
      kind: "none",
      message: "seat on claude-c; no fallback left (tried: claude-a → claude-b → claude-c)",
    });
  });

  test("a profile with no fallbacks gives no message, so the failure text is unchanged", async () => {
    await seedChain();
    expect(await nextFallback(await runningTask("claude-c"), "rate_limit")).toEqual({
      kind: "none",
      message: null,
    });
    // Control: no profile at claim never hops.
    expect(
      await nextFallback({ agentId: CLAUDE_ID, resolvedProfile: undefined }, "rate_limit"),
    ).toEqual({ kind: "none", message: null });
  });

  test("an eleven-hop chain still reaches its last unvisited fallback", async () => {
    // p0 → p1 → … → p11, created from the end so each fallback exists.
    for (let i = 11; i >= 0; i--) {
      await createModelProfile({
        name: `p${i}`,
        harness: "claude",
        model: "sonnet",
        fallbacks: i === 11 ? [] : [`p${i + 1}`],
      });
    }
    const task = await runningTask("p10");
    const hops = Array.from({ length: 10 }, (_, i) => ({
      from: `p${i}`,
      profile: `p${i + 1}`,
      errorClass: "rate_limit" as const,
      at: "t",
    }));
    const pick = await nextFallback({ ...task, fallbackHops: hops }, "rate_limit");
    expect(pick).toMatchObject({ kind: "picked", profile: "p11" });
    // Control: once p11 ran too, the acyclic chain ends by itself.
    const done = await nextFallback(
      {
        ...task,
        resolvedProfile: "p11",
        fallbackHops: [
          ...hops,
          { from: "p10", profile: "p11", errorClass: "rate_limit" as const, at: "t" },
        ],
      },
      "rate_limit",
    );
    expect(done.kind).toBe("none");
  });

  test("lead-only work on an agent that cannot hold a lead-only pin never hops", async () => {
    await seedChain();
    const task = await runningTask("claude-a");
    const pick = await nextFallback(
      { ...task, routingAffinity: { capabilities: [], leadOnly: true } },
      "rate_limit",
    );
    expect(pick.kind).toBe("none");
    expect(pick.kind === "none" && pick.message).toContain("lead-only");
  });
});

describe("same-profile key retry", () => {
  test("rate_limit with no fallbacks retries the profile while another key is unbenched", async () => {
    await seedChain();
    await seedPool(["aaaaa", "bbbbb"]);
    const task = await onKey(await runningTask("claude-c"), "aaaaa");
    await bench("aaaaa");
    const pick = await nextFallback(task, "rate_limit");
    expect(pick).toMatchObject({
      kind: "picked",
      profile: "claude-c",
      hop: { from: "claude-c", profile: "claude-c", errorClass: "rate_limit" },
    });
    // `credits` benches the key the same way; `auth` does not, so it never retries.
    expect(await nextFallback(task, "credits")).toMatchObject({
      kind: "picked",
      profile: "claude-c",
    });
    expect(await nextFallback(task, "auth")).toEqual({ kind: "none", message: null });

    // Through the route: the resume runs the same profile on the same agent.
    const res = await supersede(task.id, { reason: "provider_fallback", errorClass: "rate_limit" });
    expect(((await res.json()) as { kind: string }).kind).toBe("resumed");
    const resume = await resumeOf(task.id);
    expect(resume?.agentId).toBe(CLAUDE_ID);
    expect(resume?.profile).toBe("claude-c");
    expect(resume?.fallbackHops?.map((h) => [h.from, h.profile, h.errorClass])).toEqual([
      ["claude-c", "claude-c", "rate_limit"],
    ]);

    // Control: a workflow step still fails back to the engine.
    const step = await onKey(await runningTask("claude-c", { workflow: true }), "aaaaa");
    const stepRes = await supersede(step.id, {
      reason: "provider_fallback",
      errorClass: "rate_limit",
    });
    expect(await stepRes.json()).toMatchObject({ kind: "noFallback", failureReason: null });
  });

  test("the key that just failed never counts, even before its bench lands", async () => {
    await seedChain();
    await seedPool(["aaaaa", "bbbbb"]);
    const task = await onKey(await runningTask("claude-c"), "aaaaa");
    // Nothing benched yet: the other key is free.
    expect((await nextFallback(task, "rate_limit")).kind).toBe("picked");
    // Only the failed key is unbenched: nothing to retry on.
    await bench("bbbbb");
    expect((await nextFallback(task, "rate_limit")).kind).toBe("none");
  });

  test("a task with a key type but no recorded key never retries on a key", async () => {
    await seedChain();
    await seedPool(["aaaaa", "bbbbb"]);
    const task = await onKey(await runningTask("claude-c"), "aaaaa");
    // Without the suffix the pick cannot exclude the key that failed.
    const noSuffix = { ...task, credentialKeySuffix: undefined };
    expect(noSuffix.credentialKeyType).toBe(KEY_TYPE);
    expect(await nextFallback(noSuffix, "rate_limit")).toEqual({ kind: "none", message: null });
    // Control: the same task with its suffix retries.
    expect((await nextFallback(task, "rate_limit")).kind).toBe("picked");
  });

  test("all keys benched gives no pick and a reason that names the exhausted keys", async () => {
    await seedChain();
    await seedPool(["aaaaa", "bbbbb"]);
    const task = await onKey(await runningTask("claude-c"), "aaaaa");
    await bench("aaaaa");
    await bench("bbbbb");
    expect(await nextFallback(task, "rate_limit")).toEqual({
      kind: "none",
      message:
        "rate_limit on claude-c; no key left (all 2 CLAUDE_CODE_OAUTH_TOKEN keys are rate-limited or just failed); no fallback configured",
    });
    // Control: a one-key pool has nothing to rotate to, so the text is unchanged.
    await seedPool(["aaaaa"]);
    expect(await nextFallback(task, "rate_limit")).toEqual({ kind: "none", message: null });
  });

  test("retries stop at the pool size, even when no bench ever lands", async () => {
    await seedChain();
    await seedPool(["aaaaa", "bbbbb"]);
    // No key is ever benched, so the other key always reads free.
    let task = await onKey(await runningTask("claude-c"), "aaaaa");
    for (const nextKey of ["bbbbb", "aaaaa"]) {
      const res = await supersede(task.id, {
        reason: "provider_fallback",
        errorClass: "rate_limit",
      });
      expect(((await res.json()) as { kind: string }).kind).toBe("resumed");
      const resume = (await resumeOf(task.id))!;
      await recordClaimModelResolution(
        { id: resume.id, profile: resume.profile },
        { id: CLAUDE_ID, harnessProvider: "claude" },
      );
      await startTask(resume.id);
      task = await onKey((await getTaskById(resume.id)) as AgentTask, nextKey);
    }
    expect(task.fallbackHops).toHaveLength(2);
    const last = await supersede(task.id, {
      reason: "provider_fallback",
      errorClass: "rate_limit",
    });
    expect(await last.json()).toMatchObject({
      kind: "noFallback",
      failureReason:
        "rate_limit on claude-c; no key retry left (2 retries on a pool of 2 CLAUDE_CODE_OAUTH_TOKEN keys); no fallback configured",
    });
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("another key comes before a fallback profile; exhausted keys take the fallback", async () => {
    await seedChain();
    await seedPool(["aaaaa", "bbbbb"]);
    const task = await onKey(await runningTask("claude-a"), "aaaaa");
    await bench("aaaaa");
    expect(await nextFallback(task, "rate_limit")).toMatchObject({
      kind: "picked",
      profile: "claude-a",
    });
    await bench("bbbbb");
    const retried = {
      ...task,
      fallbackHops: [
        { from: "claude-a", profile: "claude-a", errorClass: "rate_limit" as const, at: "t1" },
      ],
    };
    const pick = await nextFallback(retried, "rate_limit");
    expect(pick).toMatchObject({
      kind: "picked",
      profile: "claude-b",
      hop: { from: "claude-a", profile: "claude-b" },
    });
    // A key retry is not a step of the chain: the tried path names each profile once.
    const ended = await nextFallback(
      {
        ...task,
        resolvedProfile: "claude-c",
        fallbackHops: [
          ...retried.fallbackHops,
          { from: "claude-a", profile: "claude-b", errorClass: "rate_limit" as const, at: "t2" },
          { from: "claude-b", profile: "claude-c", errorClass: "overloaded" as const, at: "t3" },
          { from: "claude-c", profile: "claude-c", errorClass: "rate_limit" as const, at: "t4" },
        ],
      },
      "overloaded",
    );
    expect(ended.kind === "none" && ended.message).toContain(
      "(tried: claude-a → claude-b → claude-c)",
    );
  });

  test("model_window, seat and lead-only work never try another key", async () => {
    await seedChain();
    await seedPool(["aaaaa", "bbbbb"]);
    const task = await onKey(await runningTask("claude-a"), "aaaaa");
    for (const errorClass of ["model_window", "seat"] as const) {
      expect(await nextFallback(task, errorClass)).toMatchObject({
        kind: "picked",
        profile: "claude-b",
        hop: { from: "claude-a", profile: "claude-b", errorClass },
      });
    }
    const leadOnly = await nextFallback(
      { ...task, routingAffinity: { capabilities: [], leadOnly: true } },
      "rate_limit",
    );
    expect(leadOnly.kind === "none" && leadOnly.message).toContain("lead-only");
  });
});

describe("supersede with provider_fallback", () => {
  test("errorClass is required with provider_fallback and refused without it", async () => {
    await seedChain();
    const task = await runningTask("claude-a");
    expect((await supersede(task.id, { reason: "provider_fallback" })).status).toBe(400);
    expect(
      (await supersede(task.id, { reason: "manual_supersede", errorClass: "rate_limit" })).status,
    ).toBe(400);
    expect((await getTaskById(task.id))?.status).toBe("in_progress");
  });

  test("hops through the chain on the same agent, through a real claim, then ends", async () => {
    await seedChain();
    const first = await runningTask("claude-a");
    const res = await supersede(first.id, {
      reason: "provider_fallback",
      errorClass: "rate_limit",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; resumeTaskId: string };
    expect(body.kind).toBe("resumed");
    expect((await getTaskById(first.id))?.status).toBe("superseded");

    const second = await resumeOf(first.id);
    expect(second?.id).toBe(body.resumeTaskId);
    expect(second?.agentId).toBe(CLAUDE_ID);
    expect(second?.profile).toBe("claude-b");
    expect(second?.tags).toContain("reason:provider_fallback");
    expect(second?.fallbackHops?.map((h) => [h.from, h.profile, h.errorClass])).toEqual([
      ["claude-a", "claude-b", "rate_limit"],
    ]);

    // The child's claim applies the picked profile.
    const claim = await recordClaimModelResolution(
      { id: second!.id, profile: second!.profile },
      { id: CLAUDE_ID, harnessProvider: "claude" },
    );
    expect(claim.modelUnsupported).toBeUndefined();
    await startTask(second!.id);
    expect((await getTaskById(second!.id))?.resolvedProfile).toBe("claude-b");

    const again = await supersede(second!.id, {
      reason: "provider_fallback",
      errorClass: "overloaded",
    });
    expect(((await again.json()) as { kind: string }).kind).toBe("resumed");
    const third = await resumeOf(second!.id);
    expect(third?.profile).toBe("claude-c");
    expect(third?.fallbackHops?.map((h) => h.profile)).toEqual(["claude-b", "claude-c"]);

    await recordClaimModelResolution(
      { id: third!.id, profile: third!.profile },
      { id: CLAUDE_ID, harnessProvider: "claude" },
    );
    await startTask(third!.id);
    const last = await supersede(third!.id, { reason: "provider_fallback", errorClass: "auth" });
    expect(await last.json()).toMatchObject({
      kind: "noFallback",
      resumeTaskId: null,
      failureReason: "auth on claude-c; no fallback left (tried: claude-a → claude-b → claude-c)",
    });
    // The worker fails it itself: the task is untouched and has no resume.
    expect((await getTaskById(third!.id))?.status).toBe("in_progress");
    expect(await resumeOf(third!.id)).toBeNull();
  });

  test("a fallback resume does not spend the crash-recovery budget", async () => {
    await seedChain();
    // A fresh task: two fallback hops leave it at generation 0.
    const first = await runningTask("claude-a");
    await supersede(first.id, { reason: "provider_fallback", errorClass: "rate_limit" });
    const second = await resumeOf(first.id);
    expect(second?.tags.some((t) => t.startsWith("resume-generation:"))).toBe(false);
    await recordClaimModelResolution(
      { id: second!.id, profile: second!.profile },
      { id: CLAUDE_ID, harnessProvider: "claude" },
    );
    await startTask(second!.id);
    await supersede(second!.id, { reason: "provider_fallback", errorClass: "overloaded" });
    const third = await resumeOf(second!.id);
    expect(getNextResumeGeneration(third!)).toBe(1);

    // A task already one crash deep: the hop keeps its generation, so the
    // crash after it is generation 2, not 3.
    const crashed = await createTaskExtended("crashed work", {
      agentId: CLAUDE_ID,
      profile: "claude-a",
      tags: [`${RESUME_GENERATION_TAG_PREFIX}1`],
    });
    await recordClaimModelResolution(
      { id: crashed.id, profile: "claude-a" },
      { id: CLAUDE_ID, harnessProvider: "claude" },
    );
    await startTask(crashed.id);
    await supersede(crashed.id, { reason: "provider_fallback", errorClass: "rate_limit" });
    const hopped = await resumeOf(crashed.id);
    expect(hopped?.tags).toContain(`${RESUME_GENERATION_TAG_PREFIX}1`);
    expect(getNextResumeGeneration(hopped!)).toBe(2);
  });

  test("the resume stays on the agent when a competing claim fills the freed slot", async () => {
    await seedChain();
    const first = await runningTask("claude-a");
    // Other claims hold both of the agent's slots (maxTasks 2) by the time
    // the resume is routed, so the parent's freed slot is gone.
    for (const n of [1, 2]) {
      const other = await createTaskExtended(`competing claim ${n}`, { agentId: CLAUDE_ID });
      await startTask(other.id);
    }
    const res = await supersede(first.id, {
      reason: "provider_fallback",
      errorClass: "rate_limit",
    });
    expect(((await res.json()) as { kind: string }).kind).toBe("resumed");
    const resume = await resumeOf(first.id);
    expect(resume?.profile).toBe("claude-b");
    expect(resume?.agentId).toBe(CLAUDE_ID);
    expect(resume?.status).toBe("pending");
  });

  test("the resume stays on the agent even when the agent reads offline", async () => {
    await seedChain();
    const first = await runningTask("claude-a");
    await getDbClient().run("UPDATE agents SET status = 'offline' WHERE id = ?", [CLAUDE_ID]);
    const res = await supersede(first.id, {
      reason: "provider_fallback",
      errorClass: "overloaded",
    });
    expect(((await res.json()) as { kind: string }).kind).toBe("resumed");
    const resume = await resumeOf(first.id);
    expect(resume?.profile).toBe("claude-b");
    expect(resume?.agentId).toBe(CLAUDE_ID);
  });

  test("a task with no fallbacks and a workflow step are left for the worker to fail", async () => {
    await seedChain();
    const plain = await runningTask("claude-c");
    const res = await supersede(plain.id, {
      reason: "provider_fallback",
      errorClass: "rate_limit",
    });
    expect(await res.json()).toMatchObject({ kind: "noFallback", failureReason: null });
    expect((await getTaskById(plain.id))?.status).toBe("in_progress");

    const step = await runningTask("claude-a", { workflow: true });
    const stepRes = await supersede(step.id, {
      reason: "provider_fallback",
      errorClass: "rate_limit",
    });
    expect(await stepRes.json()).toMatchObject({ kind: "noFallback", failureReason: null });
    expect((await getTaskById(step.id))?.status).toBe("in_progress");
  });

  test("control: other reasons resume as before and carry the hop list", async () => {
    await seedChain();
    const first = await runningTask("claude-a");
    await supersede(first.id, { reason: "provider_fallback", errorClass: "rate_limit" });
    const second = (await resumeOf(first.id))!;
    await recordClaimModelResolution(
      { id: second.id, profile: second.profile },
      { id: CLAUDE_ID, harnessProvider: "claude" },
    );
    await startTask(second.id);
    const res = await supersede(second.id, { reason: "manual_supersede" });
    expect(((await res.json()) as { kind: string }).kind).toBe("resumed");
    const third = await resumeOf(second.id);
    expect(third?.profile).toBe("claude-b");
    expect(third?.fallbackHops?.map((h) => h.profile)).toEqual(["claude-b"]);
  });
});
