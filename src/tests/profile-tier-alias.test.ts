// `modelTier` as an alias for the seeded `<harness>-<tier>` profile. Where the
// tier chain lands on `tier-default`, claim resolves the seed instead, with the
// same model (decision 1: the seeds are a 1:1 copy of DEFAULT_MODEL_TIER_MAP).
// Worker-env and tier-config overrides keep winning. Tools that receive
// `modelTier` return a deprecation note.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  getDbClient,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { getModelProfileByName, updateModelProfile } from "../be/db/model-profiles";
import {
  recordClaimModelResolution,
  resolveTaskModel,
  setAgentModelTierOverrides,
} from "../be/model-tier-resolution";
import { seedModelProfiles } from "../be/seed-model-profiles";
import { registerCreateScheduleTool } from "../tools/schedules/create-schedule";
import { registerSendTaskTool } from "../tools/send-task";
import {
  DEFAULT_MODEL_TIER_MAP,
  MODEL_TIERS,
  type ModelTier,
  type ProviderName,
  ProviderNameSchema,
} from "../types";

const TEST_DB_PATH = "./test-profile-tier-alias.sqlite";
const LEAD_ID = "22222222-2222-4222-a222-222222222222";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const savedTierEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // A leaked MODEL_TIER_* var would make every case a tier-config win.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MODEL_TIER_")) {
      savedTierEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  await seedModelProfiles();
  await createAgent({ id: LEAD_ID, name: "Alias Lead", isLead: true, status: "idle" });
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  Object.assign(process.env, savedTierEnv);
});

let agentSeq = 0;
async function worker(harnessProvider: ProviderName) {
  agentSeq++;
  return await createAgent({
    name: `alias-${harnessProvider}-${agentSeq}`,
    isLead: false,
    status: "idle",
    maxTasks: 5,
    harnessProvider,
  });
}

async function claimTier(harness: ProviderName, tier: ModelTier, agentId?: string) {
  const id = agentId ?? (await worker(harness)).id;
  const task = await createTaskExtended("tier work", { agentId: id, modelTier: tier });
  const fields = await recordClaimModelResolution(
    { id: task.id, modelTier: tier },
    { id, harnessProvider: harness },
  );
  const row = await getDbClient().get<{
    resolvedModel: string | null;
    modelSource: string | null;
    resolvedProfile: string | null;
  }>("SELECT resolvedModel, modelSource, resolvedProfile FROM agent_tasks WHERE id = ?", [task.id]);
  return { fields, row };
}

const SEEDED: Array<[ProviderName, ModelTier]> = ProviderNameSchema.options.flatMap((harness) =>
  MODEL_TIERS.filter((tier) => DEFAULT_MODEL_TIER_MAP[harness]?.[tier]).map(
    (tier) => [harness, tier] as [ProviderName, ModelTier],
  ),
);

describe("every seeded (harness, tier) resolves to a byte-identical model", () => {
  test("the seeds cover the whole tier map", async () => {
    expect(SEEDED.length).toBeGreaterThan(0);
    for (const [harness, tier] of SEEDED) {
      const profile = await getModelProfileByName(`${harness}-${tier}`);
      expect(profile?.model).toBe(DEFAULT_MODEL_TIER_MAP[harness][tier]);
    }
  });

  for (const [harness, tier] of SEEDED) {
    test(`${harness}-${tier}`, async () => {
      // The alias step disabled: the tier chain alone.
      const baseline = await resolveTaskModel({
        modelTier: tier,
        harnessProvider: harness,
        record: false,
      });
      const today = baseline && !("harnessMismatch" in baseline) ? baseline : null;
      const { fields, row } = await claimTier(harness, tier);

      expect(fields.resolvedModel).toBe(today?.resolvedModel);
      expect(fields.modelAlias).toBe(today?.modelAlias ?? undefined);
      expect(row?.resolvedModel ?? undefined).toBe(today?.resolvedModel);
      if (today) {
        expect(today.modelSource).toBe("tier-default");
        expect(fields.modelSource).toBe("profile:tier-alias");
        expect(fields.resolvedProfile).toBe(`${harness}-${tier}`);
        expect(row).toMatchObject({
          modelSource: "profile:tier-alias",
          resolvedProfile: `${harness}-${tier}`,
        });
      }
    });
  }
});

describe("overrides and edits", () => {
  let logSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    logSpy = spyOn(console, "log");
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  const deprecationLine = (source: string) =>
    `[model-tier] deprecated: ${source} override for claude-smart; edit profile claude-smart instead`;

  test("a worker-env MODEL_TIER_* override still wins, with a deprecation line", async () => {
    const w = await worker("claude");
    await setAgentModelTierOverrides(w.id, { claude: { smart: "sonnet" } });
    const { fields, row } = await claimTier("claude", "smart", w.id);
    expect(fields).toMatchObject({ resolvedModel: "sonnet", modelSource: "worker-env" });
    expect(fields.resolvedProfile).toBeUndefined();
    expect(row?.resolvedProfile).toBeNull();
    expect(logSpy).toHaveBeenCalledWith(deprecationLine("worker-env"));
  });

  test("a tier-config override still wins, with a deprecation line", async () => {
    process.env.MODEL_TIER_CLAUDE_SMART = "haiku";
    try {
      const { fields } = await claimTier("claude", "smart");
      expect(fields).toMatchObject({ resolvedModel: "haiku", modelSource: "tier-config" });
      expect(fields.resolvedProfile).toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith(deprecationLine("tier-config"));
    } finally {
      delete process.env.MODEL_TIER_CLAUDE_SMART;
    }
  });

  test("an edited seed model wins over the map, and its allowlist rides on the trigger", async () => {
    await updateModelProfile("claude-smart", {
      model: "sonnet",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["abcde"] },
    });
    try {
      const { fields } = await claimTier("claude", "smart");
      expect(fields).toMatchObject({
        resolvedModel: "sonnet",
        modelSource: "profile:tier-alias",
        resolvedProfile: "claude-smart",
        credentialAllowlist: { CLAUDE_CODE_OAUTH_TOKEN: ["abcde"] },
      });
    } finally {
      await updateModelProfile("claude-smart", {
        model: DEFAULT_MODEL_TIER_MAP.claude.smart,
        credentials: null,
      });
    }
  });

  test("a seed with effort hands it over only when the task set none", async () => {
    await updateModelProfile("claude-regular", { effort: "high" });
    try {
      const { fields } = await claimTier("claude", "regular");
      expect(fields.effort).toBe("high");
      const w = await worker("claude");
      const task = await createTaskExtended("tier work", {
        agentId: w.id,
        modelTier: "regular",
        effort: "low",
      });
      const own = await recordClaimModelResolution(
        { id: task.id, modelTier: "regular", effort: "low" },
        { id: w.id, harnessProvider: "claude" },
      );
      expect(own.effort).toBeUndefined();
    } finally {
      await updateModelProfile("claude-regular", { effort: null });
    }
  });

  // The seeder copies a global MODEL_TIER_* row into the seed. The tier chain
  // skips a value from another harness; the alias must not bring it back.
  test("a seed configured with another harness's model keeps the tier result", async () => {
    const key = "MODEL_TIER_CLAUDE_SMART";
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    await getDbClient().run("DELETE FROM model_profiles WHERE name = 'claude-smart'");
    await upsertSwarmConfig({ scope: "global", key, value: "gpt-5.6-sol" });
    process.env[key] = "gpt-5.6-sol";
    try {
      await seedModelProfiles();
      expect((await getModelProfileByName("claude-smart"))?.model).toBe("gpt-5.6-sol");
      const baseline = await resolveTaskModel({
        modelTier: "smart",
        harnessProvider: "claude",
        record: false,
      });
      const today = baseline && !("harnessMismatch" in baseline) ? baseline : null;
      expect(today?.resolvedModel).toBe(DEFAULT_MODEL_TIER_MAP.claude.smart);

      const { fields, row } = await claimTier("claude", "smart");
      expect(fields.resolvedModel).toBe(today?.resolvedModel);
      expect(fields.modelSource).toBe(today?.modelSource);
      expect(fields.resolvedProfile).toBeUndefined();
      expect(row?.resolvedModel).toBe(today?.resolvedModel ?? null);
      expect(row?.resolvedProfile).toBeNull();
    } finally {
      delete process.env[key];
      warnSpy.mockRestore();
      await getDbClient().run("DELETE FROM swarm_config WHERE scope = 'global' AND key = ?", [key]);
      await getDbClient().run("DELETE FROM model_profiles WHERE name = 'claude-smart'");
      await seedModelProfiles();
    }
  });

  test("a missing seed keeps the tier-default result", async () => {
    await getDbClient().run("DELETE FROM model_profiles WHERE name = 'claude-smol'");
    try {
      const { fields, row } = await claimTier("claude", "smol");
      expect(fields).toMatchObject({
        resolvedModel: DEFAULT_MODEL_TIER_MAP.claude.smol,
        modelSource: "tier-default",
      });
      expect(row?.resolvedProfile).toBeNull();
    } finally {
      await seedModelProfiles();
    }
  });

  test("an acp tier task (no seed) resolves as today", async () => {
    expect(await getModelProfileByName("acp-smart")).toBeNull();
    const { fields, row } = await claimTier("acp", "smart");
    expect(fields).toEqual({});
    expect(row).toEqual({ resolvedModel: null, modelSource: null, resolvedProfile: null });
  });

  test("a task with no tier is untouched", async () => {
    const w = await worker("claude");
    const task = await createTaskExtended("plain work", { agentId: w.id });
    const fields = await recordClaimModelResolution(
      { id: task.id },
      { id: w.id, harnessProvider: "claude" },
    );
    expect(fields).toEqual({});
  });
});

describe("deprecation note on tools that receive modelTier", () => {
  type RegisteredTool = {
    handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
  };
  const server = new McpServer({ name: "alias-test", version: "1.0.0" });
  registerSendTaskTool(server);
  registerCreateScheduleTool(server);

  function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;
    const tool = tools[name];
    if (!tool) throw new Error(`${name} not registered`);
    return tool.handler(args, {
      sessionId: "alias-session",
      requestInfo: { headers: { "x-agent-id": LEAD_ID } },
    });
  }

  type Structured = {
    success: boolean;
    nudge?: string;
    modelTierDeprecated?: { tier: string; suggestedProfile: string | null };
  };

  test("send-task to a claude worker suggests claude-smart", async () => {
    const w = await worker("claude");
    const result = await callTool("send-task", {
      task: "tier task for a known agent",
      agentId: w.id,
      routingReason: "human_pinned",
      routingNote: "This test explicitly selects the target worker",
      modelTier: "smart",
      allowDuplicate: true,
    });
    const s = result.structuredContent as Structured;
    expect(s.success).toBe(true);
    expect(s.modelTierDeprecated).toEqual({ tier: "smart", suggestedProfile: "claude-smart" });
    expect(s.nudge).toBe('modelTier is deprecated: pass profile "claude-smart" (same model).');
  });

  test("send-task to the pool has no harness to suggest", async () => {
    const result = await callTool("send-task", {
      task: "tier task for the pool",
      modelTier: "regular",
      allowDuplicate: true,
    });
    const s = result.structuredContent as Structured;
    expect(s.success).toBe(true);
    expect(s.modelTierDeprecated).toEqual({ tier: "regular", suggestedProfile: null });
    expect(s.nudge).toBe('modelTier is deprecated: pass profile "<harness>-regular" (same model).');
  });

  test("send-task without modelTier carries no note", async () => {
    const result = await callTool("send-task", { task: "no tier", allowDuplicate: true });
    const s = result.structuredContent as Structured;
    expect(s.success).toBe(true);
    expect(s.modelTierDeprecated).toBeUndefined();
    expect(s.nudge).toBeUndefined();
  });

  test("create-schedule with modelTier returns the note", async () => {
    const w = await worker("codex");
    const result = await callTool("create-schedule", {
      name: "alias-schedule",
      taskTemplate: "scheduled tier work",
      intervalMs: 3_600_000,
      targetAgentId: w.id,
      modelTier: "smol",
    });
    const s = result.structuredContent as Structured;
    expect(s.success).toBe(true);
    expect(s.modelTierDeprecated).toEqual({ tier: "smol", suggestedProfile: "codex-smol" });
    expect(s.nudge).toBe('modelTier is deprecated: pass profile "codex-smol" (same model).');
  });
});
