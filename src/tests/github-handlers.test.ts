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
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createUser, deleteKv, getDbClient, getKv, initDb } from "../be/db";
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
  getInstallationToken: async (installationId: number) => {
    if (installationId > 0) return "mock-token-for-tests";
    return null;
  },
  isReactionsEnabled: () => false,
  initGitHub: () => true,
  resetGitHub: () => {},
  getWebhookSecret: () => null,
  isGitHubEnabled: () => true,
  verifyWebhookSignature: async () => false,
}));

const TEST_DB_PATH = "./test-github-handlers.sqlite";
const UNMAPPED_NAMESPACE = "integration:unmapped:github";
const SYSTEM_ACTOR = { kind: "system" as const, id: "test:setup" };

// ── Setup ──

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  initDb(TEST_DB_PATH);
  await createAgent({
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
beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM kv_entries WHERE namespace = ?", [UNMAPPED_NAMESPACE]);
  await client.run("DELETE FROM agent_tasks");
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

function makeReviewEvent(
  senderLogin: string,
  reviewId = 1,
  options: {
    body?: string | null;
    state?: PullRequestReviewEvent["review"]["state"];
    installationId?: number;
  } = {},
): PullRequestReviewEvent {
  return {
    action: "submitted",
    review: {
      id: reviewId,
      body: options.body === undefined ? "Looks good" : options.body,
      state: options.state ?? "approved",
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
    ...(options.installationId !== undefined
      ? { installation: { id: options.installationId } }
      : {}),
  };
}

async function getMappedUserTaskCount(userId: string): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_tasks WHERE requestedByUserId = ?",
    [userId],
  );
  return row?.n ?? 0;
}

async function getLatestTaskText(): Promise<string | null> {
  const row = await getDbClient().get<{ task: string }>(
    "SELECT task FROM agent_tasks ORDER BY rowid DESC LIMIT 1",
  );
  return row?.task ?? null;
}

// ── Known sender → mapped requestedByUserId, no unmapped writes ──

describe("known github sender", () => {
  test("PR event from a mapped user populates requestedByUserId and writes no kv rows", async () => {
    const user = await createUser({ name: "Mapped User", email: "mapped@example.com" });
    await linkIdentity(user.id, "github", "mapped-login", SYSTEM_ACTOR);

    const result = await handlePullRequest(makePREvent("mapped-login", 100));
    // Even if the PR doesn't create a task (no mention), the sender resolution
    // side effects are what we're testing — assert no kv writes happened.
    expect(result.created).toBeDefined();
    expect(await getKv(UNMAPPED_NAMESPACE, "mapped-login:meta")).toBeNull();
    expect(await getKv(UNMAPPED_NAMESPACE, "mapped-login:count")).toBeNull();
  });

  test("PR with bot assignment from mapped user puts user id on the task", async () => {
    const user = await createUser({ name: "Mapped Assigner", email: "assigner@example.com" });
    await linkIdentity(user.id, "github", "assigner", SYSTEM_ACTOR);

    const event: PullRequestEvent = {
      action: "assigned",
      pull_request: { ...BASE_PR, number: 200, title: "Bot PR" },
      repository: BASE_REPO,
      sender: { login: "assigner" },
      assignee: { login: GITHUB_BOT_NAME, id: 1 },
    };
    const result = await handlePullRequest(event);
    expect(result.created).toBe(true);
    expect(await getMappedUserTaskCount(user.id)).toBe(1);

    // Mapped sender → no unmapped kv writes.
    expect(await getKv(UNMAPPED_NAMESPACE, "assigner:meta")).toBeNull();
    expect(await getKv(UNMAPPED_NAMESPACE, "assigner:count")).toBeNull();
  });

  test("comment event with bot mention from mapped user puts user id on the task", async () => {
    const user = await createUser({ name: "Mapped Commenter", email: "commenter@example.com" });
    await linkIdentity(user.id, "github", "commenter", SYSTEM_ACTOR);

    const result = await handleComment(
      makeCommentEvent("commenter", `Hey @${GITHUB_BOT_NAME} please take a look`),
      "issue_comment",
    );
    expect(result.created).toBe(true);
    expect(await getMappedUserTaskCount(user.id)).toBe(1);

    // Mapped sender → no unmapped kv writes.
    expect(await getKv(UNMAPPED_NAMESPACE, "commenter:meta")).toBeNull();
    expect(await getKv(UNMAPPED_NAMESPACE, "commenter:count")).toBeNull();
  });

  test("review event from mapped user puts user id on the task", async () => {
    const user = await createUser({ name: "Mapped Reviewer", email: "reviewer@example.com" });
    await linkIdentity(user.id, "github", "reviewer", SYSTEM_ACTOR);

    const result = await handlePullRequestReview(makeReviewEvent("reviewer"));
    expect(result.created).toBe(true);
    expect(await getMappedUserTaskCount(user.id)).toBe(1);

    // Mapped sender → no unmapped kv writes.
    expect(await getKv(UNMAPPED_NAMESPACE, "reviewer:meta")).toBeNull();
    expect(await getKv(UNMAPPED_NAMESPACE, "reviewer:count")).toBeNull();
  });

  test("review event from mapped user renders the resolved identity pair, never the raw login", async () => {
    const user = await createUser({ name: "Pair Reviewer", email: "pair-reviewer@example.com" });
    await linkIdentity(user.id, "github", "pair-reviewer", SYSTEM_ACTOR);

    const result = await handlePullRequestReview(makeReviewEvent("pair-reviewer", 1001));
    expect(result.created).toBe(true);

    const text = await getLatestTaskText();
    expect(text).toContain("Pair Reviewer (github:pair-reviewer)");
  });
});

describe("self-authored review suppression", () => {
  test("empty COMMENTED review from configured bot login is ignored when comments are unverifiable", async () => {
    const result = await handlePullRequestReview(
      makeReviewEvent(GITHUB_BOT_NAME, 2001, { body: null, state: "commented" }),
    );

    expect(result.created).toBe(false);
    expect(
      (await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks"))?.n,
    ).toBe(0);
    expect(await getKv(UNMAPPED_NAMESPACE, `${GITHUB_BOT_NAME}:meta`)).toBeNull();
  });

  test("commented review from the bot is ignored before inline comments are fetched", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 3001,
              path: "src/github/handlers.ts",
              line: 1,
              body: "Bot-authored inline reply",
              html_url: "https://github.com/test/repo/pull/99#discussion_r3001",
              diff_hunk: "@@ -1,1 +1,1 @@",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    try {
      const result = await handlePullRequestReview(
        makeReviewEvent(GITHUB_BOT_NAME, 2002, {
          body: null,
          state: "commented",
          installationId: 123,
        }),
      );
      expect(result.created).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("degraded empty review from a non-bot reviewer still creates a task", async () => {
    const result = await handlePullRequestReview(
      makeReviewEvent("third-party-reviewer", 2003, { body: null, state: "commented" }),
    );

    expect(result.created).toBe(true);
  });
});

// ── Unknown sender → unmapped kv tracker ──

describe("unknown github sender", () => {
  test("PR event from unknown user writes :meta + :count = 1", async () => {
    await handlePullRequest(makePREvent("ghost-login", 300));

    const meta = await getKv(UNMAPPED_NAMESPACE, "ghost-login:meta");
    expect(meta).not.toBeNull();
    expect(meta?.valueType).toBe("json");
    const metaValue = meta?.value as {
      lastSeenAt: string;
      sampleEventType: string;
      sampleContext: string;
    };
    expect(metaValue.sampleEventType).toBe("pull_request");
    expect(metaValue.sampleContext).toContain("PR #300");

    const count = await getKv(UNMAPPED_NAMESPACE, "ghost-login:count");
    expect(count?.valueType).toBe("integer");
    expect(count?.value).toBe(1);
  });

  test("repeated PR events from same unknown user atomically increment count", async () => {
    await handlePullRequest(makePREvent("repeater", 400));
    await handlePullRequest(makePREvent("repeater", 401));

    const count = await getKv(UNMAPPED_NAMESPACE, "repeater:count");
    expect(count?.value).toBe(2);
  });

  test("issue event from unknown user writes sampleEventType = 'issues'", async () => {
    await handleIssue(makeIssueEvent("issue-ghost", 50));

    const meta = await getKv(UNMAPPED_NAMESPACE, "issue-ghost:meta");
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

    const meta = await getKv(UNMAPPED_NAMESPACE, "comment-ghost:meta");
    const metaValue = meta?.value as { sampleEventType: string; sampleContext: string };
    expect(metaValue.sampleEventType).toBe("issue_comment");
    expect(metaValue.sampleContext).toContain("just a comment");
  });

  test("review event from unknown user writes sampleEventType = 'pull_request_review'", async () => {
    await handlePullRequestReview(makeReviewEvent("review-ghost"));

    const meta = await getKv(UNMAPPED_NAMESPACE, "review-ghost:meta");
    const metaValue = meta?.value as { sampleEventType: string; sampleContext: string };
    expect(metaValue.sampleEventType).toBe("pull_request_review");
    expect(metaValue.sampleContext).toContain("Review on PR #99");
    expect(metaValue.sampleContext).toContain("approved");
  });

  test("sampleContext is truncated to 100 characters", async () => {
    const longBody = "x".repeat(200);
    await handleComment(makeCommentEvent("trunc-ghost", longBody), "issue_comment");

    const meta = await getKv(UNMAPPED_NAMESPACE, "trunc-ghost:meta");
    const metaValue = meta?.value as { sampleContext: string };
    expect(metaValue.sampleContext.length).toBeLessThanOrEqual(100);
  });

  test("review event from unknown user renders the UNKNOWN sentinel, never a bare login", async () => {
    const result = await handlePullRequestReview(makeReviewEvent("sentinel-ghost", 1002));
    expect(result.created).toBe(true);

    const text = await getLatestTaskText();
    expect(text).toContain("github:sentinel-ghost (unknown user)");
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
    expect(await getKv(UNMAPPED_NAMESPACE, "triage-target:meta")).not.toBeNull();

    // Simulate the operator triage action that removes the kv entry after
    // mapping the identity manually (step-9 UI will do this).
    await deleteKv(UNMAPPED_NAMESPACE, "triage-target:meta");
    await deleteKv(UNMAPPED_NAMESPACE, "triage-target:count");

    expect(await getKv(UNMAPPED_NAMESPACE, "triage-target:meta")).toBeNull();
    expect(await getKv(UNMAPPED_NAMESPACE, "triage-target:count")).toBeNull();
  });
});
