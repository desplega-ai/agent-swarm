// Model-catalog phase 3: claim-time model resolution.
//
// Drives the real `/api/poll` handler with mocked req/res and asserts what the
// server records on the task (`resolvedModel`, `modelSource`, `modelAlias`),
// plus the `latest:` guardrails and the MODEL_TIER_<PROVIDER>_<TIER> validator.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb } from "../be/db";
import { type AgentTaskRow, rowToAgentTaskSummary } from "../be/db/tasks/read";
import { type ModelCatalogEntry, replaceModelCatalog } from "../be/model-catalog-store";
import {
  getAgentModelTierOverrides,
  invalidateTierResolutionCatalog,
  isTierConfigKey,
  parseModelTierOverridesHeader,
  previewModelTiers,
  resolveTaskModel,
  tierConfigKey,
} from "../be/model-tier-resolution";
import { validateConfigValue } from "../be/swarm-config-guard";
import { handleModelsCatalog } from "../http/models-catalog";
import { handlePoll } from "../http/poll";
import { parseWorkerModelTierOverrides } from "../types";

const TEST_DB_PATH = "./test-model-tier-resolution.sqlite";
const DAY = 24 * 60 * 60 * 1000;
const ENV_KEYS = [
  "MODEL_TIER_CLAUDE_SMART",
  "MODEL_TIER_CODEX_SMART",
  "MODEL_LATEST_SOAK_DAYS",
  "MODEL_AUTO_UPGRADE",
];

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
}

function entry(
  provider: string,
  modelId: string,
  releaseDate: string,
  priced = true,
): ModelCatalogEntry {
  return {
    provider,
    modelId,
    releaseDate,
    pricing: priced ? { input: 5, output: 25 } : null,
    checkedAt: Date.now(),
  };
}

async function seedCatalog(entries: ModelCatalogEntry[]): Promise<void> {
  await replaceModelCatalog(entries);
  invalidateTierResolutionCatalog();
}

type Trigger = { type: string; taskId: string; task: Record<string, unknown> };

async function callPoll(agentId: string, overridesHeader?: string): Promise<Trigger | null> {
  let bodyStr = "";
  const headers: Record<string, string> = { "x-agent-id": agentId };
  if (overridesHeader !== undefined) headers["x-model-tier-overrides"] = overridesHeader;
  const req = { method: "GET", url: "/api/poll", headers } as unknown as Parameters<
    typeof handlePoll
  >[0];
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

async function taskRow(id: string) {
  return await getDbClient().get<{
    resolvedModel: string | null;
    modelSource: string | null;
    modelAlias: string | null;
  }>("SELECT resolvedModel, modelSource, modelAlias FROM agent_tasks WHERE id = ?", [id]);
}

function header(overrides: unknown): string {
  return encodeURIComponent(JSON.stringify(overrides));
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
  await client.run("DELETE FROM model_alias_resolutions");
  await seedCatalog([
    entry("anthropic", "claude-opus-5", daysAgo(200)),
    entry("anthropic", "claude-opus-5-5", daysAgo(30)),
    entry("anthropic", "claude-sonnet-5-5", daysAgo(10)),
  ]);
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("claim-time resolution via /api/poll", () => {
  test("worker MODEL_TIER_SMART=sonnet → resolvedModel sonnet, modelSource worker-env", async () => {
    const worker = await createAgent({
      name: "w-env",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      harnessProvider: "claude",
    });
    // What the runner sends: parsed from its own process env.
    const overrides = parseWorkerModelTierOverrides({ MODEL_TIER_SMART: "sonnet" }, "claude");
    expect(overrides).toEqual({ claude: { smart: "sonnet" } });
    // Tier config is set too; the worker env must still win.
    process.env.MODEL_TIER_CLAUDE_SMART = "latest:anthropic/opus@stable";

    const task = await createTaskExtended("smart work", { agentId: worker.id, modelTier: "smart" });
    const trigger = await callPoll(worker.id, header(overrides));

    expect(trigger?.type).toBe("task_assigned");
    expect(trigger?.task.resolvedModel).toBe("sonnet");
    expect(trigger?.task.modelSource).toBe("worker-env");
    expect(await taskRow(task.id)).toEqual({
      resolvedModel: "sonnet",
      modelSource: "worker-env",
      modelAlias: null,
    });
    expect(await getAgentModelTierOverrides(worker.id)).toEqual({ claude: { smart: "sonnet" } });
  });

  test("worker latest: alias resolves to the concrete Sonnet id", async () => {
    const worker = await createAgent({
      name: "w-env-alias",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      harnessProvider: "claude",
    });
    const task = await createTaskExtended("smart work", { agentId: worker.id, modelTier: "smart" });
    await callPoll(worker.id, header({ claude: { smart: "latest:anthropic/sonnet" } }));
    expect(await taskRow(task.id)).toEqual({
      resolvedModel: "claude-sonnet-5-5",
      modelSource: "worker-env",
      modelAlias: "latest:anthropic/sonnet",
    });
  });

  test("tier-config latest: alias → catalog id, recorded in model_alias_resolutions", async () => {
    process.env.MODEL_TIER_CLAUDE_SMART = "latest:anthropic/opus@stable";
    const worker = await createAgent({
      name: "w-config",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      harnessProvider: "claude",
    });
    const task = await createTaskExtended("smart work", { agentId: worker.id, modelTier: "smart" });
    const trigger = await callPoll(worker.id, header({}));

    expect(trigger?.task.resolvedModel).toBe("claude-opus-5-5");
    expect(await taskRow(task.id)).toEqual({
      resolvedModel: "claude-opus-5-5",
      modelSource: "tier-config",
      modelAlias: "latest:anthropic/opus@stable",
    });
    const changes = await getDbClient().query<{ alias: string; newModel: string }>(
      "SELECT alias, newModel FROM model_alias_resolutions",
    );
    expect(changes).toEqual([
      { alias: "latest:anthropic/opus@stable", newModel: "claude-opus-5-5" },
    ]);
  });

  test("no overrides → tier-default; explicit task model wins over everything", async () => {
    const worker = await createAgent({
      name: "w-default",
      isLead: false,
      status: "idle",
      maxTasks: 2,
      harnessProvider: "claude",
    });
    const tierTask = await createTaskExtended("tier", { agentId: worker.id, modelTier: "smart" });
    await callPoll(worker.id, header({ claude: {} }));
    expect(await taskRow(tierTask.id)).toEqual({
      resolvedModel: "opus",
      modelSource: "tier-default",
      modelAlias: null,
    });

    const modelTask = await createTaskExtended("model", {
      agentId: worker.id,
      model: "claude-opus-5",
      modelTier: "smart",
    });
    await callPoll(worker.id, header({ claude: { smart: "sonnet" } }));
    expect(await taskRow(modelTask.id)).toEqual({
      resolvedModel: "claude-opus-5",
      modelSource: "model",
      modelAlias: null,
    });
  });

  test("pool claim of an unassigned task records the resolution", async () => {
    const worker = await createAgent({
      name: "w-pool",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      harnessProvider: "codex",
    });
    const task = await createTaskExtended("pool work", { modelTier: "regular" });
    const trigger = await callPoll(worker.id, header({}));
    expect(trigger?.taskId).toBe(task.id);
    expect(await taskRow(task.id)).toEqual({
      resolvedModel: "gpt-5.6-terra",
      modelSource: "tier-default",
      modelAlias: null,
    });
  });

  test("task without model or tier records nothing", async () => {
    const worker = await createAgent({
      name: "w-none",
      isLead: false,
      status: "idle",
      maxTasks: 1,
    });
    const task = await createTaskExtended("plain", { agentId: worker.id });
    const trigger = await callPoll(worker.id);
    expect(trigger?.task.resolvedModel).toBeUndefined();
    expect(await taskRow(task.id)).toEqual({
      resolvedModel: null,
      modelSource: null,
      modelAlias: null,
    });
  });
});

describe("task list summaries", () => {
  test("carry the claim-time resolution the dashboard table shows", async () => {
    const worker = await createAgent({
      name: "w-summary",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      harnessProvider: "claude",
    });
    process.env.MODEL_TIER_CLAUDE_SMART = "latest:anthropic/opus";
    const task = await createTaskExtended("smart work", { agentId: worker.id, modelTier: "smart" });
    await callPoll(worker.id);

    const row = await getDbClient().get<AgentTaskRow>("SELECT * FROM agent_tasks WHERE id = ?", [
      task.id,
    ]);
    expect(row).not.toBeNull();
    const summary = rowToAgentTaskSummary(row as AgentTaskRow);
    expect(summary.modelTier).toBe("smart");
    expect(summary.resolvedModel).toBe("claude-opus-5-5");
    expect(summary.modelSource).toBe("tier-config");
    expect(summary.modelAlias).toBe("latest:anthropic/opus");
  });
});

describe("latest: guardrails", () => {
  const base = { modelTier: "smart", harnessProvider: "claude" as const, env: {} };

  test("@stable skips models inside the soak window; @any does not", async () => {
    await seedCatalog([
      entry("anthropic", "claude-opus-5-5", daysAgo(30)),
      entry("anthropic", "claude-opus-6", daysAgo(1)),
    ]);
    const stable = await resolveTaskModel({ ...base, model: "latest:anthropic/opus@stable" });
    expect(stable?.resolvedModel).toBe("claude-opus-5-5");
    const any = await resolveTaskModel({ ...base, model: "latest:anthropic/opus@any" });
    expect(any?.resolvedModel).toBe("claude-opus-6");
    process.env.MODEL_LATEST_SOAK_DAYS = "0";
    const noSoak = await resolveTaskModel({ ...base, model: "latest:anthropic/opus" });
    expect(noSoak?.resolvedModel).toBe("claude-opus-6");
  });

  test("unpriced and preview models are skipped", async () => {
    await seedCatalog([
      entry("anthropic", "claude-opus-5-5", daysAgo(30)),
      entry("anthropic", "claude-opus-6", daysAgo(20), false),
      entry("anthropic", "claude-opus-6-preview", daysAgo(20)),
    ]);
    const result = await resolveTaskModel({ ...base, model: "latest:anthropic/opus" });
    expect(result?.resolvedModel).toBe("claude-opus-5-5");
  });

  test("MODEL_AUTO_UPGRADE=false freezes an alias at its last resolution", async () => {
    await seedCatalog([entry("anthropic", "claude-opus-5-5", daysAgo(30))]);
    const first = await resolveTaskModel({ ...base, model: "latest:anthropic/opus" });
    expect(first?.resolvedModel).toBe("claude-opus-5-5");

    await seedCatalog([
      entry("anthropic", "claude-opus-5-5", daysAgo(30)),
      entry("anthropic", "claude-opus-6", daysAgo(10)),
    ]);
    process.env.MODEL_AUTO_UPGRADE = "false";
    const frozen = await resolveTaskModel({ ...base, model: "latest:anthropic/opus" });
    expect(frozen?.resolvedModel).toBe("claude-opus-5-5");

    delete process.env.MODEL_AUTO_UPGRADE;
    const moved = await resolveTaskModel({ ...base, model: "latest:anthropic/opus" });
    expect(moved?.resolvedModel).toBe("claude-opus-6");
    const changes = await getDbClient().query<{ previousModel: string | null; newModel: string }>(
      "SELECT previousModel, newModel FROM model_alias_resolutions ORDER BY id",
    );
    expect(changes).toEqual([
      { previousModel: null, newModel: "claude-opus-5-5" },
      { previousModel: "claude-opus-5-5", newModel: "claude-opus-6" },
    ]);
  });

  test("an alias that resolves to nothing falls through to the next layer", async () => {
    const result = await resolveTaskModel({
      ...base,
      env: { MODEL_TIER_CLAUDE_SMART: "latest:anthropic/nosuchfamily" },
    });
    expect(result).toEqual({
      resolvedModel: "opus",
      modelSource: "tier-default",
      modelAlias: null,
    });
  });
});

describe("previewModelTiers", () => {
  test("lists every provider tier with its default, config value and resolution", async () => {
    const rows = await previewModelTiers({
      env: {
        MODEL_TIER_CLAUDE_SMART: "latest:anthropic/opus",
        MODEL_TIER_CODEX_SMOL: "gpt-5.6-luna",
      },
    });

    const claudeSmart = rows.find((r) => r.provider === "claude" && r.tier === "smart");
    expect(claudeSmart).toEqual({
      provider: "claude",
      tier: "smart",
      key: "MODEL_TIER_CLAUDE_SMART",
      defaultValue: "opus",
      configured: "latest:anthropic/opus",
      source: "tier-config",
      resolvedModel: "claude-opus-5-5",
      alias: "latest:anthropic/opus",
    });

    const claudeSmol = rows.find((r) => r.provider === "claude" && r.tier === "smol");
    expect(claudeSmol).toMatchObject({
      configured: null,
      source: "tier-default",
      resolvedModel: "haiku",
      alias: null,
    });

    const codexSmol = rows.find((r) => r.provider === "codex" && r.tier === "smol");
    expect(codexSmol).toMatchObject({ source: "tier-config", resolvedModel: "gpt-5.6-luna" });

    // acp has no portable tier mapping, so it has nothing to preview.
    expect(rows.some((r) => r.provider === "acp")).toBe(false);
    expect(new Set(rows.map((r) => r.provider)).size).toBe(7);
    expect(rows).toHaveLength(28);
  });

  test("an alias that resolves to nothing reports the default it falls back to", async () => {
    const rows = await previewModelTiers({
      env: { MODEL_TIER_CLAUDE_SMART: "latest:anthropic/nosuchfamily" },
    });
    const row = rows.find((r) => r.provider === "claude" && r.tier === "smart");
    expect(row).toMatchObject({
      configured: "latest:anthropic/nosuchfamily",
      source: "tier-default",
      resolvedModel: "opus",
      alias: null,
    });
  });

  test("previewing does not record alias resolutions", async () => {
    await previewModelTiers({ env: { MODEL_TIER_CLAUDE_SMART: "latest:anthropic/opus" } });
    const count = await getDbClient().get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM model_alias_resolutions",
    );
    expect(count?.n).toBe(0);
  });
});

describe("GET /api/models-catalog/tiers", () => {
  test("serves the preview with the process env layered over the defaults", async () => {
    process.env.MODEL_TIER_CLAUDE_SMART = "latest:anthropic/opus";
    let status = 0;
    let bodyStr = "";
    const req = {
      method: "GET",
      url: "/api/models-catalog/tiers",
      headers: {},
    } as unknown as Parameters<typeof handleModelsCatalog>[0];
    const res = {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(body?: string) {
        bodyStr = body ?? "";
      },
    } as unknown as Parameters<typeof handleModelsCatalog>[1];

    const handled = await handleModelsCatalog(
      req,
      res,
      ["api", "models-catalog", "tiers"],
      new URLSearchParams(),
    );

    expect(handled).toBe(true);
    expect(status).toBe(200);
    const body = JSON.parse(bodyStr) as { tiers: { provider: string; tier: string }[] };
    expect(body.tiers).toHaveLength(28);
    expect(body.tiers.find((t) => t.provider === "claude" && t.tier === "smart")).toMatchObject({
      key: "MODEL_TIER_CLAUDE_SMART",
      source: "tier-config",
      resolvedModel: "claude-opus-5-5",
      alias: "latest:anthropic/opus",
    });
  });
});

describe("config keys and overrides parsing", () => {
  test("tier config keys and validator", () => {
    expect(tierConfigKey("claude-managed", "smart")).toBe("MODEL_TIER_CLAUDE_MANAGED_SMART");
    expect(isTierConfigKey("MODEL_TIER_CLAUDE_SMART")).toBe(true);
    expect(isTierConfigKey("MODEL_TIER_SMART")).toBe(false);
    expect(isTierConfigKey("MODEL_TIER_NOPE_SMART")).toBe(false);
    expect(validateConfigValue("MODEL_TIER_CLAUDE_SMART", "opus")).toBeNull();
    expect(
      validateConfigValue("MODEL_TIER_CODEX_SMART", "latest:openai/gpt-5.*@stable"),
    ).toBeNull();
    expect(validateConfigValue("MODEL_TIER_CLAUDE_SMART", "latest:bogus/x")).not.toBeNull();
    expect(validateConfigValue("MODEL_TIER_CLAUDE_SMART", "  ")).not.toBeNull();
    expect(validateConfigValue("MODEL_LATEST_SOAK_DAYS", "0")).toBeNull();
    expect(validateConfigValue("MODEL_LATEST_SOAK_DAYS", "-1")).not.toBeNull();
    expect(validateConfigValue("MODEL_AUTO_UPGRADE", "false")).toBeNull();
    expect(validateConfigValue("MODEL_AUTO_UPGRADE", "maybe")).not.toBeNull();
  });

  test("worker overrides: direct env beats MODEL_TIER_MAP; header is sanitized", () => {
    expect(
      parseWorkerModelTierOverrides(
        { MODEL_TIER_MAP: '{"smart":"opus","smol":"haiku"}', MODEL_TIER_SMART: "sonnet" },
        "claude",
      ),
    ).toEqual({ claude: { smart: "sonnet", smol: "haiku" } });
    expect(parseWorkerModelTierOverrides({}, "codex")).toEqual({});
    expect(
      parseModelTierOverridesHeader(
        header({ claude: { smart: "sonnet", bogus: "x" }, notaprovider: { smart: "y" } }),
      ),
    ).toEqual({ claude: { smart: "sonnet" } });
    expect(parseModelTierOverridesHeader("%%%")).toBeUndefined();
    expect(parseModelTierOverridesHeader(undefined)).toBeUndefined();
  });
});
