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
  inviteEmailToSharedOrg,
  resetAgentFsProvisionFetchForTests,
  setAgentFsProvisionFetchForTests,
} from "../be/seed/agent-fs-provision";
import { getFileStorageProvider, resetFileStorageProviderForTests } from "../fs/registry";

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

type StubMember = {
  email?: string;
  role?: string;
  user?: { email?: string };
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

function createFetchStub(
  records: RequestRecord[],
  options: { members?: StubMember[] } = {},
): typeof fetch {
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
    if (url.pathname === "/orgs/shared-org/members" && method === "GET") {
      return Response.json({ members: options.members ?? [] });
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
    // ensureAgentFsSharedProvisioning now resets the fs-provider memo as a
    // side effect; re-select under the restored env so no provider state
    // leaks into later test files.
    resetFileStorageProviderForTests();
    getFileStorageProvider();
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
      name: "Designer User",
      email: `designer-${suffix}@example.test`,
      role: "Customer",
    });
    createUser({
      name: "Operator User",
      email: `operator-${suffix}@example.test`,
      role: "Operator",
    });
    createUser({
      name: "Explicit Viewer User",
      email: `viewer-${suffix}@example.test`,
      role: "read-only contractor",
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
        { email: `designer-${suffix}@example.test`, role: "editor" },
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

  test("classifies arbitrary non-viewer human roles as agent-fs editors", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    process.env.AGENT_FS_API_URL = "https://agent-fs.example.test/";
    process.env.AGENT_FS_REGISTER_EMAIL = "admin@example.test";
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
      key: "AGENT_FS_DEFAULT_DRIVE_ID",
      value: "shared-drive",
    });

    createUser({
      name: "Taras Founder",
      email: `taras-founder-${suffix}@example.test`,
      role: "co-founder, CTO",
    });
    createUser({
      name: "Eze Founder",
      email: `eze-founder-${suffix}@example.test`,
      role: "co-founder, CEO",
    });
    createUser({
      name: "Designer Human",
      email: `designer-${suffix}@example.test`,
      role: "designer",
    });
    createUser({
      name: "Unknown Human",
      email: `whatever-${suffix}@example.test`,
      role: "whatever",
    });

    const records: RequestRecord[] = [];
    setAgentFsProvisionFetchForTests(createFetchStub(records));

    const result = await runSeeder(agentFsProvisionSeeder, { quiet: true });

    expect(result.failed).toEqual([]);
    const invites = records
      .filter((r) => r.path === "/orgs/shared-org/members/invite")
      .map((r) => r.body);
    expect(invites).toContainEqual({
      email: `taras-founder-${suffix}@example.test`,
      role: "editor",
    });
    expect(invites).toContainEqual({
      email: `eze-founder-${suffix}@example.test`,
      role: "editor",
    });
    expect(invites).toContainEqual({
      email: `designer-${suffix}@example.test`,
      role: "editor",
    });
    expect(invites).toContainEqual({
      email: `whatever-${suffix}@example.test`,
      role: "editor",
    });
  });

  test("classifies explicitly viewer human roles as agent-fs viewers", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    process.env.AGENT_FS_API_URL = "https://agent-fs.example.test/";
    process.env.AGENT_FS_REGISTER_EMAIL = "admin@example.test";
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
      key: "AGENT_FS_DEFAULT_DRIVE_ID",
      value: "shared-drive",
    });

    createUser({
      name: "Viewer Human",
      email: `viewer-${suffix}@example.test`,
      role: "Viewer",
    });
    createUser({
      name: "Read Only Human",
      email: `read-only-${suffix}@example.test`,
      role: "read only",
    });
    createUser({
      name: "Guest Human",
      email: `guest-${suffix}@example.test`,
      role: "guest",
    });

    const records: RequestRecord[] = [];
    setAgentFsProvisionFetchForTests(createFetchStub(records));

    const result = await runSeeder(agentFsProvisionSeeder, { quiet: true });

    expect(result.failed).toEqual([]);
    const invites = records
      .filter((r) => r.path === "/orgs/shared-org/members/invite")
      .map((r) => r.body);
    expect(invites).toContainEqual({
      email: `viewer-${suffix}@example.test`,
      role: "viewer",
    });
    expect(invites).toContainEqual({
      email: `read-only-${suffix}@example.test`,
      role: "viewer",
    });
    expect(invites).toContainEqual({
      email: `guest-${suffix}@example.test`,
      role: "viewer",
    });
  });

  test("does not invite existing members when provisioning would keep or lower their role", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const existingAdmin = `existing-admin-${suffix}@example.test`;
    const existingEditor = `existing-editor-${suffix}@example.test`;
    const existingViewer = `existing-viewer-${suffix}@example.test`;
    const explicitViewer = `explicit-viewer-${suffix}@example.test`;
    process.env.AGENT_FS_API_URL = "https://agent-fs.example.test/";
    process.env.AGENT_FS_REGISTER_EMAIL = "admin@example.test";
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
      key: "AGENT_FS_DEFAULT_DRIVE_ID",
      value: "shared-drive",
    });

    createUser({ name: "Existing Admin", email: existingAdmin, role: "Customer" });
    createUser({ name: "Existing Editor", email: existingEditor, role: "Designer" });
    createUser({ name: "Existing Viewer", email: existingViewer, role: "Whatever" });
    createUser({ name: "Explicit Viewer", email: explicitViewer, role: "Guest" });

    const records: RequestRecord[] = [];
    setAgentFsProvisionFetchForTests(
      createFetchStub(records, {
        members: [
          { email: existingAdmin, role: "admin" },
          { user: { email: existingEditor }, role: "editor" },
          { email: existingViewer, role: "viewer" },
        ],
      }),
    );

    const result = await runSeeder(agentFsProvisionSeeder, { quiet: true });

    expect(result.failed).toEqual([]);
    const inviteBodies = records
      .filter((r) => r.path === "/orgs/shared-org/members/invite")
      .map((r) => r.body);

    expect(inviteBodies).not.toContainEqual({ email: existingAdmin, role: "editor" });
    expect(inviteBodies).not.toContainEqual({ email: existingEditor, role: "editor" });
    expect(inviteBodies).toContainEqual({ email: existingViewer, role: "editor" });
    expect(inviteBodies).toContainEqual({ email: explicitViewer, role: "viewer" });
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

  test("invites an external email into the shared org with the requested role", async () => {
    process.env.AGENT_FS_API_URL = "https://agent-fs.example.test/";
    process.env.AGENT_FS_REGISTER_EMAIL = "admin@example.test";

    const records: RequestRecord[] = [];
    setAgentFsProvisionFetchForTests(createFetchStub(records));

    const result = await inviteEmailToSharedOrg("Customer@Example.test ", "admin");

    expect(result).toEqual({ orgId: "shared-org", invited: true });
    const invite = records.find((r) => r.path === "/orgs/shared-org/members/invite");
    expect(invite?.method).toBe("POST");
    expect(invite?.body).toEqual({ email: "Customer@Example.test", role: "admin" });
    expect(invite?.authorization).toBe("Bearer afs-admin-key");
  });

  test("does not re-invite an external email whose current role already covers the request", async () => {
    process.env.AGENT_FS_API_URL = "https://agent-fs.example.test/";
    process.env.AGENT_FS_REGISTER_EMAIL = "admin@example.test";

    const records: RequestRecord[] = [];
    setAgentFsProvisionFetchForTests(
      createFetchStub(records, {
        members: [{ email: "customer@example.test", role: "admin" }],
      }),
    );

    const result = await inviteEmailToSharedOrg("customer@example.test", "editor");

    expect(result).toEqual({ orgId: "shared-org", invited: false });
    expect(records.filter((r) => r.path === "/orgs/shared-org/members/invite")).toEqual([]);
  });
});
