import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createSwarmRepo,
  deleteSwarmRepo,
  getSwarmRepoById,
  getSwarmRepoByName,
  getSwarmRepoByUrl,
  getSwarmRepos,
  initDb,
  updateSwarmRepo,
} from "../be/db";

const TEST_DB_PATH = "./test-swarm-repos.sqlite";

describe("Swarm Repos", () => {
  beforeAll(async () => {
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }

    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();

    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  describe("CRUD Operations", () => {
    test("should create a repo with defaults", () => {
      const repo = createSwarmRepo({
        url: "https://github.com/desplega-ai/agent-swarm",
        name: "agent-swarm",
      });

      expect(repo.id).toBeDefined();
      expect(repo.url).toBe("https://github.com/desplega-ai/agent-swarm");
      expect(repo.name).toBe("agent-swarm");
      expect(repo.clonePath).toBe("/workspace/repos/agent-swarm");
      expect(repo.defaultBranch).toBe("main");
      expect(repo.autoClone).toBe(true);
      expect(repo.createdAt).toBeDefined();
      expect(repo.lastUpdatedAt).toBeDefined();
    });

    test("should create a repo with custom clonePath", () => {
      const repo = createSwarmRepo({
        url: "https://github.com/desplega-ai/other-repo",
        name: "other-repo",
        clonePath: "/workspace/custom/other",
        defaultBranch: "develop",
        autoClone: false,
      });

      expect(repo.clonePath).toBe("/workspace/custom/other");
      expect(repo.defaultBranch).toBe("develop");
      expect(repo.autoClone).toBe(false);
    });

    test("should list repos", () => {
      const repos = getSwarmRepos();
      expect(repos.length).toBeGreaterThanOrEqual(2);
    });

    test("should filter repos by autoClone", () => {
      const autoCloneRepos = getSwarmRepos({ autoClone: true });
      expect(autoCloneRepos.every((r) => r.autoClone === true)).toBe(true);

      const noAutoCloneRepos = getSwarmRepos({ autoClone: false });
      expect(noAutoCloneRepos.every((r) => r.autoClone === false)).toBe(true);
    });

    test("should filter repos by name", () => {
      const repos = getSwarmRepos({ name: "agent-swarm" });
      expect(repos.length).toBe(1);
      expect(repos[0].name).toBe("agent-swarm");
    });

    test("should get repo by ID", () => {
      const all = getSwarmRepos();
      const repo = getSwarmRepoById(all[0].id);
      expect(repo).not.toBeNull();
      expect(repo?.id).toBe(all[0].id);
    });

    test("should get repo by name", () => {
      const repo = getSwarmRepoByName("agent-swarm");
      expect(repo).not.toBeNull();
      expect(repo?.name).toBe("agent-swarm");
    });

    test("should get repo by URL", () => {
      const repo = getSwarmRepoByUrl("https://github.com/desplega-ai/agent-swarm");
      expect(repo).not.toBeNull();
      expect(repo?.url).toBe("https://github.com/desplega-ai/agent-swarm");
    });

    test("should return null for non-existent repo", () => {
      expect(getSwarmRepoById("non-existent")).toBeNull();
      expect(getSwarmRepoByName("non-existent")).toBeNull();
      expect(getSwarmRepoByUrl("https://example.com/non-existent")).toBeNull();
    });

    test("should update repo fields", async () => {
      const repo = getSwarmRepoByName("agent-swarm");
      expect(repo).not.toBeNull();

      // Small delay to ensure different timestamp
      await Bun.sleep(10);

      const updated = updateSwarmRepo(repo!.id, {
        defaultBranch: "develop",
        autoClone: false,
      });

      expect(updated).not.toBeNull();
      expect(updated?.defaultBranch).toBe("develop");
      expect(updated?.autoClone).toBe(false);
      expect(updated?.lastUpdatedAt).not.toBe(repo?.lastUpdatedAt);
    });

    test("should update repo name and clonePath", () => {
      const repo = createSwarmRepo({
        url: "https://github.com/desplega-ai/temp-repo",
        name: "temp-repo",
      });

      const updated = updateSwarmRepo(repo.id, {
        name: "renamed-repo",
        clonePath: "/workspace/repos/renamed",
      });

      expect(updated?.name).toBe("renamed-repo");
      expect(updated?.clonePath).toBe("/workspace/repos/renamed");
    });

    test("should return unchanged repo when no updates", () => {
      const repo = getSwarmRepoByName("renamed-repo");
      const unchanged = updateSwarmRepo(repo!.id, {});
      expect(unchanged?.name).toBe("renamed-repo");
    });

    test("should delete a repo", () => {
      const repo = getSwarmRepoByName("renamed-repo");
      expect(repo).not.toBeNull();

      const deleted = deleteSwarmRepo(repo!.id);
      expect(deleted).toBe(true);

      expect(getSwarmRepoById(repo!.id)).toBeNull();
    });

    test("should return false when deleting non-existent repo", () => {
      expect(deleteSwarmRepo("non-existent")).toBe(false);
    });
  });

  describe("Guidelines", () => {
    test("should create a repo with guidelines", () => {
      const repo = createSwarmRepo({
        url: "https://github.com/desplega-ai/guidelines-repo",
        name: "guidelines-repo",
        guidelines: {
          prChecks: ["bun test", "bun run lint"],
          mergeChecks: ["all CI checks pass"],
          allowMerge: false,
          review: ["check README.md"],
        },
      });

      expect(repo.guidelines).not.toBeNull();
      expect(repo.guidelines?.prChecks).toEqual(["bun test", "bun run lint"]);
      expect(repo.guidelines?.mergeChecks).toEqual(["all CI checks pass"]);
      expect(repo.guidelines?.allowMerge).toBe(false);
      expect(repo.guidelines?.review).toEqual(["check README.md"]);
    });

    test("should return parsed guidelines (not raw string) from getSwarmRepoById", () => {
      const repo = getSwarmRepoByName("guidelines-repo");
      expect(repo).not.toBeNull();

      const fetched = getSwarmRepoById(repo!.id);
      expect(fetched).not.toBeNull();
      expect(typeof fetched?.guidelines).toBe("object");
      expect(Array.isArray(fetched?.guidelines?.prChecks)).toBe(true);
      expect(fetched?.guidelines?.prChecks).toEqual(["bun test", "bun run lint"]);
    });

    test("should create a repo without guidelines (null)", () => {
      const repo = createSwarmRepo({
        url: "https://github.com/desplega-ai/no-guidelines-repo",
        name: "no-guidelines-repo",
      });

      expect(repo.guidelines).toBeNull();
    });

    test("should update guidelines on a repo", () => {
      const repo = getSwarmRepoByName("no-guidelines-repo");
      expect(repo?.guidelines).toBeNull();

      const updated = updateSwarmRepo(repo!.id, {
        guidelines: {
          prChecks: ["npm test"],
          mergeChecks: [],
          allowMerge: true,
          review: [],
        },
      });

      expect(updated?.guidelines).not.toBeNull();
      expect(updated?.guidelines?.prChecks).toEqual(["npm test"]);
      expect(updated?.guidelines?.allowMerge).toBe(true);
    });

    test("should clear guidelines by setting to null", () => {
      const repo = getSwarmRepoByName("no-guidelines-repo");
      expect(repo?.guidelines).not.toBeNull();

      const updated = updateSwarmRepo(repo!.id, { guidelines: null });
      expect(updated?.guidelines).toBeNull();
    });

    test("should round-trip null vs configured distinction", () => {
      const withGuidelines = getSwarmRepoByName("guidelines-repo");
      const withoutGuidelines = getSwarmRepoByName("no-guidelines-repo");

      expect(withGuidelines?.guidelines).not.toBeNull();
      expect(withoutGuidelines?.guidelines).toBeNull();
    });
  });

  describe("Uniqueness Constraints", () => {
    test("should reject duplicate URL", () => {
      expect(() =>
        createSwarmRepo({
          url: "https://github.com/desplega-ai/agent-swarm",
          name: "agent-swarm-dupe",
        }),
      ).toThrow();
    });

    test("should reject duplicate name", () => {
      expect(() =>
        createSwarmRepo({
          url: "https://github.com/desplega-ai/unique-url",
          name: "agent-swarm",
        }),
      ).toThrow();
    });

    test("should reject duplicate clonePath", () => {
      expect(() =>
        createSwarmRepo({
          url: "https://github.com/desplega-ai/unique-url-2",
          name: "unique-name",
          clonePath: "/workspace/repos/agent-swarm",
        }),
      ).toThrow();
    });
  });
});
