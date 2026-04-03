import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  deleteUser,
  getAllUsers,
  getTaskById,
  getUserById,
  initDb,
  resolveUser,
  updateUser,
} from "../be/db";

const TEST_DB_PATH = "./test-user-identity.sqlite";

let leadAgent: ReturnType<typeof createAgent>;
let workerAgent: ReturnType<typeof createAgent>;

beforeAll(() => {
  initDb(TEST_DB_PATH);
  leadAgent = createAgent({ name: "TestLead", isLead: true, status: "idle" });
  workerAgent = createAgent({ name: "TestWorker", isLead: false, status: "idle" });
});

afterAll(() => {
  closeDb();
  try {
    unlinkSync(TEST_DB_PATH);
    unlinkSync(`${TEST_DB_PATH}-wal`);
    unlinkSync(`${TEST_DB_PATH}-shm`);
  } catch {
    // ignore
  }
});

// ─── User CRUD ────────────────────────────────────────────────────────────────

describe("createUser", () => {
  test("creates a user with required fields only", () => {
    const user = createUser({ name: "Alice" });
    expect(user.id).toBeDefined();
    expect(user.name).toBe("Alice");
    expect(user.email).toBeUndefined();
    expect(user.role).toBeUndefined();
    expect(user.emailAliases).toEqual([]);
    expect(user.preferredChannel).toBe("slack");
    expect(user.createdAt).toBeDefined();
    expect(user.lastUpdatedAt).toBeDefined();
  });

  test("creates a user with all fields", () => {
    const user = createUser({
      name: "Bob",
      email: "bob@example.com",
      role: "engineer",
      notes: "Test user",
      slackUserId: "U_BOB",
      linearUserId: "lin-bob-uuid",
      githubUsername: "bob-gh",
      gitlabUsername: "bob-gl",
      emailAliases: ["bob2@example.com", "robert@example.com"],
      preferredChannel: "email",
      timezone: "America/New_York",
    });
    expect(user.name).toBe("Bob");
    expect(user.email).toBe("bob@example.com");
    expect(user.role).toBe("engineer");
    expect(user.notes).toBe("Test user");
    expect(user.slackUserId).toBe("U_BOB");
    expect(user.linearUserId).toBe("lin-bob-uuid");
    expect(user.githubUsername).toBe("bob-gh");
    expect(user.gitlabUsername).toBe("bob-gl");
    expect(user.emailAliases).toEqual(["bob2@example.com", "robert@example.com"]);
    expect(user.preferredChannel).toBe("email");
    expect(user.timezone).toBe("America/New_York");
  });

  test("rejects duplicate slackUserId", () => {
    createUser({ name: "First", slackUserId: "U_UNIQUE" });
    expect(() => createUser({ name: "Second", slackUserId: "U_UNIQUE" })).toThrow();
  });

  test("rejects duplicate githubUsername", () => {
    createUser({ name: "GH1", githubUsername: "unique-gh" });
    expect(() => createUser({ name: "GH2", githubUsername: "unique-gh" })).toThrow();
  });
});

describe("getUserById", () => {
  test("returns user by ID", () => {
    const created = createUser({ name: "GetById" });
    const fetched = getUserById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("GetById");
    expect(fetched!.id).toBe(created.id);
  });

  test("returns null for non-existent ID", () => {
    expect(getUserById("nonexistent")).toBeNull();
  });
});

describe("getAllUsers", () => {
  test("returns all users", () => {
    const users = getAllUsers();
    expect(users.length).toBeGreaterThan(0);
  });
});

describe("updateUser", () => {
  test("updates specific fields", () => {
    const user = createUser({ name: "UpdateMe", role: "intern" });
    const updated = updateUser(user.id, { role: "senior", email: "updated@test.com" });
    expect(updated).toBeDefined();
    expect(updated!.role).toBe("senior");
    expect(updated!.email).toBe("updated@test.com");
    expect(updated!.name).toBe("UpdateMe"); // unchanged
  });

  test("updates emailAliases", () => {
    const user = createUser({ name: "AliasUser" });
    const updated = updateUser(user.id, { emailAliases: ["alias1@test.com", "alias2@test.com"] });
    expect(updated!.emailAliases).toEqual(["alias1@test.com", "alias2@test.com"]);
  });

  test("returns null for non-existent user", () => {
    expect(updateUser("nonexistent", { name: "Nope" })).toBeNull();
  });

  test("returns unchanged user when no updates provided", () => {
    const user = createUser({ name: "NoChange" });
    const result = updateUser(user.id, {});
    expect(result).toBeDefined();
    expect(result!.name).toBe("NoChange");
  });
});

describe("deleteUser", () => {
  test("deletes existing user", () => {
    const user = createUser({ name: "DeleteMe" });
    expect(deleteUser(user.id)).toBe(true);
    expect(getUserById(user.id)).toBeNull();
  });

  test("returns false for non-existent user", () => {
    expect(deleteUser("nonexistent")).toBe(false);
  });

  test("clears requestedByUserId on tasks when user is deleted", () => {
    const user = createUser({ name: "TaskOwner", slackUserId: "U_TASKOWNER" });
    const task = createTaskExtended("test task with user", {
      agentId: workerAgent.id,
      source: "slack",
      requestedByUserId: user.id,
    });
    expect(getTaskById(task.id)!.requestedByUserId).toBe(user.id);

    deleteUser(user.id);
    expect(getTaskById(task.id)!.requestedByUserId).toBeUndefined();
  });
});

// ─── resolveUser ──────────────────────────────────────────────────────────────

describe("resolveUser", () => {
  let testUser: ReturnType<typeof createUser>;

  beforeAll(() => {
    testUser = createUser({
      name: "Resolve TestUser",
      email: "resolve-test@example.com",
      slackUserId: "U_RESOLVE_SLACK",
      linearUserId: "lin-resolve-uuid",
      githubUsername: "resolve-gh",
      gitlabUsername: "resolve-gl",
      emailAliases: ["resolve-alias@example.com"],
    });
  });

  test("resolves by slackUserId", () => {
    const user = resolveUser({ slackUserId: "U_RESOLVE_SLACK" });
    expect(user).toBeDefined();
    expect(user!.id).toBe(testUser.id);
  });

  test("resolves by linearUserId", () => {
    const user = resolveUser({ linearUserId: "lin-resolve-uuid" });
    expect(user).toBeDefined();
    expect(user!.id).toBe(testUser.id);
  });

  test("resolves by githubUsername", () => {
    const user = resolveUser({ githubUsername: "resolve-gh" });
    expect(user).toBeDefined();
    expect(user!.id).toBe(testUser.id);
  });

  test("resolves by gitlabUsername", () => {
    const user = resolveUser({ gitlabUsername: "resolve-gl" });
    expect(user).toBeDefined();
    expect(user!.id).toBe(testUser.id);
  });

  test("resolves by primary email", () => {
    const user = resolveUser({ email: "resolve-test@example.com" });
    expect(user).toBeDefined();
    expect(user!.id).toBe(testUser.id);
  });

  test("resolves by email alias (case-insensitive)", () => {
    const user = resolveUser({ email: "RESOLVE-ALIAS@EXAMPLE.COM" });
    expect(user).toBeDefined();
    expect(user!.id).toBe(testUser.id);
  });

  test("resolves by name substring (case-insensitive)", () => {
    const user = resolveUser({ name: "resolve testuser" });
    expect(user).toBeDefined();
    expect(user!.id).toBe(testUser.id);
  });

  test("returns null for no match", () => {
    expect(resolveUser({ slackUserId: "U_NONEXISTENT" })).toBeNull();
    expect(resolveUser({ email: "nobody@nowhere.com" })).toBeNull();
    expect(resolveUser({ name: "ZZZNoSuchPerson" })).toBeNull();
  });

  test("prioritizes platform ID over email", () => {
    // Create a second user with different slack ID
    const user2 = createUser({
      name: "PriorityUser",
      slackUserId: "U_OTHER_PRIORITY",
    });
    // When resolving with both slackUserId and email, slackUserId wins
    const resolved = resolveUser({
      slackUserId: "U_OTHER_PRIORITY",
      email: "resolve-test@example.com", // belongs to testUser
    });
    expect(resolved!.id).toBe(user2.id);
    // Cleanup
    deleteUser(user2.id);
  });
});

// ─── requestedByUserId on tasks ─────────────────────────────────────────────

describe("requestedByUserId in tasks", () => {
  test("createTaskExtended stores requestedByUserId", () => {
    const user = createUser({ name: "Requester" });
    const task = createTaskExtended("task with requester", {
      agentId: workerAgent.id,
      source: "slack",
      requestedByUserId: user.id,
    });
    const fetched = getTaskById(task.id);
    expect(fetched!.requestedByUserId).toBe(user.id);
    deleteUser(user.id);
  });

  test("requestedByUserId inherits from parent task", () => {
    const user = createUser({ name: "ParentRequester" });
    const parent = createTaskExtended("parent task", {
      agentId: leadAgent.id,
      source: "slack",
      requestedByUserId: user.id,
    });
    const child = createTaskExtended("child task", {
      agentId: workerAgent.id,
      source: "mcp",
      parentTaskId: parent.id,
    });
    const fetchedChild = getTaskById(child.id);
    expect(fetchedChild!.requestedByUserId).toBe(user.id);
    deleteUser(user.id);
  });

  test("explicit requestedByUserId overrides parent inheritance", () => {
    const user1 = createUser({ name: "User1" });
    const user2 = createUser({ name: "User2" });
    const parent = createTaskExtended("parent", {
      agentId: leadAgent.id,
      source: "slack",
      requestedByUserId: user1.id,
    });
    const child = createTaskExtended("child", {
      agentId: workerAgent.id,
      source: "mcp",
      parentTaskId: parent.id,
      requestedByUserId: user2.id,
    });
    expect(getTaskById(child.id)!.requestedByUserId).toBe(user2.id);
    deleteUser(user1.id);
    deleteUser(user2.id);
  });

  test("task without requestedByUserId has undefined", () => {
    const task = createTaskExtended("no user task", {
      agentId: workerAgent.id,
      source: "mcp",
    });
    expect(getTaskById(task.id)!.requestedByUserId).toBeUndefined();
  });
});
