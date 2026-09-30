import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { webApi } from "@slack/bolt";
import {
  cancelTask,
  closeDb,
  completeTask,
  createAgent,
  createApprovalRequest,
  createTaskExtended,
  getDbClient,
  initDb,
  resolveApprovalRequest,
  startTask,
} from "../be/db";
import {
  _resetSlackSessionStatusForTests,
  _setSlackSessionStatusTimeoutForTests,
  beginSlackStatusTick,
  markSlackSessionProcessing,
  reconcileSlackSessionStatus,
} from "../slack/session-status";
import { slackContextKey } from "../tasks/context-key";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-slack-session-status.sqlite";

type Call = { method: string; payload: Record<string, unknown> };
const calls: Call[] = [];
let failWith: unknown;

const client = {
  apiCall: async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (failWith !== undefined && method === "agents.sessions.setStatus") throw failWith;
    return { ok: true };
  },
} as unknown as Parameters<typeof reconcileSlackSessionStatus>[0]["client"];

let app: { client: typeof client } | null = { client };
mock.module("../slack/app", () => ({ getSlackApp: () => app }));

const statusCalls = () =>
  calls.filter((call) => call.method === "agents.sessions.setStatus").map((c) => c.payload.status);

let leadId: string;
let sequence = 0;

function address(prefix = "C_STATUS"): { channelId: string; threadTs: string } {
  sequence++;
  return { channelId: `${prefix}_${sequence}`, threadTs: `${1_800_000_000 + sequence}.000001` };
}

async function slackTask(
  channelId: string,
  threadTs: string,
  options?: { start?: boolean },
): Promise<string> {
  const task = await createTaskExtended("ask", {
    agentId: leadId,
    source: "slack",
    slackChannelId: channelId,
    slackThreadTs: threadTs,
    contextKey: slackContextKey({ channelId, threadTs }),
  });
  if (options?.start) await startTask(task.id);
  return task.id;
}

const reconcile = (a: { channelId: string; threadTs: string }, extra?: object) =>
  reconcileSlackSessionStatus({ ...a, client, ...extra });

let warn: ReturnType<typeof spyOn>;

beforeAll(async () => {
  initDb(TEST_DB_PATH);
  leadId = (await createAgent({ name: "StatusLead", isLead: true, status: "idle" })).id;
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"])
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
});

beforeEach(async () => {
  // Open human requests are global to the sweep, so one test's must not leak into the next.
  await getDbClient().run("DELETE FROM approval_requests");
  calls.length = 0;
  failWith = undefined;
  app = { client };
  _resetSlackSessionStatusForTests();
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("lifecycle of one ask", () => {
  test("sets processing on accept in a channel thread, holds it, clears it when the ask ends", async () => {
    const thread = address("C_CHANNEL");
    const taskId = await slackTask(thread.channelId, thread.threadTs);

    await reconcile(thread);
    expect(calls[0]).toEqual({
      method: "agents.sessions.setStatus",
      payload: { channel_id: thread.channelId, thread_ts: thread.threadTs, status: "processing" },
    });

    // Every later render tick is a no-op while nothing changes.
    await reconcile(thread);
    await startTask(taskId);
    await reconcile(thread);
    expect(statusCalls()).toEqual(["processing"]);

    await completeTask(taskId, "Done");
    await reconcile(thread, { outcomeDelivered: true });
    expect(statusCalls()).toEqual(["processing", "active"]);

    // Cleared once: further ticks stay quiet, and no legacy call was needed.
    await reconcile(thread);
    expect(statusCalls()).toEqual(["processing", "active"]);
    expect(calls.some((call) => call.method === "assistant.threads.setStatus")).toBe(false);
  });

  test("works the same in a DM thread", async () => {
    const thread = address("D_DM");
    await slackTask(thread.channelId, thread.threadTs, { start: true });
    await reconcile(thread);
    expect(statusCalls()).toEqual(["processing"]);
  });

  test("stays processing while another task in the thread still runs", async () => {
    const thread = address();
    const first = await slackTask(thread.channelId, thread.threadTs, { start: true });
    await reconcile(thread);
    const second = await slackTask(thread.channelId, thread.threadTs, { start: true });

    await completeTask(first, "first done");
    await reconcile(thread, { outcomeDelivered: true });
    expect(statusCalls()).toEqual(["processing"]);

    await completeTask(second, "second done");
    await reconcile(thread, { outcomeDelivered: true });
    expect(statusCalls()).toEqual(["processing", "active"]);
  });

  test("a cancelled ask clears the status too", async () => {
    const thread = address();
    const taskId = await slackTask(thread.channelId, thread.threadTs, { start: true });
    await reconcile(thread);
    await cancelTask(taskId, "stopped");
    await reconcile(thread);
    expect(statusCalls()).toEqual(["processing", "active"]);
  });

  test("re-asserts processing before Slack's one-hour timeout, not before", async () => {
    const thread = address();
    await slackTask(thread.channelId, thread.threadTs, { start: true });
    const realNow = Date.now();
    const now = spyOn(Date, "now");
    try {
      now.mockReturnValue(realNow);
      await reconcile(thread);
      now.mockReturnValue(realNow + 29 * 60_000);
      await reconcile(thread);
      expect(statusCalls()).toEqual(["processing"]);

      now.mockReturnValue(realNow + 31 * 60_000);
      await reconcile(thread);
      expect(statusCalls()).toEqual(["processing", "processing"]);

      // The refresh restarts the clock.
      now.mockReturnValue(realNow + 50 * 60_000);
      await reconcile(thread);
      expect(statusCalls()).toEqual(["processing", "processing"]);
    } finally {
      now.mockRestore();
    }
  });
});

describe("waiting on a human", () => {
  test("shows suspended while a request from the thread is open, then clears", async () => {
    const thread = address();
    const taskId = await slackTask(thread.channelId, thread.threadTs, { start: true });
    await reconcile(thread);
    const requestId = crypto.randomUUID();
    await createApprovalRequest({
      id: requestId,
      title: "Ship it?",
      questions: [{ id: "q", type: "approval", label: "Ship it?" }],
      approvers: { users: [], roles: [], policy: "any" },
      sourceTaskId: taskId,
    });
    // The asking task is still running, so the swarm is not yet waiting on anyone.
    await reconcile(thread);
    expect(statusCalls()).toEqual(["processing"]);

    await completeTask(taskId, "Asked for approval.");
    await reconcile(thread);
    expect(statusCalls()).toEqual(["processing", "suspended"]);

    await resolveApprovalRequest(requestId, { status: "approved", resolvedBy: "someone" });
    await reconcile(thread);
    expect(statusCalls()).toEqual(["processing", "suspended", "active"]);
  });

  test("the tick sweep finds a waiting thread whose tree is no longer rendered", async () => {
    const thread = address();
    const taskId = await slackTask(thread.channelId, thread.threadTs, { start: true });
    await createApprovalRequest({
      id: crypto.randomUUID(),
      title: "Which one?",
      questions: [{ id: "q", type: "text", label: "Which one?" }],
      approvers: { users: [], roles: [], policy: "any" },
      sourceTaskId: taskId,
    });
    await completeTask(taskId, "Waiting for the answer.");

    await beginSlackStatusTick().finish();
    expect(statusCalls()).toEqual(["suspended"]);
    expect(calls[0]?.payload.thread_ts).toBe(thread.threadTs);
  });

  test("an expired request no longer counts as waiting", async () => {
    const thread = address();
    const taskId = await slackTask(thread.channelId, thread.threadTs, { start: true });
    await createApprovalRequest({
      id: crypto.randomUUID(),
      title: "Old",
      questions: [{ id: "q", type: "text", label: "Old" }],
      approvers: { users: [], roles: [], policy: "any" },
      sourceTaskId: taskId,
      timeoutSeconds: 3_600,
    });
    await completeTask(taskId, "Waiting.");
    await getDbClient().run("UPDATE approval_requests SET expiresAt = ?", [
      new Date(Date.now() - 1_000).toISOString(),
    ]);
    await reconcile(thread);
    expect(statusCalls()).toEqual([]);
  });
});

describe("fallbacks: the call fails, the task never does", () => {
  test("a missing scope is logged once, disables the native call, and a DM falls back to the legacy clear", async () => {
    failWith = { data: { error: "missing_scope" } };
    const dm = address("D_FALLBACK");
    const channel = address("C_FALLBACK");
    const dmTask = await slackTask(dm.channelId, dm.threadTs, { start: true });
    await slackTask(channel.channelId, channel.threadTs, { start: true });

    await expect(reconcile(dm)).resolves.toBeUndefined();
    await expect(reconcile(channel)).resolves.toBeUndefined();
    // One refused call; the second thread never tried the native method.
    expect(statusCalls()).toEqual(["processing"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("missing_scope");
    expect(String(warn.mock.calls[0]?.[0])).toContain("chat:write");

    await completeTask(dmTask, "done");
    await reconcile(dm, { outcomeDelivered: true });
    expect(
      calls.filter((call) => call.method === "assistant.threads.setStatus").map((c) => c.payload),
    ).toEqual([{ channel_id: dm.channelId, thread_ts: dm.threadTs, status: "" }]);
    // Channels have no legacy indicator to fall back to.
    await reconcile(channel, { outcomeDelivered: true });
    expect(calls.filter((call) => call.method === "assistant.threads.setStatus")).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("the workspace is probed again after the cooldown", async () => {
    failWith = { data: { error: "feature_disabled" } };
    const thread = address();
    await slackTask(thread.channelId, thread.threadTs, { start: true });
    const realNow = Date.now();
    const now = spyOn(Date, "now");
    try {
      now.mockReturnValue(realNow);
      await reconcile(thread);
      expect(statusCalls()).toEqual(["processing"]);

      failWith = undefined;
      now.mockReturnValue(realNow + 30 * 60_000);
      await reconcile(thread);
      expect(statusCalls()).toEqual(["processing"]);

      now.mockReturnValue(realNow + 61 * 60_000);
      await reconcile(thread);
      // The probe succeeded, so the thread is back on the normal cadence.
      await reconcile(thread);
      expect(statusCalls()).toEqual(["processing", "processing"]);
    } finally {
      now.mockRestore();
    }
  });

  test("a thread Slack refuses is left alone without blocking other threads", async () => {
    const refused = address();
    const fine = address();
    await slackTask(refused.channelId, refused.threadTs, { start: true });
    await slackTask(fine.channelId, fine.threadTs, { start: true });

    failWith = { data: { error: "not_in_channel" } };
    await reconcile(refused);
    failWith = undefined;
    await reconcile(refused);
    await reconcile(refused);
    expect(statusCalls()).toEqual(["processing"]);
    expect(warn).toHaveBeenCalledTimes(1);

    await reconcile(fine);
    expect(statusCalls()).toEqual(["processing", "processing"]);
  });

  test("a transient failure backs off and then recovers", async () => {
    const thread = address();
    await slackTask(thread.channelId, thread.threadTs, { start: true });
    const realNow = Date.now();
    const now = spyOn(Date, "now");
    try {
      now.mockReturnValue(realNow);
      failWith = { data: { error: "internal_error" } };
      await reconcile(thread);
      failWith = undefined;
      now.mockReturnValue(realNow + 5_000);
      await reconcile(thread);
      expect(statusCalls()).toEqual(["processing"]);

      now.mockReturnValue(realNow + 31_000);
      await reconcile(thread);
      // Recovered: no backoff left, and the next tick is quiet again.
      await reconcile(thread);
      expect(statusCalls()).toEqual(["processing", "processing"]);
    } finally {
      now.mockRestore();
    }
  });

  test("an error with no Slack verdict never escapes", async () => {
    failWith = new Error("socket hang up");
    const thread = address();
    await slackTask(thread.channelId, thread.threadTs, { start: true });
    await expect(reconcile(thread)).resolves.toBeUndefined();
    await expect(markSlackSessionProcessing({ ...thread, client })).resolves.toBe(false);
  });

  test("no Slack app at all is a no-op", async () => {
    app = null;
    const thread = address();
    await slackTask(thread.channelId, thread.threadTs, { start: true });
    await expect(reconcileSlackSessionStatus(thread)).resolves.toBeUndefined();
    await expect(markSlackSessionProcessing(thread)).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("markSlackSessionProcessing", () => {
  test("marks before a task row exists and reports whether native status took it", async () => {
    const thread = address("D_MARK");
    await expect(markSlackSessionProcessing({ ...thread, client })).resolves.toBe(true);
    await expect(markSlackSessionProcessing({ ...thread, client })).resolves.toBe(true);
    expect(statusCalls()).toEqual(["processing"]);

    failWith = { data: { error: "missing_scope" } };
    const other = address("D_MARK");
    await expect(markSlackSessionProcessing({ ...other, client })).resolves.toBe(false);
  });
});

describe("tick sweep", () => {
  test("clears a thread this process marked whose task never arrived, sparing a fresh mark for the grace window", async () => {
    const stale = address();
    const fresh = address();
    const realNow = Date.now();
    const now = spyOn(Date, "now");
    try {
      now.mockReturnValue(realNow - 5 * 60_000);
      await markSlackSessionProcessing(stale);
      now.mockReturnValue(realNow);
      await markSlackSessionProcessing(fresh);
      calls.length = 0;

      await beginSlackStatusTick().finish();
      expect(calls.map((call) => [call.payload.thread_ts, call.payload.status])).toEqual([
        [stale.threadTs, "active"],
      ]);

      now.mockReturnValue(realNow + 3 * 60_000);
      await beginSlackStatusTick().finish();
      expect(calls.map((call) => [call.payload.thread_ts, call.payload.status])).toEqual([
        [stale.threadTs, "active"],
        [fresh.threadTs, "active"],
      ]);
    } finally {
      now.mockRestore();
    }
  });

  test("does not touch a thread the tick already reconciled", async () => {
    const thread = address();
    await slackTask(thread.channelId, thread.threadTs, { start: true });
    const tick = beginSlackStatusTick();
    await tick.reconcile(thread.channelId, thread.threadTs);
    await tick.finish();
    expect(statusCalls()).toEqual(["processing"]);
  });

  test("spends at most eight Slack calls per tick and finishes the rest on the next", async () => {
    const threads = [];
    for (let i = 0; i < 12; i++) {
      const thread = address();
      await slackTask(thread.channelId, thread.threadTs, { start: true });
      threads.push(thread);
    }
    const first = beginSlackStatusTick();
    for (const thread of threads) await first.reconcile(thread.channelId, thread.threadTs);
    expect(statusCalls()).toHaveLength(8);

    const second = beginSlackStatusTick();
    for (const thread of threads) await second.reconcile(thread.channelId, thread.threadTs);
    expect(statusCalls()).toHaveLength(12);
  });
});

/** A Slack whose status writes can be held mid-flight and applied only when released. */
function remoteSlack() {
  const held: Array<{ release: () => void; drop: () => void }> = [];
  let holdNext = 0;
  const state = { remote: "none" };
  const apiCall = async (method: string, payload: Record<string, unknown>) => {
    calls.push({ method, payload });
    if (method !== "agents.sessions.setStatus") return { ok: true };
    const status = String(payload.status);
    if (holdNext > 0) {
      holdNext--;
      await new Promise<void>((resolve, reject) => {
        held.push({
          release: () => {
            state.remote = status;
            resolve();
          },
          drop: () => reject(new Error("socket hang up")),
        });
      });
      return { ok: true };
    }
    state.remote = status;
    return { ok: true };
  };
  return {
    client: { apiCall } as unknown as NonNullable<typeof client>,
    state,
    held,
    holdNext: () => {
      holdNext++;
    },
  };
}

async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

describe("a status write that gets no answer", () => {
  test("a write that lands after its timeout cannot leave the thread stuck on working", async () => {
    _setSlackSessionStatusTimeoutForTests(30);
    const slack = remoteSlack();
    const thread = address();
    const taskId = await slackTask(thread.channelId, thread.threadTs, { start: true });

    slack.holdNext();
    await reconcileSlackSessionStatus({ ...thread, client: slack.client });
    expect(statusCalls()).toEqual(["processing"]);
    expect(slack.state.remote).toBe("none");

    // The ask ends while the request is still out, then the request lands.
    await completeTask(taskId, "Done");
    await reconcileSlackSessionStatus({ ...thread, client: slack.client, outcomeDelivered: true });
    slack.held[0]?.release();
    expect(slack.state.remote).toBe("processing");

    await waitFor(() => slack.state.remote === "active");
    expect(slack.state.remote).toBe("active");
    expect(statusCalls()).toEqual(["processing", "active"]);
  });

  test("a write Slack may have applied is cleared at the end of the ask, not skipped as already clear", async () => {
    _setSlackSessionStatusTimeoutForTests(30);
    const slack = remoteSlack();
    const thread = address();
    const taskId = await slackTask(thread.channelId, thread.threadTs, { start: true });
    const realNow = Date.now();
    const now = spyOn(Date, "now");
    try {
      now.mockReturnValue(realNow);
      slack.holdNext();
      await reconcileSlackSessionStatus({ ...thread, client: slack.client });

      await completeTask(taskId, "Done");
      now.mockReturnValue(realNow + 31_000);
      await reconcileSlackSessionStatus({ ...thread, client: slack.client });
      expect(statusCalls()).toEqual(["processing", "active"]);
      expect(slack.state.remote).toBe("active");

      // Once answered the thread is known to be clear, so it stays quiet.
      await reconcileSlackSessionStatus({ ...thread, client: slack.client });
      expect(statusCalls()).toEqual(["processing", "active"]);
    } finally {
      now.mockRestore();
      slack.held[0]?.drop();
    }
  });

  test("a clear that lands late does not wipe the status of a newer task", async () => {
    _setSlackSessionStatusTimeoutForTests(30);
    const slack = remoteSlack();
    const thread = address();
    const first = await slackTask(thread.channelId, thread.threadTs, { start: true });
    const realNow = Date.now();
    const now = spyOn(Date, "now");
    try {
      now.mockReturnValue(realNow);
      await reconcileSlackSessionStatus({ ...thread, client: slack.client });
      await completeTask(first, "Done");
      slack.holdNext();
      await reconcileSlackSessionStatus({
        ...thread,
        client: slack.client,
        outcomeDelivered: true,
      });

      await slackTask(thread.channelId, thread.threadTs, { start: true });
      now.mockReturnValue(realNow + 31_000);
      await reconcileSlackSessionStatus({ ...thread, client: slack.client });
      expect(slack.state.remote).toBe("processing");

      slack.held[0]?.release();
      expect(slack.state.remote).toBe("active");
      await waitFor(() => slack.state.remote === "processing");
      expect(slack.state.remote).toBe("processing");
    } finally {
      now.mockRestore();
    }
  });

  describe("against a real Slack client", () => {
    let server: Server;
    let port = 0;
    let setStatusHits = 0;
    let abortedRequests = 0;
    let mode: "rate-limit" | "hang" = "rate-limit";

    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url?.endsWith("/agents.sessions.setStatus")) {
          setStatusHits++;
          if (mode === "rate-limit") {
            res.writeHead(429, { "retry-after": "1" }).end("rate limited");
          } else {
            // Never answers: the client closing the socket is the only way out.
            res.on("close", () => abortedRequests++);
          }
          return;
        }
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
      port = await listenOnFreePort(server, "127.0.0.1");
    });
    afterAll(() => {
      server.closeAllConnections();
      server.close();
    });
    beforeEach(() => {
      setStatusHits = 0;
      abortedRequests = 0;
      mode = "rate-limit";
    });

    const sharedClient = () =>
      new webApi.WebClient("xoxb-test", { slackApiUrl: `http://127.0.0.1:${port}/api/` });

    test("a rate limit is not retried and does not pause the shared client's queue", async () => {
      const shared = sharedClient();
      const thread = address();
      await slackTask(thread.channelId, thread.threadTs, { start: true });

      const started = Date.now();
      await reconcileSlackSessionStatus({ ...thread, client: shared });
      expect(Date.now() - started).toBeLessThan(800);
      expect(setStatusHits).toBe(1);

      // Delivery on the shared client keeps flowing while the status is backing off.
      const delivery = Date.now();
      await shared.apiCall("chat.postMessage", { channel: thread.channelId, text: "tree" });
      expect(Date.now() - delivery).toBeLessThan(500);
      expect(setStatusHits).toBe(1);
    });

    test("a request that never answers is aborted at the timeout", async () => {
      _setSlackSessionStatusTimeoutForTests(700);
      mode = "hang";
      const thread = address();
      await slackTask(thread.channelId, thread.threadTs, { start: true });

      await reconcileSlackSessionStatus({ ...thread, client: sharedClient() });
      await waitFor(() => abortedRequests > 0);
      expect(setStatusHits).toBe(1);
      expect(abortedRequests).toBe(1);
    });
  });
});
