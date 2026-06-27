/**
 * Tests for inline PR review comment surfacing in handlePullRequestReview.
 *
 * Covers:
 * - CHANGES_REQUESTED review with inline comments → task description includes them
 * - commented-no-body-with-inline-comments → task is created (not skipped)
 * - commented-no-body-no-inline-comments → task is skipped (existing behavior preserved)
 * - commented-no-body-no-installation → graceful fallback, task is skipped
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import { handleComment, handlePullRequestReview } from "../github/handlers";
import { GITHUB_BOT_NAME } from "../github/mentions";
import type { CommentEvent, PullRequestReviewEvent } from "../github/types";
import { getTemplateDefinition } from "../prompts/registry";

// Side-effect import: registers all GitHub templates on first load
import "../github/templates";

async function ensureTemplatesRegistered(): Promise<void> {
  if (getTemplateDefinition("github.pull_request.review_submitted")) return;
  const ts = Date.now();
  await import(`../github/templates?t=${ts}`);
}

// Mock GitHub App credentials so fetchReviewComments can obtain a token
// without a real RSA key. Must come before the handlers import is evaluated.
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

const TEST_DB_PATH = "./test-github-handlers-inline.sqlite";

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  initDb(TEST_DB_PATH);
  createAgent({
    id: "lead-inline-test",
    name: "InlineTestLead",
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

beforeEach(async () => {
  await ensureTemplatesRegistered();
  getDb().prepare("DELETE FROM agent_tasks").run();
});

// ── Helpers ──

const BASE_REPO = { full_name: "test/repo", html_url: "https://github.com/test/repo" };

let reviewIdCounter = 9000;

function makeReviewEvent(opts: {
  state: "changes_requested" | "commented";
  body: string | null;
  installationId?: number;
  prUserLogin?: string;
}): PullRequestReviewEvent {
  const id = ++reviewIdCounter;
  return {
    action: "submitted",
    review: {
      id,
      body: opts.body,
      state: opts.state,
      html_url: `https://github.com/test/repo/pull/99#pullrequestreview-${id}`,
      user: { login: "reviewer" },
      submitted_at: "2026-01-01T00:00:00Z",
    },
    pull_request: {
      number: 99,
      title: "Bot PR",
      body: null,
      html_url: "https://github.com/test/repo/pull/99",
      user: { login: opts.prUserLogin ?? GITHUB_BOT_NAME },
      head: { ref: "feature" },
      base: { ref: "main" },
    },
    repository: BASE_REPO,
    sender: { login: "reviewer" },
    ...(opts.installationId !== undefined ? { installation: { id: opts.installationId } } : {}),
  };
}

const SAMPLE_INLINE_COMMENTS = [
  {
    id: 1001,
    path: "src/domain_tables.go",
    line: 77,
    body: "This logic looks wrong — should use a map instead.",
    html_url: "https://github.com/test/repo/pull/99#discussion_r1001",
    diff_hunk: "@@ -75,6 +75,8 @@ func buildTable() {",
  },
  {
    id: 1002,
    path: "config/table-renderers.json",
    line: 7,
    body: "Why is this hardcoded? Should come from config.",
    html_url: "https://github.com/test/repo/pull/99#discussion_r1002",
    diff_hunk: "@@ -5,7 +5,9 @@ {",
  },
];

function mockFetchWithComments(
  comments: typeof SAMPLE_INLINE_COMMENTS | [],
): ReturnType<typeof spyOn> {
  return spyOn(globalThis, "fetch").mockImplementationOnce(
    async () =>
      new Response(JSON.stringify(comments), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

function getLastTaskText(): string | undefined {
  const row = getDb()
    .prepare<{ task: string }, never>("SELECT task FROM agent_tasks ORDER BY rowid DESC LIMIT 1")
    .get();
  return row?.task;
}

// ── Tests ──

describe("inline review comment surfacing", () => {
  test("CHANGES_REQUESTED review with inline comments: task includes path:line and bodies", async () => {
    const fetchSpy = mockFetchWithComments(SAMPLE_INLINE_COMMENTS);

    const event = makeReviewEvent({
      state: "changes_requested",
      body: "CI is not green",
      installationId: 123,
    });
    const result = await handlePullRequestReview(event);

    fetchSpy.mockRestore();

    expect(result.created).toBe(true);
    const text = getLastTaskText();
    expect(text).toBeDefined();
    expect(text).toContain("src/domain_tables.go:77");
    expect(text).toContain("This logic looks wrong");
    expect(text).toContain("config/table-renderers.json:7");
    expect(text).toContain("Why is this hardcoded?");
    expect(text).toContain("Inline review comments");
    expect(text).toContain("reply to and resolve each inline review thread");
  });

  test("commented review with no body but with inline comments: task is created, not skipped", async () => {
    const fetchSpy = mockFetchWithComments([SAMPLE_INLINE_COMMENTS[0]]);

    const event = makeReviewEvent({ state: "commented", body: null, installationId: 123 });
    const result = await handlePullRequestReview(event);

    fetchSpy.mockRestore();

    expect(result.created).toBe(true);
  });

  test("commented review with no body and no inline comments: task is skipped", async () => {
    const fetchSpy = mockFetchWithComments([]);

    const event = makeReviewEvent({ state: "commented", body: null, installationId: 123 });
    const result = await handlePullRequestReview(event);

    fetchSpy.mockRestore();

    expect(result.created).toBe(false);
  });

  test("commented review with no body and no installation: graceful fallback, task is skipped", async () => {
    const event = makeReviewEvent({ state: "commented", body: null });
    const result = await handlePullRequestReview(event);
    expect(result.created).toBe(false);
  });

  test("review comments fetch failure: task still created (graceful degradation)", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementationOnce(
      async () => new Response("Internal Server Error", { status: 500 }),
    );

    const event = makeReviewEvent({
      state: "changes_requested",
      body: "Needs work",
      installationId: 123,
    });
    const result = await handlePullRequestReview(event);

    fetchSpy.mockRestore();

    // Task should still be created even if the inline comments fetch fails
    expect(result.created).toBe(true);
    const text = getLastTaskText();
    expect(text).toContain("Needs work");
    // No inline comments section when fetch failed
    expect(text).not.toContain("Inline review comments");
  });

  test("pagination: two-page review comment response surfaces all comments from both pages", async () => {
    const page1 = [SAMPLE_INLINE_COMMENTS[0]];
    const page2 = [SAMPLE_INLINE_COMMENTS[1]];
    const nextUrl =
      "https://api.github.com/repos/test/repo/pulls/99/reviews/9001/comments?per_page=100&page=2";

    const fetchSpy = spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify(page1), {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              Link: `<${nextUrl}>; rel="next", <${nextUrl}>; rel="last"`,
            },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify(page2), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );

    const event = makeReviewEvent({
      state: "changes_requested",
      body: "Multi-page review",
      installationId: 123,
    });
    const result = await handlePullRequestReview(event);
    fetchSpy.mockRestore();

    expect(result.created).toBe(true);
    const text = getLastTaskText();
    expect(text).toBeDefined();
    // Both pages of inline comments must appear in the task
    expect(text).toContain("src/domain_tables.go:77"); // page 1 comment
    expect(text).toContain("config/table-renderers.json:7"); // page 2 comment
    expect(text).toContain("Inline review comments (2)");
  });

  test("no-double-spawn: review-attached inline comment via pull_request_review_comment event does not create a second task", async () => {
    // Step 1: submitted review creates exactly ONE bundle task
    const fetchSpy = mockFetchWithComments(SAMPLE_INLINE_COMMENTS);
    const reviewEvent = makeReviewEvent({
      state: "changes_requested",
      body: "Please address my comments",
      installationId: 123,
    });
    const reviewResult = await handlePullRequestReview(reviewEvent);
    fetchSpy.mockRestore();

    expect(reviewResult.created).toBe(true);
    const taskCountAfterReview = getDb()
      .prepare<{ n: number }, never>("SELECT COUNT(*) AS n FROM agent_tasks")
      .get()!.n;
    expect(taskCountAfterReview).toBe(1);

    // Step 2: GitHub also delivers the same inline comments as individual
    // pull_request_review_comment events (no @agent-swarm mention). These
    // must NOT spawn additional tasks — the mention gate in handleComment blocks them.
    const inlineCommentEvent: CommentEvent = {
      action: "created",
      comment: {
        id: SAMPLE_INLINE_COMMENTS[0].id,
        body: SAMPLE_INLINE_COMMENTS[0].body, // no @agent-swarm mention
        html_url: SAMPLE_INLINE_COMMENTS[0].html_url,
        user: { login: "reviewer" },
      },
      pull_request: {
        number: 99,
        title: "Bot PR",
        html_url: "https://github.com/test/repo/pull/99",
      },
      repository: BASE_REPO,
      sender: { login: "reviewer" },
    };
    const commentResult = await handleComment(inlineCommentEvent, "pull_request_review_comment");
    expect(commentResult.created).toBe(false);

    // Total tasks must still be exactly 1 — no double-spawn
    const taskCountAfter = getDb()
      .prepare<{ n: number }, never>("SELECT COUNT(*) AS n FROM agent_tasks")
      .get()!.n;
    expect(taskCountAfter).toBe(1);
  });
});
