import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import { createTrackerSync, getTrackerSync, updateTrackerSync } from "../be/db-queries/tracker";
import { initJiraOutboundSync, teardownJiraOutboundSync } from "../jira/outbound";
import { workflowEventBus } from "../workflows/event-bus";

const TEST_DB_PATH = "./test-jira-outbound-sync.sqlite";

// Capture every jiraFetch call so we can assert on path/body shape and emoji
// rendering without hitting the network.
const mockJiraFetch = mock(
  () =>
    Promise.resolve(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as Promise<Response>,
);

mock.module("../jira/client", () => ({
  jiraFetch: mockJiraFetch,
  // The outbound module only imports `jiraFetch`; stub the others for
  // robustness in case the module surface grows.
  getJiraAccessToken: () => Promise.resolve("test-token"),
  getJiraCloudId: () => "test-cloud-id",
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

describe("Jira Outbound Sync", () => {
  beforeEach(() => {
    mockJiraFetch.mockClear();
    initJiraOutboundSync();
  });

  afterEach(() => {
    teardownJiraOutboundSync();
  });

  test("init/teardown is idempotent — double init/teardown does not double-fire", async () => {
    // Already inited in beforeEach, init again — should be no-op.
    initJiraOutboundSync();

    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-idempotent",
      externalId: "10001",
      externalIdentifier: "KAN-1",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.cancelled", { taskId: "jira-out-idempotent" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should be exactly 1 call, not 2 — proving init didn't re-subscribe.
    expect(mockJiraFetch).toHaveBeenCalledTimes(1);
  });

  test("task.created posts plaintext comment with rocket emoji + summary", async () => {
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-created",
      externalId: "10002",
      externalIdentifier: "KAN-2",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.created", {
      taskId: "jira-out-created",
      task: "Investigate flaky test",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockJiraFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockJiraFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/rest/api/2/issue/KAN-2/comment");
    expect(init.method).toBe("POST");
    const parsed = JSON.parse(init.body as string) as { body: string };
    expect(parsed.body).toBe("🚀 Swarm task started: Investigate flaky test");
    // Guard against shortcode regression — Jira REST v2 plaintext does not
    // expand `:rocket:` style.
    expect(parsed.body).not.toContain(":rocket:");
  });

  test("task.completed truncates output to 4000 chars and ellipsizes", async () => {
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-completed-long",
      externalId: "10003",
      externalIdentifier: "KAN-3",
      syncDirection: "bidirectional",
    });

    const longOutput = "x".repeat(5000);
    workflowEventBus.emit("task.completed", {
      taskId: "jira-out-completed-long",
      output: longOutput,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockJiraFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockJiraFetch.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as { body: string };
    expect(parsed.body.startsWith("✅ Swarm task completed.\n\n")).toBe(true);
    expect(parsed.body).toContain("…"); // ellipsis suffix
    // Body = "✅ Swarm task completed.\n\n" + 4000x + "…" — no shortcodes.
    expect(parsed.body).not.toContain(":white_check_mark:");
  });

  test("task.completed without output uses bare completion message", async () => {
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-completed-empty",
      externalId: "10004",
      externalIdentifier: "KAN-4",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.completed", { taskId: "jira-out-completed-empty" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [, init] = mockJiraFetch.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as { body: string };
    expect(parsed.body).toBe("✅ Swarm task completed.");
  });

  test("task.failed renders cross emoji + reason; falls back when reason missing", async () => {
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-failed-with-reason",
      externalId: "10005",
      externalIdentifier: "KAN-5",
      syncDirection: "bidirectional",
    });
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-failed-no-reason",
      externalId: "10006",
      externalIdentifier: "KAN-6",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.failed", {
      taskId: "jira-out-failed-with-reason",
      failureReason: "Build broke on line 42",
    });
    workflowEventBus.emit("task.failed", { taskId: "jira-out-failed-no-reason" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockJiraFetch).toHaveBeenCalledTimes(2);
    const calls = mockJiraFetch.mock.calls as [string, RequestInit][];
    const bodies = calls.map(([, init]) => JSON.parse(init.body as string).body as string);

    expect(bodies).toContain("❌ Swarm task failed.\n\nBuild broke on line 42");
    expect(bodies).toContain("❌ Swarm task failed.\n\n(no failure reason recorded)");
    // No shortcode regression.
    for (const b of bodies) {
      expect(b).not.toContain(":x:");
    }
  });

  test("task.cancelled posts stop emoji message", async () => {
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-cancelled",
      externalId: "10007",
      externalIdentifier: "KAN-7",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.cancelled", { taskId: "jira-out-cancelled" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [, init] = mockJiraFetch.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string) as { body: string };
    expect(parsed.body).toBe("⛔ Swarm task cancelled.");
    expect(parsed.body).not.toContain(":no_entry:");
  });

  test("flips lastSyncOrigin → 'swarm' on successful post", async () => {
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-origin-flip",
      externalId: "10008",
      externalIdentifier: "KAN-8",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.completed", {
      taskId: "jira-out-origin-flip",
      output: "ok",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const updated = getTrackerSync("jira", "task", "jira-out-origin-flip");
    expect(updated?.lastSyncOrigin).toBe("swarm");
  });

  test("no-op when no tracker_sync row exists for the task", async () => {
    workflowEventBus.emit("task.completed", {
      taskId: "jira-out-no-sync-row",
      output: "phantom",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockJiraFetch).not.toHaveBeenCalled();
  });

  test("loop prevention: skips when lastSyncOrigin='external' within 5s", async () => {
    const sync = createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-loop",
      externalId: "10009",
      externalIdentifier: "KAN-9",
      syncDirection: "bidirectional",
    });
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "external",
      lastSyncedAt: new Date().toISOString(),
    });

    workflowEventBus.emit("task.completed", {
      taskId: "jira-out-loop",
      output: "should-skip",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockJiraFetch).not.toHaveBeenCalled();
  });

  test("allows sync when lastSyncOrigin='external' but older than 5s", async () => {
    const sync = createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-loop-old",
      externalId: "10010",
      externalIdentifier: "KAN-10",
      syncDirection: "bidirectional",
    });
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "external",
      lastSyncedAt: new Date(Date.now() - 10_000).toISOString(),
    });

    workflowEventBus.emit("task.completed", {
      taskId: "jira-out-loop-old",
      output: "should-fire",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockJiraFetch).toHaveBeenCalledTimes(1);
  });

  test("falls back to externalId when externalIdentifier is null", async () => {
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-no-key",
      externalId: "10011",
      externalIdentifier: null,
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.cancelled", { taskId: "jira-out-no-key" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const [path] = mockJiraFetch.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/rest/api/2/issue/10011/comment");
  });

  test("teardown removes listeners — events fire no posts after teardown", async () => {
    teardownJiraOutboundSync();
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-teardown",
      externalId: "10012",
      externalIdentifier: "KAN-12",
      syncDirection: "bidirectional",
    });

    workflowEventBus.emit("task.completed", {
      taskId: "jira-out-teardown",
      output: "ignored",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockJiraFetch).not.toHaveBeenCalled();
  });

  test("does NOT flip lastSyncOrigin on HTTP error from Jira", async () => {
    const sync = createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "jira-out-error",
      externalId: "10013",
      externalIdentifier: "KAN-13",
      syncDirection: "bidirectional",
    });
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "external",
      lastSyncedAt: new Date(Date.now() - 10_000).toISOString(), // outside loop window
    });

    mockJiraFetch.mockImplementationOnce(
      () => Promise.resolve(new Response("forbidden", { status: 403 })) as Promise<Response>,
    );

    workflowEventBus.emit("task.cancelled", { taskId: "jira-out-error" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockJiraFetch).toHaveBeenCalledTimes(1);
    const after = getTrackerSync("jira", "task", "jira-out-error");
    // Origin should remain 'external' — we did not write swarm-origin on failed POST.
    expect(after?.lastSyncOrigin).toBe("external");
  });
});
