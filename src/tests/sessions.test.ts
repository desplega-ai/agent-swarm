import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getRootTaskChain,
  initDb,
  listRecentSessions,
} from "../be/db";

const TEST_DB_PATH = "./test-sessions.sqlite";

describe("sessions — getRootTaskChain + listRecentSessions", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("empty chain — no rows for non-existent root", () => {
    const chain = getRootTaskChain("nonexistent-root-id");
    expect(chain).toEqual([]);
  });

  test("single-root chain — chain length 1", () => {
    const agent = createAgent({
      id: "sessions-test-agent-1",
      name: "Sessions Test Agent 1",
      isLead: false,
      status: "idle",
    });
    const root = createTaskExtended("root only", { agentId: agent.id });

    const chain = getRootTaskChain(root.id);
    expect(chain).toHaveLength(1);
    expect(chain[0].id).toBe(root.id);
    expect(chain[0].parentTaskId).toBeUndefined();
  });

  test("3-level chain — root → child → grandchild", () => {
    const agent = createAgent({
      id: "sessions-test-agent-2",
      name: "Sessions Test Agent 2",
      isLead: false,
      status: "idle",
    });
    const root = createTaskExtended("root", { agentId: agent.id });
    const child = createTaskExtended("child", {
      agentId: agent.id,
      parentTaskId: root.id,
    });
    const grandchild = createTaskExtended("grandchild", {
      agentId: agent.id,
      parentTaskId: child.id,
    });

    const chain = getRootTaskChain(root.id);
    expect(chain).toHaveLength(3);

    // ordered by createdAt — root first, then child, then grandchild
    expect(chain.map((t) => t.id)).toEqual([root.id, child.id, grandchild.id]);
    expect(chain[0].parentTaskId).toBeUndefined();
    expect(chain[1].parentTaskId).toBe(root.id);
    expect(chain[2].parentTaskId).toBe(child.id);
  });

  test("parallel siblings — root with two children", () => {
    const agent = createAgent({
      id: "sessions-test-agent-3",
      name: "Sessions Test Agent 3",
      isLead: false,
      status: "idle",
    });
    const root = createTaskExtended("parallel root", { agentId: agent.id });
    const sibA = createTaskExtended("sibling A", {
      agentId: agent.id,
      parentTaskId: root.id,
    });
    const sibB = createTaskExtended("sibling B", {
      agentId: agent.id,
      parentTaskId: root.id,
    });

    const chain = getRootTaskChain(root.id);
    expect(chain).toHaveLength(3);
    expect(chain[0].id).toBe(root.id);
    // siblings appear in createdAt order (sibA before sibB)
    const ids = chain.map((t) => t.id);
    expect(ids.indexOf(sibA.id)).toBeLessThan(ids.indexOf(sibB.id));
  });

  test("listRecentSessions returns root tasks with chain summary", () => {
    const sessions = listRecentSessions({ limit: 50 });
    // We've created multiple roots above; each non-empty session must surface.
    expect(sessions.length).toBeGreaterThanOrEqual(3);

    for (const s of sessions) {
      // Root tasks only — never have parentTaskId
      expect(s.root.parentTaskId).toBeUndefined();
      expect(typeof s.chainTaskCount).toBe("number");
      expect(s.chainTaskCount).toBeGreaterThanOrEqual(1);
      expect(typeof s.lastActivityAt).toBe("string");
      expect(typeof s.latestStatus).toBe("string");
    }

    // The 3-level chain must report chainTaskCount of 3
    const threeLevel = sessions.find((s) => s.root.task === "root");
    expect(threeLevel).toBeDefined();
    expect(threeLevel?.chainTaskCount).toBe(3);

    // The parallel-root must report chainTaskCount of 3 (root + 2 siblings)
    const parallel = sessions.find((s) => s.root.task === "parallel root");
    expect(parallel).toBeDefined();
    expect(parallel?.chainTaskCount).toBe(3);

    // The single-root chain must report chainTaskCount of 1
    const single = sessions.find((s) => s.root.task === "root only");
    expect(single).toBeDefined();
    expect(single?.chainTaskCount).toBe(1);
  });

  test("listRecentSessions ordered by lastActivityAt DESC", () => {
    const sessions = listRecentSessions({ limit: 50 });
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i - 1].lastActivityAt >= sessions[i].lastActivityAt).toBe(true);
    }
  });

  test("listRecentSessions — requestedByUserId filter: positive / negative / NULL exclusion / compat", () => {
    const userA = createUser({ name: "Test User A" });
    const userB = createUser({ name: "Test User B" });

    const agent = createAgent({
      id: "sessions-test-agent-user-filter",
      name: "Sessions Test Agent UserFilter",
      isLead: false,
      status: "idle",
    });
    createTaskExtended("user-a session 1", {
      agentId: agent.id,
      requestedByUserId: userA.id,
    });
    createTaskExtended("user-a session 2", {
      agentId: agent.id,
      requestedByUserId: userA.id,
    });
    createTaskExtended("user-b session 1", {
      agentId: agent.id,
      requestedByUserId: userB.id,
    });

    // Positive: user A sees only their own sessions
    const aOnly = listRecentSessions({ limit: 50, requestedByUserId: userA.id });
    const aTasks = aOnly.map((s) => s.root.task);
    expect(aTasks).toContain("user-a session 1");
    expect(aTasks).toContain("user-a session 2");
    expect(aTasks).not.toContain("user-b session 1");
    for (const s of aOnly) {
      expect(s.root.requestedByUserId).toBe(userA.id);
    }

    // Negative: user A cannot see user B's sessions
    const hasUserBInA = aOnly.some((s) => s.root.requestedByUserId === userB.id);
    expect(hasUserBInA).toBe(false);

    // NULL exclusion: NULL requestedByUserId rows excluded when filter is active
    const hasNullInA = aOnly.some((s) => s.root.requestedByUserId == null);
    expect(hasNullInA).toBe(false);

    // Empty: unknown user ID returns empty list
    const nobody = listRecentSessions({ limit: 50, requestedByUserId: "non-existent-user-id" });
    expect(nobody).toHaveLength(0);

    // Compat: no filter returns all sessions including NULL rows and both users
    const all = listRecentSessions({ limit: 100 });
    expect(all.some((s) => s.root.requestedByUserId == null)).toBe(true);
    expect(all.some((s) => s.root.requestedByUserId === userA.id)).toBe(true);
    expect(all.some((s) => s.root.requestedByUserId === userB.id)).toBe(true);
  });
});
