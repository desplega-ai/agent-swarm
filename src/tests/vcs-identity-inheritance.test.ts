import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { closeDb, createTaskExtended, initDb } from "../be/db";

const TEST_DB_PATH = "./test-vcs-identity-inheritance.sqlite";

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(() => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(`${TEST_DB_PATH}${suffix}`);
    } catch {
      // ignore if the file does not exist
    }
  }
});

async function createGithubPrParent() {
  return createTaskExtended("GitHub comment on landing PR", {
    source: "github",
    vcsProvider: "github",
    vcsRepo: "acme/landing",
    vcsNumber: 271,
    vcsEventType: "issue_comment",
    vcsCommentId: 9001,
    vcsAuthor: "octocat",
    vcsUrl: "https://github.com/acme/landing/pull/271",
    vcsInstallationId: 42,
    vcsNodeId: "PR_node_271",
  });
}

describe("createTaskExtended: VCS identity is inherited as a unit", () => {
  test("child with a different vcsRepo inherits none of the parent's vcs fields", async () => {
    const parent = await createGithubPrParent();
    const child = await createTaskExtended("fix a docs page in another repo", {
      parentTaskId: parent.id,
      vcsRepo: "acme/platform",
    });

    expect(child.vcsRepo).toBe("acme/platform");
    expect(child.vcsNumber).toBeUndefined();
    expect(child.vcsUrl).toBeUndefined();
    expect(child.vcsProvider).toBeUndefined();
    expect(child.vcsEventType).toBeUndefined();
    expect(child.vcsCommentId).toBeUndefined();
    expect(child.vcsAuthor).toBeUndefined();
    expect(child.vcsInstallationId).toBeUndefined();
    expect(child.vcsNodeId).toBeUndefined();
  });

  test("child with no vcsRepo inherits the parent's full vcs identity", async () => {
    const parent = await createGithubPrParent();
    const child = await createTaskExtended("resume the parent's work", {
      parentTaskId: parent.id,
    });

    expect(child.vcsProvider).toBe("github");
    expect(child.vcsRepo).toBe("acme/landing");
    expect(child.vcsNumber).toBe(271);
    expect(child.vcsEventType).toBe("issue_comment");
    expect(child.vcsCommentId).toBe(9001);
    expect(child.vcsAuthor).toBe("octocat");
    expect(child.vcsUrl).toBe("https://github.com/acme/landing/pull/271");
    expect(child.vcsInstallationId).toBe(42);
    expect(child.vcsNodeId).toBe("PR_node_271");
  });

  test("child naming the parent's repo (case-insensitive) still fills in the rest", async () => {
    const parent = await createGithubPrParent();
    const child = await createTaskExtended("follow-up on the same PR", {
      parentTaskId: parent.id,
      vcsRepo: "ACME/Landing",
    });

    expect(child.vcsRepo).toBe("ACME/Landing");
    expect(child.vcsProvider).toBe("github");
    expect(child.vcsNumber).toBe(271);
    expect(child.vcsUrl).toBe("https://github.com/acme/landing/pull/271");
  });
});
