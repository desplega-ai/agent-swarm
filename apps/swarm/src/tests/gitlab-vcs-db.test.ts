import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  findTaskByVcs,
  getTaskById,
  initDb,
} from "../be/db";

const TEST_DB_PATH = "./test-gitlab-vcs-db.sqlite";

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);

  createAgent({
    id: "vcs-lead-001",
    name: "VcsTestLead",
    status: "idle",
    isLead: true,
  });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

// ═══════════════════════════════════════════════════════
// VCS columns in agent_tasks
// ═══════════════════════════════════════════════════════

describe("VCS columns in tasks", () => {
  test("creates task with vcsProvider=github", () => {
    const task = createTaskExtended("GitHub task", {
      source: "github",
      vcsProvider: "github",
      vcsRepo: "org/repo",
      vcsEventType: "pull_request",
      vcsNumber: 42,
      vcsAuthor: "alice",
      vcsUrl: "https://github.com/org/repo/pull/42",
      agentId: "vcs-lead-001",
    });

    expect(task.vcsProvider).toBe("github");
    expect(task.vcsRepo).toBe("org/repo");
    expect(task.vcsNumber).toBe(42);

    const retrieved = getTaskById(task.id);
    expect(retrieved?.vcsProvider).toBe("github");
  });

  test("creates task with vcsProvider=gitlab", () => {
    const task = createTaskExtended("GitLab task", {
      source: "gitlab",
      vcsProvider: "gitlab",
      vcsRepo: "group/project",
      vcsEventType: "merge_request",
      vcsNumber: 10,
      vcsAuthor: "bob",
      vcsUrl: "https://gitlab.com/group/project/-/merge_requests/10",
      agentId: "vcs-lead-001",
    });

    expect(task.vcsProvider).toBe("gitlab");
    expect(task.vcsRepo).toBe("group/project");
    expect(task.vcsNumber).toBe(10);
  });

  test("creates task without vcsProvider (null)", () => {
    const task = createTaskExtended("Non-VCS task", {
      source: "mcp",
    });

    expect(task.vcsProvider).toBeUndefined();
    expect(task.vcsRepo).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// findTaskByVcs across providers
// ═══════════════════════════════════════════════════════

describe("findTaskByVcs", () => {
  test("finds github task by repo and number", () => {
    createTaskExtended("GH findable", {
      source: "github",
      vcsProvider: "github",
      vcsRepo: "findme/gh-repo",
      vcsNumber: 100,
      agentId: "vcs-lead-001",
    });

    const found = findTaskByVcs("findme/gh-repo", 100);
    expect(found).not.toBeNull();
    expect(found?.vcsProvider).toBe("github");
  });

  test("finds gitlab task by repo and number", () => {
    createTaskExtended("GL findable", {
      source: "gitlab",
      vcsProvider: "gitlab",
      vcsRepo: "findme/gl-project",
      vcsNumber: 200,
      agentId: "vcs-lead-001",
    });

    const found = findTaskByVcs("findme/gl-project", 200);
    expect(found).not.toBeNull();
    expect(found?.vcsProvider).toBe("gitlab");
  });

  test("does not find completed tasks", () => {
    const task = createTaskExtended("To be completed", {
      source: "gitlab",
      vcsProvider: "gitlab",
      vcsRepo: "findme/completed",
      vcsNumber: 300,
      agentId: "vcs-lead-001",
    });

    // Complete the task
    const db = require("../be/db");
    db.startTask(task.id);
    db.completeTask(task.id, "Done");

    const found = findTaskByVcs("findme/completed", 300);
    expect(found).toBeNull();
  });

  test("returns null for non-existent repo/number", () => {
    const found = findTaskByVcs("nonexistent/repo", 9999);
    expect(found).toBeNull();
  });
});
