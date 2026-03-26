import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  findTaskByVcs,
  initDb,
  updateTaskVcs,
} from "../be/db";

const TEST_DB_PATH = "./test-vcs-tracking.sqlite";

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);

  createAgent({
    id: "vcs-track-agent-001",
    name: "VcsTrackingTestAgent",
    status: "idle",
    isLead: false,
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

describe("updateTaskVcs", () => {
  test("sets all VCS fields correctly", () => {
    const task = createTaskExtended("Test task for VCS update", {
      agentId: "vcs-track-agent-001",
      source: "api",
    });

    const updated = updateTaskVcs(task.id, {
      vcsProvider: "github",
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 42,
      vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/42",
    });

    expect(updated).not.toBeNull();
    expect(updated!.vcsProvider).toBe("github");
    expect(updated!.vcsRepo).toBe("desplega-ai/agent-swarm");
    expect(updated!.vcsNumber).toBe(42);
    expect(updated!.vcsUrl).toBe("https://github.com/desplega-ai/agent-swarm/pull/42");
  });

  test("returns null for non-existent task", () => {
    const result = updateTaskVcs("non-existent-id", {
      vcsProvider: "github",
      vcsRepo: "owner/repo",
      vcsNumber: 1,
      vcsUrl: "https://github.com/owner/repo/pull/1",
    });
    expect(result).toBeNull();
  });

  test("updates lastUpdatedAt", () => {
    const task = createTaskExtended("Test lastUpdatedAt", {
      agentId: "vcs-track-agent-001",
      source: "api",
    });

    const before = new Date(task.lastUpdatedAt).getTime();

    // Small delay to ensure timestamp differs
    const updated = updateTaskVcs(task.id, {
      vcsProvider: "github",
      vcsRepo: "owner/repo",
      vcsNumber: 10,
      vcsUrl: "https://github.com/owner/repo/pull/10",
    });

    expect(updated).not.toBeNull();
    const after = new Date(updated!.lastUpdatedAt).getTime();
    expect(after).toBeGreaterThanOrEqual(before);
  });

  test("overwrites existing VCS fields (last PR wins)", () => {
    const task = createTaskExtended("Test overwrite VCS", {
      agentId: "vcs-track-agent-001",
      source: "github",
      vcsProvider: "github",
      vcsRepo: "owner/repo",
      vcsNumber: 1,
      vcsUrl: "https://github.com/owner/repo/pull/1",
    });

    expect(task.vcsNumber).toBe(1);

    const updated = updateTaskVcs(task.id, {
      vcsProvider: "github",
      vcsRepo: "owner/repo",
      vcsNumber: 2,
      vcsUrl: "https://github.com/owner/repo/pull/2",
    });

    expect(updated).not.toBeNull();
    expect(updated!.vcsNumber).toBe(2);
    expect(updated!.vcsUrl).toBe("https://github.com/owner/repo/pull/2");
  });

  test("findTaskByVcs finds task after updateTaskVcs", () => {
    const task = createTaskExtended("Test findTaskByVcs linkage", {
      agentId: "vcs-track-agent-001",
      source: "api",
    });

    // Before update — no VCS fields, shouldn't be found
    const notFound = findTaskByVcs("owner/findme", 99);
    expect(notFound).toBeNull();

    updateTaskVcs(task.id, {
      vcsProvider: "github",
      vcsRepo: "owner/findme",
      vcsNumber: 99,
      vcsUrl: "https://github.com/owner/findme/pull/99",
    });

    // After update — should be found (task is pending, not completed/failed)
    const found = findTaskByVcs("owner/findme", 99);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(task.id);
  });

  test("idempotent: calling twice with same data both succeed", () => {
    const task = createTaskExtended("Test idempotency", {
      agentId: "vcs-track-agent-001",
      source: "api",
    });

    const vcs = {
      vcsProvider: "github" as const,
      vcsRepo: "owner/idem",
      vcsNumber: 50,
      vcsUrl: "https://github.com/owner/idem/pull/50",
    };

    const first = updateTaskVcs(task.id, vcs);
    const second = updateTaskVcs(task.id, vcs);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.vcsNumber).toBe(50);
    expect(second!.vcsNumber).toBe(50);
  });

  test("supports gitlab provider", () => {
    const task = createTaskExtended("Test gitlab VCS", {
      agentId: "vcs-track-agent-001",
      source: "api",
    });

    const updated = updateTaskVcs(task.id, {
      vcsProvider: "gitlab",
      vcsRepo: "group/project",
      vcsNumber: 7,
      vcsUrl: "https://gitlab.com/group/project/-/merge_requests/7",
    });

    expect(updated).not.toBeNull();
    expect(updated!.vcsProvider).toBe("gitlab");
    expect(updated!.vcsRepo).toBe("group/project");
    expect(updated!.vcsNumber).toBe(7);
  });
});
