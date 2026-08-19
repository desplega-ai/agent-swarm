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
        providerId: "url",
        providerKey: "https://github.com/desplega-ai/agent-swarm/pull/1200",
      },
      {
        name: "GitHub pull request #81",
        url: "https://github.com/desplega-ai/docs/pull/81",
        intent: "task-deliverable",
        providerId: "url",
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
});

describe("attachment-first task shipping evidence", () => {
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
});
