import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  deleteUser,
  getAllUsers,
  getDb,
  getTaskById,
  getUserById,
  initDb,
  updateUser,
} from "../be/db";
import {
  findOrCreateUserByEmail,
  findUserByEmail,
  findUserByExternalId,
  findUserById,
  fingerprintApiKey,
  getUserIdentities,
  type IdentityActor,
  linkIdentity,
  mintToken,
  recordIdentityEvent,
  resolveUserByToken,
  revokeToken,
  unlinkIdentity,
} from "../be/users";

const TEST_DB_PATH = "./test-user-identity.sqlite";

let leadAgent: ReturnType<typeof createAgent>;
let workerAgent: ReturnType<typeof createAgent>;

const SYSTEM_ACTOR: IdentityActor = { kind: "system", id: "test-suite" };
const OPERATOR_ACTOR: IdentityActor = { kind: "operator", id: "op:0000000000000000" };

async function eventsFor(userId: string): Promise<
  Array<{
    eventType: string;
    actor: string;
    beforeJson: string | null;
    afterJson: string | null;
  }>
> {
  // Order by createdAt then rowid — events emitted within the same
  // millisecond (synchronous bursts in tests) need a stable tiebreaker.
  return (await getDb())
    .prepare<
      { eventType: string; actor: string; beforeJson: string | null; afterJson: string | null },
      string
    >(
      "SELECT eventType, actor, beforeJson, afterJson FROM user_identity_events WHERE userId = ? ORDER BY createdAt ASC, rowid ASC",
    )
    .all(userId);
}

beforeAll(async () => {
  // Best-effort cleanup of any lingering test DB from a previous crashed run.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
  await initDb(TEST_DB_PATH);
  leadAgent = await createAgent({ name: "TestLead", isLead: true, status: "idle" });
  workerAgent = await createAgent({ name: "TestWorker", isLead: false, status: "idle" });
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore
    }
  }
});

// ─── User CRUD ────────────────────────────────────────────────────────────────

describe("createUser", () => {
  test("creates a user with required fields only — no identities yet", async () => {
    const user = await createUser({ name: "Alice" });
    expect(user.id).toBeDefined();
    expect(user.name).toBe("Alice");
    expect(user.email).toBeUndefined();
    expect(user.role).toBeUndefined();
    expect(user.emailAliases).toEqual([]);
    expect(user.preferredChannel).toBe("slack");
    expect(user.status).toBe("active");
    expect(user.dailyBudgetUsd).toBeNull();
    expect(user.createdAt).toBeDefined();
    expect(user.lastUpdatedAt).toBeDefined();
    expect(await getUserIdentities(user.id)).toEqual([]);
  });

  test("links identities one-by-one via linkIdentity", async () => {
    const user = await createUser({
      name: "Bob",
      email: "bob@example.com",
      role: "engineer",
      notes: "Test user",
      emailAliases: ["bob2@example.com", "robert@example.com"],
      preferredChannel: "email",
      timezone: "America/New_York",
    });
    expect(user.name).toBe("Bob");
    expect(user.email).toBe("bob@example.com");
    expect(user.emailAliases).toEqual(["bob2@example.com", "robert@example.com"]);

    await linkIdentity(user.id, "slack", "U_BOB", SYSTEM_ACTOR);
    await linkIdentity(user.id, "linear", "lin-bob-uuid", SYSTEM_ACTOR);
    await linkIdentity(user.id, "github", "bob-gh", SYSTEM_ACTOR);
    await linkIdentity(user.id, "gitlab", "bob-gl", SYSTEM_ACTOR);

    const ids = await getUserIdentities(user.id);
    expect(ids).toContainEqual({ kind: "slack", externalId: "U_BOB" });
    expect(ids).toContainEqual({ kind: "linear", externalId: "lin-bob-uuid" });
    expect(ids).toContainEqual({ kind: "github", externalId: "bob-gh" });
    expect(ids).toContainEqual({ kind: "gitlab", externalId: "bob-gl" });
  });

  test("supports new Phase 064 fields", async () => {
    const user = await createUser({
      name: "Budgeted",
      dailyBudgetUsd: 12.5,
      status: "invited",
      metadata: { hint: "test" },
    });
    expect(user.dailyBudgetUsd).toBe(12.5);
    expect(user.status).toBe("invited");
    expect(user.metadata).toEqual({ hint: "test" });
  });
});

describe("linkIdentity", () => {
  test("rejects duplicate (kind, externalId) — PK collision", async () => {
    const u1 = await createUser({ name: "Dup1" });
    const u2 = await createUser({ name: "Dup2" });
    await linkIdentity(u1.id, "slack", "U_DUP", SYSTEM_ACTOR);
    expect(async () => await linkIdentity(u2.id, "slack", "U_DUP", SYSTEM_ACTOR)).toThrow();
  });

  test("rejects duplicate (kind, externalId) — same user, second call", async () => {
    const u = await createUser({ name: "SelfDup" });
    await linkIdentity(u.id, "github", "self-dup-gh", SYSTEM_ACTOR);
    expect(async () => await linkIdentity(u.id, "github", "self-dup-gh", SYSTEM_ACTOR)).toThrow();
  });

  test("emits identity_added event in the same transaction", async () => {
    const u = await createUser({ name: "EventLink" });
    await linkIdentity(u.id, "slack", "U_EVENTLINK", SYSTEM_ACTOR);
    const events = await eventsFor(u.id);
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("identity_added");
    expect(events[0]!.actor).toBe("system:test-suite");
    expect(JSON.parse(events[0]!.afterJson!)).toEqual({
      kind: "slack",
      externalId: "U_EVENTLINK",
    });
  });
});

describe("unlinkIdentity", () => {
  test("removes the mapping and emits identity_removed", async () => {
    const u = await createUser({ name: "Unlink" });
    await linkIdentity(u.id, "slack", "U_UNLINK", SYSTEM_ACTOR);
    expect(await findUserByExternalId("slack", "U_UNLINK")).not.toBeNull();

    await unlinkIdentity(u.id, "slack", "U_UNLINK", SYSTEM_ACTOR);
    expect(await findUserByExternalId("slack", "U_UNLINK")).toBeNull();

    const events = await eventsFor(u.id);
    expect(events.map((e) => e.eventType)).toEqual(["identity_added", "identity_removed"]);
    expect(JSON.parse(events[1]!.beforeJson!)).toEqual({
      kind: "slack",
      externalId: "U_UNLINK",
    });
    expect(events[1]!.afterJson).toBeNull();
  });
});

describe("getUserById / getUserIdentities", () => {
  test("returns user by ID", async () => {
    const created = await createUser({ name: "GetById" });
    const fetched = await getUserById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("GetById");
    expect(fetched!.id).toBe(created.id);
  });

  test("findUserById returns null for non-existent ID", async () => {
    expect(await findUserById("nonexistent")).toBeNull();
  });

  test("getUserIdentities returns sorted (kind, externalId) tuples", async () => {
    const u = await createUser({ name: "IdList" });
    await linkIdentity(u.id, "slack", "U_LIST", SYSTEM_ACTOR);
    await linkIdentity(u.id, "github", "list-gh", SYSTEM_ACTOR);
    const list = await getUserIdentities(u.id);
    expect(list.length).toBe(2);
    expect(list).toEqual([
      { kind: "github", externalId: "list-gh" },
      { kind: "slack", externalId: "U_LIST" },
    ]);
  });
});

describe("getAllUsers", () => {
  test("returns all users", async () => {
    const users = await getAllUsers();
    expect(users.length).toBeGreaterThan(0);
  });
});

describe("updateUser", () => {
  test("updates specific fields", async () => {
    const user = await createUser({ name: "UpdateMe", role: "intern" });
    const updated = await updateUser(user.id, { role: "senior", email: "updated@test.com" });
    expect(updated).toBeDefined();
    expect(updated!.role).toBe("senior");
    expect(updated!.email).toBe("updated@test.com");
    expect(updated!.name).toBe("UpdateMe"); // unchanged
  });

  test("updates emailAliases", async () => {
    const user = await createUser({ name: "AliasUser" });
    const updated = await updateUser(user.id, {
      emailAliases: ["alias1@test.com", "alias2@test.com"],
    });
    expect(updated!.emailAliases).toEqual(["alias1@test.com", "alias2@test.com"]);
  });

  test("updates new Phase 064 fields", async () => {
    const user = await createUser({ name: "BudgetUser" });
    const updated = await updateUser(user.id, {
      dailyBudgetUsd: 25.0,
      status: "suspended",
      metadata: { reason: "test" },
    });
    expect(updated!.dailyBudgetUsd).toBe(25.0);
    expect(updated!.status).toBe("suspended");
    expect(updated!.metadata).toEqual({ reason: "test" });
  });

  test("returns null for non-existent user", async () => {
    expect(await updateUser("nonexistent", { name: "Nope" })).toBeNull();
  });

  test("returns unchanged user when no updates provided", async () => {
    const user = await createUser({ name: "NoChange" });
    const result = await updateUser(user.id, {});
    expect(result).toBeDefined();
    expect(result!.name).toBe("NoChange");
  });
});

describe("deleteUser", () => {
  test("deletes existing user", async () => {
    const user = await createUser({ name: "DeleteMe" });
    expect(await deleteUser(user.id)).toBe(true);
    expect(await getUserById(user.id)).toBeNull();
  });

  test("returns false for non-existent user", async () => {
    expect(await deleteUser("nonexistent")).toBe(false);
  });

  test("clears requestedByUserId on tasks AND cascades user_external_ids", async () => {
    const user = await createUser({ name: "TaskOwner" });
    await linkIdentity(user.id, "slack", "U_TASKOWNER", SYSTEM_ACTOR);
    expect(await findUserByExternalId("slack", "U_TASKOWNER")).not.toBeNull();

    const task = await createTaskExtended("test task with user", {
      agentId: workerAgent.id,
      source: "slack",
      requestedByUserId: user.id,
    });
    expect((await getTaskById(task.id))!.requestedByUserId).toBe(user.id);

    await deleteUser(user.id);
    expect((await getTaskById(task.id))!.requestedByUserId).toBeUndefined();
    // ON DELETE CASCADE on user_external_ids.userId should clear the mapping.
    expect(await findUserByExternalId("slack", "U_TASKOWNER")).toBeNull();
  });
});

// ─── findUserByExternalId ─────────────────────────────────────────────────────

describe("findUserByExternalId", () => {
  let testUser: ReturnType<typeof createUser>;

  beforeAll(async () => {
    testUser = await createUser({
      name: "Resolve TestUser",
      email: "resolve-test@example.com",
    });
    await linkIdentity(testUser.id, "slack", "U_RESOLVE_SLACK", SYSTEM_ACTOR);
    await linkIdentity(testUser.id, "linear", "lin-resolve-uuid", SYSTEM_ACTOR);
    await linkIdentity(testUser.id, "github", "resolve-gh", SYSTEM_ACTOR);
    await linkIdentity(testUser.id, "gitlab", "resolve-gl", SYSTEM_ACTOR);
  });

  test("resolves by slack identity", async () => {
    const user = await findUserByExternalId("slack", "U_RESOLVE_SLACK");
    expect(user).toBeDefined();
    expect(user!.id).toBe(testUser.id);
  });

  test("resolves by linear identity", async () => {
    const user = await findUserByExternalId("linear", "lin-resolve-uuid");
    expect(user!.id).toBe(testUser.id);
  });

  test("resolves by github identity", async () => {
    const user = await findUserByExternalId("github", "resolve-gh");
    expect(user!.id).toBe(testUser.id);
  });

  test("resolves by gitlab identity", async () => {
    const user = await findUserByExternalId("gitlab", "resolve-gl");
    expect(user!.id).toBe(testUser.id);
  });

  test("returns null for unknown externalId", async () => {
    expect(await findUserByExternalId("slack", "U_NONEXISTENT")).toBeNull();
    expect(await findUserByExternalId("github", "no-such-account")).toBeNull();
  });

  test("kind is exact — slack externalId does not resolve under github", async () => {
    expect(await findUserByExternalId("github", "U_RESOLVE_SLACK")).toBeNull();
  });
});

// ─── findUserByEmail ──────────────────────────────────────────────────────────

describe("findUserByEmail", () => {
  test("matches primary email (case-insensitive)", async () => {
    const user = await createUser({
      name: "EmailPrimary",
      email: "primary@example.com",
    });
    expect((await findUserByEmail("primary@example.com"))!.id).toBe(user.id);
    expect((await findUserByEmail("PRIMARY@example.com"))!.id).toBe(user.id);
  });

  test("matches an emailAlias (case-insensitive)", async () => {
    const user = await createUser({
      name: "EmailAlias",
      email: "main@example.com",
      emailAliases: ["alt@example.com", "other@example.com"],
    });
    expect((await findUserByEmail("alt@example.com"))!.id).toBe(user.id);
    expect((await findUserByEmail("OTHER@EXAMPLE.COM"))!.id).toBe(user.id);
  });

  test("returns null on no match", async () => {
    expect(await findUserByEmail("nobody@nowhere.com")).toBeNull();
  });
});

// ─── findOrCreateUserByEmail ──────────────────────────────────────────────────

describe("findOrCreateUserByEmail", () => {
  test("creates a fresh user + emits identity_added when no match", async () => {
    const result = await findOrCreateUserByEmail(
      "new-foc@example.com",
      { name: "FocNew" },
      { kind: "system", id: "webhook:test" },
    );
    expect(result.created).toBe(true);
    expect(result.user.email).toBe("new-foc@example.com");
    expect(result.user.name).toBe("FocNew");
    const events = await eventsFor(result.user.id);
    expect(events.length).toBe(1);
    expect(events[0]!.eventType).toBe("identity_added");
    expect(events[0]!.actor).toBe("system:webhook:test");
  });

  test("returns the existing user + emits auto_merge on a second call", async () => {
    const first = await findOrCreateUserByEmail(
      "merge-foc@example.com",
      { name: "FocMerge" },
      SYSTEM_ACTOR,
    );
    expect(first.created).toBe(true);

    const second = await findOrCreateUserByEmail(
      "merge-foc@example.com",
      { name: "FocMergeRetry" },
      SYSTEM_ACTOR,
    );
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);

    const events = await eventsFor(first.user.id);
    // identity_added (initial) + auto_merge (second call) = 2 events.
    expect(events.map((e) => e.eventType)).toEqual(["identity_added", "auto_merge"]);
  });

  test("falls back to email local-part when no name hint provided", async () => {
    const result = await findOrCreateUserByEmail("auto-name@example.com", {}, SYSTEM_ACTOR);
    expect(result.created).toBe(true);
    expect(result.user.name).toBe("auto-name");
  });
});

// ─── Tokens ───────────────────────────────────────────────────────────────────

describe("mintToken / revokeToken / resolveUserByToken", () => {
  test("mintToken returns aswt_-prefixed plaintext and stores hash + 4-char preview", async () => {
    const user = await createUser({ name: "TokenUser" });
    const { tokenId, plaintext } = await mintToken(user.id, "CI test", OPERATOR_ACTOR);

    expect(plaintext.startsWith("aswt_")).toBe(true);
    expect(plaintext.length).toBeGreaterThanOrEqual(25);
    expect(tokenId).toBeDefined();

    // Stored row should have hash != plaintext and preview = last 4 chars.
    const row = (await getDb())
      .prepare<{ tokenHash: string; tokenPreview: string }, string>(
        "SELECT tokenHash, tokenPreview FROM user_tokens WHERE id = ?",
      )
      .get(tokenId);
    expect(row).toBeDefined();
    expect(row!.tokenHash).not.toBe(plaintext);
    expect(row!.tokenHash.length).toBe(64); // sha256 hex
    expect(row!.tokenPreview).toBe(plaintext.slice(-4));

    // token_minted event landed with operator actor.
    const events = await eventsFor(user.id);
    expect(events.find((e) => e.eventType === "token_minted")).toBeDefined();
    expect(events.find((e) => e.eventType === "token_minted")!.actor).toBe(
      "operator:op:0000000000000000",
    );
  });

  test("resolveUserByToken returns the owning user and bumps lastUsedAt", async () => {
    const user = await createUser({ name: "ResolveTokenUser" });
    const { tokenId, plaintext } = await mintToken(user.id, null, OPERATOR_ACTOR);

    const resolved = await resolveUserByToken(plaintext);
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(user.id);

    const row = (await getDb())
      .prepare<{ lastUsedAt: string | null }, string>(
        "SELECT lastUsedAt FROM user_tokens WHERE id = ?",
      )
      .get(tokenId);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  test("revokeToken sets revokedAt + emits token_revoked + resolveUserByToken returns null", async () => {
    const user = await createUser({ name: "RevokeUser" });
    const { tokenId, plaintext } = await mintToken(user.id, "to-revoke", OPERATOR_ACTOR);
    await revokeToken(tokenId, OPERATOR_ACTOR);

    const row = (await getDb())
      .prepare<{ revokedAt: string | null }, string>(
        "SELECT revokedAt FROM user_tokens WHERE id = ?",
      )
      .get(tokenId);
    expect(row!.revokedAt).not.toBeNull();

    expect(await resolveUserByToken(plaintext)).toBeNull();

    const events = await eventsFor(user.id);
    expect(events.map((e) => e.eventType)).toContain("token_revoked");
  });

  test("resolveUserByToken returns null for unknown plaintext", async () => {
    expect(await resolveUserByToken("aswt_unknown000000000000000000000")).toBeNull();
  });
});

// ─── fingerprintApiKey ────────────────────────────────────────────────────────

describe("fingerprintApiKey", () => {
  test("returns op:<sha256-16-hex> format", () => {
    expect(fingerprintApiKey("some-key")).toMatch(/^op:[0-9a-f]{16}$/);
    expect(fingerprintApiKey("")).toMatch(/^op:[0-9a-f]{16}$/);
  });

  test("is deterministic", () => {
    expect(fingerprintApiKey("same-input")).toBe(fingerprintApiKey("same-input"));
  });
});

// ─── recordIdentityEvent (direct API) ─────────────────────────────────────────

describe("recordIdentityEvent", () => {
  test("can emit budget_changed / status_changed / email_* directly", async () => {
    const user = await createUser({ name: "EventDirect" });
    await recordIdentityEvent(user.id, "budget_changed", OPERATOR_ACTOR, null, {
      dailyBudgetUsd: 10,
    });
    await recordIdentityEvent(
      user.id,
      "status_changed",
      OPERATOR_ACTOR,
      { status: "active" },
      {
        status: "suspended",
      },
    );
    await recordIdentityEvent(user.id, "email_added", OPERATOR_ACTOR, null, { email: "x@y.com" });
    await recordIdentityEvent(user.id, "email_removed", OPERATOR_ACTOR, { email: "x@y.com" }, null);

    const events = await eventsFor(user.id);
    expect(events.map((e) => e.eventType)).toEqual([
      "budget_changed",
      "status_changed",
      "email_added",
      "email_removed",
    ]);
  });
});

// ─── requestedByUserId on tasks ───────────────────────────────────────────────

describe("requestedByUserId in tasks", () => {
  test("createTaskExtended stores requestedByUserId", async () => {
    const user = await createUser({ name: "Requester" });
    const task = await createTaskExtended("task with requester", {
      agentId: workerAgent.id,
      source: "slack",
      requestedByUserId: user.id,
    });
    const fetched = await getTaskById(task.id);
    expect(fetched!.requestedByUserId).toBe(user.id);
    await deleteUser(user.id);
  });

  test("requestedByUserId inherits from parent task", async () => {
    const user = await createUser({ name: "ParentRequester" });
    const parent = await createTaskExtended("parent task", {
      agentId: leadAgent.id,
      source: "slack",
      requestedByUserId: user.id,
    });
    const child = await createTaskExtended("child task", {
      agentId: workerAgent.id,
      source: "mcp",
      parentTaskId: parent.id,
    });
    const fetchedChild = await getTaskById(child.id);
    expect(fetchedChild!.requestedByUserId).toBe(user.id);
    await deleteUser(user.id);
  });

  test("explicit requestedByUserId overrides parent inheritance", async () => {
    const user1 = await createUser({ name: "User1" });
    const user2 = await createUser({ name: "User2" });
    const parent = await createTaskExtended("parent", {
      agentId: leadAgent.id,
      source: "slack",
      requestedByUserId: user1.id,
    });
    const child = await createTaskExtended("child", {
      agentId: workerAgent.id,
      source: "mcp",
      parentTaskId: parent.id,
      requestedByUserId: user2.id,
    });
    expect((await getTaskById(child.id))!.requestedByUserId).toBe(user2.id);
    await deleteUser(user1.id);
    await deleteUser(user2.id);
  });

  test("task without requestedByUserId has undefined", async () => {
    const task = await createTaskExtended("no user task", {
      agentId: workerAgent.id,
      source: "mcp",
    });
    expect((await getTaskById(task.id))!.requestedByUserId).toBeUndefined();
  });
});
