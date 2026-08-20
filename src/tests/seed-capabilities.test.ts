import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, deleteSwarmConfig, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";
import { seedLegacyCapabilitiesConfig } from "../be/seed-capabilities";

const TEST_DB_PATH = "./test-seed-capabilities.sqlite";
const originalCapabilities = process.env.CAPABILITIES;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // missing is fine
    }
  }
}

async function clearCapabilitiesRows(): Promise<void> {
  for (const row of await getSwarmConfigs({ scope: "global", key: "CAPABILITIES" })) {
    await deleteSwarmConfig(row.id);
  }
}

describe("seedLegacyCapabilitiesConfig", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles();
  });

  afterEach(async () => {
    await clearCapabilitiesRows();
    if (originalCapabilities === undefined) delete process.env.CAPABILITIES;
    else process.env.CAPABILITIES = originalCapabilities;
  });

  test("no env value → no seed (defaults in play)", async () => {
    delete process.env.CAPABILITIES;
    const result = await seedLegacyCapabilitiesConfig();
    expect(result.seeded).toBe(false);
    expect(await getSwarmConfigs({ scope: "global", key: "CAPABILITIES" })).toHaveLength(0);
  });

  test("legacy explicit list → seeds a global row backfilled with always-on groups", async () => {
    process.env.CAPABILITIES = "core,task-pool,messaging,profiles,services,scheduling,memory";
    const result = await seedLegacyCapabilitiesConfig();
    expect(result.seeded).toBe(true);
    expect(result.added).toEqual([
      "config",
      "scripts",
      "mcp",
      "slack",
      "tracker",
      "skills",
      "repo",
    ]);

    const rows = await getSwarmConfigs({ scope: "global", key: "CAPABILITIES" });
    expect(rows).toHaveLength(1);
    // Operator's original entries preserved (including previously-gated opt-ins
    // like messaging/services and free-form tags), backfill appended.
    const value = rows[0]!.value.split(",");
    for (const cap of ["core", "messaging", "services", "config", "scripts", "slack", "repo"]) {
      expect(value).toContain(cap);
    }
    // env updated in place so the running process sees the resolved set.
    expect(process.env.CAPABILITIES).toBe(rows[0]!.value);
  });

  test("existing global row → never touched", async () => {
    process.env.CAPABILITIES = "core,task-pool";
    await upsertSwarmConfig({ scope: "global", key: "CAPABILITIES", value: "core" });
    const result = await seedLegacyCapabilitiesConfig();
    expect(result.seeded).toBe(false);
    const rows = await getSwarmConfigs({ scope: "global", key: "CAPABILITIES" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe("core");
    expect(process.env.CAPABILITIES).toBe("core,task-pool");
  });

  test("explicit list already containing all always-on groups → no seed", async () => {
    process.env.CAPABILITIES = "core,config,scripts,mcp,slack,tracker,skills,repo,kv";
    const result = await seedLegacyCapabilitiesConfig();
    expect(result.seeded).toBe(false);
    expect(await getSwarmConfigs({ scope: "global", key: "CAPABILITIES" })).toHaveLength(0);
  });
});
