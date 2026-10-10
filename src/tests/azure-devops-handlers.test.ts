import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { resetAzureDevOpsBotIdCache } from "../azure-devops/api";
import { AZURE_DEVOPS_BOT_NAME, initAzureDevOps, resetAzureDevOps } from "../azure-devops/auth";
import { handlePullRequestCommented, handlePullRequestCreated } from "../azure-devops/handlers";
import type { PullRequestCommentedEvent, PullRequestCreatedEvent } from "../azure-devops/types";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getKv,
  getTaskById,
  initDb,
} from "../be/db";
import { findUserByExternalId, linkIdentity } from "../be/users";
import { parseContextKey } from "../tasks/context-key";
import commentedSample from "./fixtures/azure-devops/pull-request-commented.json";
import createdSample from "./fixtures/azure-devops/pull-request-created.json";

// Fixtures are the verbatim sample payloads from
// https://learn.microsoft.com/azure/devops/service-hooks/events
const TEST_DB_PATH = "./test-azure-devops-handlers.sqlite";
const BOT_ID = "6f1a4e2b-0c3d-4e5f-8a9b-0c1d2e3f4a5b";
const ENV_KEYS = [
  "AZURE_DEVOPS_WEBHOOK_SECRET",
  "AZURE_DEVOPS_TOKEN",
  "AZURE_DEVOPS_ORG_URL",
  "AZURE_DEVOPS_BOT_ID",
  "AZURE_DEVOPS_DISABLE",
] as const;

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  resetAzureDevOps();
  resetAzureDevOpsBotIdCache();
}

function makeCreatedEvent(
  pullRequestId: number,
  description: string,
  createdBy?: Partial<PullRequestCreatedEvent["resource"]["createdBy"]>,
): PullRequestCreatedEvent {
  const event = structuredClone(createdSample) as unknown as PullRequestCreatedEvent;
  event.resource.pullRequestId = pullRequestId;
  event.resource.description = description;
  if (createdBy) event.resource.createdBy = { ...event.resource.createdBy, ...createdBy };
  return event;
}

function makeCommentedEvent(
  pullRequestId: number,
  content: string,
  overrides: Partial<PullRequestCommentedEvent["resource"]["comment"]> = {},
): PullRequestCommentedEvent {
  const event = structuredClone(commentedSample) as unknown as PullRequestCommentedEvent;
  const { comment, pullRequest } = event.resource;
  pullRequest.pullRequestId = pullRequestId;
  if (pullRequest._links?.web) {
    pullRequest._links.web.href = pullRequest._links.web.href.replace(
      /pullrequest\/\d+/,
      `pullrequest/${pullRequestId}`,
    );
  }
  comment.content = content;
  // The docs sample is an edit; a fresh comment has matching timestamps.
  comment.lastContentUpdatedDate = comment.publishedDate;
  Object.assign(comment, overrides);
  return event;
}

beforeAll(async () => {
  clearEnv();
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
  await createAgent({
    id: "lead-azdo-001",
    name: "AzureDevOpsTestLead",
    status: "idle",
    isLead: true,
  });
});

afterAll(async () => {
  clearEnv();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

afterEach(() => {
  clearEnv();
});

// ═══════════════════════════════════════════════════════
// git.pullrequest.created
// ═══════════════════════════════════════════════════════

describe("handlePullRequestCreated", () => {
  test("creates a task when the description mentions the bot by name", async () => {
    const event = makeCreatedEvent(101, `@${AZURE_DEVOPS_BOT_NAME} please review the retry logic`);

    const result = await handlePullRequestCreated(event);
    expect(result.created).toBe(true);

    const task = await getTaskById(result.taskId!);
    expect(task?.source).toBe("azure-devops");
    expect(task?.vcsProvider).toBe("azure-devops");
    expect(task?.taskType).toBe("azure-devops-pr");
    expect(task?.vcsRepo).toBe("https://dev.azure.com/fabrikam/DefaultCollection/_git/Fabrikam");
    expect(task?.vcsNumber).toBe(101);
    expect(task?.vcsEventType).toBe("pull_request");
    expect(task?.vcsUrl).toBe(
      "https://dev.azure.com/fabrikam/DefaultCollection/_git/Fabrikam/pullrequest/101",
    );
    expect(task?.task).toContain("[Azure DevOps PR #101] my first pull request");
    expect(task?.task).toContain("Branch: mytopic → main");
    expect(task?.task).toContain("Context: please review the retry logic");
    expect(task?.task).toContain("pullRequestId=101");
    expect(task?.task).not.toContain(`@${AZURE_DEVOPS_BOT_NAME}`);
    expect(parseContextKey(task!.contextKey!)).toEqual({
      family: "trackers",
      subFamily: "azure-devops",
      parts: {
        repositoryId: "b1b1b1b1-cccc-dddd-eeee-f2f2f2f2f2f2",
        kind: "pr",
        pullRequestId: 101,
      },
    });
  });

  test("creates a task for an identity-picker mention (@<GUID>)", async () => {
    process.env.AZURE_DEVOPS_BOT_ID = BOT_ID;
    const event = makeCreatedEvent(102, `@<${BOT_ID.toUpperCase()}> can you take this one?`);

    const result = await handlePullRequestCreated(event);
    expect(result.created).toBe(true);

    const task = await getTaskById(result.taskId!);
    expect(task?.task).toContain("Context: can you take this one?");
    expect(task?.task).not.toContain(BOT_ID.toUpperCase());
  });

  test("skips a PR without a bot mention", async () => {
    const result = await handlePullRequestCreated(makeCreatedEvent(103, " - test2\r\n"));
    expect(result.created).toBe(false);
  });

  test("skips a PR opened by the bot itself", async () => {
    process.env.AZURE_DEVOPS_BOT_ID = BOT_ID;
    const event = makeCreatedEvent(104, `@<${BOT_ID}> self-mention`, { id: BOT_ID });
    const result = await handlePullRequestCreated(event);
    expect(result.created).toBe(false);
  });

  test("deduplicates a redelivered event", async () => {
    const event = makeCreatedEvent(105, `@${AZURE_DEVOPS_BOT_NAME} review`);
    expect((await handlePullRequestCreated(event)).created).toBe(true);
    expect((await handlePullRequestCreated(event)).created).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// ms.vss-code.git-pullrequest-comment-event
// ═══════════════════════════════════════════════════════

describe("handlePullRequestCommented", () => {
  test("creates a task for a new comment that mentions the bot", async () => {
    const event = makeCommentedEvent(201, `@${AZURE_DEVOPS_BOT_NAME} also fix the linting`);

    const result = await handlePullRequestCommented(event);
    expect(result.created).toBe(true);

    const task = await getTaskById(result.taskId!);
    expect(task?.source).toBe("azure-devops");
    expect(task?.vcsProvider).toBe("azure-devops");
    expect(task?.taskType).toBe("azure-devops-comment");
    expect(task?.vcsEventType).toBe("pull_request_comment");
    expect(task?.vcsRepo).toBe("https://fabrikam.visualstudio.com/DefaultCollection/_git/Fabrikam");
    expect(task?.vcsNumber).toBe(201);
    expect(task?.vcsCommentId).toBe(2);
    expect(task?.vcsUrl).toBe(
      "https://fabrikam.visualstudio.com/DefaultCollection/_git/Fabrikam/pullrequest/201",
    );
    expect(task?.task).toContain("[Azure DevOps Comment on PR #201]");
    expect(task?.task).toContain("also fix the linting");
    expect(task?.parentTaskId).toBeFalsy();
  });

  test("ignores the docs sample as-is: it is an edited comment", async () => {
    const event = structuredClone(commentedSample) as unknown as PullRequestCommentedEvent;
    event.resource.comment.content = `@${AZURE_DEVOPS_BOT_NAME} edited in`;
    expect((await handlePullRequestCommented(event)).created).toBe(false);
  });

  test("skips comments without a bot mention", async () => {
    const result = await handlePullRequestCommented(makeCommentedEvent(202, "This is my comment."));
    expect(result.created).toBe(false);
  });

  test("skips system comments", async () => {
    const event = makeCommentedEvent(203, `@${AZURE_DEVOPS_BOT_NAME} voted`, {
      commentType: "system",
    });
    expect((await handlePullRequestCommented(event)).created).toBe(false);
  });

  test("skips comments written by the bot", async () => {
    process.env.AZURE_DEVOPS_BOT_ID = BOT_ID;
    const event = makeCommentedEvent(204, `@<${BOT_ID}> note to self`);
    event.resource.comment.author = { ...event.resource.comment.author, id: BOT_ID };
    expect((await handlePullRequestCommented(event)).created).toBe(false);
  });

  test("links to the active task for the same PR", async () => {
    const existing = await createTaskExtended("[Azure DevOps PR #205] Existing", {
      source: "azure-devops",
      vcsProvider: "azure-devops",
      vcsRepo: "https://fabrikam.visualstudio.com/DefaultCollection/_git/Fabrikam",
      vcsEventType: "pull_request",
      vcsNumber: 205,
      agentId: "lead-azdo-001",
    });

    const result = await handlePullRequestCommented(
      makeCommentedEvent(205, `@${AZURE_DEVOPS_BOT_NAME} one more thing`),
    );
    expect(result.created).toBe(true);

    const task = await getTaskById(result.taskId!);
    expect(task?.parentTaskId).toBe(existing.id);
    expect(task?.task).toContain(`active task (${existing.id})`);
  });

  test("likes the comment as the ack when a token is configured", async () => {
    process.env.AZURE_DEVOPS_WEBHOOK_SECRET = "example-test-secret";
    process.env.AZURE_DEVOPS_TOKEN = "example-pat";
    process.env.AZURE_DEVOPS_ORG_URL = "https://dev.azure.com/fabrikam";
    process.env.AZURE_DEVOPS_BOT_ID = BOT_ID;
    initAzureDevOps();

    const calls: Array<{ url: string; method?: string; auth?: string }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: String(input), method: init?.method, auth: headers.Authorization });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    try {
      const result = await handlePullRequestCommented(
        makeCommentedEvent(206, `@<${BOT_ID}> take a look`),
      );
      expect(result.created).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls).toEqual([
      {
        url:
          "https://dev.azure.com/fabrikam/d3d3d3d3-eeee-ffff-aaaa-b4b4b4b4b4b4/_apis/git/repositories/" +
          "c2c2c2c2-dddd-eeee-ffff-a3a3a3a3a3a3/pullRequests/206/threads/5/comments/2/likes?api-version=7.1",
        method: "POST",
        auth: `Basic ${Buffer.from(":example-pat").toString("base64")}`,
      },
    ]);
  });
});

// ═══════════════════════════════════════════════════════
// Identity resolution
// ═══════════════════════════════════════════════════════

describe("identity resolution", () => {
  const UNMAPPED_NS = "integration:unmapped:azure-devops";

  beforeEach(() => {
    process.env.AZURE_DEVOPS_BOT_ID = BOT_ID;
  });

  test("a linked identity populates requestedByUserId", async () => {
    const known = await createUser({ name: "Known Reviewer" });
    await linkIdentity(known.id, "azure-devops", "known@fabrikam.example", {
      kind: "system",
      id: "test",
    });

    const result = await handlePullRequestCreated(
      makeCreatedEvent(301, `@<${BOT_ID}> review`, { uniqueName: "known@fabrikam.example" }),
    );
    const task = await getTaskById(result.taskId!);
    expect(task?.requestedByUserId).toBe(known.id);
  });

  test("an email uniqueName creates and links a user", async () => {
    expect(await findUserByExternalId("azure-devops", "new@fabrikam.example")).toBeNull();

    const result = await handlePullRequestCreated(
      makeCreatedEvent(302, `@<${BOT_ID}> review`, { uniqueName: "new@fabrikam.example" }),
    );
    const linked = await findUserByExternalId("azure-devops", "new@fabrikam.example");
    expect(linked).not.toBeNull();
    const task = await getTaskById(result.taskId!);
    expect(task?.requestedByUserId).toBe(linked!.id);
  });

  test("a non-email uniqueName is recorded as unmapped", async () => {
    const result = await handlePullRequestCreated(
      makeCreatedEvent(303, `@<${BOT_ID}> review`, { uniqueName: "FABRIKAM\\jamal" }),
    );
    const task = await getTaskById(result.taskId!);
    expect(task?.requestedByUserId).toBeFalsy();

    const meta = await getKv(UNMAPPED_NS, "FABRIKAM\\jamal:meta");
    expect((meta?.value as Record<string, unknown>).sampleEventType).toBe("pull_request");
    const count = await getKv(UNMAPPED_NS, "FABRIKAM\\jamal:count");
    expect(count?.value).toBe(1);
  });
});
