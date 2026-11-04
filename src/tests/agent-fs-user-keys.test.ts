import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  AgentFsKeyValidationError,
  ensureUserAgentFsAccount,
  mintUserAgentFsKey,
} from "../be/agent-fs-user-keys";
import { closeDb, getDbClient, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";
import { ensureRbacSeedsSynced, setUserRoles } from "../be/rbac-roles";
import { scrubSecrets } from "../utils/secret-scrubber";

const BOOTSTRAP_KEY = `af_${"a1".repeat(32)}`;
const PRIMARY_KEY = `af_${"b2".repeat(32)}`;
const MINTED_KEY = `af_${"c3".repeat(32)}`;
const ORG_ID = crypto.randomUUID();
const DRIVE_ID = crypto.randomUUID();
const AFS_USER_ID = crypto.randomUUID();
const KEY_ID = crypto.randomUUID();
const MEMBERS_PATH = `/orgs/${ORG_ID}/members`;
const KEYS_PATH = `${MEMBERS_PATH}/${AFS_USER_ID}/keys`;
const ENV_KEYS = [
  "AGENT_FS_API_URL",
  "API_AGENT_FS_API_KEY",
  "AGENT_FS_API_KEY",
  "AGENT_FS_DEFAULT_ORG_ID",
  "AGENT_FS_SHARED_ORG_ID",
  "AGENT_FS_DEFAULT_DRIVE_ID",
  "AGENT_FS_REGISTER_EMAIL",
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

type Member = { userId: string; email: string; role: "admin" | "editor" | "viewer" };
type RequestRecord = {
  method: string;
  path: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
};

let dbPath: string;
let server: ReturnType<typeof Bun.serve> | undefined;
let userId: string;
let email: string;
let members: Member[];
let records: RequestRecord[];
let registerResponse: Response | undefined;
let inviteResponse: Response | undefined;
let keyResponse: Response | undefined;
let membersResponse: Response | undefined;
let roleUpdateResponse: Response | undefined;

async function configSnapshot() {
  return getDbClient().query("SELECT * FROM swarm_config ORDER BY id");
}

async function createUser(userEmail: string | null = email, role = "admin") {
  const id = crypto.randomUUID();
  await getDbClient().run("INSERT INTO users (id, name, email, role) VALUES (?, ?, ?, ?)", [
    id,
    "Human Name",
    userEmail,
    "Viewer",
  ]);
  await setUserRoles(id, [role], null);
  return id;
}

beforeEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  dbPath = `/tmp/agent-fs-user-keys-${crypto.randomUUID()}.sqlite`;
  initDb(dbPath);
  ensureRbacSeedsSynced({ quiet: true });
  records = [];
  email = `human-${crypto.randomUUID()}@example.test`;
  members = [{ userId: AFS_USER_ID, email, role: "editor" }];
  registerResponse = undefined;
  inviteResponse = undefined;
  keyResponse = undefined;
  membersResponse = undefined;
  roleUpdateResponse = undefined;
  server = undefined;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = request.method === "GET" ? null : await request.json();
      records.push({
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
        body,
      });
      if (request.method === "GET" && path === MEMBERS_PATH) {
        return membersResponse ?? Response.json({ members });
      }
      if (request.method === "POST" && path === "/auth/register") {
        return (
          registerResponse ??
          Response.json({ apiKey: PRIMARY_KEY, userId: AFS_USER_ID, orgId: crypto.randomUUID() })
        );
      }
      if (request.method === "POST" && path === `${MEMBERS_PATH}/invite`) {
        if (inviteResponse) return inviteResponse;
        members = [{ userId: AFS_USER_ID, email, role: body.role }];
        return Response.json({
          ok: true,
          status: "added",
          userId: AFS_USER_ID,
          email,
          orgRole: body.role,
          drives: [],
        });
      }
      if (request.method === "PATCH" && path === `${MEMBERS_PATH}/${AFS_USER_ID}`) {
        if (roleUpdateResponse) return roleUpdateResponse;
        members = members.map((member) =>
          member.userId === AFS_USER_ID ? { ...member, role: body.role } : member,
        );
        return Response.json({ ok: true });
      }
      if (request.method === "POST" && path === KEYS_PATH) {
        return (
          keyResponse ??
          Response.json(
            {
              id: KEY_ID,
              label: body.label,
              createdAt: "2026-11-04T10:00:00Z",
              apiKey: MINTED_KEY,
              userId: AFS_USER_ID,
              orgId: ORG_ID,
            },
            { status: 201 },
          )
        );
      }
      return Response.json({ error: "Unexpected test request", path }, { status: 500 });
    },
  });
  process.env.AGENT_FS_API_URL = server.url.origin;
  for (const [key, value] of [
    ["AGENT_FS_API_URL", server.url.origin],
    ["API_AGENT_FS_API_KEY", BOOTSTRAP_KEY],
    ["AGENT_FS_DEFAULT_ORG_ID", ORG_ID],
    ["AGENT_FS_DEFAULT_DRIVE_ID", DRIVE_ID],
  ] as const) {
    await upsertSwarmConfig({
      scope: "global",
      key,
      value,
      isSecret: key === "API_AGENT_FS_API_KEY",
    });
  }
  userId = await createUser();
});

afterEach(async () => {
  server?.stop(true);
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = Bun.file(dbPath + suffix);
    if (await file.exists()) await file.delete();
  }
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("user agent-fs keys", () => {
  test("ensures an existing member without changing config", async () => {
    const before = await configSnapshot();
    expect(await ensureUserAgentFsAccount(userId)).toEqual({
      status: "ready",
      agentFsUserId: AFS_USER_ID,
      email,
      displayName: "Human Name",
      orgId: ORG_ID,
      driveId: DRIVE_ID,
    });
    expect(records.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: MEMBERS_PATH },
    ]);
    expect(records[0]?.authorization).toBe(`Bearer ${BOOTSTRAP_KEY}`);
    expect(await configSnapshot()).toEqual(before);
  });

  test("mints a labelled key with the bootstrap bearer and no config writes", async () => {
    const before = await configSnapshot();
    expect(await mintUserAgentFsKey(userId, "Laptop")).toEqual({
      status: "minted",
      apiKey: MINTED_KEY,
      keyId: KEY_ID,
      label: "Laptop",
      agentFsUserId: AFS_USER_ID,
      orgId: ORG_ID,
      driveId: DRIVE_ID,
    });
    expect(records.at(-1)).toEqual({
      method: "POST",
      path: KEYS_PATH,
      authorization: `Bearer ${BOOTSTRAP_KEY}`,
      body: { label: "Laptop" },
    });
    expect(records.every((record) => record.authorization === `Bearer ${BOOTSTRAP_KEY}`)).toBe(
      true,
    );
    expect(await configSnapshot()).toEqual(before);
  });

  test("registers, invites, then mints without returning or storing the primary key", async () => {
    members = [];
    const before = await configSnapshot();
    const result = await mintUserAgentFsKey(userId, "Desktop");
    expect(result.status).toBe("minted");
    expect(JSON.stringify(result)).not.toContain(PRIMARY_KEY);
    expect(records.find((record) => record.path === "/auth/register")?.body).toEqual(
      expect.objectContaining({ email }),
    );
    expect(records.find((record) => record.path === `${MEMBERS_PATH}/invite`)).toEqual({
      method: "POST",
      path: `${MEMBERS_PATH}/invite`,
      authorization: `Bearer ${BOOTSTRAP_KEY}`,
      body: { email, role: "editor" },
    });
    const paths = records.map((record) => record.path);
    expect(paths.indexOf("/auth/register")).toBeLessThan(paths.indexOf(`${MEMBERS_PATH}/invite`));
    expect(paths.indexOf(`${MEMBERS_PATH}/invite`)).toBeLessThan(paths.indexOf(KEYS_PATH));
    expect(await configSnapshot()).toEqual(before);
    expect(JSON.stringify(await getSwarmConfigs())).not.toContain(PRIMARY_KEY);
    expect(JSON.stringify(await getSwarmConfigs())).not.toContain(MINTED_KEY);
  });

  test("returns pending when registration rejects the email domain", async () => {
    members = [];
    registerResponse = Response.json(
      { error: "REGISTRATION_DOMAIN_NOT_ALLOWED", message: "Email domain is not allowed" },
      { status: 403 },
    );
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("pending");
    expect(records.some((record) => record.path === KEYS_PATH)).toBe(false);
  });

  test("continues after an existing registration conflict", async () => {
    members = [];
    registerResponse = Response.json(
      { error: "CONFLICT", message: "Email is already registered" },
      { status: 409 },
    );
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("minted");
    expect(records.some((record) => record.path === `${MEMBERS_PATH}/invite`)).toBe(true);
  });

  test("returns unsupported when the member key route is absent", async () => {
    keyResponse = new Response("404 Not Found", { status: 404 });
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("unsupported");
  });

  test("returns pending for a missing upstream account on a supported key route", async () => {
    keyResponse = Response.json(
      { error: "NOT_FOUND", message: `Org not found: ${ORG_ID}` },
      { status: 404 },
    );
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("pending");
  });

  test("returns pending instead of minting when the invitation is pending", async () => {
    members = [];
    inviteResponse = Response.json({
      ok: true,
      status: "pending",
      inviteId: crypto.randomUUID(),
      expiresAt: "2026-11-11T10:00:00Z",
      token: crypto.randomUUID(),
    });
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("pending");
    expect(records.some((record) => record.path === KEYS_PATH)).toBe(false);
  });

  test("upgrades a lower member role before minting", async () => {
    members[0]!.role = "viewer";
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("minted");
    expect(records.find((record) => record.path === `${MEMBERS_PATH}/invite`)?.body).toEqual({
      email,
      role: "editor",
    });
  });

  test.each(["admin", "editor"] as const)("keeps an existing %s member role", async (role) => {
    members[0]!.role = role;
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("minted");
    expect(records.some((record) => record.path === `${MEMBERS_PATH}/invite`)).toBe(false);
  });

  test("lowers an editor member to viewer when the grant dropped before minting", async () => {
    await createUser(`admin-${crypto.randomUUID()}@example.test`);
    await setUserRoles(userId, ["viewer"], null);
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("minted");
    const patch = records.find((record) => record.method === "PATCH");
    expect(patch).toEqual({
      method: "PATCH",
      path: `${MEMBERS_PATH}/${AFS_USER_ID}`,
      authorization: `Bearer ${BOOTSTRAP_KEY}`,
      body: { role: "viewer" },
    });
    const paths = records.map((record) => `${record.method} ${record.path}`);
    expect(paths.indexOf(`PATCH ${MEMBERS_PATH}/${AFS_USER_ID}`)).toBeLessThan(
      paths.indexOf(`POST ${KEYS_PATH}`),
    );
    expect(members[0]?.role).toBe("viewer");
  });

  test("keeps an agent-fs admin role for a viewer grant", async () => {
    await createUser(`admin-${crypto.randomUUID()}@example.test`);
    await setUserRoles(userId, ["viewer"], null);
    members[0]!.role = "admin";
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("minted");
    expect(records.some((record) => record.method === "PATCH")).toBe(false);
  });

  test("refuses to mint when the higher role cannot be lowered", async () => {
    await createUser(`admin-${crypto.randomUUID()}@example.test`);
    await setUserRoles(userId, ["viewer"], null);
    roleUpdateResponse = Response.json(
      { error: "BAD_REQUEST", message: "Member not found in org" },
      { status: 400 },
    );
    const result = await mintUserAgentFsKey(userId, "Laptop");
    expect(result).toEqual(
      expect.objectContaining({
        status: "pending",
        reason: "The agent-fs org role could not be lowered to viewer",
      }),
    );
    expect(records.some((record) => record.path === KEYS_PATH)).toBe(false);
  });

  test.each([
    ["requester", "editor"],
    ["viewer", "viewer"],
  ])("maps the %s RBAC grant to an agent-fs %s role", async (grant, expectedRole) => {
    await createUser(`admin-${crypto.randomUUID()}@example.test`);
    await setUserRoles(userId, [grant], null);
    members = [];
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("minted");
    expect(records.find((record) => record.path === `${MEMBERS_PATH}/invite`)?.body).toEqual({
      email,
      role: expectedRole,
    });
  });

  test.each([
    ["controls and whitespace", "  Laptop \u0000\u007f \n\tKey  ", "Laptop Key"],
    ["150 ASCII characters", "L".repeat(150), "L".repeat(100)],
    ["150 Unicode code points", "🔑".repeat(150), "🔑".repeat(100)],
  ])("sanitizes %s in the label before minting", async (_name, label, expectedLabel) => {
    const result = await mintUserAgentFsKey(userId, label);
    expect(result.status).toBe("minted");
    expect(records.at(-1)?.body).toEqual({ label: expectedLabel });
    if (result.status === "minted") expect(result.label).toBe(expectedLabel);
  });

  test("rejects an empty sanitized label before any request", async () => {
    await expect(mintUserAgentFsKey(userId, " \u0000\u007f\n\t ")).rejects.toBeInstanceOf(
      AgentFsKeyValidationError,
    );
    expect(records).toEqual([]);
  });

  test("returns pending for a missing user or email without making requests", async () => {
    const noEmail = await createUser(null);
    await getDbClient().run("DELETE FROM swarm_config WHERE key != ?", ["AGENT_FS_API_URL"]);
    expect((await ensureUserAgentFsAccount(crypto.randomUUID())).status).toBe("pending");
    expect((await mintUserAgentFsKey(noEmail, "Laptop")).status).toBe("pending");
    expect(records).toEqual([]);
  });

  test("returns off when no agent-fs URL is configured", async () => {
    delete process.env.AGENT_FS_API_URL;
    await getDbClient().run("DELETE FROM swarm_config WHERE key = ?", ["AGENT_FS_API_URL"]);
    expect((await ensureUserAgentFsAccount(userId)).status).toBe("off");
    expect((await mintUserAgentFsKey(userId, "Laptop")).status).toBe("off");
    expect(records).toEqual([]);
  });

  test.each([
    "members",
    "register",
    "invite",
    "mint",
  ])("propagates upstream server errors during %s", async (stage) => {
    const failure = Response.json({ error: "Temporary server error" }, { status: 500 });
    if (stage === "members") membersResponse = failure;
    if (stage === "register") {
      members = [];
      registerResponse = failure;
    }
    if (stage === "invite") {
      members = [];
      inviteResponse = failure;
    }
    if (stage === "mint") keyResponse = failure;
    await expect(mintUserAgentFsKey(userId, "Laptop")).rejects.toThrow();
  });

  test("propagates network errors", async () => {
    server?.stop(true);
    await expect(mintUserAgentFsKey(userId, "Laptop")).rejects.toThrow();
  });

  test("does not log primary or minted keys and registers the minted key for scrubbing", async () => {
    members = [];
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await mintUserAgentFsKey(userId, "Laptop");
      expect(result.status).toBe("minted");
      const output = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls]);
      expect(output).not.toContain(PRIMARY_KEY);
      expect(output).not.toContain(MINTED_KEY);
      expect(scrubSecrets(`Created key ${MINTED_KEY}`)).not.toContain(MINTED_KEY);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
