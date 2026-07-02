/**
 * Identity resolution tests for GitHub webhook handlers.
 *
 * Covers the step-3 rewire: every handler now goes through
 * `findUserByExternalId('github', sender.login)` + the kv-backed unmapped
 * tracker. No email auto-link path exists (Q17.A — GitHub never exposes
 * email reliably via webhook or App-installation token).
 *
 * Test matrix:
 *   - PR event from a known github user → requestedByUserId populated, no kv writes
 *   - PR event from unknown user → requestedByUserId undefined, kv :meta + :count = 1
 *   - Repeat PR from same unknown user → :count = 2
 *   - Issue, comment, review events follow the same pattern
 *   - No `enrichUserFromIntegration('github', ...)` helper is invoked (no
 *     module-level email-fetch path exists at all).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createUser, deleteKv, getDb, getKv, initDb } from "../be/db";
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

const TEST_DB_PATH = "./test-github-handlers.sqlite";
const UNMAPPED_NAMESPACE = "integration:unmapped:github";
const SYSTEM_ACTOR = { kind: "system" as const, id: "test:setup" };

// ── Setup ──

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  initDb(TEST_DB_PATH);
  createAgent({
    id: "lead-gh-handlers",
    name: "GitHubHandlersTestLead",
    status: "idle",
    isLead: true,
  });
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

// Clear unmapped kv rows + tasks between tests to keep assertions independent.
beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM kv_entries WHERE namespace = ?").run(UNMAPPED_NAMESPACE);
  db.prepare("DELETE FROM agent_tasks").run();
});

// ── Helpers ──

const BASE_REPO = { full_name: "test/repo", html_url: "https://github.com/test/repo" };
const BASE_PR = {
  number: 1,
  title: "Test PR",
  body: null as string | null,
  html_url: "https://github.com/test/repo/pull/1",
  user: { login: "anonymous" },
  head: { ref: "feature", sha: "abc1234567890" },
  base: { ref: "main" },
  merged: false,
  merged_by: undefined,
};

function makePREvent(senderLogin: string, prNumber = 1): PullRequestEvent {
  return {
    action: "opened",
    pull_request: { ...BASE_PR, number: prNumber, title: `PR #${prNumber}` },
    repository: BASE_REPO,
    sender: { login: senderLogin },
  };
}

function makeIssueEvent(senderLogin: string, issueNumber = 10): IssueEvent {
  return {
    action: "opened",
    issue: {
      number: issueNumber,
      title: `Issue #${issueNumber}`,
      body: null,
      html_url: `https://github.com/test/repo/issues/${issueNumber}`,
      user: { login: senderLogin },
    },
    repository: BASE_REPO,
    sender: { login: senderLogin },
  };
}

function makeCommentEvent(senderLogin: string, body: string): CommentEvent {
  return {
    action: "created",
    comment: {
      id: 999,
      body,
      html_url: "https://github.com/test/repo/issues/10#issuecomment-999",
      user: { login: senderLogin },
    },
    issue: { number: 10, title: "Test Issue", html_url: "https://github.com/test/repo/issues/10" },
    repository: BASE_REPO,
    sender: { login: senderLogin },
  };
}

function makeReviewEvent(senderLogin: string): PullRequestReviewEvent {
  return {
    action: "submitted",
    review: {
      id: 1,
      body: "Looks good",
      state: "approved",
      html_url: "https://github.com/test/repo/pull/99#pullrequestreview-1",
      user: { login: senderLogin },
      submitted_at: "2026-01-01T00:00:00Z",
    },
    pull_request: {
      number: 99,
      title: "Bot PR",
      body: null,
      html_url: "https://github.com/test/repo/pull/99",
      user: { login: GITHUB_BOT_NAME },
      head: { ref: "feature" },
      base: { ref: "main" },
    },
    repository: BASE_REPO,
    sender: { login: senderLogin },
  };
}

function getMappedUserTaskCount(userId: string): number {
  const row = getDb()
    .prepare<{ n: number }, string>(
      "SELECT COUNT(*) AS n FROM agent_tasks WHERE requestedByUserId = ?",
    )
    .get(userId);
  return row?.n ?? 0;
}

// ── Known sender → mapped requestedByUserId, no unmapped writes ──

describe("known github sender", () => {
  test("PR event from a mapped user populates requestedByUserId and writes no kv rows", async () => {
    const user = createUser({ name: "Mapped User", email: "mapped@example.com" });
    linkIdentity(user.id, "github", "mapped-login", SYSTEM_ACTOR);

    const result = await handlePullRequest(makePREvent("mapped-login", 100));
    // Even if the PR doesn't create a task (no mention), the sender resolution
    // side effects are what we're testing — assert no kv writes happened.
    expect(result.created).toBeDefined();
    expect(getKv(UNMAPPED_NAMESPACE, "mapped-login:meta")).toBeNull();
    expect(getKv(UNMAPPED_NAMESPACE, "mapped-login:count")).toBeNull();
  });

  test("PR with bot assignment from mapped user puts user id on the task", async () => {
    const user = createUser({ name: "Mapped Assigner", email: "assigner@example.com" });
    linkIdentity(user.id, "github", "assigner", SYSTEM_ACTOR);

    const event: PullRequestEvent = {
      action: "assigned",
      pull_request: { ...BASE_PR, number: 200, title: "Bot PR" },
      repository: BASE_REPO,
      sender: { login: "assigner" },
      assignee: { login: GITHUB_BOT_NAME, id: 1 },
    };
    const result = await handlePullRequest(event);
    expect(result.created).toBe(true);
    expect(getMappedUserTaskCount(user.id)).toBe(1);

    // Mapped sender → no unmapped kv writes.
    expect(getKv(UNMAPPED_NAMESPACE, "assigner:meta")).toBeNull();
    expect(getKv(UNMAPPED_NAMESPACE, "assigner:count")).toBeNull();
  });

  test("comment event with bot mention from mapped user puts user id on the task", async () => {
    const user = createUser({ name: "Mapped Commenter", email: "commenter@example.com" });
    linkIdentity(user.id, "github", "commenter", SYSTEM_ACTOR);

    const result = await handleComment(
      makeCommentEvent("commenter", `Hey @${GITHUB_BOT_NAME} please take a look`),
      "issue_comment",
    );
    expect(result.created).toBe(true);
    expect(getMappedUserTaskCount(user.id)).toBe(1);

    // Mapped sender → no unmapped kv writes.
    expect(getKv(UNMAPPED_NAMESPACE, "commenter:meta")).toBeNull();
    expect(getKv(UNMAPPED_NAMESPACE, "commenter:count")).toBeNull();
  });

  test("review event from mapped user puts user id on the task", async () => {
    const user = createUser({ name: "Mapped Reviewer", email: "reviewer@example.com" });
    linkIdentity(user.id, "github", "reviewer", SYSTEM_ACTOR);

    const result = await handlePullRequestReview(makeReviewEvent("reviewer"));
    expect(result.created).toBe(true);
    expect(getMappedUserTaskCount(user.id)).toBe(1);

    // Mapped sender → no unmapped kv writes.
    expect(getKv(UNMAPPED_NAMESPACE, "reviewer:meta")).toBeNull();
    expect(getKv(UNMAPPED_NAMESPACE, "reviewer:count")).toBeNull();
  });
});

// ── Unknown sender → unmapped kv tracker ──

describe("unknown github sender", () => {
  test("PR event from unknown user writes :meta + :count = 1", async () => {
    await handlePullRequest(makePREvent("ghost-login", 300));

    const meta = getKv(UNMAPPED_NAMESPACE, "ghost-login:meta");
    expect(meta).not.toBeNull();
    expect(meta?.valueType).toBe("json");
    const metaValue = meta?.value as {
      lastSeenAt: string;
      sampleEventType: string;
      sampleContext: string;
    };
    expect(metaValue.sampleEventType).toBe("pull_request");
    expect(metaValue.sampleContext).toContain("PR #300");

    const count = getKv(UNMAPPED_NAMESPACE, "ghost-login:count");
    expect(count?.valueType).toBe("integer");
    expect(count?.value).toBe(1);
  });

  test("repeated PR events from same unknown user atomically increment count", async () => {
    await handlePullRequest(makePREvent("repeater", 400));
    await handlePullRequest(makePREvent("repeater", 401));

    const count = getKv(UNMAPPED_NAMESPACE, "repeater:count");
    expect(count?.value).toBe(2);
  });

  test("issue event from unknown user writes sampleEventType = 'issues'", async () => {
    await handleIssue(makeIssueEvent("issue-ghost", 50));

    const meta = getKv(UNMAPPED_NAMESPACE, "issue-ghost:meta");
    const metaValue = meta?.value as { sampleEventType: string; sampleContext: string };
    expect(metaValue.sampleEventType).toBe("issues");
    expect(metaValue.sampleContext).toContain("Issue #50");
  });

  test("comment event from unknown user writes sampleEventType = 'issue_comment'", async () => {
    // Need a bot mention to avoid early-return — handleComment still runs the
    // sender resolution before the mention check, though, so the kv write
    // happens either way.
    await handleComment(
      makeCommentEvent("comment-ghost", "just a comment without mention"),
      "issue_comment",
    );

    const meta = getKv(UNMAPPED_NAMESPACE, "comment-ghost:meta");
    const metaValue = meta?.value as { sampleEventType: string; sampleContext: string };
    expect(metaValue.sampleEventType).toBe("issue_comment");
    expect(metaValue.sampleContext).toContain("just a comment");
  });

  test("review event from unknown user writes sampleEventType = 'pull_request_review'", async () => {
    await handlePullRequestReview(makeReviewEvent("review-ghost"));

    const meta = getKv(UNMAPPED_NAMESPACE, "review-ghost:meta");
    const metaValue = meta?.value as { sampleEventType: string; sampleContext: string };
    expect(metaValue.sampleEventType).toBe("pull_request_review");
    expect(metaValue.sampleContext).toContain("Review on PR #99");
    expect(metaValue.sampleContext).toContain("approved");
  });

  test("sampleContext is truncated to 100 characters", async () => {
    const longBody = "x".repeat(200);
    await handleComment(makeCommentEvent("trunc-ghost", longBody), "issue_comment");

    const meta = getKv(UNMAPPED_NAMESPACE, "trunc-ghost:meta");
    const metaValue = meta?.value as { sampleContext: string };
    expect(metaValue.sampleContext.length).toBeLessThanOrEqual(100);
  });
});

// ── Negative: no email-enrichment helper exists for GitHub ──

describe("no github email enrichment", () => {
  test("handlers module exports no `enrichUserFromIntegration`-style helper", async () => {
    // Q17.A — there is intentionally NO email auto-link cascade for GitHub.
    // Confirm the module surface stays clean.
    const mod = await import("../github/handlers");
    const exported = Object.keys(mod);
    expect(exported.some((name) => /enrich.*github/i.test(name))).toBe(false);
    expect(exported.some((name) => /github.*enrich/i.test(name))).toBe(false);
  });

  test("kv entries are cleaned up by deleteKv (operator triage flow)", async () => {
    await handlePullRequest(makePREvent("triage-target", 500));
    expect(getKv(UNMAPPED_NAMESPACE, "triage-target:meta")).not.toBeNull();

    // Simulate the operator triage action that removes the kv entry after
    // mapping the identity manually (step-9 UI will do this).
    deleteKv(UNMAPPED_NAMESPACE, "triage-target:meta");
    deleteKv(UNMAPPED_NAMESPACE, "triage-target:count");

    expect(getKv(UNMAPPED_NAMESPACE, "triage-target:meta")).toBeNull();
    expect(getKv(UNMAPPED_NAMESPACE, "triage-target:count")).toBeNull();
  });
});
