import { afterAll, beforeAll, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  findTaskByVcs,
  getTaskById,
  initDb,
} from "../be/db";
import { handlePullRequestCreated, resetBitbucketDedup } from "../bitbucket/handlers";
import { handlePullRequest } from "../github/handlers";
import { GITHUB_BOT_NAME } from "../github/mentions";
import type { PullRequestEvent } from "../github/types";
import { handleMergeRequest } from "../gitlab/handlers";
import type { MergeRequestEvent } from "../gitlab/types";
import mentionSample from "./fixtures/bitbucket/pullrequest-created-mention.json";

// The same `owner/repo` + number can exist on GitHub, GitLab and Bitbucket at
// once. Each host's webhook must act only on its own tasks.
const DB = "./test-vcs-provider-isolation.sqlite";
beforeAll(async () => {
  initDb(DB);
  await createAgent({
    id: crypto.randomUUID(),
    name: "Provider isolation lead",
    status: "idle",
    isLead: true,
  });
  process.env.BITBUCKET_BOT_ACCOUNT_ID = "557058:00000000-0000-4000-8000-0000000000b0";
});
afterAll(async () => {
  closeDb();
  delete process.env.BITBUCKET_BOT_ACCOUNT_ID;
  resetBitbucketDedup();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(DB + suffix).catch(() => {});
});

async function createBitbucketTask(id: number) {
  const event = structuredClone(mentionSample);
  event.pullrequest.id = id;
  const result = await handlePullRequestCreated(event);
  expect(result.created).toBe(true);
  return (await getTaskById(result.taskId!))!;
}

function gitlabMerge(iid: number): MergeRequestEvent {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    user: { id: 1, name: "Test user", username: "review2339", avatar_url: "" },
    project: {
      id: 1,
      name: "widgets",
      path_with_namespace: "acme-ws/widgets",
      web_url: "https://gitlab.com/acme-ws/widgets",
      default_branch: "main",
    },
    object_attributes: {
      id: 101,
      iid,
      title: "Unrelated GitLab MR",
      description: "",
      state: "merged",
      action: "merge",
      source_branch: "feature",
      target_branch: "main",
      url: `https://gitlab.com/acme-ws/widgets/-/merge_requests/${iid}`,
      last_commit: null,
      author_id: 1,
    },
  };
}

function githubEvent(number: number, action: string): PullRequestEvent {
  return {
    action,
    pull_request: {
      number,
      title: "Unrelated GitHub PR",
      body: "Please review",
      html_url: `https://github.com/acme-ws/widgets/pull/${number}`,
      user: { login: "review2339" },
      head: { ref: "feature", sha: "abc123" },
      base: { ref: "main" },
      merged: false,
    },
    repository: { full_name: "acme-ws/widgets", html_url: "https://github.com/acme-ws/widgets" },
    sender: { login: "review2339" },
    assignee: { login: GITHUB_BOT_NAME, id: 2 },
    requested_reviewer: { login: GITHUB_BOT_NAME, id: 2 },
  };
}

test("GitLab merge must not cancel a real Bitbucket task", async () => {
  const task = await createBitbucketTask(701);
  await handleMergeRequest(gitlabMerge(701));
  expect((await getTaskById(task.id))?.status).toBe(task.status);
});

test("GitHub unassignment must not cancel a real Bitbucket task", async () => {
  const task = await createBitbucketTask(702);
  await handlePullRequest(githubEvent(702, "unassigned"));
  expect((await getTaskById(task.id))?.status).toBe(task.status);
});

test("Bitbucket task must not suppress an unrelated GitHub review request", async () => {
  await createBitbucketTask(703);
  const result = await handlePullRequest(githubEvent(703, "review_requested"));
  expect(result.created).toBe(true);
});

test("GitHub lookup still matches a legacy task with no vcsProvider", async () => {
  const legacy = await createTaskExtended("Legacy GitHub PR task", {
    source: "github",
    vcsRepo: "acme-ws/legacy",
    vcsNumber: 704,
  });
  expect(legacy.vcsProvider).toBeUndefined();
  expect((await findTaskByVcs("acme-ws/legacy", 704, "github"))?.id).toBe(legacy.id);
  expect(await findTaskByVcs("acme-ws/legacy", 704, "bitbucket")).toBeNull();
  expect(await findTaskByVcs("acme-ws/legacy", 704, "gitlab")).toBeNull();
});
