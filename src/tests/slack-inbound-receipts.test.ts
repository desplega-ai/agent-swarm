/**
 * Durable Slack inbound receipts and explicit dispatch outcomes (Slack HTTP
 * mode, Phase 2).
 *
 * Covers atomic admission under concurrency, encrypted payload retention,
 * admission bounds, the crash/recovery contract (pending resumes, interrupted
 * processing becomes uncertain and is never replayed), and that Socket Mode
 * ingress keeps producing the same tasks and the same dedup outcome.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { AnyMiddlewareArgs } from "@slack/bolt";
import {
  __resetEncryptionKeyForTests,
  decryptSecret,
  getEncryptionKey,
  resolveEncryptionKey,
} from "../be/crypto";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb } from "../be/db";
import {
  admitSlackInboundReceipt,
  claimSlackInboundReceipt,
  getSlackInboundReceiptById,
  getSlackInboundReceiptByKey,
  purgeSlackInboundReceipts,
  SLACK_INBOUND_LIMITS,
} from "../be/db-queries/slack-inbound";
import { registerActionHandlers } from "../slack/actions";
import { getSlackConfiguration } from "../slack/config";
import * as slackEnrichModule from "../slack/enrich";
import { _resetForTests as resetEventDedup, wasEventSeen } from "../slack/event-dedup";
import { registerMessageHandler, resetSlackHandlerCachesForTesting } from "../slack/handlers";
import {
  admitSlackInbound,
  computeSlackInboundKey,
  createSlackInboundDrain,
  getSlackInboundDiagnostics,
  noteSlackInboundSideEffect,
  processNextSlackInboundReceipt,
  recoverSlackInboundAfterRestart,
  resetSlackInboundCountersForTests,
  slackInboundOutcomeMiddleware,
} from "../slack/inbound-dispatch";

const TEST_DB_PATH = "./test-slack-inbound-receipts.sqlite";
const testGlobals = globalThis as typeof globalThis & {
  __testMigrationTemplate?: Uint8Array;
};
let savedMigrationTemplate: Uint8Array | undefined;
const previousEnv = {
  ADDITIVE_SLACK: process.env.ADDITIVE_SLACK,
  SLACK_RENDER_V2: process.env.SLACK_RENDER_V2,
};

function removeTestDb(): void {
  for (const path of [TEST_DB_PATH, `${TEST_DB_PATH}-wal`, `${TEST_DB_PATH}-shm`]) {
    try {
      unlinkSync(path);
    } catch {
      // The SQLite sidecars are not always created.
    }
  }
}

type Handler = (args: Record<string, unknown>) => Promise<void>;
let channelMessage: Handler;
let followUpSubmit: Handler;
const resolveSlackUserIdSpy = spyOn(slackEnrichModule, "resolveSlackUserId");

beforeAll(() => {
  closeDb();
  savedMigrationTemplate = testGlobals.__testMigrationTemplate;
  testGlobals.__testMigrationTemplate = undefined;
  removeTestDb();
  initDb(TEST_DB_PATH);
  process.env.ADDITIVE_SLACK = "false";
  process.env.SLACK_RENDER_V2 = "false";
  resolveSlackUserIdSpy.mockImplementation(async () => undefined);
  registerMessageHandler({
    event: (type: string, handler: Handler) => {
      if (type === "message") channelMessage = handler;
    },
  } as never);
  registerActionHandlers({
    action: () => {},
    view: (id: string, handler: Handler) => {
      if (id === "follow_up_submit") followUpSubmit = handler;
    },
  } as never);
});

afterAll(() => {
  resolveSlackUserIdSpy.mockRestore();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  removeTestDb();
  testGlobals.__testMigrationTemplate = savedMigrationTemplate;
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM slack_inbound_receipts");
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM agents");
  resetEventDedup();
  resetSlackHandlerCachesForTesting();
  resetSlackInboundCountersForTests();
});

let seq = 0;
function nextTs(): string {
  seq += 1;
  return `1950000000.${String(seq).padStart(6, "0")}`;
}

function slackClient() {
  return {
    auth: { test: async () => ({ user_id: "U_SWARM_BOT", bot_id: "B_SWARM_BOT" }) },
    conversations: { replies: async () => ({ ok: true, messages: [] }) },
    reactions: { add: mock(async () => ({ ok: true })) },
    chat: { postMessage: mock(async () => ({ ok: true, ts: "9999999999.000001" })) },
    files: { info: mock(async () => ({ ok: false })) },
  };
}

function messageEnvelope(eventId: string, ts: string, text = "<@U_SWARM_BOT> please triage") {
  return {
    type: "event_callback",
    api_app_id: "A_TEST",
    event_id: eventId,
    event: { type: "message", channel: "C0RECEIPTS", ts, user: "U_HUMAN", text },
  };
}

/** Mirrors Bolt: the global outcome middleware wraps the listener; Bolt's
 * error handler swallows what the middleware rethrows. */
async function runThroughBolt(listener: () => Promise<void>): Promise<void> {
  const middleware = slackInboundOutcomeMiddleware();
  try {
    await middleware({ next: listener } as unknown as AnyMiddlewareArgs & {
      next: () => Promise<void>;
    });
  } catch {
    // Bolt routes listener errors to App.handleError; processEvent resolves.
  }
}

/** A drain processor that dispatches an event envelope to the real handler. */
function messageProcessor(client = slackClient()) {
  return async ({ rawBody }: { rawBody: string }) => {
    const body = JSON.parse(rawBody);
    await runThroughBolt(() =>
      channelMessage({ event: body.event, body, client, say: mock(async () => ({ ts: "1" })) }),
    );
  };
}

async function tasksForTs(ts: string) {
  return getDbClient().query<{ id: string; parentTaskId: string | null }>(
    "SELECT id, parentTaskId FROM agent_tasks WHERE slackTriggerMessageTs = ?",
    [ts],
  );
}

async function receiptCount(): Promise<number> {
  const row = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM slack_inbound_receipts",
  );
  return row?.n ?? 0;
}

describe("admission", () => {
  test("concurrent identical deliveries store one receipt", async () => {
    const body = messageEnvelope("Ev_CONCURRENT", nextTs());
    const rawBody = JSON.stringify(body);

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        admitSlackInbound({ transport: "http", kind: "event", rawBody, body }),
      ),
    );

    expect(results.filter((r) => r.status === "admitted")).toHaveLength(1);
    expect(results.filter((r) => r.status === "duplicate")).toHaveLength(11);
    expect(await receiptCount()).toBe(1);
    const receipt = await getSlackInboundReceiptByKey("event:A_TEST:Ev_CONCURRENT");
    expect(receipt?.duplicateCount).toBe(11);
    expect(receipt?.state).toBe("pending");
  });

  test("the payload is stored encrypted and round-trips", async () => {
    const body = messageEnvelope("Ev_ENCRYPTED", nextTs(), "<@U_SWARM_BOT> secret words");
    const rawBody = JSON.stringify(body);
    const result = await admitSlackInbound({ transport: "http", kind: "event", rawBody, body });
    if (result.status !== "admitted") throw new Error(`unexpected ${result.status}`);

    const stored = result.receipt.payloadCiphertext!;
    expect(stored).not.toContain("secret words");
    expect(decryptSecret(stored, getEncryptionKey())).toBe(rawBody);
    expect(result.receipt.payloadBytes).toBe(Buffer.byteLength(rawBody));
  });

  test("keys events by app and event id, and interactions by kind-scoped body hash", () => {
    const missing = computeSlackInboundKey("event", "{}", { type: "event_callback" });
    expect(missing).toEqual({ ok: false, reason: "missing_event_id" });

    const control = computeSlackInboundKey("event", '{"type":"app_rate_limited"}', {
      type: "app_rate_limited",
    });
    expect(control.ok && control.dedupKey.startsWith("event:app_rate_limited:")).toBe(true);

    const a = '{"type":"view_submission","view":{"hash":"1"}}';
    const b = '{"type":"view_submission","view":{"hash":"2"}}';
    const keyA = computeSlackInboundKey("interaction", a, JSON.parse(a));
    const keyA2 = computeSlackInboundKey("interaction", a, JSON.parse(a));
    const keyB = computeSlackInboundKey("interaction", b, JSON.parse(b));
    expect(keyA.ok && keyA2.ok && keyA.dedupKey === keyA2.dedupKey).toBe(true);
    expect(keyA.ok && keyB.ok && keyA.dedupKey !== keyB.dedupKey).toBe(true);
  });

  test("a full backlog refuses new work but still acknowledges a stored duplicate", async () => {
    const limits = { maxBacklogReceipts: 1, maxBacklogBytes: 1_000_000, maxPayloadBytes: 1_000 };
    const input = (key: string) => ({
      dedupKey: key,
      transport: "http" as const,
      kind: "event" as const,
      payloadType: "event_callback",
      payloadCiphertext: "x",
      payloadBytes: 10,
    });

    expect((await admitSlackInboundReceipt(input("k1"), new Date(), limits)).status).toBe(
      "admitted",
    );
    expect(await admitSlackInboundReceipt(input("k2"), new Date(), limits)).toEqual({
      status: "rejected",
      reason: "backlog_full",
    });
    expect((await admitSlackInboundReceipt(input("k1"), new Date(), limits)).status).toBe(
      "duplicate",
    );
    expect(
      await admitSlackInboundReceipt({ ...input("k3"), payloadBytes: 5_000 }, new Date(), {
        ...limits,
        maxBacklogReceipts: 10,
      }),
    ).toEqual({ status: "rejected", reason: "payload_too_large" });
    expect(await receiptCount()).toBe(1);
  });
});

describe("dispatch and recovery", () => {
  test("concurrent identical modal submissions create one follow-up task", async () => {
    const lead = await createAgent({ name: "ReceiptLead", isLead: true, status: "idle" });
    const original = await createTaskExtended("original", {
      agentId: lead.id,
      source: "slack",
      slackChannelId: "C0MODAL",
      slackThreadTs: "1950000000.000000",
      slackUserId: "U_HUMAN",
    });
    const body = {
      type: "view_submission",
      api_app_id: "A_TEST",
      trigger_id: "trigger-1",
      user: { id: "U_HUMAN" },
      view: {
        id: "V1",
        hash: "h1",
        callback_id: "follow_up_submit",
        private_metadata: original.id,
        state: { values: { follow_up_input: { follow_up_text: { value: "one more thing" } } } },
      },
    };
    const rawBody = JSON.stringify(body);

    const admissions = await Promise.all(
      Array.from({ length: 8 }, () =>
        admitSlackInbound({ transport: "http", kind: "interaction", rawBody, body }),
      ),
    );
    expect(admissions.filter((r) => r.status === "admitted")).toHaveLength(1);

    const processor = mock(async ({ rawBody: raw }: { rawBody: string }) => {
      const parsed = JSON.parse(raw);
      await runThroughBolt(() =>
        followUpSubmit({
          ack: async () => {},
          view: parsed.view,
          body: parsed,
          client: slackClient(),
        }),
      );
    });
    const drain = createSlackInboundDrain(processor);
    await Promise.all([drain.wake(), drain.wake(), drain.wake()]);

    expect(processor).toHaveBeenCalledTimes(1);
    const followUps = await getDbClient().query<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE parentTaskId = ?",
      [original.id],
    );
    expect(followUps).toHaveLength(1);
    const receipt = await getSlackInboundReceiptByKey(
      (admissions[0] as { receipt: { dedupKey: string } }).receipt.dedupKey,
    );
    expect(receipt?.state).toBe("processed");
    expect(receipt?.outcomeCode).toBe("task_created");
    expect(receipt?.payloadCiphertext).toBeNull();
  });

  test("a crash before admission commits leaves nothing, so Slack's retry is admitted fresh", async () => {
    const body = messageEnvelope("Ev_CRASH_BEFORE_ACK", nextTs());
    const rawBody = JSON.stringify(body);

    __resetEncryptionKeyForTests();
    try {
      await expect(
        admitSlackInbound({ transport: "http", kind: "event", rawBody, body }),
      ).rejects.toThrow();
    } finally {
      resolveEncryptionKey(TEST_DB_PATH);
    }
    expect(await receiptCount()).toBe(0);

    const retry = await admitSlackInbound({
      transport: "http",
      kind: "event",
      rawBody,
      body,
      retryNum: 1,
      retryReason: "http_timeout",
    });
    expect(retry.status).toBe("admitted");
    if (retry.status === "admitted") {
      expect(retry.receipt.retryNum).toBe(1);
      expect(retry.receipt.retryReason).toBe("http_timeout");
    }
  });

  test("a crash after ack but before claim resumes the pending receipt", async () => {
    await createAgent({ name: "ReceiptLead", isLead: true, status: "idle" });
    const ts = nextTs();
    const body = messageEnvelope("Ev_AFTER_ACK", ts);
    await admitSlackInbound({
      transport: "http",
      kind: "event",
      rawBody: JSON.stringify(body),
      body,
    });

    expect(await recoverSlackInboundAfterRestart()).toBe(0);
    const result = await processNextSlackInboundReceipt(messageProcessor());

    expect(result?.state).toBe("processed");
    expect(await tasksForTs(ts)).toHaveLength(1);
  });

  test("a crash after claim leaves an uncertain receipt that is never replayed", async () => {
    const ts = nextTs();
    const body = messageEnvelope("Ev_AFTER_CLAIM", ts);
    const admitted = await admitSlackInbound({
      transport: "http",
      kind: "event",
      rawBody: JSON.stringify(body),
      body,
    });
    if (admitted.status !== "admitted") throw new Error("expected admission");
    expect((await claimSlackInboundReceipt())?.id).toBe(admitted.receipt.id);

    // Process dies here. Next boot:
    expect(await recoverSlackInboundAfterRestart()).toBe(1);
    const processor = mock(async () => {});
    expect(await processNextSlackInboundReceipt(processor)).toBeNull();
    expect(processor).not.toHaveBeenCalled();

    const receipt = await getSlackInboundReceiptById(admitted.receipt.id);
    expect(receipt?.state).toBe("uncertain");
    expect(receipt?.errorCode).toBe("interrupted_during_processing");
    expect(receipt?.payloadCiphertext).not.toBeNull();

    const diagnostics = await getSlackInboundDiagnostics();
    expect(diagnostics.receipts.counts.uncertain).toBe(1);
    expect(diagnostics.receipts.uncertain[0]?.id).toBe(admitted.receipt.id);
    expect(JSON.stringify(diagnostics)).not.toContain("please triage");
  });

  test("a failure after task creation is uncertain and creates no duplicate task", async () => {
    await createAgent({ name: "ReceiptLead", isLead: true, status: "idle" });
    const ts = nextTs();
    const body = messageEnvelope("Ev_AFTER_TASK", ts);
    await admitSlackInbound({
      transport: "http",
      kind: "event",
      rawBody: JSON.stringify(body),
      body,
    });

    // The task lands, then a later Slack call in the listener throws. Bolt's
    // error handler swallows it; the outcome middleware still saw it.
    const brokenClient = {
      ...slackClient(),
      reactions: { add: mock(async () => Promise.reject(new Error("slack down"))) },
    };
    const processor = async ({ rawBody }: { rawBody: string }) => {
      const parsed = JSON.parse(rawBody);
      await runThroughBolt(async () => {
        await channelMessage({
          event: parsed.event,
          body: parsed,
          client: brokenClient,
          say: mock(async () => ({ ts: "1" })),
        });
        throw new Error("listener failed after its side effect");
      });
    };

    const first = await processNextSlackInboundReceipt(processor);
    expect(first?.state).toBe("uncertain");
    expect(await processNextSlackInboundReceipt(processor)).toBeNull();
    expect(await tasksForTs(ts)).toHaveLength(1);
  });

  test("a failure before any side effect is retried with backoff, then becomes terminal", async () => {
    const body = messageEnvelope("Ev_RETRYABLE", nextTs());
    const admitted = await admitSlackInbound({
      transport: "http",
      kind: "event",
      rawBody: JSON.stringify(body),
      body,
    });
    if (admitted.status !== "admitted") throw new Error("expected admission");

    let clock = Date.now();
    const now = () => new Date(clock);
    const failing = async () => {
      throw Object.assign(new Error("auth.test failed"), { code: "slack_webapi_platform_error" });
    };

    const first = await processNextSlackInboundReceipt(failing, { now });
    expect(first).toMatchObject({ state: "pending", outcome: { state: "failed" } });
    expect(await processNextSlackInboundReceipt(failing, { now })).toBeNull();

    for (let attempt = 2; attempt <= SLACK_INBOUND_LIMITS.maxAttempts; attempt++) {
      clock += SLACK_INBOUND_LIMITS.retryBackoffMs * attempt;
      const result = await processNextSlackInboundReceipt(failing, { now });
      expect(result?.state).toBe(
        attempt === SLACK_INBOUND_LIMITS.maxAttempts ? "failed" : "pending",
      );
    }
    const receipt = await getSlackInboundReceiptById(admitted.receipt.id);
    expect(receipt?.state).toBe("failed");
    expect(receipt?.attempts).toBe(SLACK_INBOUND_LIMITS.maxAttempts);
    expect(receipt?.errorCode).toBe("slack_webapi_platform_error");
  });

  test("a delivery Bolt never dispatched is a failure, not a success", async () => {
    const body = messageEnvelope("Ev_NOT_DISPATCHED", nextTs());
    await admitSlackInbound({
      transport: "http",
      kind: "event",
      rawBody: JSON.stringify(body),
      body,
    });

    const result = await processNextSlackInboundReceipt(async () => {}, {
      requireBoltDispatch: true,
    });
    expect(result?.outcome).toEqual({ state: "failed", code: "not_dispatched" });
  });

  test("an expected filter is recorded as ignored", async () => {
    const body = messageEnvelope("Ev_BOT_ECHO", nextTs());
    body.event = { ...body.event, user: "U_SWARM_BOT" };
    await admitSlackInbound({
      transport: "http",
      kind: "event",
      rawBody: JSON.stringify(body),
      body,
    });

    const result = await processNextSlackInboundReceipt(messageProcessor());
    expect(result?.outcome).toEqual({ state: "ignored", code: "bot_message" });
  });
});

describe("retention", () => {
  test("never purges pending or uncertain work and keeps live dedup keys", async () => {
    const received = new Date("2026-09-01T00:00:00.000Z");
    const store = (key: string) =>
      admitSlackInboundReceipt(
        {
          dedupKey: key,
          transport: "http",
          kind: "event",
          payloadType: "event_callback",
          payloadCiphertext: "ciphertext",
          payloadBytes: 10,
        },
        received,
      );
    await store("pending");
    await store("uncertain");
    await store("processed");
    await store("failed");
    await getDbClient().run(
      "UPDATE slack_inbound_receipts SET state = 'uncertain' WHERE dedup_key = 'uncertain'",
    );
    await getDbClient().run(
      `UPDATE slack_inbound_receipts SET state = 'processed', completed_at = ?
        WHERE dedup_key = 'processed'`,
      ["2026-09-01T00:00:01.000Z"],
    );
    await getDbClient().run(
      `UPDATE slack_inbound_receipts SET state = 'failed', completed_at = ?
        WHERE dedup_key = 'failed'`,
      ["2026-09-01T00:00:01.000Z"],
    );

    // Inside the window: the stray processed payload is erased, keys survive.
    const early = await purgeSlackInboundReceipts(new Date("2026-09-02T00:00:00.000Z"));
    expect(early).toEqual({ erasedPayloads: 1, deletedReceipts: 0 });
    const processed = await getSlackInboundReceiptByKey("processed");
    expect(processed?.payloadCiphertext).toBeNull();
    expect((await store("processed")).status).toBe("duplicate");
    expect((await getSlackInboundReceiptByKey("failed"))?.payloadCiphertext).toBe("ciphertext");

    // Long after the window: completed receipts go; pending and uncertain stay.
    const late = await purgeSlackInboundReceipts(new Date("2026-10-01T00:00:00.000Z"));
    expect(late.deletedReceipts).toBe(2);
    const remaining = await getDbClient().query<{ dedup_key: string; payload_ciphertext: string }>(
      "SELECT dedup_key, payload_ciphertext FROM slack_inbound_receipts ORDER BY dedup_key",
    );
    expect(remaining).toEqual([
      { dedup_key: "pending", payload_ciphertext: "ciphertext" },
      { dedup_key: "uncertain", payload_ciphertext: "ciphertext" },
    ]);
  });
});

describe("Socket Mode ingress is unchanged", () => {
  test("SLACK_MODE defaults to socket", () => {
    expect(getSlackConfiguration({}).mode).toBe("socket");
  });

  test("a redelivered socket event creates one task, dedups in memory, and stores no receipt", async () => {
    await createAgent({ name: "SocketLead", isLead: true, status: "idle" });
    const ts = nextTs();
    const body = messageEnvelope("Ev_SOCKET", ts);
    const deliver = () =>
      runThroughBolt(() =>
        channelMessage({
          event: body.event,
          body,
          client: slackClient(),
          say: mock(async () => ({ ts: "1" })),
        }),
      );

    await deliver();
    await deliver();

    expect(await tasksForTs(ts)).toHaveLength(1);
    expect(await receiptCount()).toBe(0);
    const { outcomes } = await getSlackInboundDiagnostics();
    expect(outcomes.socket).toMatchObject({ processed: 1, ignored: 1, failed: 0, uncertain: 0 });
    expect(outcomes.http).toMatchObject({ processed: 0, ignored: 0 });
  });

  test("socket listener errors still propagate to Bolt unchanged", async () => {
    const middleware = slackInboundOutcomeMiddleware();
    const boom = new Error("listener exploded");
    await expect(
      middleware({
        next: async () => {
          noteSlackInboundSideEffect("task_created");
          throw boom;
        },
      } as unknown as AnyMiddlewareArgs & { next: () => Promise<void> }),
    ).rejects.toBe(boom);
    const { outcomes } = await getSlackInboundDiagnostics();
    expect(outcomes.socket.uncertain).toBe(1);
  });

  test("an admitted delivery bypasses the legacy in-memory event cache", async () => {
    await createAgent({ name: "HttpLead", isLead: true, status: "idle" });
    const ts = nextTs();
    const body = messageEnvelope("Ev_ADMITTED_BYPASS", ts);
    await admitSlackInbound({
      transport: "http",
      kind: "event",
      rawBody: JSON.stringify(body),
      body,
    });

    const result = await processNextSlackInboundReceipt(messageProcessor());

    expect(result?.state).toBe("processed");
    expect(await tasksForTs(ts)).toHaveLength(1);
    // The receipt deduplicated it; the socket cache never saw the id.
    expect(wasEventSeen("Ev_ADMITTED_BYPASS")).toBe(false);
  });
});
