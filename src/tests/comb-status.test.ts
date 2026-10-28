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
  "AGENT_FS_PROXY",
  "PUBLIC_MCP_BASE_URL",
  "MCP_BASE_URL",
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
  test("unset and AGENT_FS_API_URL is a docker-internal host: off, and says what is missing", async () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    const result = await comb();
    expect(result.enabled).toBe(false);
    expect(result.api_url).toBe("http://agent-fs:7433");
    expect(result.reason).toContain("AGENT_FS_PUBLIC_URL or AGENT_FS_PROXY=true");
  });

  test("unset and AGENT_FS_PROXY on: on, through the API", async () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.com";
    process.env.AGENT_FS_PROXY = "true";
    const result = await comb();
    expect(result.enabled).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.api_url).toBe("https://swarm.example.com/agentfs");
  });

  test("unset, AGENT_FS_PROXY on and an internal API address: off, and names PUBLIC_MCP_BASE_URL", async () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.MCP_BASE_URL = "http://api:3013";
    process.env.AGENT_FS_PROXY = "true";
    const result = await comb();
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("PUBLIC_MCP_BASE_URL");
  });

  test("unset and an IPv4-mapped private IPv6 AGENT_FS_API_URL: off", async () => {
    process.env.AGENT_FS_API_URL = "http://[::ffff:10.0.0.5]:7433";
    const result = await comb();
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("not reachable from a browser");
  });

  test("unset and AGENT_FS_PUBLIC_URL set: on", async () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.AGENT_FS_PUBLIC_URL = "https://fs.example.com";
    const result = await comb();
    expect(result.enabled).toBe(true);
    expect(result.api_url).toBe("https://fs.example.com");
  });

  test("unset and a browser-reachable AGENT_FS_API_URL: on", async () => {
    process.env.AGENT_FS_API_URL = "https://fs.example.com";
    expect((await comb()).enabled).toBe(true);
  });

  test("COMB_ENABLED=false wins over a reachable URL", async () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.AGENT_FS_PUBLIC_URL = "https://fs.example.com";
    process.env.COMB_ENABLED = "false";
    const result = await comb();
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("COMB_ENABLED is false.");
  });

  test("unset and no AGENT_FS_API_URL: off, and says so", async () => {
    process.env.AGENT_FS_PUBLIC_URL = "https://fs.example.com";
    const result = await comb();
    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("AGENT_FS_API_URL is not set.");
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
    for (const value of ["false", "0", " FALSE "]) {
      process.env.COMB_ENABLED = value;
      expect((await comb()).enabled).toBe(false);
    }
    // Unrecognized or blank means unset: the docker-internal URL keeps it off.
    for (const value of ["yes", ""]) {
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

  test("AGENT_FS_PROXY on and a blank public URL: api_url is <PUBLIC_MCP_BASE_URL>/agentfs", async () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.MCP_BASE_URL = "http://swarm-api:3013";
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.com/";
    for (const value of ["true", " TRUE ", "1"]) {
      process.env.AGENT_FS_PROXY = value;
      expect((await comb()).api_url).toBe("https://swarm.example.com/agentfs");
    }
    process.env.AGENT_FS_PUBLIC_URL = "  ";
    expect((await comb()).api_url).toBe("https://swarm.example.com/agentfs");
    // No public URL: falls back to MCP_BASE_URL.
    delete process.env.PUBLIC_MCP_BASE_URL;
    expect((await comb()).api_url).toBe("http://swarm-api:3013/agentfs");
  });

  test("AGENT_FS_PROXY on: an explicit AGENT_FS_PUBLIC_URL still wins", async () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.com";
    process.env.AGENT_FS_PROXY = "true";
    process.env.AGENT_FS_PUBLIC_URL = "https://files.example.com/";
    expect((await comb()).api_url).toBe("https://files.example.com");
  });

  test("AGENT_FS_PROXY off or without AGENT_FS_API_URL: api_url unchanged", async () => {
    process.env.COMB_ENABLED = "true";
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.com";
    for (const value of [undefined, "false", "0", ""]) {
      if (value === undefined) delete process.env.AGENT_FS_PROXY;
      else process.env.AGENT_FS_PROXY = value;
      expect((await comb()).api_url).toBe("http://agent-fs:7433");
    }
    process.env.AGENT_FS_PROXY = "true";
    delete process.env.AGENT_FS_API_URL;
    const result = await comb();
    expect(result.enabled).toBe(false);
    expect(result.api_url).toBeNull();
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
      reason: null,
      api_url: "http://agent-fs:7433",
      live_url: "https://live.example.com",
      org_id: "org-1",
      drive_id: "drive-1",
      service_user_id: null,
    });
  });

  test("service_user_id is the bootstrap key's agent-fs user, asked once", async () => {
    let meCalls = 0;
    const agentFs = Bun.serve({
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname !== "/auth/me") return new Response("", { status: 404 });
        meCalls++;
        return request.headers.get("authorization") === "Bearer af_boot"
          ? Response.json({ userId: "svc-user", email: "swarm-admin@agent-fs.local" })
          : Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
      },
    });
    try {
      process.env.AGENT_FS_API_URL = `http://localhost:${agentFs.port}`;
      process.env.API_AGENT_FS_API_KEY = "af_boot";
      process.env.AGENT_FS_DEFAULT_ORG_ID = "org-1";
      process.env.AGENT_FS_DEFAULT_DRIVE_ID = "drive-1";

      // Comb off: no lookup.
      process.env.COMB_ENABLED = "false";
      expect((await comb()).service_user_id).toBeNull();
      expect(meCalls).toBe(0);

      process.env.COMB_ENABLED = "true";
      expect((await comb()).service_user_id).toBe("svc-user");
      expect((await comb()).service_user_id).toBe("svc-user");
      expect(meCalls).toBe(1);

      // A rejected key reports null instead of failing /status.
      process.env.API_AGENT_FS_API_KEY = "af_other";
      resetFileStorageProvider();
      expect((await comb()).service_user_id).toBeNull();
    } finally {
      agentFs.stop(true);
    }
  });
});
