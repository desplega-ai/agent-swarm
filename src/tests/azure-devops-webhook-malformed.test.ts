import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";

// A service-hook payload without the resource fields we read must ack with
// 200 {created:false}, not 500. Both the handler and the workflow-event emit
// after it used to dereference the missing pull request.

const realAzureDevOps = await import("../azure-devops");
mock.module("../azure-devops", () => ({
  ...realAzureDevOps,
  isAzureDevOpsEnabled: () => true,
  verifyAzureDevOpsWebhook: () => true,
}));

const { handleWebhooks } = await import("../http/webhooks");
const { workflowEventBus } = await import("../workflows/event-bus");

function fakeReqRes(rawBody: string) {
  const req = {
    method: "POST",
    headers: { authorization: "Basic eDp5" },
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

const cases = [
  {
    name: "git.pullrequest.created with an empty resource",
    body: { eventType: "git.pullrequest.created", resource: {} },
  },
  {
    name: "comment event on resourceVersion 1.0",
    body: {
      eventType: "ms.vss-code.git-pullrequest-comment-event",
      resourceVersion: "1.0",
      resource: {
        id: 3,
        parentCommentId: 0,
        author: { id: "54d125f7-69f7-4191-904f-c5b96b6261c8", displayName: "Jamal Hartnett" },
        content: "@agent-swarm-bot please look",
        publishedDate: "2026-10-01T15:00:00Z",
        commentType: "text",
        _links: {
          pullRequests: {
            href: "https://dev.azure.com/fabrikam/_apis/git/repositories/r/pullRequests/1",
          },
        },
      },
    },
  },
];

let emitted: string[] = [];
let originalEmit: typeof workflowEventBus.emit;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  emitted = [];
  originalEmit = workflowEventBus.emit.bind(workflowEventBus);
  workflowEventBus.emit = ((name: string) => {
    emitted.push(name);
  }) as typeof workflowEventBus.emit;
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  workflowEventBus.emit = originalEmit;
  warn.mockRestore();
});

describe("Azure DevOps webhook with missing resource fields", () => {
  for (const c of cases) {
    test(`${c.name}: returns 200 created:false and emits no workflow event`, async () => {
      const { req, res, captured } = fakeReqRes(JSON.stringify(c.body));
      expect(await handleWebhooks(req, res, ["api", "azure-devops", "webhook"])).toBe(true);
      expect(captured.status).toBe(200);
      expect(JSON.parse(captured.body)).toEqual({ created: false });
      expect(emitted).toEqual([]);
      expect(String(warn.mock.calls[0]?.[0])).toContain("required resource fields are missing");
    });
  }
});
