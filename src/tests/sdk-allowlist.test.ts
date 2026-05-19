import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { mcpToolNameForSdkMethod, SDK_ALLOWLIST } from "../scripts-runtime/sdk-allowlist";
import type { SwarmConfig } from "../scripts-runtime/swarm-config";
import { createSwarmSdk } from "../scripts-runtime/swarm-sdk";
import { createServer } from "../server";

const TEST_DB_PATH = "./test-sdk-allowlist.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

describe("script SDK allowlist", () => {
  let registeredTools: Record<string, unknown>;

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
    const server = createServer();
    registeredTools = (server as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("every SDK allowlist entry resolves to a live MCP tool", () => {
    const missing = SDK_ALLOWLIST.map((name) => mcpToolNameForSdkMethod(name)).filter(
      (name) => !(name in registeredTools),
    );
    expect(missing).toEqual([]);
  });

  test("runtime proxy rejects non-allowlisted tools before fetch", async () => {
    const sdk = createSwarmSdk({} as SwarmConfig);
    await expect(sdk.join_swarm({})).rejects.toThrow(
      "Tool 'join_swarm' is not exposed to scripts (lifecycle/cred tool)",
    );
  });

  test("bundled swarm-sdk.d.ts exposes only allowlisted methods", async () => {
    const types = await Bun.file("src/scripts-runtime/types/swarm-sdk.d.ts").text();
    for (const name of SDK_ALLOWLIST) {
      expect(types).toContain(`${name}(args`);
    }
    expect(types).not.toContain("join_swarm(");
    expect(types).not.toContain("start_worker(");
  });
});
