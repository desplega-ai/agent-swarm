import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { unlink } from "node:fs/promises";
import { closeDb, createTaskExtended, getTaskById, initDb } from "../be/db";
import { createTrackerSync, getTrackerSyncByExternalId } from "../be/db-queries/tracker";
import {
  handleAgentSessionEvent,
  handleIssueDelete,
  handleIssueUpdate,
  mapLinearStatusToSwarm,
} from "../linear/sync";
import {
  _clearRecentDeliveries,
  _getRecentDeliveries,
  handleLinearWebhook,
  verifyLinearWebhook,
} from "../linear/webhook";

const TEST_DB_PATH = "./test-linear-webhook.sqlite";
const TEST_SECRET = "test-webhook-secret-123";

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
  process.env.LINEAR_SIGNING_SECRET = TEST_SECRET;
});

afterAll(async () => {
  delete process.env.LINEAR_SIGNING_SECRET;
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

beforeEach(() => {
  _clearRecentDeliveries();
});

// ─── verifyLinearWebhook ─────────────────────────────────────────────────────

describe("verifyLinearWebhook", () => {
  test("returns true for valid signature", () => {
    const body = '{"type":"Issue","action":"update"}';
    const sig = signPayload(body, TEST_SECRET);
    expect(verifyLinearWebhook(body, sig, TEST_SECRET)).toBe(true);
  });

  test("returns false for invalid signature", () => {
    const body = '{"type":"Issue","action":"update"}';
    const sig = "deadbeef0000000000000000000000000000000000000000000000000000abcd";
    expect(verifyLinearWebhook(body, sig, TEST_SECRET)).toBe(false);
  });

  test("returns false for tampered body", () => {
    const body = '{"type":"Issue","action":"update"}';
    const sig = signPayload(body, TEST_SECRET);
    expect(verifyLinearWebhook(body + "x", sig, TEST_SECRET)).toBe(false);
  });

  test("returns false for mismatched length signature", () => {
    const body = '{"type":"Issue","action":"update"}';
    expect(verifyLinearWebhook(body, "short", TEST_SECRET)).toBe(false);
  });
});

// ─── handleLinearWebhook ─────────────────────────────────────────────────────

describe("handleLinearWebhook", () => {
  test("returns 503 when LINEAR_SIGNING_SECRET is not set", async () => {
    const saved = process.env.LINEAR_SIGNING_SECRET;
    delete process.env.LINEAR_SIGNING_SECRET;

    const result = await handleLinearWebhook("{}", {});
    expect(result.status).toBe(503);

    process.env.LINEAR_SIGNING_SECRET = saved;
  });

  test("returns 401 with missing signature", async () => {
    const body = '{"type":"Issue","action":"update"}';
    const result = await handleLinearWebhook(body, {});
    expect(result.status).toBe(401);
  });

  test("returns 401 with invalid signature", async () => {
    const body = '{"type":"Issue","action":"update"}';
    const result = await handleLinearWebhook(body, {
      "linear-signature": "bad-signature-value-that-is-long-enough-for-hmac-compare-64ch",
    });
    expect(result.status).toBe(401);
  });

  test("returns 200 with valid signature", async () => {
    const body = '{"type":"Issue","action":"update","data":{}}';
    const sig = signPayload(body, TEST_SECRET);

    const result = await handleLinearWebhook(body, { "linear-signature": sig });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "accepted" });
  });

  test("accepts x-linear-signature header as alternative", async () => {
    const body = '{"type":"Issue","action":"update","data":{}}';
    const sig = signPayload(body, TEST_SECRET);

    const result = await handleLinearWebhook(body, { "x-linear-signature": sig });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "accepted" });
  });

  test("deduplicates by linear-delivery header", async () => {
    const body = '{"type":"Issue","action":"update","data":{}}';
    const sig = signPayload(body, TEST_SECRET);
    const deliveryId = "dedup-test-delivery-001";

    const first = await handleLinearWebhook(body, {
      "linear-signature": sig,
      "linear-delivery": deliveryId,
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: "accepted" });

    const second = await handleLinearWebhook(body, {
      "linear-signature": sig,
      "linear-delivery": deliveryId,
    });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ status: "duplicate" });
  });

  test("allows different delivery IDs through", async () => {
    const body = '{"type":"Issue","action":"update","data":{}}';
    const sig = signPayload(body, TEST_SECRET);

    const first = await handleLinearWebhook(body, {
      "linear-signature": sig,
      "linear-delivery": "delivery-a",
    });
    expect(first.body).toEqual({ status: "accepted" });

    const second = await handleLinearWebhook(body, {
      "linear-signature": sig,
      "linear-delivery": "delivery-b",
    });
    expect(second.body).toEqual({ status: "accepted" });
  });
});

// ─── mapLinearStatusToSwarm ──────────────────────────────────────────────────

describe("mapLinearStatusToSwarm", () => {
  test("maps known statuses", () => {
    expect(mapLinearStatusToSwarm("Backlog")).toBe("skip");
    expect(mapLinearStatusToSwarm("Todo")).toBe("unassigned");
    expect(mapLinearStatusToSwarm("In Progress")).toBe("in_progress");
    expect(mapLinearStatusToSwarm("Done")).toBe("completed");
    expect(mapLinearStatusToSwarm("Canceled")).toBe("cancelled");
    expect(mapLinearStatusToSwarm("Cancelled")).toBe("cancelled");
  });

  test("returns null for unknown status", () => {
    expect(mapLinearStatusToSwarm("Triage")).toBeNull();
    expect(mapLinearStatusToSwarm("Custom Status")).toBeNull();
  });
});

// ─── handleAgentSessionEvent (sync) ──────────────────────────────────────────

describe("handleAgentSessionEvent", () => {
  test("creates a task and tracker_sync for new issue", async () => {
    const event = {
      type: "AgentSession",
      action: "create",
      data: {
        issue: {
          id: "issue-agent-session-001",
          identifier: "ENG-100",
          title: "Fix login bug",
          url: "https://linear.app/team/issue/ENG-100",
          description: "Users cannot log in with SSO",
        },
      },
    };

    await handleAgentSessionEvent(event);

    const sync = getTrackerSyncByExternalId("linear", "task", "issue-agent-session-001");
    expect(sync).not.toBeNull();
    expect(sync!.externalIdentifier).toBe("ENG-100");
    expect(sync!.externalUrl).toBe("https://linear.app/team/issue/ENG-100");
    expect(sync!.lastSyncOrigin).toBe("external");
    expect(sync!.syncDirection).toBe("inbound");

    const task = getTaskById(sync!.swarmId);
    expect(task).not.toBeNull();
    expect(task!.source).toBe("linear");
    expect(task!.taskType).toBe("linear-issue");
    expect(task!.task).toContain("[Linear ENG-100]");
    expect(task!.task).toContain("Fix login bug");
  });

  test("skips duplicate issue (already tracked)", async () => {
    const event = {
      type: "AgentSession",
      action: "create",
      data: {
        issue: {
          id: "issue-agent-session-001",
          identifier: "ENG-100",
          title: "Fix login bug",
          url: "https://linear.app/team/issue/ENG-100",
        },
      },
    };

    // Should not throw or create a second tracker_sync
    await handleAgentSessionEvent(event);
    // Just verify it didn't throw — the existing sync is still there
    const sync = getTrackerSyncByExternalId("linear", "task", "issue-agent-session-001");
    expect(sync).not.toBeNull();
  });

  test("skips event with no issue data", async () => {
    await handleAgentSessionEvent({ type: "AgentSession", data: {} });
    await handleAgentSessionEvent({ type: "AgentSession" });
  });
});

// ─── handleIssueUpdate (sync) ────────────────────────────────────────────────

describe("handleIssueUpdate", () => {
  test("updates tracker_sync metadata on tracked issue status change", async () => {
    // Create a task + tracker_sync first
    const task = createTaskExtended("Test issue update task", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: task.id,
      externalId: "issue-update-001",
      externalIdentifier: "ENG-200",
      syncDirection: "inbound",
    });

    const event = {
      type: "Issue",
      action: "update",
      data: {
        id: "issue-update-001",
        identifier: "ENG-200",
        state: { name: "In Progress" },
      },
      updatedFrom: { stateId: "old-state-id" },
    };

    await handleIssueUpdate(event, "delivery-update-001");

    const sync = getTrackerSyncByExternalId("linear", "task", "issue-update-001");
    expect(sync).not.toBeNull();
    expect(sync!.lastSyncOrigin).toBe("external");
    expect(sync!.lastDeliveryId).toBe("delivery-update-001");
  });

  test("cancels task when Linear issue is cancelled", async () => {
    const task = createTaskExtended("Test cancel task", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: task.id,
      externalId: "issue-cancel-001",
      externalIdentifier: "ENG-201",
      syncDirection: "inbound",
    });

    const event = {
      type: "Issue",
      action: "update",
      data: {
        id: "issue-cancel-001",
        identifier: "ENG-201",
        state: { name: "Canceled" },
      },
      updatedFrom: { stateId: "old-state-id" },
    };

    await handleIssueUpdate(event);

    const updated = getTaskById(task.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("cancelled");
  });

  test("ignores untracked issue updates", async () => {
    const event = {
      type: "Issue",
      action: "update",
      data: {
        id: "untracked-issue-999",
        state: { name: "In Progress" },
      },
      updatedFrom: { stateId: "old-state-id" },
    };

    // Should not throw
    await handleIssueUpdate(event);
  });

  test("ignores update without updatedFrom field", async () => {
    const task = createTaskExtended("Test no-updatedFrom task", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: task.id,
      externalId: "issue-no-update-from-001",
      externalIdentifier: "ENG-300",
      syncDirection: "inbound",
    });

    const event = {
      type: "Issue",
      action: "update",
      data: {
        id: "issue-no-update-from-001",
        state: { name: "In Progress" },
      },
      // no updatedFrom
    };

    await handleIssueUpdate(event);
    // Should not throw — just silently returns
  });
});

// ─── handleIssueDelete (sync) ────────────────────────────────────────────────

describe("handleIssueDelete", () => {
  test("cancels task when tracked issue is deleted", async () => {
    const task = createTaskExtended("Test delete task", { source: "linear" });
    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: task.id,
      externalId: "issue-delete-001",
      externalIdentifier: "ENG-400",
      syncDirection: "inbound",
    });

    const event = {
      type: "Issue",
      action: "remove",
      data: { id: "issue-delete-001" },
    };

    await handleIssueDelete(event);

    const updated = getTaskById(task.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("cancelled");
  });

  test("ignores untracked issue delete", async () => {
    const event = {
      type: "Issue",
      action: "remove",
      data: { id: "untracked-delete-999" },
    };

    // Should not throw
    await handleIssueDelete(event);
  });

  test("ignores delete for already-completed task", async () => {
    const task = createTaskExtended("Test completed delete task", {
      source: "linear",
    });
    // Manually complete the task to test guard
    const { getDb } = await import("../be/db");
    getDb().query("UPDATE agent_tasks SET status = 'completed' WHERE id = ?").run(task.id);

    createTrackerSync({
      provider: "linear",
      entityType: "task",
      swarmId: task.id,
      externalId: "issue-delete-completed-001",
      externalIdentifier: "ENG-401",
      syncDirection: "inbound",
    });

    await handleIssueDelete({
      type: "Issue",
      action: "remove",
      data: { id: "issue-delete-completed-001" },
    });

    // Should still be completed, not cancelled
    const updated = getTaskById(task.id);
    expect(updated!.status).toBe("completed");
  });
});
