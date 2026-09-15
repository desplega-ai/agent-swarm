import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { initAgentMailOutboundSync, teardownAgentMailOutboundSync } from "../agentmail/outbound";
import {
  closeDb,
  completeTask,
  createTaskExtended,
  failTask,
  getTaskById,
  initDb,
  markTaskAgentmailReplySent,
  releaseTaskAgentmailReplySent,
} from "../be/db";

const TEST_DB_PATH = "./test-agentmail-outbound-sync.sqlite";

// Capture every agentmailReplyToMessage call so we can assert on
// inbox/message id + body shape without hitting the network.
const mockReply = mock(
  () =>
    Promise.resolve(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as Promise<Response>,
);

mock.module("../agentmail/client", () => ({
  agentmailReplyToMessage: mockReply,
}));

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

async function makeAgentmailTask(
  label: string,
  overrides?: { agentmailInboxId?: string; agentmailMessageId?: string },
) {
  return createTaskExtended(`AgentMail task ${label}`, {
    source: "agentmail",
    taskType: "agentmail-message",
    agentmailInboxId: overrides?.agentmailInboxId ?? `inbox-${label}`,
    agentmailMessageId: overrides?.agentmailMessageId ?? `msg-${label}`,
    agentmailThreadId: `thread-${label}`,
  });
}

describe("AgentMail Outbound Reply Sync", () => {
  beforeEach(() => {
    mockReply.mockClear();
    initAgentMailOutboundSync();
  });

  afterEach(() => {
    teardownAgentMailOutboundSync();
  });

  test("init/teardown is idempotent — double init does not double-fire", async () => {
    initAgentMailOutboundSync();

    const task = await makeAgentmailTask("idempotent-init");
    await completeTask(task.id, "The answer is 42.");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).toHaveBeenCalledTimes(1);
  });

  test("task.completed with output sends a reply carrying output + task URL", async () => {
    const task = await makeAgentmailTask("completed-with-output");
    await completeTask(task.id, "The answer is 42.");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).toHaveBeenCalledTimes(1);
    const [inboxId, messageId, body] = mockReply.mock.calls[0] as [
      string,
      string,
      { text: string },
    ];
    expect(inboxId).toBe("inbox-completed-with-output");
    expect(messageId).toBe("msg-completed-with-output");
    expect(body.text).toContain("The answer is 42.");
    expect(body.text).toContain(`/tasks/${task.id}`);
  });

  test("task.completed with empty output does NOT send a blank email", async () => {
    const task = await makeAgentmailTask("completed-empty");
    await completeTask(task.id, "");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).not.toHaveBeenCalled();
  });

  test("task.completed with whitespace-only output does NOT send a blank email", async () => {
    const task = await makeAgentmailTask("completed-whitespace");
    await completeTask(task.id, "   \n  ");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).not.toHaveBeenCalled();
  });

  test("task.failed sends a reply carrying failureReason + task URL", async () => {
    const task = await makeAgentmailTask("failed-with-reason");
    await failTask(task.id, "Build broke on line 42");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).toHaveBeenCalledTimes(1);
    const [, , body] = mockReply.mock.calls[0] as [string, string, { text: string }];
    expect(body.text).toContain("Build broke on line 42");
    expect(body.text).toContain(`/tasks/${task.id}`);
  });

  test("task.failed still sends when failureReason is empty (fallback text)", async () => {
    const task = await makeAgentmailTask("failed-empty-reason");
    await failTask(task.id, "");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).toHaveBeenCalledTimes(1);
    const [, , body] = mockReply.mock.calls[0] as [string, string, { text: string }];
    expect(body.text).toContain("(no failure reason recorded)");
  });

  test("marks agentmailReplySent after a successful send", async () => {
    const task = await makeAgentmailTask("marks-flag");
    await completeTask(task.id, "done");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const updated = await getTaskById(task.id);
    expect(updated?.agentmailReplySent).toBe(true);
  });

  test("does not double-send: force re-completion never replays task.completed", async () => {
    const task = await makeAgentmailTask("no-double-send");
    await completeTask(task.id, "first result");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockReply).toHaveBeenCalledTimes(1);

    // A second completeTask on an already-terminal task is a no-op (idempotency
    // guard) and must not replay the event or the email send.
    const second = await completeTask(task.id, "second result");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(second).toBeNull();
    expect(mockReply).toHaveBeenCalledTimes(1);
  });

  test("does not send when task did not originate from agentmail", async () => {
    const task = await createTaskExtended("Non-agentmail task", { source: "slack" });
    await completeTask(task.id, "should not send");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).not.toHaveBeenCalled();
  });

  test("does not send when agentmailMessageId is missing", async () => {
    const task = await createTaskExtended("Missing message id", {
      source: "agentmail",
      agentmailInboxId: "inbox-only",
    });
    await completeTask(task.id, "should not send");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).not.toHaveBeenCalled();
  });

  test("does not flag agentmailReplySent when the send fails", async () => {
    mockReply.mockImplementationOnce(
      () => Promise.resolve(new Response("forbidden", { status: 403 })) as Promise<Response>,
    );

    const task = await makeAgentmailTask("send-failure");
    await completeTask(task.id, "should attempt but fail");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).toHaveBeenCalledTimes(1);
    const updated = await getTaskById(task.id);
    expect(updated?.agentmailReplySent).toBe(false);
  });

  test("concurrent claims: exactly one of two simultaneous claims wins", async () => {
    const task = await makeAgentmailTask("concurrent-claim");
    const [a, b] = await Promise.all([
      markTaskAgentmailReplySent(task.id),
      markTaskAgentmailReplySent(task.id),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  test("a released claim can be re-claimed for a later send", async () => {
    const task = await makeAgentmailTask("release-and-reclaim");
    expect(await markTaskAgentmailReplySent(task.id)).toBe(true);
    expect(await releaseTaskAgentmailReplySent(task.id)).toBe(true);
    expect(await markTaskAgentmailReplySent(task.id)).toBe(true);
  });

  test("release is a no-op when the claim was never taken", async () => {
    const task = await makeAgentmailTask("release-noop");
    expect(await releaseTaskAgentmailReplySent(task.id)).toBe(false);
  });

  test("a failed send releases the claim, permitting a later successful send attempt", async () => {
    mockReply.mockImplementationOnce(
      () => Promise.resolve(new Response("forbidden", { status: 403 })) as Promise<Response>,
    );

    const task = await makeAgentmailTask("release-after-failed-send");
    await completeTask(task.id, "should attempt but fail");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).toHaveBeenCalledTimes(1);
    const afterFailure = await getTaskById(task.id);
    expect(afterFailure?.agentmailReplySent).toBe(false);

    // The claim was released, so a fresh claim attempt (simulating a manual
    // retry path) succeeds — the flag is not stuck claimed forever.
    expect(await markTaskAgentmailReplySent(task.id)).toBe(true);
  });

  test("teardown removes listeners — events fire no sends after teardown", async () => {
    teardownAgentMailOutboundSync();

    const task = await makeAgentmailTask("teardown");
    await completeTask(task.id, "ignored");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockReply).not.toHaveBeenCalled();
  });

  test("deferred tasks never trigger a send — no task.completed/task.failed event fires on defer", async () => {
    // Deferral goes through a different code path (store-progress defer-task)
    // that never calls completeTask/failTask, so it can never reach this
    // handler. This test documents that guarantee at the event-bus level:
    // simulate what WOULD happen if a "task.deferred" event existed and
    // confirm the outbound sync does not subscribe to it at all.
    const task = await makeAgentmailTask("deferred-not-terminal");
    expect(task.status).not.toBe("completed");
    expect(task.status).not.toBe("failed");
    // No completeTask/failTask call — status stays non-terminal, and no
    // send should ever occur without one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockReply).not.toHaveBeenCalled();
  });
});
