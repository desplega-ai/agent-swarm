import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { resetFileStorageProvider } from "../fs/registry";
import { buildStatusPayload } from "../http/status";

const TEST_DB_PATH = "./test-comb-status.sqlite";

const ENV_KEYS = [
  "COMB_ENABLED",
  "AGENT_FS_API_URL",
  "AGENT_FS_PUBLIC_URL",
  "AGENT_FS_LIVE_URL",
  "AGENT_FS_DEFAULT_ORG_ID",
  "AGENT_FS_DEFAULT_DRIVE_ID",
  "API_AGENT_FS_API_KEY",
  "AGENT_FS_API_KEY",
];
const savedEnv = new Map<string, string | undefined>();

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(TEST_DB_PATH + suffix).catch(() => {});
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function comb() {
  return (await buildStatusPayload()).agent_fs.comb;
}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles();
  restoreEnv();
});

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetFileStorageProvider();
});

afterEach(() => {
  restoreEnv();
  resetFileStorageProvider();
});

describe("/status agent_fs.comb", () => {
  test("is off by default", async () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    const result = await comb();
    expect(result.enabled).toBe(false);
    expect(result.api_url).toBe("http://agent-fs:7433");
  });

  test("stays off with the flag on but no AGENT_FS_API_URL", async () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_PUBLIC_URL = "http://localhost:7433";
    expect((await comb()).enabled).toBe(false);
  });

  test("turns on with the flag and AGENT_FS_API_URL", async () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    for (const value of ["true", " TRUE ", "1"]) {
      process.env.COMB_ENABLED = value;
      expect((await comb()).enabled).toBe(true);
    }
    for (const value of ["false", "0", "yes", ""]) {
      process.env.COMB_ENABLED = value;
      expect((await comb()).enabled).toBe(false);
    }
  });

  test("AGENT_FS_PUBLIC_URL wins over AGENT_FS_API_URL, without a trailing slash", async () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433/";
    expect((await comb()).api_url).toBe("http://agent-fs:7433");
    process.env.AGENT_FS_PUBLIC_URL = "https://files.example.com/";
    expect((await comb()).api_url).toBe("https://files.example.com");
  });

  test("ids come from AGENT_FS_DEFAULT_*, and live_url from AGENT_FS_LIVE_URL", async () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    let result = await comb();
    expect(result.org_id).toBeNull();
    expect(result.drive_id).toBeNull();
    expect(result.live_url).toBe("https://live.agent-fs.dev");

    process.env.AGENT_FS_DEFAULT_ORG_ID = "org-1";
    process.env.AGENT_FS_DEFAULT_DRIVE_ID = "drive-1";
    process.env.AGENT_FS_LIVE_URL = "https://live.example.com/";
    result = await comb();
    expect(result).toEqual({
      enabled: true,
      api_url: "http://agent-fs:7433",
      live_url: "https://live.example.com",
      org_id: "org-1",
      drive_id: "drive-1",
    });
  });
});
