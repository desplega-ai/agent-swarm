import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  closeDb,
  completeTask,
  createAgent,
  createTaskExtended,
  getDb,
  getTaskAttachments,
  initDb,
  insertTaskAttachment,
  startTask,
  updateTaskVcs,
} from "../be/db";
import { getTaskShippingEvidence, taskShippingEvidenceSql } from "../be/db-queries/task-artifacts";
import { extractGitHubPullRequestUrls } from "../utils/github-pull-request";

const TEST_DB_PATH = "./test-task-artifacts.sqlite";
let agentId: string;

const ECMASCRIPT_WHITESPACE_CODE_POINTS = [
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
  8202, 8232, 8233, 8239, 8287, 12288, 65279,
];

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(`${TEST_DB_PATH}${suffix}`).delete();
    } catch {}
  }
  initDb(TEST_DB_PATH);
  agentId = createAgent({ name: "Task artifact test agent", isLead: false, status: "idle" }).id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await Bun.file(`${TEST_DB_PATH}${suffix}`).delete();
    } catch {}
  }
});

function inProgressTask(name: string) {
  const task = createTaskExtended(name, { agentId, source: "api" });
  startTask(task.id);
  return task;
}

describe("GitHub pull-request extraction", () => {
  test("canonicalizes, deduplicates, and strips URL suffixes", () => {
    expect(
      extractGitHubPullRequestUrls(
        "See https://github.com/Owner/repo.name/pull/42/files and " +
          "https://github.com/Owner/repo.name/pull/42#discussion plus " +
          "github.com/other/repo/pull/7).",
      ),
    ).toEqual([
      {
        url: "https://github.com/Owner/repo.name/pull/42",
        owner: "Owner",
        repo: "repo.name",
        number: 42,
      },
      {
        url: "https://github.com/other/repo/pull/7",
        owner: "other",
        repo: "repo",
        number: 7,
      },
    ]);
    expect(extractGitHubPullRequestUrls("https://notgithub.com/o/r/pull/8")).toEqual([]);
  });

  test("requires GitHub to be the host or a bare token", () => {
    for (const fixture of [
      "https://evil.example/?next=github.com/o/r/pull/8",
      "xhttps://github.com/o/r/pull/1",
      "https://evil.example/github.com/o/r/pull/8",
      "https://github.com/o/r/pull/123.foo",
      "https://github.com/o/r/pull/123,abc",
      "https://github.com/o/./pull/1",
      "https://github.com/../r/pull/1",
    ]) {
      expect(extractGitHubPullRequestUrls(fixture)).toEqual([]);
    }
    for (const fixture of [
      "https://github.com/o/r/pull/8/files",
      "github.com/o/r/pull/8",
      "Shipped https://github.com/o/r/pull/8, with follow-up prose.",
    ]) {
      expect(extractGitHubPullRequestUrls(fixture)).toEqual([
        { url: "https://github.com/o/r/pull/8", owner: "o", repo: "r", number: 8 },
      ]);
    }
  });
});

describe("automatic task pull-request attachments", () => {
  test("records every PR from successful task completion", () => {
    const task = inProgressTask("completion records PRs");
    completeTask(
      task.id,
      "Shipped https://github.com/desplega-ai/agent-swarm/pull/1200 and " +
        "https://github.com/desplega-ai/docs/pull/81).",
    );

    expect(
      getTaskAttachments(task.id).map((attachment) => ({
        name: attachment.name,
        url: attachment.url,
        intent: attachment.intent,
        providerId: attachment.providerId,
        providerKey: attachment.providerKey,
      })),
    ).toEqual([
      {
        name: "GitHub pull request #1200",
        url: "https://github.com/desplega-ai/agent-swarm/pull/1200",
        intent: "task-deliverable",
        providerId: "github",
        providerKey: "https://github.com/desplega-ai/agent-swarm/pull/1200",
      },
      {
        name: "GitHub pull request #81",
        url: "https://github.com/desplega-ai/docs/pull/81",
        intent: "task-deliverable",
        providerId: "github",
        providerKey: "https://github.com/desplega-ai/docs/pull/81",
      },
    ]);
  });

  test("does not duplicate an existing URL attachment with a different name", () => {
    const task = inProgressTask("completion preserves caller attachment");
    const url = "http://GitHub.com/desplega-ai/agent-swarm/pull/1201/files";
    insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "Review this change",
      kind: "url",
      url,
      intent: "review",
    });

    completeTask(task.id, "Done: https://github.com/desplega-ai/agent-swarm/pull/1201");
    const attachments = getTaskAttachments(task.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toBe("Review this change");
  });

  test("records deterministic GitHub VCS discovery idempotently", () => {
    const task = createTaskExtended("VCS discovery records PR", { agentId, source: "api" });
    const vcs = {
      vcsProvider: "github" as const,
      vcsRepo: "desplega-ai/agent-swarm",
      vcsNumber: 1202,
      vcsUrl: "https://github.com/desplega-ai/agent-swarm/pull/1202",
    };
    updateTaskVcs(task.id, vcs);
    updateTaskVcs(task.id, vcs);

    const attachments = getTaskAttachments(task.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.url).toBe(vcs.vcsUrl);
  });

  test("reconciles generated VCS attachments while preserving caller-authored rows", () => {
    const task = createTaskExtended("VCS discovery replaces generated PR", {
      agentId,
      source: "api",
    });
    const callerUrl = "https://github.com/caller/owned/pull/77";
    insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "Caller-owned evidence",
      kind: "url",
      url: callerUrl,
      providerId: "github",
      intent: "task-deliverable",
      description: "Pull request shipped by this task",
    });

    updateTaskVcs(task.id, {
      vcsProvider: "github",
      vcsRepo: "owner/repo",
      vcsNumber: 1,
      vcsUrl: "https://github.com/owner/repo/pull/1",
    });
    updateTaskVcs(task.id, {
      vcsProvider: "github",
      vcsRepo: "owner/repo",
      vcsNumber: 2,
      vcsUrl: "https://github.com/owner/repo/pull/2",
    });

    expect(
      getTaskAttachments(task.id).map(({ name, url, providerId }) => ({ name, url, providerId })),
    ).toEqual([
      { name: "Caller-owned evidence", url: callerUrl, providerId: "github" },
      {
        name: "GitHub pull request #2",
        url: "https://github.com/owner/repo/pull/2",
        providerId: "github",
      },
    ]);

    updateTaskVcs(task.id, {
      vcsProvider: "gitlab",
      vcsRepo: "owner/repo",
      vcsNumber: 3,
      vcsUrl: "https://gitlab.com/owner/repo/-/merge_requests/3",
    });
    expect(getTaskAttachments(task.id).map(({ name, url }) => ({ name, url }))).toEqual([
      { name: "Caller-owned evidence", url: callerUrl },
    ]);
  });
});

describe("attachment-first task shipping evidence", () => {
  const pullRequestFixtures = [
    "https://github.com/desplega-ai/agent-swarm/pull/1207",
    "github.com/desplega-ai/docs/pull/9/files",
    "https://github.com/org/repo/tree/pull/123",
    "https://github.com/org/repo/issues/1/pull/2",
    "https://notgithub.com/o/r/pull/8",
    "https://_github.com/o/r/pull/8",
    "https://evil.example/github.com/o/r/pull/8",
    "https://evil.example/?next=github.com/o/r/pull/8",
    "xhttps://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/123abc",
    "https://github.com/o/r/pull/123.foo",
    "https://github.com/o/r/pull/123,abc",
    "https://github.com/o/./pull/1",
    "https://github.com/../r/pull/1",
    "https://github.com/o/r/pull/123/files",
    "https://github.com/o/r/pull/8/files",
    "github.com/o/r/pull/8",
    "https://github.com/o/r/pull/123.",
    "Reject https://github.com/org/repo/tree/pull/123, then accept github.com/o/r/pull/8",
    ...ECMASCRIPT_WHITESPACE_CODE_POINTS.map(
      (codePoint) => `done${String.fromCodePoint(codePoint)}https://github.com/o/r/pull/8`,
    ),
  ];

  test("falls back to legacy output even when a non-PR attachment exists", () => {
    const task = createTaskExtended("legacy output fallback", { agentId, source: "api" });
    insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "Notes",
      kind: "url",
      url: "https://example.com/notes",
    });
    getDb()
      .prepare("UPDATE agent_tasks SET output = ?, status = 'completed' WHERE id = ?")
      .run("Legacy https://github.com/desplega-ai/agent-swarm/pull/1203", task.id);

    expect(getTaskShippingEvidence(task.id)).toEqual({
      hasArtifact: true,
      hasPullRequest: true,
      pullRequestUrls: ["https://github.com/desplega-ai/agent-swarm/pull/1203"],
      pullRequestSource: "output-fallback",
    });
  });

  test("prefers attachment PR evidence over legacy output", () => {
    const task = createTaskExtended("attachment wins", { agentId, source: "api" });
    insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "Shipped PR",
      kind: "url",
      url: "https://github.com/desplega-ai/agent-swarm/pull/1204",
    });
    getDb()
      .prepare("UPDATE agent_tasks SET output = ? WHERE id = ?")
      .run("Old https://github.com/desplega-ai/agent-swarm/pull/999", task.id);

    expect(getTaskShippingEvidence(task.id)).toEqual({
      hasArtifact: true,
      hasPullRequest: true,
      pullRequestUrls: ["https://github.com/desplega-ai/agent-swarm/pull/1204"],
      pullRequestSource: "attachment",
    });
  });

  test("provides aggregate SQL predicates without multiplying task rows", () => {
    const task = createTaskExtended("aggregate predicates", { agentId, source: "api" });
    insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "First",
      kind: "url",
      url: "https://github.com/desplega-ai/agent-swarm/pull/1205",
    });
    insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "Second",
      kind: "url",
      url: "https://example.com/report",
    });
    const sql = taskShippingEvidenceSql("t");
    const row = getDb()
      .prepare<{ hasArtifact: number; hasPullRequest: number }, [string]>(
        `SELECT ${sql.hasArtifact} AS hasArtifact, ${sql.hasPullRequest} AS hasPullRequest
         FROM agent_tasks t WHERE t.id = ?`,
      )
      .get(task.id);
    expect(row).toEqual({ hasArtifact: 1, hasPullRequest: 1 });
    expect(() => taskShippingEvidenceSql("t; DROP TABLE agent_tasks")).toThrow(
      "Invalid task SQL alias",
    );
  });

  test("keeps aggregate and single-task evidence aligned for alternate URL forms", () => {
    const task = createTaskExtended("aggregate parity", { agentId, source: "api" });
    insertTaskAttachment({
      taskId: task.id,
      agentId,
      name: "Alternate PR URL",
      kind: "url",
      url: "http://GitHub.com/desplega-ai/agent-swarm/pull/1206/files",
    });
    const sql = taskShippingEvidenceSql("t");
    const row = getDb()
      .prepare<{ hasPullRequest: number }, [string]>(
        `SELECT ${sql.hasPullRequest} AS hasPullRequest FROM agent_tasks t WHERE t.id = ?`,
      )
      .get(task.id);

    expect(row?.hasPullRequest).toBe(1);
    expect(getTaskShippingEvidence(task.id)?.hasPullRequest).toBe(true);
  });

  test("rejects lookalike domains in both aggregate and single-task fallback evidence", () => {
    const task = createTaskExtended("fallback negative control", { agentId, source: "api" });
    getDb()
      .prepare("UPDATE agent_tasks SET output = ? WHERE id = ?")
      .run("Not a PR: https://notgithub.com/o/r/pull/8", task.id);
    const sql = taskShippingEvidenceSql("t");
    const row = getDb()
      .prepare<{ hasPullRequest: number }, [string]>(
        `SELECT ${sql.hasPullRequest} AS hasPullRequest FROM agent_tasks t WHERE t.id = ?`,
      )
      .get(task.id);

    expect(row?.hasPullRequest).toBe(0);
    expect(getTaskShippingEvidence(task.id)?.hasPullRequest).toBe(false);
  });

  test("keeps aggregate SQL and TypeScript extraction aligned for URL shapes", () => {
    const sql = taskShippingEvidenceSql("t");

    for (const evidenceSource of ["output", "attachment"] as const) {
      for (const fixture of pullRequestFixtures) {
        const task = createTaskExtended(`${evidenceSource} fixture: ${fixture}`, {
          agentId,
          source: "api",
        });
        if (evidenceSource === "output") {
          getDb().prepare("UPDATE agent_tasks SET output = ? WHERE id = ?").run(fixture, task.id);
        } else {
          insertTaskAttachment({
            taskId: task.id,
            agentId,
            name: "Fixture URL",
            kind: "url",
            url: fixture,
          });
        }
        const aggregate = getDb()
          .prepare<{ hasPullRequest: number }, [string]>(
            `SELECT ${sql.hasPullRequest} AS hasPullRequest FROM agent_tasks t WHERE t.id = ?`,
          )
          .get(task.id);
        const expected = extractGitHubPullRequestUrls(fixture).length > 0;

        expect(Boolean(aggregate?.hasPullRequest)).toBe(expected);
        expect(getTaskShippingEvidence(task.id)?.hasPullRequest).toBe(expected);
      }
    }
  });
});
