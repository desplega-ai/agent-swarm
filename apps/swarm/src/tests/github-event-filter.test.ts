import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, initDb } from "../be/db";
import {
  handleCheckRun,
  handleCheckSuite,
  handleComment,
  handleIssue,
  handlePullRequest,
  handlePullRequestReview,
  handleWorkflowRun,
} from "../github/handlers";
import { GITHUB_BOT_NAME } from "../github/mentions";
import type {
  CheckRunEvent,
  CheckSuiteEvent,
  CommentEvent,
  IssueEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
  WorkflowRunEvent,
} from "../github/types";

const TEST_DB_PATH = "./test-github-event-filter.sqlite";

// ── Setup ──

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  initDb(TEST_DB_PATH);
  // Create a lead agent so handlers can assign tasks
  createAgent({
    id: "lead-gh-001",
    name: "GitHubTestLead",
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

// ── Helpers ──

const BASE_REPO = { full_name: "test/repo", html_url: "https://github.com/test/repo" };
const BASE_SENDER = { login: "testuser" };
const BASE_PR = {
  number: 1,
  title: "Test PR",
  body: null as string | null,
  html_url: "https://github.com/test/repo/pull/1",
  user: { login: "testuser" },
  head: { ref: "feature", sha: "abc1234567890" },
  base: { ref: "main" },
  merged: false,
  merged_by: undefined,
};

function makePREvent(overrides: Partial<PullRequestEvent> = {}): PullRequestEvent {
  return {
    action: "opened",
    pull_request: BASE_PR,
    repository: BASE_REPO,
    sender: BASE_SENDER,
    ...overrides,
  };
}

function makeIssueEvent(overrides: Partial<IssueEvent> = {}): IssueEvent {
  return {
    action: "opened",
    issue: {
      number: 10,
      title: "Test Issue",
      body: null,
      html_url: "https://github.com/test/repo/issues/10",
      user: { login: "testuser" },
    },
    repository: BASE_REPO,
    sender: BASE_SENDER,
    ...overrides,
  };
}

// ── Suppressed events ──

describe("suppressed cascade events", () => {
  test("pull_request.closed returns created: false", async () => {
    const result = await handlePullRequest(makePREvent({ action: "closed" }));
    expect(result.created).toBe(false);
  });

  test("pull_request.synchronize returns created: false", async () => {
    const result = await handlePullRequest(makePREvent({ action: "synchronize" }));
    expect(result.created).toBe(false);
  });

  test("pull_request_review.submitted returns created: false when bot is not PR author and no existing task", async () => {
    const event: PullRequestReviewEvent = {
      action: "submitted",
      review: {
        id: 1,
        body: "Looks good",
        state: "approved",
        html_url: "https://github.com/test/repo/pull/1#pullrequestreview-1",
        user: { login: "reviewer" },
        submitted_at: "2026-01-01T00:00:00Z",
      },
      pull_request: {
        number: 1,
        title: "Test PR",
        body: null,
        html_url: "https://github.com/test/repo/pull/1",
        user: { login: "testuser" },
        head: { ref: "feature" },
        base: { ref: "main" },
      },
      repository: BASE_REPO,
      sender: { login: "reviewer" },
    };
    const result = await handlePullRequestReview(event);
    expect(result.created).toBe(false);
  });

  test("pull_request_review.submitted creates task when bot is PR author", async () => {
    const event: PullRequestReviewEvent = {
      action: "submitted",
      review: {
        id: 2,
        body: "LGTM",
        state: "approved",
        html_url: "https://github.com/test/repo/pull/99#pullrequestreview-2",
        user: { login: "reviewer" },
        submitted_at: "2026-01-01T00:00:00Z",
      },
      pull_request: {
        number: 99,
        title: "Bot PR",
        body: null,
        html_url: "https://github.com/test/repo/pull/99",
        user: { login: GITHUB_BOT_NAME },
        head: { ref: "bot-feature" },
        base: { ref: "main" },
      },
      repository: BASE_REPO,
      sender: { login: "reviewer" },
    };
    const result = await handlePullRequestReview(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
  });

  test("pull_request_review.edited is ignored", async () => {
    const event: PullRequestReviewEvent = {
      action: "edited",
      review: {
        id: 3,
        body: "Updated review",
        state: "approved",
        html_url: "https://github.com/test/repo/pull/99#pullrequestreview-3",
        user: { login: "reviewer" },
        submitted_at: "2026-01-01T00:00:00Z",
      },
      pull_request: {
        number: 99,
        title: "Bot PR",
        body: null,
        html_url: "https://github.com/test/repo/pull/99",
        user: { login: GITHUB_BOT_NAME },
        head: { ref: "bot-feature" },
        base: { ref: "main" },
      },
      repository: BASE_REPO,
      sender: { login: "reviewer" },
    };
    const result = await handlePullRequestReview(event);
    expect(result.created).toBe(false);
  });

  test("pull_request_review.submitted with empty commented review is ignored", async () => {
    const event: PullRequestReviewEvent = {
      action: "submitted",
      review: {
        id: 4,
        body: "",
        state: "commented",
        html_url: "https://github.com/test/repo/pull/99#pullrequestreview-4",
        user: { login: "reviewer" },
        submitted_at: "2026-01-01T00:00:00Z",
      },
      pull_request: {
        number: 99,
        title: "Bot PR",
        body: null,
        html_url: "https://github.com/test/repo/pull/99",
        user: { login: GITHUB_BOT_NAME },
        head: { ref: "bot-feature" },
        base: { ref: "main" },
      },
      repository: BASE_REPO,
      sender: { login: "reviewer" },
    };
    const result = await handlePullRequestReview(event);
    expect(result.created).toBe(false);
  });

  test("check_run.completed with failure returns created: false", async () => {
    const event: CheckRunEvent = {
      action: "completed",
      check_run: {
        id: 1,
        name: "ci/test",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/test/repo/runs/1",
        started_at: "2026-01-01T00:00:00Z",
        completed_at: "2026-01-01T00:01:00Z",
        output: { title: null, summary: null },
        check_suite: { id: 1, head_sha: "abc1234" },
        pull_requests: [{ number: 1, head: { sha: "abc1234" } }],
      },
      repository: BASE_REPO,
      sender: BASE_SENDER,
    };
    const result = await handleCheckRun(event);
    expect(result.created).toBe(false);
  });

  test("check_suite.completed with failure returns created: false", async () => {
    const event: CheckSuiteEvent = {
      action: "completed",
      check_suite: {
        id: 1,
        status: "completed",
        conclusion: "failure",
        head_sha: "abc1234567890",
        head_branch: "feature",
        pull_requests: [{ number: 1, head: { sha: "abc1234" } }],
      },
      repository: BASE_REPO,
      sender: BASE_SENDER,
    };
    const result = await handleCheckSuite(event);
    expect(result.created).toBe(false);
  });

  test("workflow_run.completed with failure returns created: false", async () => {
    const event: WorkflowRunEvent = {
      action: "completed",
      workflow_run: {
        id: 1,
        name: "CI",
        head_branch: "feature",
        head_sha: "abc1234567890",
        status: "completed",
        conclusion: "failure",
        html_url: "https://github.com/test/repo/actions/runs/1",
        run_number: 42,
        event: "pull_request",
        pull_requests: [{ number: 1, head: { sha: "abc1234" } }],
      },
      workflow: { id: 1, name: "CI", path: ".github/workflows/ci.yml" },
      repository: BASE_REPO,
      sender: BASE_SENDER,
    };
    const result = await handleWorkflowRun(event);
    expect(result.created).toBe(false);
  });
});

// ── Explicit actions still create tasks ──

describe("explicit actions create tasks", () => {
  test("issue_comment with @mention creates task", async () => {
    const event: CommentEvent = {
      action: "created",
      comment: {
        id: 100,
        body: `@${GITHUB_BOT_NAME} please review this`,
        html_url: "https://github.com/test/repo/issues/10#issuecomment-100",
        user: { login: "testuser" },
      },
      issue: {
        number: 10,
        title: "Test Issue",
        html_url: "https://github.com/test/repo/issues/10",
      },
      repository: BASE_REPO,
      sender: BASE_SENDER,
    };
    const result = await handleComment(event, "issue_comment");
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
  });

  test("pull_request.review_requested with bot as reviewer creates task", async () => {
    const event = makePREvent({
      action: "review_requested",
      requested_reviewer: { login: GITHUB_BOT_NAME, id: 1 },
    });
    const result = await handlePullRequest(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
  });

  test("pull_request.assigned with bot as assignee creates task", async () => {
    const event = makePREvent({
      action: "assigned",
      pull_request: { ...BASE_PR, number: 2 },
      assignee: { login: GITHUB_BOT_NAME, id: 1 },
    });
    const result = await handlePullRequest(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
  });

  test("pull_request.labeled with matching label creates task", async () => {
    const event = makePREvent({
      action: "labeled",
      pull_request: { ...BASE_PR, number: 3 },
      label: { id: 1, name: "swarm-review", color: "0075ca" },
    });
    const result = await handlePullRequest(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
  });

  test("pull_request.labeled with non-matching label does not create task", async () => {
    const event = makePREvent({
      action: "labeled",
      pull_request: { ...BASE_PR, number: 4 },
      label: { id: 2, name: "bug", color: "d73a4a" },
    });
    const result = await handlePullRequest(event);
    expect(result.created).toBe(false);
  });

  test("issue.labeled with matching label creates task", async () => {
    const event = makeIssueEvent({
      action: "labeled",
      label: { id: 1, name: "swarm-review", color: "0075ca" },
    });
    const result = await handleIssue(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
  });

  test("issue.labeled with non-matching label does not create task", async () => {
    const event = makeIssueEvent({
      action: "labeled",
      issue: {
        number: 11,
        title: "Another Issue",
        body: null,
        html_url: "https://github.com/test/repo/issues/11",
        user: { login: "testuser" },
      },
      label: { id: 2, name: "enhancement", color: "a2eeef" },
    });
    const result = await handleIssue(event);
    expect(result.created).toBe(false);
  });

  test("pull_request.opened with @mention creates task", async () => {
    const event = makePREvent({
      action: "opened",
      pull_request: {
        ...BASE_PR,
        number: 5,
        title: `@${GITHUB_BOT_NAME} review this PR`,
      },
    });
    const result = await handlePullRequest(event);
    expect(result.created).toBe(true);
    expect(result.taskId).toBeDefined();
  });
});
