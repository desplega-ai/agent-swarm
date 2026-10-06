import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TaskCreationBlockedError } from "../tasks/errors";
import azureDevOpsCreatedSample from "./fixtures/azure-devops/pull-request-created.json";

// A pre.task.create extension block must ack the delivery (200, skipped) and
// still emit the delivery's workflow events; any other error stays a 500.

type Outcome = "blocked" | "boom";
let outcome: Outcome = "blocked";

function failingHandler(): Promise<never> {
  if (outcome === "blocked") {
    return Promise.reject(
      new TaskCreationBlockedError("sender not allowed", { id: "ext-1", name: "gate" }),
    );
  }
  return Promise.reject(new Error("db exploded"));
}

const realGithub = await import("../github");
const realGitlab = await import("../gitlab");
const realAzureDevOps = await import("../azure-devops");
mock.module("../github", () => ({
  ...realGithub,
  isGitHubEnabled: () => true,
  verifyWebhookSignature: async () => true,
  handleIssue: failingHandler,
}));
mock.module("../gitlab", () => ({
  ...realGitlab,
  isGitLabEnabled: () => true,
  verifyGitLabWebhook: () => true,
  handleIssue: failingHandler,
}));
mock.module("../azure-devops", () => ({
  ...realAzureDevOps,
  isAzureDevOpsEnabled: () => true,
  verifyAzureDevOpsWebhook: () => true,
  handlePullRequestCreated: failingHandler,
}));

const { handleWebhooks } = await import("../http/webhooks");
const { workflowEventBus } = await import("../workflows/event-bus");

function fakeReqRes(rawBody: string, headers: Record<string, string>) {
  const req = {
    method: "POST",
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(rawBody);
    },
  } as unknown as IncomingMessage;
  const captured = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.body = chunk;
      return this;
    },
  } as unknown as ServerResponse;
  return { req, res, captured };
}

const githubIssue = JSON.stringify({
  action: "opened",
  issue: { number: 7, title: "hi" },
  repository: { full_name: "acme/repo" },
});
const gitlabIssue = JSON.stringify({
  object_kind: "issue",
  object_attributes: { action: "open", iid: 3, title: "hi" },
  project: { path_with_namespace: "acme/repo" },
});
const azureDevOpsPullRequest = JSON.stringify({
  ...azureDevOpsCreatedSample,
  resourceVersion: "2.0",
  resource: {
    ...azureDevOpsCreatedSample.resource,
    description: `@${realAzureDevOps.AZURE_DEVOPS_BOT_NAME} please review`,
  },
});

const cases = [
  {
    name: "GitHub",
    path: ["api", "github", "webhook"],
    body: githubIssue,
    headers: { "x-github-event": "issues", "x-hub-signature-256": "sha256=x" },
    events: ["github.issue.opened"],
  },
  {
    name: "GitLab",
    path: ["api", "gitlab", "webhook"],
    body: gitlabIssue,
    headers: { "x-gitlab-token": "t" },
    events: ["gitlab.issue.opened", "gitlab.issue.open"],
  },
  {
    name: "Azure DevOps",
    path: ["api", "azure-devops", "webhook"],
    body: azureDevOpsPullRequest,
    headers: { authorization: "Basic test" },
    events: ["azure-devops.pull_request.created"],
  },
];

let emitted: string[] = [];
let originalEmit: typeof workflowEventBus.emit;

beforeEach(() => {
  emitted = [];
  originalEmit = workflowEventBus.emit.bind(workflowEventBus);
  workflowEventBus.emit = ((name: string) => {
    emitted.push(name);
  }) as typeof workflowEventBus.emit;
});

afterEach(() => {
  workflowEventBus.emit = originalEmit;
});

describe("webhook task creation blocked by extension", () => {
  for (const c of cases) {
    test(`${c.name}: blocked create returns 200 skipped and still emits the workflow event`, async () => {
      outcome = "blocked";
      const { req, res, captured } = fakeReqRes(c.body, c.headers);
      expect(await handleWebhooks(req, res, c.path)).toBe(true);
      expect(captured.status).toBe(200);
      expect(JSON.parse(captured.body)).toEqual({
        created: false,
        skipped: true,
        reason: "sender not allowed",
        extension: { id: "ext-1", name: "gate" },
      });
      expect(emitted).toEqual(c.events);
    });

    test(`${c.name}: a non-blocked handler error still returns 500`, async () => {
      outcome = "boom";
      const { req, res, captured } = fakeReqRes(c.body, c.headers);
      await handleWebhooks(req, res, c.path);
      expect(captured.status).toBe(500);
      expect(emitted).toEqual([]);
    });
  }
});
