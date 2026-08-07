import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, initDb, upsertSwarmConfig } from "../be/db";
import { getConfigHandler } from "../tools/swarm-config/get-config";

const TEST_DB_PATH = "/tmp/get-config-tool-overlay.sqlite";
const ENV_KEYS = ["DREAMING_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};

let agentId: string;

beforeAll(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
  initDb(TEST_DB_PATH);
  agentId = createAgent({ name: "Overlay Reader", isLead: true, status: "idle" }).id;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

function configsOf(result: { data?: unknown }) {
  return ((result.data as { configs?: Array<{ key: string; value: string; scope: string }> })
    .configs ?? []) as Array<{ key: string; value: string; scope: string }>;
}

describe("get-config env overlay", () => {
  test("the unfiltered read surfaces an env-only operator value, like the keyed read", async () => {
    // An env-only kill switch never gets a swarm_config row. Auditing effective
    // config without a `key` must still show it, or the audit reports no
    // override at all — the keyed path already did, the list path did not.
    process.env.DREAMING_ENABLED = "false";

    const keyed = await getConfigHandler({ key: "DREAMING_ENABLED" }, { agentId });
    expect(configsOf(keyed).find((c) => c.key === "DREAMING_ENABLED")?.value).toBe("false");

    const all = await getConfigHandler({}, { agentId });
    const overlaid = configsOf(all).find((c) => c.key === "DREAMING_ENABLED");
    expect(overlaid?.value).toBe("false");
    expect(overlaid?.scope).toBe("global");
  });

  test("a stored row that lost to env at boot reads as the value the server obeys", async () => {
    upsertSwarmConfig({ scope: "global", key: "DREAMING_ENABLED", value: "true" });
    process.env.DREAMING_ENABLED = "false";

    const all = await getConfigHandler({}, { agentId });
    const rows = configsOf(all).filter((c) => c.key === "DREAMING_ENABLED");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("false");
  });

  test("non-catalog env vars are never invented as config rows", async () => {
    const all = await getConfigHandler({}, { agentId });
    expect(configsOf(all).find((c) => c.key === "PATH")).toBeUndefined();
    expect(configsOf(all).find((c) => c.key === "API_KEY")).toBeUndefined();
  });
});
