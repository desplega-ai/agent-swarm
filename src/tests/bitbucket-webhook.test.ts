import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { closeDb, createAgent, getTaskById, initDb } from "../be/db";
import { resetBitbucketBotCache } from "../bitbucket/api";
import { initBitbucket, resetBitbucket } from "../bitbucket/auth";
import { resetBitbucketDedup } from "../bitbucket/handlers";
import { handleWebhooks } from "../http/webhooks";
import { workflowEventBus } from "../workflows/event-bus";
import commentSample from "./fixtures/bitbucket/pullrequest-comment-created.json";

// End-to-end through the HTTP dispatch block: signature, delivery dedup,
// event routing and workflow events, with the real handlers and a test DB.
const TEST_DB_PATH = "./test-bitbucket-webhook.sqlite";
const SECRET = "example-webhook-secret";
const PATH = ["api", "bitbucket", "webhook"];

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

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
    setHeader() {},
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

async function deliver(rawBody: string, headers: Record<string, string>) {
  const { req, res, captured } = fakeReqRes(rawBody, headers);
  expect(await handleWebhooks(req, res, PATH)).toBe(true);
  return { status: captured.status, body: captured.body ? JSON.parse(captured.body) : null };
}

function commentBody(prId: number): string {
  const event = structuredClone(commentSample);
  event.pullrequest.id = prId;
  event.comment.id = prId * 10;
  return JSON.stringify(event);
}

let emitted: Array<{ name: string; payload: unknown }> = [];
let originalEmit: typeof workflowEventBus.emit;

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
  await createAgent({ id: "lead-bb-webhook", name: "BBWebhookLead", status: "idle", isLead: true });
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
  process.env.BITBUCKET_WEBHOOK_SECRET = SECRET;
  process.env.BITBUCKET_BOT_ACCOUNT_ID = "557058:00000000-0000-4000-8000-0000000000b0";
  initBitbucket();
  emitted = [];
  originalEmit = workflowEventBus.emit.bind(workflowEventBus);
  workflowEventBus.emit = ((name: string, payload: unknown) => {
    // task.created and other lifecycle events fire too; keep the webhook's own.
    if (name.startsWith("bitbucket.")) emitted.push({ name, payload });
  }) as typeof workflowEventBus.emit;
});

afterEach(() => {
  workflowEventBus.emit = originalEmit;
  delete process.env.BITBUCKET_WEBHOOK_SECRET;
  delete process.env.BITBUCKET_BOT_ACCOUNT_ID;
  delete process.env.BITBUCKET_DISABLE;
  resetBitbucket();
  resetBitbucketBotCache();
  resetBitbucketDedup();
});

describe("POST /api/bitbucket/webhook", () => {
  test("503 when the integration is disabled", async () => {
    process.env.BITBUCKET_DISABLE = "true";
    const body = commentBody(1);
    const res = await deliver(body, { "x-hub-signature": sign(body) });
    expect(res.status).toBe(503);
  });

  test("401 on a bad signature, 200 on the correct one", async () => {
    const body = commentBody(2);
    const headers = { "x-event-key": "pullrequest:comment_created", "x-request-uuid": "r-2" };
    const bad = await deliver(body, { ...headers, "x-hub-signature": sign(body, "wrong") });
    expect(bad.status).toBe(401);
    const missing = await deliver(body, headers);
    expect(missing.status).toBe(401);
    const good = await deliver(body, { ...headers, "x-hub-signature": sign(body) });
    expect(good.status).toBe(200);
    expect(good.body.created).toBe(true);
  });

  test("a signed comment creates a task and emits the workflow event", async () => {
    const body = commentBody(3);
    const res = await deliver(body, {
      "x-event-key": "pullrequest:comment_created",
      "x-request-uuid": "r-3",
      "x-hub-signature": sign(body),
    });
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);
    const task = await getTaskById(res.body.taskId);
    expect(task?.source).toBe("bitbucket");
    expect(task?.contextKey).toStartWith("task:trackers:bitbucket:");

    expect(emitted).toEqual([
      {
        name: "bitbucket.pull_request.commented",
        payload: {
          repo: "acme-ws/widgets",
          number: 3,
          body: "@{557058:00000000-0000-4000-8000-0000000000b0} can you fix the flaky test?",
          action: "commented",
          user_login: "557058:11111111-1111-4111-8111-111111111111",
        },
      },
    ]);
  });

  test("a replayed X-Request-UUID is acked without a second task or event", async () => {
    const body = commentBody(4);
    const headers = {
      "x-event-key": "pullrequest:comment_created",
      "x-request-uuid": "r-4",
      "x-hub-signature": sign(body),
    };
    expect((await deliver(body, headers)).body.created).toBe(true);
    emitted = [];
    const replay = await deliver(body, headers);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ created: false });
    expect(emitted).toEqual([]);
  });

  test("an unsupported event key is acked and ignored", async () => {
    const body = commentBody(5);
    const res = await deliver(body, {
      "x-event-key": "repo:push",
      "x-request-uuid": "r-5",
      "x-hub-signature": sign(body),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: false });
    expect(emitted).toEqual([]);
  });

  test("a payload missing the pull request acks with created:false and no event", async () => {
    const body = JSON.stringify({ actor: {}, repository: {} });
    const res = await deliver(body, {
      "x-event-key": "pullrequest:fulfilled",
      "x-request-uuid": "r-6",
      "x-hub-signature": sign(body),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ created: false });
    expect(emitted).toEqual([]);
  });

  test("413 on a declared Content-Length over 1 MiB, before any signature check", async () => {
    const body = commentBody(7);
    const res = await deliver(body, {
      "content-length": String(1024 * 1024 + 1),
      "x-event-key": "pullrequest:comment_created",
      "x-hub-signature": sign(body),
    });
    expect(res.status).toBe(413);
    expect(emitted).toEqual([]);
  });

  test("413 on a streamed body over 1 MiB with no Content-Length", async () => {
    const chunk = Buffer.alloc(512 * 1024, "a");
    const req = {
      method: "POST",
      headers: { "x-event-key": "pullrequest:comment_created", "x-hub-signature": "sha256=00" },
      async *[Symbol.asyncIterator]() {
        yield chunk;
        yield chunk;
        yield chunk;
      },
    } as unknown as IncomingMessage;
    const { res, captured } = fakeReqRes("", {});
    expect(await handleWebhooks(req, res, PATH)).toBe(true);
    expect(captured.status).toBe(413);
    expect(emitted).toEqual([]);
  });

  test("400 on a signed but non-JSON body", async () => {
    const body = "not json";
    const res = await deliver(body, { "x-hub-signature": sign(body) });
    expect(res.status).toBe(400);
  });
});
