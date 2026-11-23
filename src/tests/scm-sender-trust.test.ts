/**
 * Sender trust for GitLab, Bitbucket and Azure DevOps mention events.
 *
 * A mention creates a lead task only when the sender is a linked swarm user
 * or an allowlisted account, matching the GitHub rule. An unknown sender is
 * still recorded for operator triage, but no task is created.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { resetAzureDevOpsBotIdCache } from "../azure-devops/api";
import { AZURE_DEVOPS_BOT_NAME, resetAzureDevOps } from "../azure-devops/auth";
import { handleWorkItemCreated } from "../azure-devops/boards-sync";
import { handlePullRequestCommented } from "../azure-devops/handlers";
import type { PullRequestCommentedEvent, WorkItemCreatedEvent } from "../azure-devops/types";
import { closeDb, createAgent, createUser, getDbClient, initDb } from "../be/db";
import { findUserByEmail, findUserByExternalId, linkIdentity } from "../be/users";
import { resetBitbucketBotCache } from "../bitbucket/api";
import { resetBitbucket } from "../bitbucket/auth";
import { handlePullRequestCommentCreated, resetBitbucketDedup } from "../bitbucket/handlers";
import type { PullRequestCommentEvent } from "../bitbucket/types";
import { handleComment } from "../github/handlers";
import { GITHUB_BOT_NAME } from "../github/mentions";
import type { CommentEvent } from "../github/types";
import { getGitLabBotName } from "../gitlab/auth";
import { handleNote } from "../gitlab/handlers";
import type { NoteEvent } from "../gitlab/types";
import azureWorkItemSample from "./fixtures/azure-boards/workitem.created.json";
import azureCommentSample from "./fixtures/azure-devops/pull-request-commented.json";
import bitbucketCommentSample from "./fixtures/bitbucket/pullrequest-comment-created.json";

mock.module("../github/app", () => ({
  getInstallationToken: async () => null,
  isReactionsEnabled: () => false,
  initGitHub: () => true,
  resetGitHub: () => {},
  getWebhookSecret: () => null,
  isGitHubEnabled: () => true,
  verifyWebhookSignature: async () => false,
}));

const TEST_DB_PATH = "./test-scm-sender-trust.sqlite";
const LEAD_ID = "lead-scm-sender-trust";
const SETUP_ACTOR = { kind: "system", id: "test:setup" } as const;
const BITBUCKET_BOT = "557058:00000000-0000-4000-8000-0000000000b0";
const AZURE_BOT = "6f1a4e2b-0c3d-4e5f-8a9b-0c1d2e3f4a5b";
const ENV_KEYS = [
  "BITBUCKET_BOT_ACCOUNT_ID",
  "AZURE_DEVOPS_BOT_ID",
  "AZURE_DEVOPS_TOKEN",
  "AZURE_DEVOPS_ORG_URL",
  "GITLAB_ALLOWED_SENDERS",
  "BITBUCKET_ALLOWED_SENDERS",
  "AZURE_DEVOPS_ALLOWED_ACTORS",
  "GITHUB_ALLOWED_SENDERS",
] as const;

beforeAll(async () => {
  for (const s of ["", "-wal", "-shm"]) await unlink(`${TEST_DB_PATH}${s}`).catch(() => {});
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "ScmSenderTrustLead", status: "idle", isLead: true });
});

afterAll(async () => {
  closeDb();
  for (const s of ["", "-wal", "-shm"]) await unlink(`${TEST_DB_PATH}${s}`).catch(() => {});
});

beforeEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.BITBUCKET_BOT_ACCOUNT_ID = BITBUCKET_BOT;
  process.env.AZURE_DEVOPS_BOT_ID = AZURE_BOT;
  await getDbClient().run("DELETE FROM agent_tasks");
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  resetBitbucket();
  resetBitbucketBotCache();
  resetBitbucketDedup();
  resetAzureDevOps();
  resetAzureDevOpsBotIdCache();
});

let nextId = 7000;

async function taskCount(provider: string): Promise<number> {
  const rows = await getDbClient().query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM agent_tasks WHERE vcsProvider = ?",
    [provider],
  );
  return rows[0]?.n ?? 0;
}

function gitlabNote(username: string, email?: string): NoteEvent {
  const id = nextId++;
  return {
    object_kind: "note",
    event_type: "note",
    user: { id, name: username, username, avatar_url: "", ...(email ? { email } : {}) },
    project: {
      id: 1,
      name: "project",
      path_with_namespace: "group/project",
      web_url: "https://gitlab.com/group/project",
      default_branch: "main",
    },
    object_attributes: {
      id,
      note: `@${getGitLabBotName()} please look`,
      noteable_type: "MergeRequest",
      noteable_id: id,
      url: `https://gitlab.com/group/project/-/merge_requests/${id}#note_${id}`,
      author_id: id,
      type: null,
    },
    merge_request: {
      id,
      iid: id,
      title: "MR",
      description: "",
      state: "opened",
      action: "open",
      source_branch: "feature",
      target_branch: "main",
      url: `https://gitlab.com/group/project/-/merge_requests/${id}`,
      last_commit: null,
      author_id: id,
    },
  } as NoteEvent;
}

function bitbucketComment(accountId: string): PullRequestCommentEvent {
  const id = nextId++;
  const event = structuredClone(bitbucketCommentSample) as unknown as PullRequestCommentEvent;
  event.pullrequest.id = id;
  event.comment.id = id * 10;
  event.comment.content.raw = `@{${BITBUCKET_BOT}} please look`;
  const account = { ...event.comment.user!, account_id: accountId, uuid: `{${accountId}}` };
  event.comment.user = account;
  event.actor = account;
  return event;
}

function azureComment(uniqueName: string): PullRequestCommentedEvent {
  const id = nextId++;
  const event = structuredClone(azureCommentSample) as unknown as PullRequestCommentedEvent;
  const { comment, pullRequest } = event.resource;
  pullRequest.pullRequestId = id;
  comment.id = id;
  comment.content = `@${AZURE_DEVOPS_BOT_NAME} please look`;
  comment.lastContentUpdatedDate = comment.publishedDate;
  comment.author = { ...comment.author, id: `id-${uniqueName}`, uniqueName };
  return event;
}

function azureWorkItem(changedBy: string): WorkItemCreatedEvent {
  const id = nextId++;
  const event = structuredClone(azureWorkItemSample) as unknown as WorkItemCreatedEvent;
  event.id = `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`;
  event.resource.id = id;
  event.resource.fields["System.ChangedBy"] = changedBy;
  event.resource.fields["System.Description"] = `@${AZURE_DEVOPS_BOT_NAME} please look`;
  return event;
}

function githubComment(login: string): CommentEvent {
  const id = nextId++;
  return {
    action: "created",
    comment: {
      id,
      body: `@${GITHUB_BOT_NAME} please look`,
      html_url: `https://github.com/test/repo/issues/10#issuecomment-${id}`,
      user: { login },
      author_association: "NONE",
    },
    issue: { number: 10, title: "Issue", html_url: "https://github.com/test/repo/issues/10" },
    repository: { full_name: "test/repo", html_url: "https://github.com/test/repo" },
    sender: { login },
  };
}

describe("unknown senders do not create tasks", () => {
  test("GitLab note from an unlinked user without an email", async () => {
    const result = await handleNote(gitlabNote("gl-stranger"));
    expect(result.created).toBe(false);
    expect(await taskCount("gitlab")).toBe(0);
  });

  test("Bitbucket PR comment from an unlinked account", async () => {
    const result = await handlePullRequestCommentCreated(bitbucketComment("557058:stranger"));
    expect(result.created).toBe(false);
    expect(await taskCount("bitbucket")).toBe(0);
  });

  test("Azure DevOps PR comment from an unlinked identity", async () => {
    const result = await handlePullRequestCommented(azureComment("stranger"));
    expect(result.created).toBe(false);
    expect(await taskCount("azure-devops")).toBe(0);
  });

  test("GitLab sender with an email no user owns is not linked, so a second mention is refused too", async () => {
    for (let i = 0; i < 2; i++) {
      const result = await handleNote(gitlabNote("gl-emailer", "gl-emailer@example.test"));
      expect(result.created).toBe(false);
    }
    expect(await findUserByExternalId("gitlab", "gl-emailer")).toBeNull();
    expect(await findUserByEmail("gl-emailer@example.test")).toBeNull();
  });
});

describe("allowlisted senders create tasks", () => {
  test("GITLAB_ALLOWED_SENDERS", async () => {
    process.env.GITLAB_ALLOWED_SENDERS = "other, GL-Allowed";
    expect((await handleNote(gitlabNote("gl-allowed"))).created).toBe(true);
  });

  test("BITBUCKET_ALLOWED_SENDERS", async () => {
    process.env.BITBUCKET_ALLOWED_SENDERS = "557058:allowed";
    expect(
      (await handlePullRequestCommentCreated(bitbucketComment("557058:allowed"))).created,
    ).toBe(true);
  });

  test("AZURE_DEVOPS_ALLOWED_ACTORS", async () => {
    process.env.AZURE_DEVOPS_ALLOWED_ACTORS = "allowed-az@example.test";
    expect(
      (await handlePullRequestCommented(azureComment("allowed-az@example.test"))).created,
    ).toBe(true);
  });

  test("AZURE_DEVOPS_ALLOWED_ACTORS name without an email creates a task with no linked user", async () => {
    process.env.AZURE_DEVOPS_ALLOWED_ACTORS = "CONTOSO\\az-builder";
    const result = await handlePullRequestCommented(azureComment("contoso\\az-builder"));
    expect(result.created).toBe(true);
    expect(await findUserByExternalId("azure-devops", "contoso\\az-builder")).toBeNull();
  });

  test("AZURE_DEVOPS_ALLOWED_ACTORS name without an email creates a Boards task", async () => {
    process.env.AZURE_DEVOPS_ORG_URL = "https://dev.azure.com/acme-org";
    const changedBy = "Builder <CONTOSO\\az-builder>";
    expect((await handleWorkItemCreated(azureWorkItem(changedBy))).created).toBe(false);
    process.env.AZURE_DEVOPS_ALLOWED_ACTORS = "contoso\\az-builder";
    expect((await handleWorkItemCreated(azureWorkItem(changedBy))).created).toBe(true);
  });
});

describe("controls", () => {
  test("GitHub comment from an unlinked NONE author creates no task", async () => {
    const result = await handleComment(githubComment("gh-stranger"));
    expect(result.created).toBe(false);
  });

  test("GitLab note from a linked user creates a task", async () => {
    const user = await createUser({ name: "Linked GL", email: "linked-gl@example.test" });
    await linkIdentity(user.id, "gitlab", "gl-linked", SETUP_ACTOR);
    const result = await handleNote(gitlabNote("gl-linked"));
    expect(result.created).toBe(true);
  });

  test("Bitbucket comment from a linked account creates a task", async () => {
    const user = await createUser({ name: "Linked BB", email: "linked-bb@example.test" });
    await linkIdentity(user.id, "bitbucket", "557058:linked", SETUP_ACTOR);
    const result = await handlePullRequestCommentCreated(bitbucketComment("557058:linked"));
    expect(result.created).toBe(true);
  });

  test("Azure DevOps comment from a linked identity creates a task", async () => {
    const user = await createUser({ name: "Linked AZ", email: "linked-az@example.test" });
    await linkIdentity(user.id, "azure-devops", "linked-az@example.test", SETUP_ACTOR);
    const result = await handlePullRequestCommented(azureComment("linked-az@example.test"));
    expect(result.created).toBe(true);
  });
});
