import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  initDb,
} from "../be/db";
import { attachRole, detachRole } from "../be/rbac-roles";
import { linkIdentity, mintToken, revokeToken } from "../be/users";
import { _resetTelemetryStateForTests, initTelemetry } from "../telemetry";
import { collectOrgSnapshot, emitOrgSnapshotIfDue, LAST_SNAPSHOT_KEY } from "../telemetry-snapshot";

// initTelemetry no-ops when ANONYMIZED_TELEMETRY=false, and the CI env may set it.
process.env.ANONYMIZED_TELEMETRY = "true";

const TEST_DB_PATH = "./test-telemetry-snapshot.sqlite";
const ACTOR = { kind: "system", id: "telemetry-snapshot-test" } as const;
const DAY_MS = 24 * 60 * 60_000;

async function removeTestDb(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File does not exist.
    }
  }
}

function memoryConfig(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

/** Fixture: 3 active users, 1 suspended, 1 invited, 2 agents. */
async function seedFixture() {
  const admin = await createUser({ name: "Admin Person", email: "admin.person@corp.example" });
  const tokenUser = await createUser({ name: "Token Person" });
  const revokedUser = await createUser({ name: "Revoked Person" });
  const suspended = await createUser({
    name: "Suspended Person",
    email: "suspended@corp.example",
    status: "suspended",
  });
  const invited = await createUser({ name: "Invited Person", status: "invited" });
  for (const user of [tokenUser, revokedUser, suspended, invited]) {
    await detachRole(user.id, "admin");
    await attachRole(user.id, "requester");
  }

  await mintToken(tokenUser.id, "live", ACTOR);
  const revoked = await mintToken(revokedUser.id, "revoked", ACTOR);
  const revokedRow = await getDbClient().get<{ id: string }>(
    "SELECT id FROM user_tokens WHERE userId = ?",
    [revokedUser.id],
  );
  await revokeToken(revokedRow?.id ?? revoked.tokenId, ACTOR);

  await linkIdentity(admin.id, "slack", "U-ADMIN", ACTOR);
  await linkIdentity(admin.id, "github", "admin-gh", ACTOR);
  await linkIdentity(tokenUser.id, "composio", "c-1", ACTOR);
  await linkIdentity(tokenUser.id, "kapso", "k-1", ACTOR);
  await linkIdentity(revokedUser.id, "jira", "j-1", ACTOR);
  await linkIdentity(revokedUser.id, "linear", "l-1", ACTOR);
  await linkIdentity(revokedUser.id, "gitlab", "g-1", ACTOR);
  // A suspended user's links and an invited user's links do not count.
  await linkIdentity(suspended.id, "slack", "U-SUSPENDED", ACTOR);

  await createAgent({
    id: "aaaa0000-0000-4000-8000-0000000000a1",
    name: "A1",
    isLead: true,
    status: "idle",
  });
  await createAgent({
    id: "bbbb0000-0000-4000-8000-0000000000b1",
    name: "B1",
    isLead: false,
    status: "idle",
  });

  // Two recent tasks by one user, one recent by another, one old by a third.
  const recentA = await createTaskExtended("recent a", { requestedByUserId: admin.id });
  await createTaskExtended("recent a again", { requestedByUserId: admin.id });
  await createTaskExtended("recent b", { requestedByUserId: revokedUser.id });
  const old = await createTaskExtended("old", { requestedByUserId: tokenUser.id });
  await getDbClient().run("UPDATE agent_tasks SET createdAt = ? WHERE id = ?", [
    new Date(Date.now() - 10 * DAY_MS).toISOString(),
    old.id,
  ]);
  expect(recentA.id).toBeTruthy();
  return { admin, tokenUser, revokedUser, suspended, invited };
}

describe("org snapshot", () => {
  const originalFetch = globalThis.fetch;
  let sent: Array<{ event: string; properties: Record<string, unknown> }>;

  beforeEach(async () => {
    closeDb();
    await removeTestDb();
    initDb(TEST_DB_PATH);
    _resetTelemetryStateForTests();
    process.env.ANONYMIZED_TELEMETRY = "true";
    sent = [];
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      if (init?.body) sent.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.env.ANONYMIZED_TELEMETRY = "true";
    _resetTelemetryStateForTests();
    closeDb();
    await removeTestDb();
  });

  async function boot(config = memoryConfig({ telemetry_installation_id: "install_snapshot" })) {
    await initTelemetry("api-server", config.get, config.set, { generateIfMissing: true });
    return config;
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("counts match the fixture rows", async () => {
    await seedFixture();
    expect(await collectOrgSnapshot()).toEqual({
      users_total: 3,
      users_suspended: 1,
      users_admin: 1,
      users_with_login: 2, // the admin's email and the live token; the revoked one has neither
      users_linked_slack: 1,
      users_linked_github: 1,
      users_linked_gitlab: 1,
      users_linked_linear: 1,
      users_linked_jira: 1,
      users_linked_other: 1, // composio + kapso on one user count once
      users_active_7d: 2,
      agents_total: 2,
    });
  });

  test("an empty install snapshots all zeros", async () => {
    const snapshot = await collectOrgSnapshot();
    expect(Object.values(snapshot).every((n) => n === 0)).toBe(true);
  });

  test("the payload has no @, no email local part, no name and no raw user ID", async () => {
    const { admin, tokenUser } = await seedFixture();
    const config = await boot();
    expect(await emitOrgSnapshotIfDue({ getConfig: config.get, setConfig: config.set })).toBe(true);
    await tick();

    // Seeding fires task events after boot; only the snapshot is under test.
    const snapshots = sent.filter((e) => e.event === "org.snapshot");
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.properties).toMatchObject({ users_total: 3, agents_total: 2 });
    const text = JSON.stringify(snapshots[0]);
    expect(text).not.toContain("@");
    for (const secret of [admin.id, tokenUser.id, "admin.person", "Admin Person", "corp.example"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("one send per 24 hours, across a simulated restart", async () => {
    await seedFixture();
    const config = await boot();
    const t0 = Date.parse("2026-10-01T00:00:00.000Z");
    const deps = (now: number) => ({
      getConfig: config.get,
      setConfig: config.set,
      now: () => now,
    });

    expect(await emitOrgSnapshotIfDue(deps(t0))).toBe(true);
    expect(config.store.get(LAST_SNAPSHOT_KEY)).toBe(new Date(t0).toISOString());
    expect(await emitOrgSnapshotIfDue(deps(t0 + 60_000))).toBe(false);

    // Restart: module state is gone, the stored timestamp is what remains.
    _resetTelemetryStateForTests();
    await boot(config);
    expect(await emitOrgSnapshotIfDue(deps(t0 + DAY_MS - 60_000))).toBe(false);
    expect(await emitOrgSnapshotIfDue(deps(t0 + DAY_MS + 60_000))).toBe(true);
    await tick();
    expect(sent.filter((e) => e.event === "org.snapshot")).toHaveLength(2);
  });

  test("two overlapping ticks send once", async () => {
    await seedFixture();
    const config = await boot();
    const deps = { getConfig: config.get, setConfig: config.set };
    const [a, b] = await Promise.all([emitOrgSnapshotIfDue(deps), emitOrgSnapshotIfDue(deps)]);
    await tick();
    expect([a, b]).toEqual([true, true]); // both callers share the one in-flight send
    expect(sent.filter((e) => e.event === "org.snapshot")).toHaveLength(1);
  });

  test("nothing is sent or recorded when opted out", async () => {
    await seedFixture();
    process.env.ANONYMIZED_TELEMETRY = "false";
    const config = await boot(memoryConfig());
    expect(await emitOrgSnapshotIfDue({ getConfig: config.get, setConfig: config.set })).toBe(
      false,
    );
    await tick();
    expect(sent).toEqual([]);
    expect(config.store.has(LAST_SNAPSHOT_KEY)).toBe(false);
  });

  test("nothing is sent or recorded before telemetry has an identity, so the next tick retries", async () => {
    await seedFixture();
    const config = memoryConfig(); // never booted: no install ID, no org ID
    expect(await emitOrgSnapshotIfDue({ getConfig: config.get, setConfig: config.set })).toBe(
      false,
    );
    expect(config.store.has(LAST_SNAPSHOT_KEY)).toBe(false);
  });
});
