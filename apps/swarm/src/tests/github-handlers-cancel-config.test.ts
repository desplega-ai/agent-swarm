/**
 * Tests for the runtime-config flags that control whether GitHub unassign and
 * review-request-removed events terminate the linked swarm task.
 *
 * Flags (scope "global"):
 *   github.cancelOnUnassign              — PR unassigned + issue unassigned
 *   github.cancelOnReviewRequestRemoved  — PR review_request_removed
 *
 * Absent / any value ≠ "false" → cancel (current behavior, default).
 * Value "false" → leave task untouched, return { created: false }.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  deleteSwarmConfig,
  getDb,
  getSwarmConfigs,
  getTaskById,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { handleIssue, handlePullRequest } from "../github/handlers";
import { GITHUB_BOT_NAME } from "../github/mentions";
import type { IssueEvent, PullRequestEvent } from "../github/types";

const TEST_DB_PATH = "./test-github-handlers-cancel-config.sqlite";

const BASE_REPO = { full_name: "test/repo", html_url: "https://github.com/test/repo" };
const BASE_PR = {
  number: 1,
  title: "Test PR",
  body: null as string | null,
  html_url: "https://github.com/test/repo/pull/1",
  user: { login: "sender" },
  head: { ref: "feature", sha: "abc1234567890" },
  base: { ref: "main" },
  merged: false,
  merged_by: undefined,
};
const BASE_ISSUE = {
  number: 10,
  title: "Test Issue",
  body: null as string | null,
  html_url: "https://github.com/test/repo/issues/10",
  user: { login: "sender" },
};

// ── Setup ──

beforeAll(async () => {
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
  initDb(TEST_DB_PATH);
  createAgent({
    id: "lead-cancel-config-test",
    name: "CancelConfigTestLead",
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

// Clear tasks and config rows between tests.
beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM agent_tasks").run();
  // Remove both flag rows so each test starts from a clean slate.
  for (const key of ["github.cancelOnUnassign", "github.cancelOnReviewRequestRemoved"]) {
    const rows = getSwarmConfigs({ scope: "global", key });
    for (const row of rows) deleteSwarmConfig(row.id);
  }
});

// ── Helpers ──

function seedTask(vcsNumber: number, kind: "pr" | "issue"): string {
  const task = createTaskExtended("test task", {
    agentId: "lead-cancel-config-test",
    source: "github",
    vcsProvider: "github",
    vcsRepo: BASE_REPO.full_name,
    vcsNumber,
    vcsEventType: kind === "pr" ? "pull_request" : "issues",
  });
  return task.id;
}

function setConfigFlag(key: string, value: string) {
  upsertSwarmConfig({ scope: "global", key, value });
}

function getTaskStatus(taskId: string): string | undefined {
  return getTaskById(taskId)?.status;
}

// ── github.cancelOnUnassign — PR unassigned ──

describe("PR unassigned — github.cancelOnUnassign", () => {
  test("default (no config row): unassign cancels the task", async () => {
    const taskId = seedTask(BASE_PR.number, "pr");
    expect(getTaskStatus(taskId)).toBe("pending");

    const event: PullRequestEvent = {
      action: "unassigned",
      pull_request: { ...BASE_PR },
      repository: BASE_REPO,
      sender: { login: "someone" },
      assignee: { login: GITHUB_BOT_NAME, id: 1 },
    };
    const result = await handlePullRequest(event);

    expect(result.created).toBe(false);
    expect(getTaskStatus(taskId)).toBe("failed");
  });

  test("config = 'false': unassign leaves task untouched", async () => {
    setConfigFlag("github.cancelOnUnassign", "false");
    const taskId = seedTask(BASE_PR.number, "pr");
    expect(getTaskStatus(taskId)).toBe("pending");

    const event: PullRequestEvent = {
      action: "unassigned",
      pull_request: { ...BASE_PR },
      repository: BASE_REPO,
      sender: { login: "someone" },
      assignee: { login: GITHUB_BOT_NAME, id: 1 },
    };
    const result = await handlePullRequest(event);

    expect(result.created).toBe(false);
    // Task must NOT have been failed — still pending.
    expect(getTaskStatus(taskId)).toBe("pending");
  });
});

// ── github.cancelOnUnassign — issue unassigned ──

describe("issue unassigned — github.cancelOnUnassign", () => {
  test("default (no config row): unassign cancels the task", async () => {
    const taskId = seedTask(BASE_ISSUE.number, "issue");
    expect(getTaskStatus(taskId)).toBe("pending");

    const event: IssueEvent = {
      action: "unassigned",
      issue: { ...BASE_ISSUE },
      repository: BASE_REPO,
      sender: { login: "someone" },
      assignee: { login: GITHUB_BOT_NAME, id: 1 },
    };
    const result = await handleIssue(event);

    expect(result.created).toBe(false);
    expect(getTaskStatus(taskId)).toBe("failed");
  });

  test("config = 'false': unassign leaves task untouched", async () => {
    setConfigFlag("github.cancelOnUnassign", "false");
    const taskId = seedTask(BASE_ISSUE.number, "issue");
    expect(getTaskStatus(taskId)).toBe("pending");

    const event: IssueEvent = {
      action: "unassigned",
      issue: { ...BASE_ISSUE },
      repository: BASE_REPO,
      sender: { login: "someone" },
      assignee: { login: GITHUB_BOT_NAME, id: 1 },
    };
    const result = await handleIssue(event);

    expect(result.created).toBe(false);
    expect(getTaskStatus(taskId)).toBe("pending");
  });
});

// ── github.cancelOnReviewRequestRemoved ──

describe("PR review_request_removed — github.cancelOnReviewRequestRemoved", () => {
  test("default (no config row): review removal cancels the task", async () => {
    const taskId = seedTask(BASE_PR.number, "pr");
    expect(getTaskStatus(taskId)).toBe("pending");

    const event: PullRequestEvent = {
      action: "review_request_removed",
      pull_request: { ...BASE_PR },
      repository: BASE_REPO,
      sender: { login: "someone" },
      requested_reviewer: { login: GITHUB_BOT_NAME, id: 1 },
    };
    const result = await handlePullRequest(event);

    expect(result.created).toBe(false);
    expect(getTaskStatus(taskId)).toBe("failed");
  });

  test("config = 'false': review removal leaves task untouched", async () => {
    setConfigFlag("github.cancelOnReviewRequestRemoved", "false");
    const taskId = seedTask(BASE_PR.number, "pr");
    expect(getTaskStatus(taskId)).toBe("pending");

    const event: PullRequestEvent = {
      action: "review_request_removed",
      pull_request: { ...BASE_PR },
      repository: BASE_REPO,
      sender: { login: "someone" },
      requested_reviewer: { login: GITHUB_BOT_NAME, id: 1 },
    };
    const result = await handlePullRequest(event);

    expect(result.created).toBe(false);
    expect(getTaskStatus(taskId)).toBe("pending");
  });
});

// ── Independence: flags do not bleed into each other ──

describe("flag independence", () => {
  test("cancelOnUnassign=false does NOT affect review_request_removed (still cancels)", async () => {
    // Only disable the unassign flag; leave review-request flag absent (default = cancel).
    setConfigFlag("github.cancelOnUnassign", "false");
    const taskId = seedTask(BASE_PR.number, "pr");

    const event: PullRequestEvent = {
      action: "review_request_removed",
      pull_request: { ...BASE_PR },
      repository: BASE_REPO,
      sender: { login: "someone" },
      requested_reviewer: { login: GITHUB_BOT_NAME, id: 1 },
    };
    await handlePullRequest(event);

    // review_request_removed STILL cancels because its own flag is absent (default true).
    expect(getTaskStatus(taskId)).toBe("failed");
  });

  test("cancelOnReviewRequestRemoved=false does NOT affect unassign (still cancels)", async () => {
    // Only disable the review-request flag; leave unassign flag absent (default = cancel).
    setConfigFlag("github.cancelOnReviewRequestRemoved", "false");
    const taskId = seedTask(BASE_PR.number, "pr");

    const event: PullRequestEvent = {
      action: "unassigned",
      pull_request: { ...BASE_PR },
      repository: BASE_REPO,
      sender: { login: "someone" },
      assignee: { login: GITHUB_BOT_NAME, id: 1 },
    };
    await handlePullRequest(event);

    // unassigned STILL cancels because its own flag is absent (default true).
    expect(getTaskStatus(taskId)).toBe("failed");
  });
});
