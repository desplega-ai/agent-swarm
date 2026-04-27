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
import { closeDb, getDb, initDb } from "../be/db";
import { upsertOAuthApp } from "../be/db-queries/oauth";
import {
  createTrackerSync,
  hasTrackerDelivery,
  markTrackerDelivery,
} from "../be/db-queries/tracker";
import * as syncModule from "../jira/sync";

const TEST_DB_PATH = "./test-jira-webhook.sqlite";
const TEST_TOKEN = "test-jira-webhook-token-deadbeefcafe1234";

// Spy on the sync handlers — using mock.module here would leak globally
// because bun's mock.module has no documented restore. spyOn is restored by
// mock.restore() in afterAll, leaving the real module intact for other test
// files (notably jira-sync.test.ts which exercises the real handlers).
const issueHandler = spyOn(syncModule, "handleIssueEvent").mockResolvedValue(undefined);
const commentHandler = spyOn(syncModule, "handleCommentEvent").mockResolvedValue(undefined);
const issueDeleteHandler = spyOn(syncModule, "handleIssueDeleteEvent").mockResolvedValue(undefined);

const { handleJiraWebhook, isDuplicateDelivery, synthesizeDeliveryId, verifyJiraWebhookToken } =
  await import("../jira/webhook");

beforeAll(() => {
  initDb(TEST_DB_PATH);
  process.env.JIRA_WEBHOOK_TOKEN = TEST_TOKEN;
  // Seed an oauth app so any nested calls don't blow up.
  upsertOAuthApp("jira", {
    clientId: "client-id",
    clientSecret: "client-secret",
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    redirectUri: "http://localhost:3013/api/trackers/jira/callback",
    scopes: "read:jira-work",
  });
});

afterAll(async () => {
  delete process.env.JIRA_WEBHOOK_TOKEN;
  mock.restore();
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

beforeEach(() => {
  issueHandler.mockClear();
  commentHandler.mockClear();
  issueDeleteHandler.mockClear();
  // Reset tracker_sync rows
  getDb().query("DELETE FROM tracker_sync").run();
});

afterEach(() => {
  // Allow any fire-and-forget dispatch to settle so it doesn't bleed into
  // the next test.
});

describe("verifyJiraWebhookToken", () => {
  test("returns true for matching token", () => {
    expect(verifyJiraWebhookToken(TEST_TOKEN, TEST_TOKEN)).toBe(true);
  });

  test("returns false for empty/missing path token", () => {
    expect(verifyJiraWebhookToken(undefined, TEST_TOKEN)).toBe(false);
    expect(verifyJiraWebhookToken("", TEST_TOKEN)).toBe(false);
  });

  test("returns false for empty expected token", () => {
    expect(verifyJiraWebhookToken(TEST_TOKEN, "")).toBe(false);
  });

  test("returns false for length mismatch", () => {
    expect(verifyJiraWebhookToken("short", TEST_TOKEN)).toBe(false);
    expect(verifyJiraWebhookToken(`${TEST_TOKEN}extra`, TEST_TOKEN)).toBe(false);
  });

  test("returns false for byte mismatch at same length", () => {
    const wrong = `${TEST_TOKEN.slice(0, -1)}X`;
    expect(verifyJiraWebhookToken(wrong, TEST_TOKEN)).toBe(false);
  });
});

describe("synthesizeDeliveryId", () => {
  test("stable across same body+envelope (idempotent retries)", () => {
    const body = {
      webhookEvent: "jira:issue_updated",
      timestamp: 1700000000,
      issue: { id: "10001" },
    };
    const raw = JSON.stringify(body);
    const id1 = synthesizeDeliveryId(body, raw);
    const id2 = synthesizeDeliveryId(body, raw);
    expect(id1).toBe(id2);
  });

  test("differs across different bodies even at same timestamp/event", () => {
    const a = { webhookEvent: "comment_created", timestamp: 1700000000, issue: { id: "10001" } };
    const b = { webhookEvent: "comment_created", timestamp: 1700000000, issue: { id: "10002" } };
    expect(synthesizeDeliveryId(a, JSON.stringify(a))).not.toBe(
      synthesizeDeliveryId(b, JSON.stringify(b)),
    );
  });
});

describe("DB-persisted dedup (hasTrackerDelivery + markTrackerDelivery)", () => {
  test("round-trip: marked delivery is found, unknown delivery is not", () => {
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "task-1",
      externalId: "10001",
      externalIdentifier: "KAN-1",
    });
    expect(hasTrackerDelivery("jira", "delivery-abc")).toBe(false);
    markTrackerDelivery("jira", "task", "10001", "delivery-abc");
    expect(hasTrackerDelivery("jira", "delivery-abc")).toBe(true);
  });

  test("hasTrackerDelivery returns false for empty/null deliveryId", () => {
    expect(hasTrackerDelivery("jira", null)).toBe(false);
    expect(hasTrackerDelivery("jira", "")).toBe(false);
    expect(hasTrackerDelivery("jira", undefined)).toBe(false);
  });

  test("dedup state is durable: marked deliveries survive any number of subsequent reads", () => {
    // We can't fully simulate a process restart in-process (the test harness
    // uses a deserialized in-memory template), but the storage is the
    // tracker_sync table — so as long as the row stays, dedup works. Verify
    // the data persists across many independent reads (the same property a
    // restart would test against the underlying store).
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "task-restart",
      externalId: "10099",
      externalIdentifier: "KAN-99",
    });
    markTrackerDelivery("jira", "task", "10099", "persistent-id");
    for (let i = 0; i < 5; i++) {
      expect(hasTrackerDelivery("jira", "persistent-id")).toBe(true);
    }
    // And the row exists in the underlying SQL store (proves it's not just a
    // process-local Map).
    const row = getDb()
      .query("SELECT lastDeliveryId FROM tracker_sync WHERE externalId = '10099'")
      .get() as { lastDeliveryId: string };
    expect(row.lastDeliveryId).toBe("persistent-id");
  });
});

describe("handleJiraWebhook — auth + status codes", () => {
  test("returns 503 when JIRA_WEBHOOK_TOKEN is unset", async () => {
    const saved = process.env.JIRA_WEBHOOK_TOKEN;
    delete process.env.JIRA_WEBHOOK_TOKEN;
    const result = await handleJiraWebhook(TEST_TOKEN, "{}");
    expect(result.status).toBe(503);
    process.env.JIRA_WEBHOOK_TOKEN = saved;
  });

  test("returns 401 with empty body for missing path token", async () => {
    const result = await handleJiraWebhook(undefined, "{}");
    expect(result.status).toBe(401);
    expect(result.body).toBe("");
  });

  test("returns 401 with empty body for wrong path token", async () => {
    const result = await handleJiraWebhook("wrong-token-32-chars-long-xxxxxx", "{}");
    expect(result.status).toBe(401);
    expect(result.body).toBe("");
  });

  test("returns 200 + 'ignored' for invalid JSON body", async () => {
    const result = await handleJiraWebhook(TEST_TOKEN, "{not json");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ignored", reason: "invalid-json" });
  });
});

describe("handleJiraWebhook — dispatcher routing", () => {
  async function letDispatchSettle() {
    // Dispatch is fire-and-forget; let microtasks drain.
    await new Promise((r) => setTimeout(r, 20));
  }

  test("issue_updated routes to handleIssueEvent", async () => {
    const body = { webhookEvent: "jira:issue_updated", timestamp: 1, issue: { id: "10001" } };
    const result = await handleJiraWebhook(TEST_TOKEN, JSON.stringify(body));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "accepted" });
    await letDispatchSettle();
    expect(issueHandler).toHaveBeenCalledTimes(1);
    expect(commentHandler).not.toHaveBeenCalled();
    expect(issueDeleteHandler).not.toHaveBeenCalled();
  });

  test("comment_created routes to handleCommentEvent", async () => {
    const body = {
      webhookEvent: "comment_created",
      timestamp: 2,
      issue: { id: "10002" },
      comment: { id: "c1" },
    };
    await handleJiraWebhook(TEST_TOKEN, JSON.stringify(body));
    await letDispatchSettle();
    expect(commentHandler).toHaveBeenCalledTimes(1);
    expect(issueHandler).not.toHaveBeenCalled();
  });

  test("comment_updated routes to handleCommentEvent", async () => {
    const body = {
      webhookEvent: "comment_updated",
      timestamp: 3,
      issue: { id: "10003" },
      comment: { id: "c2" },
    };
    await handleJiraWebhook(TEST_TOKEN, JSON.stringify(body));
    await letDispatchSettle();
    expect(commentHandler).toHaveBeenCalledTimes(1);
  });

  test("issue_deleted routes to handleIssueDeleteEvent", async () => {
    const body = { webhookEvent: "jira:issue_deleted", timestamp: 4, issue: { id: "10004" } };
    await handleJiraWebhook(TEST_TOKEN, JSON.stringify(body));
    await letDispatchSettle();
    expect(issueDeleteHandler).toHaveBeenCalledTimes(1);
  });

  test("unhandled event is ignored — no handler invoked", async () => {
    const body = { webhookEvent: "issue_link_created", timestamp: 5, issue: { id: "10005" } };
    const result = await handleJiraWebhook(TEST_TOKEN, JSON.stringify(body));
    expect(result.status).toBe(200);
    await letDispatchSettle();
    expect(issueHandler).not.toHaveBeenCalled();
    expect(commentHandler).not.toHaveBeenCalled();
    expect(issueDeleteHandler).not.toHaveBeenCalled();
  });

  test("duplicate delivery short-circuits (200 + 'duplicate')", async () => {
    // Pre-stamp the delivery on a tracker_sync row.
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "task-dup",
      externalId: "10006",
      externalIdentifier: "KAN-6",
    });
    const body = { webhookEvent: "jira:issue_updated", timestamp: 6, issue: { id: "10006" } };
    const raw = JSON.stringify(body);
    const did = synthesizeDeliveryId(body, raw);
    markTrackerDelivery("jira", "task", "10006", did);

    expect(isDuplicateDelivery(did)).toBe(true);

    const result = await handleJiraWebhook(TEST_TOKEN, raw);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "duplicate" });
    await letDispatchSettle();
    expect(issueHandler).not.toHaveBeenCalled();
  });
});
