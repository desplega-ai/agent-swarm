import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getDbClient, initDb, upsertKv } from "../be/db";
import { startMcpOverflowSweep, stopMcpOverflowSweep } from "../be/mcp-overflow-sweep";

const TEST_DB_PATH = "./test-mcp-overflow-sweep.sqlite";

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => undefined);
}

// Reads the raw row: getKv deletes an expired row itself, which would hide
// whether the sweep ran.
async function stored(namespace: string, key: string): Promise<boolean> {
  const row = await getDbClient().get<{ key: string }>(
    "SELECT key FROM kv_entries WHERE namespace = ? AND key = ?",
    [namespace, key],
  );
  return row !== null;
}

async function spill(namespace: string, key: string, expiresAt: number): Promise<void> {
  await upsertKv({ namespace, key, value: "x", valueType: "string", expiresAt });
}

describe("MCP overflow sweep lifecycle", () => {
  beforeAll(async () => {
    await removeDbFiles();
    initDb(TEST_DB_PATH);
  });

  afterEach(() => stopMcpOverflowSweep());

  afterAll(async () => {
    stopMcpOverflowSweep();
    closeDb();
    await removeDbFiles();
  });

  test("start twice creates one interval, stop clears it, start after stop works", () => {
    const set = spyOn(globalThis, "setInterval");
    const clear = spyOn(globalThis, "clearInterval");
    try {
      startMcpOverflowSweep(60_000);
      startMcpOverflowSweep(60_000);
      expect(set).toHaveBeenCalledTimes(1);
      const first = set.mock.results[0]?.value;

      stopMcpOverflowSweep();
      expect(clear).toHaveBeenCalledTimes(1);
      expect(clear).toHaveBeenCalledWith(first);
      stopMcpOverflowSweep();
      expect(clear).toHaveBeenCalledTimes(1);

      startMcpOverflowSweep(60_000);
      expect(set).toHaveBeenCalledTimes(2);
    } finally {
      stopMcpOverflowSweep();
      set.mockRestore();
      clear.mockRestore();
    }
  });

  test("a running sweep deletes expired spills on its tick and stops after stop", async () => {
    const now = Date.now();
    await spill("mcp:overflow:agent-a", "expired", now - 1);
    await spill("mcp:overflow:agent-b", "live", now + 60_000);

    expect(await stored("mcp:overflow:agent-a", "expired")).toBe(true);

    startMcpOverflowSweep(5);
    for (let i = 0; i < 100 && (await stored("mcp:overflow:agent-a", "expired")); i++) {
      await Bun.sleep(5);
    }
    expect(await stored("mcp:overflow:agent-a", "expired")).toBe(false);
    expect(await stored("mcp:overflow:agent-b", "live")).toBe(true);

    stopMcpOverflowSweep();
    await spill("mcp:overflow:agent-a", "after-stop", Date.now() - 1);
    await Bun.sleep(30);
    expect(await stored("mcp:overflow:agent-a", "after-stop")).toBe(true);
  });
});
