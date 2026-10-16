// The shipped `<harness>-<tier>` seeds, and migration 220's profiles made from
// agents' MODEL_OVERRIDE + REASONING_EFFORT_OVERRIDE.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  closeDb,
  createAgent,
  getDb,
  getDbClient,
  getSwarmConfigs,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { getModelProfileByName, listModelProfiles } from "../be/db/model-profiles";
import { recordClaimModelResolution } from "../be/model-tier-resolution";
import { seedModelProfiles } from "../be/seed-model-profiles";
import { DEFAULT_MODEL_TIER_MAP, type MODEL_TIERS, type ProviderName } from "../types";

const TEST_DB_PATH = "./test-seed-model-profiles.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/** The part of migration 220 that turns agent overrides into profiles. */
function agentOverrideMigrationSql(): string {
  const sql = readFileSync(
    join(import.meta.dir, "../be/migrations/220_model_profiles.sql"),
    "utf8",
  );
  return sql.slice(sql.indexOf("CREATE TEMP TABLE _model_profile_overrides"));
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
  await client.run("DELETE FROM swarm_config");
  await client.run("DELETE FROM swarm_repos");
  await client.run("DELETE FROM agents");
  await client.run("DELETE FROM model_profiles");
});

describe("tier seeds", () => {
  test("one profile per harness and tier, copied from the tier map; none for acp", async () => {
    expect(await seedModelProfiles()).toBe(40);
    const profiles = await listModelProfiles();
    expect(profiles).toHaveLength(40);
    expect(profiles.some((p) => p.harness === "acp")).toBe(false);
    for (const profile of profiles) {
      const tier = profile.seededFrom?.replace("tier:", "") as (typeof MODEL_TIERS)[number];
      expect(profile.name).toBe(`${profile.harness}-${tier}`);
      expect(profile.model).toBe(DEFAULT_MODEL_TIER_MAP[profile.harness as ProviderName][tier]);
      expect(profile.effort).toBeNull();
    }
    expect((await getModelProfileByName("claude-smart"))?.model).toBe("opus");
    expect((await getModelProfileByName("codex-ultra"))?.model).toBe("gpt-5.6-sol");
  });

  test("a global MODEL_TIER row overrides the seed's model; reseeding never overwrites", async () => {
    await upsertSwarmConfig({
      scope: "global",
      key: "MODEL_TIER_CLAUDE_SMART",
      value: "claude-opus-5-5",
    });
    await seedModelProfiles();
    expect((await getModelProfileByName("claude-smart"))?.model).toBe("claude-opus-5-5");

    await getDbClient().run(
      "UPDATE model_profiles SET model = 'edited' WHERE name = 'claude-regular'",
    );
    expect(await seedModelProfiles()).toBe(0);
    expect((await getModelProfileByName("claude-regular"))?.model).toBe("edited");
  });
});

describe("migration 220: profiles from agent overrides", () => {
  async function agentWith(
    name: string,
    harnessProvider: ProviderName,
    model?: string,
    effort?: string,
  ): Promise<string> {
    const agent = await createAgent({ name, isLead: false, status: "idle", harnessProvider });
    if (model) {
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: agent.id,
        key: "MODEL_OVERRIDE",
        value: model,
      });
    }
    if (effort) {
      await upsertSwarmConfig({
        scope: "agent",
        scopeId: agent.id,
        key: "REASONING_EFFORT_OVERRIDE",
        value: effort,
      });
    }
    return agent.id;
  }

  test("dedupes by (harness, model, effort) and makes each the agent's default", async () => {
    const a = await agentWith("m-a", "claude", "claude-opus-5-5", "high");
    const b = await agentWith("m-b", "claude", "claude-opus-5-5", "high");
    const c = await agentWith("m-c", "codex", "gpt-6.1-sol", "xhigh");
    const d = await agentWith("m-d", "claude", "openrouter/vendor/model:free");
    const skipped = [
      await agentWith("m-acp", "acp", "some-acp-model"),
      await agentWith("m-alias", "claude", "latest:anthropic/opus"),
      await agentWith("m-none", "claude"),
    ];

    getDb().exec(agentOverrideMigrationSql());

    const profiles = await listModelProfiles();
    expect(profiles.map((p) => [p.name, p.harness, p.model, p.effort])).toEqual([
      ["claude-openrouter-vendor-model-free", "claude", "openrouter/vendor/model:free", null],
      ["claude-opus-5-5-high", "claude", "claude-opus-5-5", "high"],
      ["codex-gpt-6.1-sol-xhigh", "codex", "gpt-6.1-sol", "xhigh"],
    ]);
    expect(profiles.every((p) => p.seededFrom === "agent-config" && p.allowCustomModel)).toBe(true);

    const defaults = await getSwarmConfigs({ scope: "agent", key: "MODEL_PROFILE" });
    expect(Object.fromEntries(defaults.map((row) => [row.scopeId, row.value]))).toEqual({
      [a]: "claude-opus-5-5-high",
      [b]: "claude-opus-5-5-high",
      [c]: "codex-gpt-6.1-sol-xhigh",
      [d]: "claude-openrouter-vendor-model-free",
    });
    expect(defaults.every((row) => row.exportToEnv === false)).toBe(true);
    expect(defaults.some((row) => skipped.includes(row.scopeId ?? ""))).toBe(false);
  });

  test("an overridden agent's untiered task resolves to the same model and effort as before", async () => {
    const id = await agentWith("m-same", "codex", "gpt-6.1-sol", "xhigh");
    getDb().exec(agentOverrideMigrationSql());
    const task = await getDbClient().get<{ id: string }>(
      `INSERT INTO agent_tasks (id, agentId, task, status, source, createdAt, lastUpdatedAt)
       VALUES ('t-same', ?, 'work', 'pending', 'mcp', '2026-01-01', '2026-01-01') RETURNING id`,
      [id],
    );
    const fields = await recordClaimModelResolution(
      { id: task?.id ?? "" },
      { id, harnessProvider: "codex" },
    );
    expect(fields).toMatchObject({
      resolvedModel: "gpt-6.1-sol",
      modelSource: "profile:agent-default",
      resolvedProfile: "codex-gpt-6.1-sol-xhigh",
      effort: "xhigh",
    });
  });
});
