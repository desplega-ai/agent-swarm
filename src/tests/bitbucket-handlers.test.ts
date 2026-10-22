import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  deletePromptTemplate,
  getDb,
  getKv,
  getTaskById,
  initDb,
  upsertPromptTemplate,
} from "../be/db";
import { linkIdentity } from "../be/users";
import { resetBitbucketBotCache } from "../bitbucket/api";
import { getBitbucketBotName, resetBitbucket } from "../bitbucket/auth";
import {
  detectMention,
  handlePullRequestClosed,
  handlePullRequestCommentCreated,
  handlePullRequestCreated,
  isDuplicateDelivery,
  markDeliveryProcessed,
  resetBitbucketDedup,
} from "../bitbucket/handlers";
import type { PullRequestCommentEvent, PullRequestEvent } from "../bitbucket/types";
import commentSample from "./fixtures/bitbucket/pullrequest-comment-created.json";
import commentInlineSample from "./fixtures/bitbucket/pullrequest-comment-created-inline.json";
import mentionSample from "./fixtures/bitbucket/pullrequest-created-mention.json";
import reviewerSample from "./fixtures/bitbucket/pullrequest-created-reviewer.json";
import fulfilledSample from "./fixtures/bitbucket/pullrequest-fulfilled.json";
import rejectedSample from "./fixtures/bitbucket/pullrequest-rejected.json";

// Fixtures follow the documented Bitbucket Cloud event payloads
// (https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/),
// with placeholder workspace, repository and account ids.
const TEST_DB_PATH = "./test-bitbucket-handlers.sqlite";
const BOT_ACCOUNT_ID = "557058:00000000-0000-4000-8000-0000000000b0";
const HUMAN_ACCOUNT_ID = "557058:11111111-1111-4111-8111-111111111111";
const REPO = "acme-ws/widgets";
const REPO_UUID = "0f9b2c4e-7a1d-4e5f-9c3b-2d8e6a1f4b70";
const LEAD_ID = "lead-bitbucket-001";

function withPr<T extends PullRequestEvent>(sample: unknown, id: number): T {
  const event = structuredClone(sample) as T;
  event.pullrequest.id = id;
  if (event.pullrequest.links?.html) {
    event.pullrequest.links.html.href = `https://bitbucket.org/${REPO}/pull-requests/${id}`;
  }
  return event;
}

function commentEvent(sample: unknown, prId: number, raw?: string): PullRequestCommentEvent {
  const event = withPr<PullRequestCommentEvent>(sample, prId);
  event.comment.id = prId * 10;
  if (raw !== undefined) event.comment.content.raw = raw;
  return event;
}

async function seedActiveTask(prId: number) {
  return createTaskExtended(`[Bitbucket PR #${prId}] Existing`, {
    source: "bitbucket",
    vcsProvider: "bitbucket",
    vcsRepo: REPO,
    vcsEventType: "pull_request",
    vcsNumber: prId,
    agentId: LEAD_ID,
  });
}

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "BitbucketTestLead", status: "idle", isLead: true });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

beforeEach(() => {
  process.env.BITBUCKET_BOT_ACCOUNT_ID = BOT_ACCOUNT_ID;
});

afterEach(() => {
  delete process.env.BITBUCKET_BOT_ACCOUNT_ID;
  resetBitbucket();
  resetBitbucketBotCache();
  resetBitbucketDedup();
});

describe("detectMention", () => {
  test("matches a picker mention and a typed @name", () => {
    expect(detectMention(`hi @{${BOT_ACCOUNT_ID}} there`, BOT_ACCOUNT_ID)).toBe(true);
    expect(detectMention(`hi @${getBitbucketBotName()} there`, null)).toBe(true);
  });

  test("ignores other accounts and lookalike names", () => {
    expect(detectMention(`hi @{${HUMAN_ACCOUNT_ID}}`, BOT_ACCOUNT_ID)).toBe(false);
    expect(detectMention(`hi @${getBitbucketBotName()}-two`, BOT_ACCOUNT_ID)).toBe(false);
    expect(detectMention(null, BOT_ACCOUNT_ID)).toBe(false);
  });

  test("reads BITBUCKET_BOT_NAME at match time, so a config reload applies", () => {
    process.env.BITBUCKET_BOT_NAME = "renamed-bot";
    try {
      expect(detectMention("hi @renamed-bot there", null)).toBe(true);
      expect(detectMention("hi @agent-swarm-bot there", null)).toBe(false);
    } finally {
      delete process.env.BITBUCKET_BOT_NAME;
    }
  });
});

// ═══════════════════════════════════════════════════════
// pullrequest:created
// ═══════════════════════════════════════════════════════

describe("handlePullRequestCreated", () => {
  test("creates a task when the description mentions the bot", async () => {
    const result = await handlePullRequestCreated(withPr(mentionSample, 101));
    expect(result.created).toBe(true);

    const task = await getTaskById(result.taskId!);
    expect(task?.source).toBe("bitbucket");
    expect(task?.vcsProvider).toBe("bitbucket");
    expect(task?.taskType).toBe("bitbucket-pr");
    expect(task?.vcsRepo).toBe(REPO);
    expect(task?.vcsNumber).toBe(101);
    expect(task?.vcsEventType).toBe("pull_request");
    expect(task?.vcsAuthor).toBe(HUMAN_ACCOUNT_ID);
    expect(task?.vcsUrl).toBe(`https://bitbucket.org/${REPO}/pull-requests/101`);
    expect(task?.contextKey).toBe(`task:trackers:bitbucket:${REPO_UUID}:pr:101`);
    expect(task?.task).toContain("[Bitbucket PR #101] Add retry to the widget fetcher");
    expect(task?.task).toContain("Branch: feature/retry → main");
    expect(task?.task).toContain("Context: please add tests for the retry path.");
    expect(task?.task).toContain("api.bitbucket.org/2.0/repositories/acme-ws/widgets");
    expect(task?.task).not.toContain(BOT_ACCOUNT_ID);
  });

  test("creates a review task when the bot is listed as a reviewer", async () => {
    const result = await handlePullRequestCreated(withPr(reviewerSample, 102));
    expect(result.created).toBe(true);

    const task = await getTaskById(result.taskId!);
    expect(task?.taskType).toBe("bitbucket-pr");
    expect(task?.task).toContain("Review requested: Add retry to the widget fetcher");
    expect(task?.task).toContain("You were added as a reviewer");
  });

  test("creates one task when the bot is both mentioned and a reviewer", async () => {
    const event = withPr<PullRequestEvent>(mentionSample, 103);
    event.pullrequest.reviewers = [{ account_id: BOT_ACCOUNT_ID, display_name: "Bot" }];
    const first = await handlePullRequestCreated(event);
    expect(first.created).toBe(true);
    expect((await getTaskById(first.taskId!))?.task).not.toContain("Review requested");
    expect((await handlePullRequestCreated(event)).created).toBe(false);
  });

  test("skips a PR without a bot mention or review request", async () => {
    const event = withPr<PullRequestEvent>(mentionSample, 104);
    event.pullrequest.description = "Just a regular PR.";
    expect((await handlePullRequestCreated(event)).created).toBe(false);
  });

  test("skips a PR opened by the bot itself", async () => {
    const event = withPr<PullRequestEvent>(mentionSample, 105);
    event.pullrequest.author = { account_id: BOT_ACCOUNT_ID, display_name: "Bot" };
    expect((await handlePullRequestCreated(event)).created).toBe(false);
  });

  test("deduplicates a redelivered event", async () => {
    const event = withPr(mentionSample, 106);
    expect((await handlePullRequestCreated(event)).created).toBe(true);
    expect((await handlePullRequestCreated(event)).created).toBe(false);
  });

  test("ignores a payload missing the pull request", async () => {
    expect((await handlePullRequestCreated({ actor: {} })).created).toBe(false);
  });

  test("a skip_event template override suppresses the task", async () => {
    const override = upsertPromptTemplate({
      eventType: "bitbucket.pull_request.opened",
      scope: "global",
      state: "skip_event",
      body: "Skipped body",
    });
    try {
      expect((await handlePullRequestCreated(withPr(mentionSample, 107))).created).toBe(false);
    } finally {
      await deletePromptTemplate(override.id);
    }
  });
});

// ═══════════════════════════════════════════════════════
// pullrequest:comment_created
// ═══════════════════════════════════════════════════════

describe("handlePullRequestCommentCreated", () => {
  test("creates a task for a comment that mentions the bot", async () => {
    const result = await handlePullRequestCommentCreated(commentEvent(commentSample, 201));
    expect(result.created).toBe(true);

    const task = await getTaskById(result.taskId!);
    expect(task?.source).toBe("bitbucket");
    expect(task?.taskType).toBe("bitbucket-comment");
    expect(task?.vcsEventType).toBe("pull_request_comment");
    expect(task?.vcsNumber).toBe(201);
    expect(task?.vcsCommentId).toBe(2010);
    expect(task?.contextKey).toBe(`task:trackers:bitbucket:${REPO_UUID}:pr:201`);
    expect(task?.task).toContain("[Bitbucket Comment on PR #201]");
    expect(task?.task).toContain("can you fix the flaky test?");
    expect(task?.task).not.toContain("File:");
    expect(task?.parentTaskId).toBeFalsy();
  });

  test("an inline comment carries its file and line", async () => {
    const result = await handlePullRequestCommentCreated(commentEvent(commentInlineSample, 202));
    expect(result.created).toBe(true);
    const task = await getTaskById(result.taskId!);
    expect(task?.task).toContain("File: src/fetcher.ts:17");
    expect(task?.task).toContain("this off-by-one looks wrong");
  });

  test("links to the active task for the same PR", async () => {
    const existing = await seedActiveTask(203);
    const result = await handlePullRequestCommentCreated(commentEvent(commentSample, 203));
    expect(result.created).toBe(true);

    const task = await getTaskById(result.taskId!);
    expect(task?.parentTaskId).toBe(existing.id);
    expect(task?.task).toContain(`active task (${existing.id})`);
  });

  test("skips a comment without a bot mention", async () => {
    const event = commentEvent(commentSample, 204, "Looks good to me.");
    expect((await handlePullRequestCommentCreated(event)).created).toBe(false);
  });

  test("skips a comment written by the bot", async () => {
    const event = commentEvent(commentSample, 205);
    event.comment.user = { account_id: BOT_ACCOUNT_ID, display_name: "Bot" };
    expect((await handlePullRequestCommentCreated(event)).created).toBe(false);
  });

  test("matches a typed @name when no bot account id is known", async () => {
    delete process.env.BITBUCKET_BOT_ACCOUNT_ID;
    const event = commentEvent(commentSample, 206, `@${getBitbucketBotName()} please rebase`);
    expect((await handlePullRequestCommentCreated(event)).created).toBe(true);
  });

  test("ignores a payload missing the comment", async () => {
    const event = withPr(mentionSample, 207);
    expect((await handlePullRequestCommentCreated(event)).created).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// pullrequest:fulfilled / pullrequest:rejected
// ═══════════════════════════════════════════════════════

describe("handlePullRequestClosed", () => {
  test("a merge cancels the active task", async () => {
    const existing = await seedActiveTask(301);
    const result = await handlePullRequestClosed(withPr(fulfilledSample, 301), "merged");
    expect(result.created).toBe(false);
    const task = await getTaskById(existing.id);
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toBe("PR was merged");
  });

  test("a decline cancels the active task", async () => {
    const existing = await seedActiveTask(302);
    await handlePullRequestClosed(withPr(rejectedSample, 302), "declined");
    const task = await getTaskById(existing.id);
    expect(task?.status).toBe("failed");
    expect(task?.failureReason).toBe("PR was declined");
  });

  test("a merge cancels every active task for the PR, not only the newest", async () => {
    const prTask = await seedActiveTask(304);
    const commentTask = await createTaskExtended("[Bitbucket PR #304] Comment", {
      source: "bitbucket",
      vcsProvider: "bitbucket",
      vcsRepo: REPO,
      vcsEventType: "pull_request_comment",
      vcsNumber: 304,
      agentId: LEAD_ID,
      parentTaskId: prTask.id,
    });
    await handlePullRequestClosed(withPr(fulfilledSample, 304), "merged");
    for (const id of [prTask.id, commentTask.id]) {
      const task = await getTaskById(id);
      expect(task?.status).toBe("failed");
      expect(task?.failureReason).toBe("PR was merged");
    }
  });

  test("a close with no active task is a no-op", async () => {
    const result = await handlePullRequestClosed(withPr(fulfilledSample, 303), "merged");
    expect(result).toEqual({ created: false });
  });
});

// ═══════════════════════════════════════════════════════
// Delivery dedup and identity resolution
// ═══════════════════════════════════════════════════════

describe("delivery dedup", () => {
  test("a delivery is a duplicate only after it was acked", () => {
    expect(isDuplicateDelivery("req-1")).toBe(false);
    expect(isDuplicateDelivery("req-1")).toBe(false);
    markDeliveryProcessed("req-1");
    expect(isDuplicateDelivery("req-1")).toBe(true);
    expect(isDuplicateDelivery("req-2")).toBe(false);
    expect(isDuplicateDelivery(undefined)).toBe(false);
  });
});

describe("identity resolution", () => {
  const UNMAPPED_NS = "integration:unmapped:bitbucket";

  test("a linked identity populates requestedByUserId", async () => {
    const known = await createUser({ name: "Known Reviewer" });
    const accountId = "557058:22222222-2222-4222-8222-222222222222";
    await linkIdentity(known.id, "bitbucket", accountId, { kind: "system", id: "test" });

    const event = withPr<PullRequestEvent>(mentionSample, 401);
    event.pullrequest.author = { ...event.pullrequest.author, account_id: accountId };
    const result = await handlePullRequestCreated(event);
    const task = await getTaskById(result.taskId!);
    expect(task?.requestedByUserId).toBe(known.id);
  });

  test("an unknown sender is recorded as unmapped", async () => {
    const accountId = "557058:33333333-3333-4333-8333-333333333333";
    const event = withPr<PullRequestEvent>(mentionSample, 402);
    event.pullrequest.author = { ...event.pullrequest.author, account_id: accountId };
    const result = await handlePullRequestCreated(event);
    const task = await getTaskById(result.taskId!);
    expect(task?.requestedByUserId).toBeFalsy();

    const meta = await getKv(UNMAPPED_NS, `${accountId}:meta`);
    expect((meta?.value as Record<string, unknown>).sampleEventType).toBe("pull_request");
    const count = await getKv(UNMAPPED_NS, `${accountId}:count`);
    expect(count?.value).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// Provider scoping and retry after a failed write
// ═══════════════════════════════════════════════════════

describe("same owner/repo on another host", () => {
  async function seedGitHubTask(prId: number) {
    return createTaskExtended(`[GitHub PR #${prId}] Same name, other host`, {
      source: "github",
      vcsProvider: "github",
      vcsRepo: REPO,
      vcsEventType: "pull_request",
      vcsNumber: prId,
      agentId: LEAD_ID,
    });
  }

  test("a Bitbucket merge does not cancel a GitHub task with the same repo and number", async () => {
    const github = await seedGitHubTask(501);
    await handlePullRequestClosed(withPr(fulfilledSample, 501), "merged");
    expect((await getTaskById(github.id))?.status).not.toBe("failed");
  });

  test("a Bitbucket comment does not parent onto a GitHub task with the same repo and number", async () => {
    const github = await seedGitHubTask(502);
    const result = await handlePullRequestCommentCreated(commentEvent(commentSample, 502));
    expect(result.created).toBe(true);
    const task = await getTaskById(result.taskId!);
    expect(task?.parentTaskId).toBeFalsy();
    expect(task?.task).not.toContain(github.id);
  });
});

describe("retry after a failed task insert", () => {
  // A temp trigger makes the next agent_tasks INSERT fail, as a transient DB
  // error would; Bitbucket then retries the delivery after our 5xx.
  function failTaskInserts() {
    getDb().run(
      "CREATE TEMP TRIGGER bb_fail_insert BEFORE INSERT ON agent_tasks BEGIN SELECT RAISE(ABORT, 'injected fault'); END",
    );
  }
  function restoreTaskInserts() {
    getDb().run("DROP TRIGGER IF EXISTS temp.bb_fail_insert");
  }

  test("a PR event that failed to write creates its task on retry", async () => {
    const event = withPr(mentionSample, 601);
    failTaskInserts();
    try {
      await expect(handlePullRequestCreated(event)).rejects.toThrow();
    } finally {
      restoreTaskInserts();
    }
    expect((await handlePullRequestCreated(event)).created).toBe(true);
  });

  test("a comment event that failed to write creates its task on retry", async () => {
    const event = commentEvent(commentSample, 602);
    failTaskInserts();
    try {
      await expect(handlePullRequestCommentCreated(event)).rejects.toThrow();
    } finally {
      restoreTaskInserts();
    }
    expect((await handlePullRequestCommentCreated(event)).created).toBe(true);
  });
});
