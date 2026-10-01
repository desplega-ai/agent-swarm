/**
 * 👀 acknowledgement on every GitHub webhook path that creates a task.
 *
 * The deployment under test is a plain webhook plus a PAT: no GitHub App, so no
 * installation id and no App credentials. The handlers must still react on the
 * item that pinged the swarm, using `GITHUB_TOKEN`, and each event type must hit
 * its own endpoint:
 *
 *   issue / PR body            -> POST /repos/{repo}/issues/{number}/reactions
 *   issue or PR conversation   -> POST /repos/{repo}/issues/comments/{id}/reactions
 *   inline diff comment        -> POST /repos/{repo}/pulls/comments/{id}/reactions
 *   PR review                  -> GraphQL addReaction on the review node
 *
 * Both sides are covered: issues (opened, edited, assigned, labeled, comment) and
 * pull requests (opened, edited, assigned, review requested, labeled, conversation
 * comment, review, inline review comment).
 *
 * Uses the real `../github/app` module (no App env, so it reports "not enabled")
 * and spies on `fetch` so nothing reaches api.github.com.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
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

const TEST_DB_PATH = "./test-github-handlers-reactions.sqlite";
const PAT = "ghp_fixturePersonalAccessToken0000000000";
const API = "https://api.github.com/repos/test/repo";
const MENTION = `@${GITHUB_BOT_NAME} please take a look`;
const BOT = { login: GITHUB_BOT_NAME, id: 1 };

interface FetchCall {
  url: string;
  authorization: string | null;
  body: string | null;
}

let calls: FetchCall[] = [];
let fetchRejects = false;
let fetchSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let savedToken: string | undefined;

// Each test gets a fresh issue/PR/comment number: the handlers dedupe on them.
let seq = 5000;
const nextId = () => ++seq;

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  initDb(TEST_DB_PATH);
  await createAgent({
    id: "lead-gh-reactions",
    name: "GitHubReactionsTestLead",
    status: "idle",
    isLead: true,
  });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
});

beforeEach(async () => {
  savedToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = PAT;
  calls = [];
  fetchRejects = false;
  await getDbClient().run("DELETE FROM agent_tasks");
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      authorization: headers.Authorization ?? null,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (fetchRejects) throw new Error("socket hang up");
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedToken;
});

// ── Event builders ──

function makeIssueEvent(overrides: Partial<IssueEvent> & { number: number }): IssueEvent {
  const { number, ...rest } = overrides;
  return {
    action: "opened",
    issue: {
      number,
      title: `Issue #${number}`,
      body: null,
      html_url: `https://github.com/test/repo/issues/${number}`,
      user: { login: "human-dev" },
    },
    repository: { full_name: "test/repo", html_url: "https://github.com/test/repo" },
    sender: { login: "human-dev" },
    ...rest,
  };
}

function makePREvent(overrides: Partial<PullRequestEvent> & { number: number }): PullRequestEvent {
  const { number, ...rest } = overrides;
  return {
    action: "opened",
    pull_request: {
      number,
      title: `PR #${number}`,
      body: null,
      html_url: `https://github.com/test/repo/pull/${number}`,
      user: { login: "human-dev" },
      head: { ref: "feature", sha: "abc1234567890" },
      base: { ref: "main" },
      merged: false,
    },
    repository: { full_name: "test/repo", html_url: "https://github.com/test/repo" },
    sender: { login: "human-dev" },
    ...rest,
  };
}

function makeCommentEvent(opts: {
  commentId: number;
  kind: "issue" | "pr-conversation" | "pr-inline";
  number: number;
  nodeId?: string;
  installationId?: number;
}): CommentEvent {
  const base = {
    action: "created",
    comment: {
      id: opts.commentId,
      node_id: opts.nodeId,
      body: MENTION,
      html_url: `https://github.com/test/repo/issues/${opts.number}#issuecomment-${opts.commentId}`,
      user: { login: "human-dev" },
    },
    repository: { full_name: "test/repo", html_url: "https://github.com/test/repo" },
    sender: { login: "human-dev" },
    ...(opts.installationId !== undefined ? { installation: { id: opts.installationId } } : {}),
  };
  if (opts.kind === "pr-inline") {
    return {
      ...base,
      pull_request: {
        number: opts.number,
        title: `PR #${opts.number}`,
        html_url: `https://github.com/test/repo/pull/${opts.number}`,
      },
    };
  }
  // GitHub delivers PR-conversation comments as `issue_comment` with an `issue` payload.
  return {
    ...base,
    issue: {
      number: opts.number,
      title: `${opts.kind === "issue" ? "Issue" : "PR"} #${opts.number}`,
      html_url: `https://github.com/test/repo/${opts.kind === "issue" ? "issues" : "pull"}/${opts.number}`,
    },
  };
}

function makeReviewEvent(opts: {
  reviewId: number;
  prNumber: number;
  nodeId?: string;
}): PullRequestReviewEvent {
  return {
    action: "submitted",
    review: {
      id: opts.reviewId,
      node_id: opts.nodeId,
      body: "Please fix the naming",
      state: "changes_requested",
      html_url: `https://github.com/test/repo/pull/${opts.prNumber}#pullrequestreview-${opts.reviewId}`,
      user: { login: "human-dev" },
      submitted_at: "2026-10-01T00:00:00Z",
    },
    pull_request: {
      number: opts.prNumber,
      title: `Bot PR #${opts.prNumber}`,
      body: null,
      html_url: `https://github.com/test/repo/pull/${opts.prNumber}`,
      user: { login: GITHUB_BOT_NAME },
      head: { ref: "feature" },
      base: { ref: "main" },
    },
    repository: { full_name: "test/repo", html_url: "https://github.com/test/repo" },
    sender: { login: "human-dev" },
  };
}

// ── Assertions ──

/** The ack is fire-and-forget, so give the un-awaited promise a moment to land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50 && calls.length === 0; i++) await Bun.sleep(5);
  await Bun.sleep(10);
}

async function expectCreatedWithReaction(
  run: () => Promise<{ created: boolean; taskId?: string }>,
  expectedUrl: string,
): Promise<void> {
  const result = await run();
  await settle();

  expect(result.created).toBe(true);
  expect(calls.map((c) => c.url)).toEqual([expectedUrl]);
  expect(calls[0]?.authorization).toBe(`Bearer ${PAT}`);
}

// ── Issue side ──

describe("issues: 👀 via GITHUB_TOKEN with no GitHub App", () => {
  test("issue opened with an @mention reacts on the issue", async () => {
    const n = nextId();
    await expectCreatedWithReaction(
      () =>
        handleIssue(
          makeIssueEvent({
            number: n,
            issue: { ...makeIssueEvent({ number: n }).issue, body: MENTION },
          }),
        ),
      `${API}/issues/${n}/reactions`,
    );
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ content: "eyes" });
  });

  test("issue edited with an @mention reacts on the issue", async () => {
    const n = nextId();
    await expectCreatedWithReaction(
      () =>
        handleIssue(
          makeIssueEvent({
            number: n,
            action: "edited",
            issue: { ...makeIssueEvent({ number: n }).issue, body: MENTION },
          }),
        ),
      `${API}/issues/${n}/reactions`,
    );
  });

  test("issue assigned to the bot reacts on the issue", async () => {
    const n = nextId();
    await expectCreatedWithReaction(
      () => handleIssue(makeIssueEvent({ number: n, action: "assigned", assignee: BOT })),
      `${API}/issues/${n}/reactions`,
    );
  });

  test("swarm label on an issue reacts on the issue", async () => {
    const n = nextId();
    await expectCreatedWithReaction(
      () =>
        handleIssue(
          makeIssueEvent({
            number: n,
            action: "labeled",
            label: { id: 1, name: "swarm-review", color: "ffffff" },
          }),
        ),
      `${API}/issues/${n}/reactions`,
    );
  });

  test("@mention in an issue comment reacts on the comment (issues/comments)", async () => {
    const id = nextId();
    await expectCreatedWithReaction(
      () =>
        handleComment(
          makeCommentEvent({ commentId: id, kind: "issue", number: nextId() }),
          "issue_comment",
        ),
      `${API}/issues/comments/${id}/reactions`,
    );
  });
});

// ── PR side ──

describe("pull requests: 👀 via GITHUB_TOKEN with no GitHub App", () => {
  test("PR opened with an @mention reacts on the PR", async () => {
    const n = nextId();
    await expectCreatedWithReaction(
      () =>
        handlePullRequest(
          makePREvent({
            number: n,
            pull_request: { ...makePREvent({ number: n }).pull_request, body: MENTION },
          }),
        ),
      `${API}/issues/${n}/reactions`,
    );
  });

  test("PR edited with an @mention reacts on the PR", async () => {
    const n = nextId();
    await expectCreatedWithReaction(
      () =>
        handlePullRequest(
          makePREvent({
            number: n,
            action: "edited",
            pull_request: { ...makePREvent({ number: n }).pull_request, body: MENTION },
          }),
        ),
      `${API}/issues/${n}/reactions`,
    );
  });

  test("PR assigned to the bot reacts on the PR", async () => {
    const n = nextId();
    await expectCreatedWithReaction(
      () => handlePullRequest(makePREvent({ number: n, action: "assigned", assignee: BOT })),
      `${API}/issues/${n}/reactions`,
    );
  });

  test("bot requested as reviewer reacts on the PR", async () => {
    const n = nextId();
    await expectCreatedWithReaction(
      () =>
        handlePullRequest(
          makePREvent({ number: n, action: "review_requested", requested_reviewer: BOT }),
        ),
      `${API}/issues/${n}/reactions`,
    );
  });

  test("swarm label on a PR reacts on the PR", async () => {
    const n = nextId();
    await expectCreatedWithReaction(
      () =>
        handlePullRequest(
          makePREvent({
            number: n,
            action: "labeled",
            label: { id: 2, name: "swarm-review", color: "ffffff" },
          }),
        ),
      `${API}/issues/${n}/reactions`,
    );
  });

  test("@mention in a PR conversation comment reacts on the comment (issues/comments)", async () => {
    const id = nextId();
    await expectCreatedWithReaction(
      () =>
        handleComment(
          makeCommentEvent({ commentId: id, kind: "pr-conversation", number: nextId() }),
          "issue_comment",
        ),
      `${API}/issues/comments/${id}/reactions`,
    );
  });

  test("@mention in an inline review comment reacts via pulls/comments, not issues/comments", async () => {
    const id = nextId();
    await expectCreatedWithReaction(
      () =>
        handleComment(
          makeCommentEvent({ commentId: id, kind: "pr-inline", number: nextId() }),
          "pull_request_review_comment",
        ),
      `${API}/pulls/comments/${id}/reactions`,
    );
  });

  test("PR review reacts on the review itself through GraphQL", async () => {
    const result = await handlePullRequestReview(
      makeReviewEvent({ reviewId: nextId(), prNumber: nextId(), nodeId: "PRR_kwDOabc123" }),
    );
    await settle();

    expect(result.created).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/graphql"]);
    expect(calls[0]?.authorization).toBe(`Bearer ${PAT}`);
    expect(JSON.parse(calls[0]?.body ?? "{}").variables.input).toEqual({
      subjectId: "PRR_kwDOabc123",
      content: "EYES",
    });
  });

  test("PR review without a node id falls back to reacting on the PR", async () => {
    const pr = nextId();
    await expectCreatedWithReaction(
      () => handlePullRequestReview(makeReviewEvent({ reviewId: nextId(), prNumber: pr })),
      `${API}/issues/${pr}/reactions`,
    );
  });
});

// ── Cross-cutting ──

describe("reaction fallback never gets in the way of task creation", () => {
  test("no App and no GITHUB_TOKEN: the task is still created and nothing is sent", async () => {
    delete process.env.GITHUB_TOKEN;

    const result = await handleComment(
      makeCommentEvent({ commentId: nextId(), kind: "issue", number: nextId() }),
      "issue_comment",
    );
    await Bun.sleep(30);

    expect(result.created).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a failing reaction request does not block or fail task creation", async () => {
    fetchRejects = true;

    const result = await handleComment(
      makeCommentEvent({ commentId: nextId(), kind: "pr-inline", number: nextId() }),
      "pull_request_review_comment",
    );
    await settle();

    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
    expect(calls).toHaveLength(1);
  });

  test("an installation id with no App configured still falls back to the PAT", async () => {
    const id = nextId();
    await expectCreatedWithReaction(
      () =>
        handleComment(
          makeCommentEvent({ commentId: id, kind: "issue", number: nextId(), installationId: 987 }),
          "issue_comment",
        ),
      `${API}/issues/comments/${id}/reactions`,
    );
  });

  test("the token never shows up in logs", async () => {
    await handleComment(
      makeCommentEvent({ commentId: nextId(), kind: "issue", number: nextId() }),
      "issue_comment",
    );
    await settle();

    const output = [...logSpy.mock.calls, ...errorSpy.mock.calls]
      .map((args: unknown[]) => args.map((a) => String(a)).join(" "))
      .join("\n");
    expect(output).not.toContain(PAT);
  });
});
