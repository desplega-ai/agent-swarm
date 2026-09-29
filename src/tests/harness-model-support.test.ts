// Model-catalog phase 4: harness CLI model support, CLI-unsupported fallback
// and fail-fast at claim, and the worker-side outcome reporter.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb } from "../be/db";
import {
  getHarnessModelSupport,
  recordHarnessModelSupport,
  setAgentHarnessCliVersion,
} from "../be/harness-model-support";
import { type ModelCatalogEntry, replaceModelCatalog } from "../be/model-catalog-store";
import { invalidateTierResolutionCatalog } from "../be/model-tier-resolution";
import { handlePoll } from "../http/poll";
import {
  parseCliVersion,
  reportHarnessModelOutcome,
  resetHarnessCliVersionForTests,
} from "../utils/harness-cli-version";
import { isUnknownModelError } from "../utils/harness-model-error";

const TEST_DB_PATH = "./test-harness-model-support.sqlite";
const DAY = 24 * 60 * 60 * 1000;
const CLI = "2.1.283";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function entry(modelId: string, daysOld: number): ModelCatalogEntry {
  return {
    provider: "anthropic",
    modelId,
    releaseDate: new Date(Date.now() - daysOld * DAY).toISOString().slice(0, 10),
    pricing: { input: 5, output: 25 },
    checkedAt: Date.now(),
  };
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

async function worker(name: string) {
  const agent = await createAgent({
    name,
    isLead: false,
    status: "idle",
    maxTasks: 1,
    harnessProvider: "claude",
  });
  await setAgentHarnessCliVersion(agent.id, CLI);
  return agent;
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
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM agents");
  await client.run("DELETE FROM harness_model_support");
  await client.run("DELETE FROM model_alias_resolutions");
  await replaceModelCatalog([
    entry("claude-opus-5", 200),
    entry("claude-opus-5-5", 30),
    entry("claude-sonnet-5-5", 10),
  ]);
  invalidateTierResolutionCatalog();
  delete process.env.MODEL_TIER_CLAUDE_SMART;
});

describe("claim-time CLI support", () => {
  test("alias resolving to an unsupported model falls back within the family", async () => {
    process.env.MODEL_TIER_CLAUDE_SMART = "latest:anthropic/opus@stable";
    await recordHarnessModelSupport({
      harness: "claude",
      cliVersion: CLI,
      modelId: "claude-opus-5-5",
      status: "unsupported",
      error: "There's an issue with the selected model (claude-opus-5-5).",
    });
    const w = await worker("w-fallback");
    const task = await createTaskExtended("smart work", { agentId: w.id, modelTier: "smart" });

    const trigger = await callPoll(w.id);
    expect(trigger?.task.resolvedModel).toBe("claude-opus-5");
    expect(trigger?.task.modelSource).toBe("fallback:cli-unsupported");
    const row = await getDbClient().get<{ resolvedModel: string; modelSource: string }>(
      "SELECT resolvedModel, modelSource FROM agent_tasks WHERE id = ?",
      [task.id],
    );
    expect(row).toEqual({
      resolvedModel: "claude-opus-5",
      modelSource: "fallback:cli-unsupported",
    });
    delete process.env.MODEL_TIER_CLAUDE_SMART;
  });

  test("explicit unsupported model fails fast: trigger carries modelUnsupported", async () => {
    await recordHarnessModelSupport({
      harness: "claude",
      cliVersion: CLI,
      modelId: "claude-opus-5-5",
      status: "unsupported",
    });
    const w = await worker("w-explicit");
    await createTaskExtended("pinned work", { agentId: w.id, model: "claude-opus-5-5" });
    const trigger = await callPoll(w.id);
    expect(String(trigger?.task.modelUnsupported)).toContain("claude-opus-5-5");
    expect(trigger?.task.resolvedModel).toBeUndefined();
  });

  test("an explicit latest: alias on an unsupported model falls back, like a tier alias", async () => {
    await recordHarnessModelSupport({
      harness: "claude",
      cliVersion: CLI,
      modelId: "claude-opus-5-5",
      status: "unsupported",
    });
    const w = await worker("w-explicit-alias");
    const task = await createTaskExtended("aliased work", {
      agentId: w.id,
      model: "latest:anthropic/opus",
    });
    const trigger = await callPoll(w.id);
    expect(trigger?.task.modelUnsupported).toBeUndefined();
    expect(trigger?.task.resolvedModel).toBe("claude-opus-5");
    expect(trigger?.task.modelSource).toBe("fallback:cli-unsupported");
    // The alias the task named is still on the record.
    expect(trigger?.task.modelAlias).toBe("latest:anthropic/opus");
    const row = await getDbClient().get<{ modelAlias: string }>(
      "SELECT modelAlias FROM agent_tasks WHERE id = ?",
      [task.id],
    );
    expect(row?.modelAlias).toBe("latest:anthropic/opus");
  });

  test("an alias with no usable sibling keeps its resolution instead of failing the task", async () => {
    for (const modelId of ["claude-opus-5-5", "claude-opus-5"]) {
      await recordHarnessModelSupport({
        harness: "claude",
        cliVersion: CLI,
        modelId,
        status: "unsupported",
      });
    }
    const w = await worker("w-no-sibling");
    await createTaskExtended("aliased work", { agentId: w.id, model: "latest:anthropic/opus" });
    const trigger = await callPoll(w.id);
    expect(trigger?.task.modelUnsupported).toBeUndefined();
    expect(trigger?.task.resolvedModel).toBe("claude-opus-5-5");
    expect(trigger?.task.modelSource).toBe("model");
  });

  test("a tier default (CLI shortname) the CLI rejected falls back within its family", async () => {
    await recordHarnessModelSupport({
      harness: "claude",
      cliVersion: CLI,
      modelId: "opus",
      status: "unsupported",
    });
    const w = await worker("w-tier-default");
    await createTaskExtended("smart work", { agentId: w.id, modelTier: "smart" });
    const trigger = await callPoll(w.id);
    expect(trigger?.task.modelUnsupported).toBeUndefined();
    expect(trigger?.task.resolvedModel).toBe("claude-opus-5-5");
    expect(trigger?.task.modelSource).toBe("fallback:cli-unsupported");
  });

  test("a tier default shortname stays when only a catalog id was rejected: the CLI resolves it", async () => {
    await recordHarnessModelSupport({
      harness: "claude",
      cliVersion: CLI,
      modelId: "claude-opus-5-5",
      status: "unsupported",
    });
    const w = await worker("w-shortname-ok");
    await createTaskExtended("smart work", { agentId: w.id, modelTier: "smart" });
    const trigger = await callPoll(w.id);
    expect(trigger?.task.resolvedModel).toBe("opus");
    expect(trigger?.task.modelSource).toBe("tier-default");
  });

  test("a concrete id from a tier config value falls back; only a pinned task model fails fast", async () => {
    process.env.MODEL_TIER_CLAUDE_SMART = "claude-opus-5-5";
    await recordHarnessModelSupport({
      harness: "claude",
      cliVersion: CLI,
      modelId: "claude-opus-5-5",
      status: "unsupported",
    });
    const w = await worker("w-tier-config");
    await createTaskExtended("smart work", { agentId: w.id, modelTier: "smart" });
    const trigger = await callPoll(w.id);
    expect(trigger?.task.resolvedModel).toBe("claude-opus-5");
    expect(trigger?.task.modelSource).toBe("fallback:cli-unsupported");
    delete process.env.MODEL_TIER_CLAUDE_SMART;
  });

  test("unknown support (no row) is allowed; other CLI versions are unaffected", async () => {
    await recordHarnessModelSupport({
      harness: "claude",
      cliVersion: "2.0.0",
      modelId: "claude-opus-5-5",
      status: "unsupported",
    });
    const w = await worker("w-unknown");
    await createTaskExtended("pinned work", { agentId: w.id, model: "claude-opus-5-5" });
    const trigger = await callPoll(w.id);
    expect(trigger?.task.resolvedModel).toBe("claude-opus-5-5");
    expect(trigger?.task.modelUnsupported).toBeUndefined();
  });

  test("an ok row is never downgraded to unknown", async () => {
    const base = { harness: "claude", cliVersion: CLI, modelId: "claude-opus-5-5" };
    await recordHarnessModelSupport({ ...base, status: "ok" });
    await recordHarnessModelSupport({ ...base, status: "unknown" });
    expect(await getHarnessModelSupport("claude", CLI, "claude-opus-5-5")).toBe("ok");
  });
});

describe("worker outcome reporting", () => {
  test("parses CLI versions and recognizes unknown-model errors", () => {
    expect(parseCliVersion("2.1.283 (Claude Code)")).toBe("2.1.283");
    expect(parseCliVersion("codex-cli 0.157.1")).toBe("0.157.1");
    expect(isUnknownModelError("There's an issue with the selected model (claude-x).")).toBe(true);
    expect(isUnknownModelError("The model `gpt-9` does not exist or you do not have access")).toBe(
      true,
    );
    expect(isUnknownModelError("rate limit reached")).toBe(false);
  });

  test("sends unsupported on a model rejection, ok once on success, nothing on other failures", async () => {
    resetHarnessCliVersionForTests({ claude: CLI });
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const base = { apiUrl: "http://x", agentId: "a", harness: "claude", fetchImpl };

    await reportHarnessModelOutcome({ ...base, model: "m1", exitCode: 1, failureReason: "boom" });
    await reportHarnessModelOutcome({
      ...base,
      model: "m1",
      exitCode: 1,
      failureReason: "There's an issue with the selected model (m1).",
    });
    await reportHarnessModelOutcome({ ...base, model: "m2", exitCode: 0 });
    await reportHarnessModelOutcome({ ...base, model: "m2", exitCode: 0 });

    expect(bodies).toMatchObject([
      { modelId: "m1", status: "unsupported", cliVersion: CLI },
      { modelId: "m2", status: "ok" },
    ]);
    resetHarnessCliVersionForTests();
  });
});
