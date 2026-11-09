/**
 * Sender trust for GitHub content events (mentions, comments, reviews).
 *
 * A lead task is created only when the sender is a linked swarm user, a login
 * in GITHUB_ALLOWED_SENDERS, or the content's author with an OWNER, MEMBER or
 * COLLABORATOR author_association. Anyone else is still recorded on the
 * unmapped tracker, but no task is created.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createUser, getDbClient, getKv, initDb } from "../be/db";
import { linkIdentity } from "../be/users";
import {
  handleComment,
  handleIssue,
  handlePullRequest,
  handlePullRequestReview,
} from "../github/handlers";
import { GITHUB_BOT_NAME } from "../github/mentions";
import type {
  CommentEvent,
  IssueEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
} from "../github/types";

mock.module("../github/app", () => ({
  getInstallationToken: async () => null,
  isReactionsEnabled: () => false,
  initGitHub: () => true,
  resetGitHub: () => {},
  getWebhookSecret: () => null,
  isGitHubEnabled: () => true,
  verifyWebhookSignature: async () => false,
}));

const TEST_DB_PATH = "./test-github-sender-trust.sqlite";
const UNMAPPED_NAMESPACE = "integration:unmapped:github";
const LEAD_ID = "lead-gh-sender-trust";
const EXTERNAL = "external-user";
const REPO = { full_name: "test/repo", html_url: "https://github.com/test/repo" };
const MENTION = `@${GITHUB_BOT_NAME} hello`;

beforeAll(async () => {
  for (const s of ["", "-wal", "-shm"]) await unlink(`${TEST_DB_PATH}${s}`).catch(() => {});
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "SenderTrustLead", status: "idle", isLead: true });
});

afterAll(async () => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) await unlink(`${TEST_DB_PATH}${s}`).catch(() => {});
});

beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM kv_entries WHERE namespace = ?", [UNMAPPED_NAMESPACE]);
  await client.run("DELETE FROM agent_tasks");
});

afterEach(() => {
  delete process.env.GITHUB_ALLOWED_SENDERS;
});

type TaskRow = { agentId: string | null; requestedByUserId: string | null };

async function tasksBy(login: string): Promise<TaskRow[]> {
  return getDbClient().query<TaskRow>(
    "SELECT agentId, requestedByUserId FROM agent_tasks WHERE vcsAuthor = ?",
    [login],
  );
}

let nextId = 9000;

function commentEvent(login: string, association?: string, author = login): CommentEvent {
  const id = nextId++;
  return {
    action: "created",
    comment: {
      id,
      body: MENTION,
      html_url: `https://github.com/test/repo/issues/10#issuecomment-${id}`,
      user: { login: author },
      author_association: association,
    },
    issue: { number: 10, title: "Issue", html_url: "https://github.com/test/repo/issues/10" },
    repository: REPO,
    sender: { login },
  };
}

function issueEvent(login: string, association?: string, author = login): IssueEvent {
  const number = nextId++;
  return {
    action: "opened",
    issue: {
      number,
      title: "Issue",
      body: MENTION,
      html_url: `https://github.com/test/repo/issues/${number}`,
      user: { login: author },
      author_association: association,
    },
    repository: REPO,
    sender: { login },
  };
}

function prEvent(login: string, association?: string): PullRequestEvent {
  const number = nextId++;
  return {
    action: "opened",
    pull_request: {
      number,
      title: "PR",
      body: MENTION,
      html_url: `https://github.com/test/repo/pull/${number}`,
      user: { login },
      author_association: association,
      head: { ref: "feature", sha: "0000000000000" },
      base: { ref: "main" },
      merged: false,
    },
    repository: REPO,
    sender: { login },
  };
}

function reviewEvent(login: string, association?: string): PullRequestReviewEvent {
  const number = nextId++;
  return {
    action: "submitted",
    review: {
      id: nextId++,
      body: "hello",
      state: "approved",
      html_url: `https://github.com/test/repo/pull/${number}#pullrequestreview-1`,
      user: { login },
      author_association: association,
      submitted_at: "2026-01-01T00:00:00Z",
    },
    pull_request: {
      number,
      title: "Bot PR",
      body: null,
      html_url: `https://github.com/test/repo/pull/${number}`,
      user: { login: GITHUB_BOT_NAME },
      head: { ref: "feature" },
      base: { ref: "main" },
    },
    repository: REPO,
    sender: { login },
  };
}

describe("unlinked sender without repo association creates no task", () => {
  test("issue comment mention", async () => {
    const res = await handleComment(commentEvent(EXTERNAL, "NONE"), "issue_comment");
    expect(res.created).toBe(false);
    expect(await tasksBy(EXTERNAL)).toHaveLength(0);
    // The sender is still recorded for operator triage.
    expect(await getKv(UNMAPPED_NAMESPACE, `${EXTERNAL}:meta`)).not.toBeNull();
  });

  test("issue opened with a mention", async () => {
    const res = await handleIssue(issueEvent(EXTERNAL, "NONE"));
    expect(res.created).toBe(false);
    expect(await tasksBy(EXTERNAL)).toHaveLength(0);
  });

  test("pull request opened with a mention", async () => {
    const res = await handlePullRequest(prEvent(EXTERNAL, "CONTRIBUTOR"));
    expect(res.created).toBe(false);
    expect(await tasksBy(EXTERNAL)).toHaveLength(0);
  });

  test("review on a bot-authored PR", async () => {
    const res = await handlePullRequestReview(reviewEvent(EXTERNAL, "NONE"));
    expect(res.created).toBe(false);
    expect(await tasksBy(EXTERNAL)).toHaveLength(0);
  });

  test("missing association", async () => {
    const res = await handleComment(commentEvent(EXTERNAL), "issue_comment");
    expect(res.created).toBe(false);
  });

  test("an association on content someone else wrote does not vouch for the sender", async () => {
    const res = await handleIssue(issueEvent(EXTERNAL, "OWNER", "repo-owner"));
    expect(res.created).toBe(false);
  });
});

describe("trusted senders still create a lead task", () => {
  test("linked swarm user with no association", async () => {
    const user = await createUser({ name: "Known Dev", email: "known@example.test" });
    await linkIdentity(user.id, "github", "known-dev", { kind: "system", id: "test:setup" });
    const res = await handleComment(commentEvent("known-dev", "NONE"), "issue_comment");
    const rows = await tasksBy("known-dev");
    expect(res.created).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe(LEAD_ID);
    expect(rows[0]?.requestedByUserId).toBe(user.id);
  });

  test.each(["OWNER", "MEMBER", "COLLABORATOR"])("%s association", async (association) => {
    const login = `assoc-${association.toLowerCase()}`;
    expect((await handleComment(commentEvent(login, association), "issue_comment")).created).toBe(
      true,
    );
    expect((await handleIssue(issueEvent(login, association))).created).toBe(true);
    expect((await handlePullRequest(prEvent(login, association))).created).toBe(true);
    expect((await handlePullRequestReview(reviewEvent(login, association))).created).toBe(true);
  });

  test("login listed in GITHUB_ALLOWED_SENDERS (case-insensitive)", async () => {
    process.env.GITHUB_ALLOWED_SENDERS = " someone-else , External-User ";
    const res = await handleComment(commentEvent(EXTERNAL, "NONE"), "issue_comment");
    expect(res.created).toBe(true);
    expect(await tasksBy(EXTERNAL)).toHaveLength(1);
  });
});
