import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createUser,
  getSwarmConfigs,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { runSeeder } from "../be/seed";
import {
  agentFsProvisionSeeder,
  ensureAgentFsCredentialsForAgent,
  resetAgentFsProvisionFetchForTests,
  setAgentFsProvisionFetchForTests,
} from "../be/seed/agent-fs-provision";

const TEST_DB_PATH = `./test-agent-fs-provision-seeder-${process.pid}.sqlite`;
const ORIGINAL_ENV = {
  AGENT_FS_API_URL: process.env.AGENT_FS_API_URL,
  API_AGENT_FS_API_KEY: process.env.API_AGENT_FS_API_KEY,
  AGENT_FS_API_KEY: process.env.AGENT_FS_API_KEY,
  AGENT_FS_DEFAULT_ORG_ID: process.env.AGENT_FS_DEFAULT_ORG_ID,
  AGENT_FS_SHARED_ORG_ID: process.env.AGENT_FS_SHARED_ORG_ID,
  AGENT_FS_DEFAULT_DRIVE_ID: process.env.AGENT_FS_DEFAULT_DRIVE_ID,
  AGENT_FS_REGISTER_EMAIL: process.env.AGENT_FS_REGISTER_EMAIL,
  AGENT_FS_EMAIL_DOMAIN: process.env.AGENT_FS_EMAIL_DOMAIN,
  SWARM_INSTALLATION_ID: process.env.SWARM_INSTALLATION_ID,
  SWARM_ORG_ID: process.env.SWARM_ORG_ID,
};

type RequestRecord = {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
  hasSignal: boolean;
};

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => {});
  }
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function configValue(key: string): string | undefined {
  return getSwarmConfigs({ scope: "global", key })[0]?.value;
}

function createFetchStub(records: RequestRecord[]): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const authorization = new Headers(init?.headers).get("authorization");
    records.push({
      method,
      path: url.pathname,
      body,
      authorization,
      hasSignal: init?.signal instanceof AbortSignal,
    });

    if (url.pathname === "/auth/register" && method === "POST") {
      if (
        body &&
        typeof body === "object" &&
        "email" in body &&
        body.email !== "admin@example.test"
      ) {
        return Response.json({
          apiKey: "afs-agent-key",
          userId: "agent-user",
          orgId: "agent-personal-org",
        });
      }
      return Response.json({
        apiKey: "afs-admin-key",
        userId: "admin-user",
        orgId: "personal-org",
      });
    }
    if (url.pathname === "/auth/me" && method === "GET") {
      return Response.json({
        userId: "admin-user",
        email: "admin@example.test",
        defaultOrgId: "personal-org",
        defaultDriveId: "personal-drive",
      });
    }
    if (url.pathname === "/orgs" && method === "GET") {
      return Response.json({ orgs: [] });
    }
    if (url.pathname === "/orgs" && method === "POST") {
      return Response.json({ id: "shared-org", name: "swarm" }, { status: 201 });
    }
    if (url.pathname === "/orgs/shared-org/drives" && method === "GET") {
      return Response.json({ drives: [] });
    }
    if (url.pathname === "/orgs/shared-org/drives" && method === "POST") {
      return Response.json({ id: "shared-drive", name: "shared" }, { status: 201 });
    }
    if (url.pathname === "/orgs/shared-org/members/invite" && method === "POST") {
      return Response.json({ ok: true });
    }

    return Response.json(
      { error: "unexpected route", path: url.pathname, method },
      { status: 500 },
    );
  }) as typeof fetch;
}

describe("agent-fs provisioning seeder", () => {
  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });

  afterEach(() => {
    resetAgentFsProvisionFetchForTests();
    restoreEnv();
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  test("skips cleanly when AGENT_FS_API_URL is unset", async () => {
    delete process.env.AGENT_FS_API_URL;

    const result = await runSeeder(agentFsProvisionSeeder, { quiet: true });

    expect(result.failed).toEqual([]);
    expect(result.created).toBe(0);
    expect(result.skippedUnchanged).toBe(0);
  });

  test("provisions shared org/drive, stores global config, invites users, then no-ops", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    process.env.AGENT_FS_API_URL = "https://agent-fs.example.test/";
    delete process.env.API_AGENT_FS_API_KEY;
    delete process.env.AGENT_FS_API_KEY;
    delete process.env.AGENT_FS_DEFAULT_ORG_ID;
    delete process.env.AGENT_FS_SHARED_ORG_ID;
    delete process.env.AGENT_FS_DEFAULT_DRIVE_ID;
    process.env.AGENT_FS_REGISTER_EMAIL = "admin@example.test";
    process.env.AGENT_FS_EMAIL_DOMAIN = "agents.example.test";

    createUser({
      name: "Viewer User",
      email: `viewer-${suffix}@example.test`,
      role: "Customer",
    });
    createUser({
      name: "Operator User",
      email: `operator-${suffix}@example.test`,
      role: "Operator",
    });
    const records: RequestRecord[] = [];
    setAgentFsProvisionFetchForTests(createFetchStub(records));

    const result = await runSeeder(agentFsProvisionSeeder, { quiet: true });

    expect(result.failed).toEqual([]);
    expect(result.created).toBe(1);
    expect(configValue("API_AGENT_FS_API_KEY")).toBe("afs-admin-key");
    expect(getSwarmConfigs({ scope: "global", key: "API_AGENT_FS_API_KEY" })[0]?.encrypted).toBe(
      true,
    );
    expect(configValue("AGENT_FS_API_KEY")).toBeUndefined();
    expect(configValue("AGENT_FS_DEFAULT_ORG_ID")).toBe("shared-org");
    expect(configValue("AGENT_FS_SHARED_ORG_ID")).toBe("shared-org");
    expect(configValue("AGENT_FS_DEFAULT_DRIVE_ID")).toBe("shared-drive");
    expect(process.env.API_AGENT_FS_API_KEY).toBe("afs-admin-key");

    const register = records.find((r) => r.path === "/auth/register");
    expect(register?.body).toEqual({ email: "admin@example.test" });

    // Every agent-fs request must carry an abort signal — the seeder runs before
    // the HTTP server binds, so an un-timed request to a hung agent-fs would
    // block boot forever (PR #850 review).
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((r) => r.hasSignal)).toBe(true);

    const invites = records
      .filter((r) => r.path === "/orgs/shared-org/members/invite")
      .map((r) => r.body)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

    expect(invites).toEqual(
      [
        { email: `operator-${suffix}@example.test`, role: "editor" },
        { email: `viewer-${suffix}@example.test`, role: "viewer" },
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );

    records.length = 0;
    const second = await runSeeder(agentFsProvisionSeeder, { quiet: true });

    expect(second.failed).toEqual([]);
    expect(second.skippedUnchanged).toBe(1);
    expect(records).toEqual([]);
  });

  test("provisions agent-scoped credentials through the API-owned bootstrap key", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    process.env.AGENT_FS_API_URL = "https://agent-fs.example.test/";
    process.env.AGENT_FS_EMAIL_DOMAIN = "agents.example.test";
    upsertSwarmConfig({
      scope: "global",
      key: "API_AGENT_FS_API_KEY",
      value: "afs-admin-key",
      isSecret: true,
    });
    upsertSwarmConfig({
      scope: "global",
      key: "AGENT_FS_DEFAULT_ORG_ID",
      value: "shared-org",
    });
    upsertSwarmConfig({
      scope: "global",
      key: "AGENT_FS_SHARED_ORG_ID",
      value: "shared-org",
    });
    upsertSwarmConfig({
      scope: "global",
      key: "AGENT_FS_DEFAULT_DRIVE_ID",
      value: "shared-drive",
    });
    const worker = createAgent({
      name: "Credential Worker",
      description: "Worker with custom agent-fs email",
      role: "worker",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      capabilities: [],
    });
    upsertSwarmConfig({
      scope: "agent",
      scopeId: worker.id,
      key: "AGENT_EMAIL",
      value: `custom-worker-${suffix}@example.test`,
    });

    const records: RequestRecord[] = [];
    setAgentFsProvisionFetchForTests(createFetchStub(records));

    const first = await ensureAgentFsCredentialsForAgent(worker.id);

    expect(first).toMatchObject({
      enabled: true,
      created: true,
      agentId: worker.id,
      email: `custom-worker-${suffix}@example.test`,
      orgId: "shared-org",
      driveId: "shared-drive",
    });
    const agentKey = getSwarmConfigs({
      scope: "agent",
      scopeId: worker.id,
      key: "AGENT_FS_API_KEY",
    })[0];
    expect(agentKey?.value).toBe("afs-agent-key");
    expect(agentKey?.encrypted).toBe(true);
    expect(records.find((r) => r.path === "/auth/register")?.body).toEqual({
      email: `custom-worker-${suffix}@example.test`,
    });
    expect(records.find((r) => r.path === "/orgs/shared-org/members/invite")?.body).toEqual({
      email: `custom-worker-${suffix}@example.test`,
      role: "editor",
    });

    records.length = 0;
    const second = await ensureAgentFsCredentialsForAgent(worker.id);

    expect(second.created).toBe(false);
    expect(records).toEqual([]);
  });
});
