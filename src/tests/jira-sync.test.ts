import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  completeTask,
  createAgent,
  createUser,
  getDb,
  getTaskById,
  initDb,
} from "../be/db";
import { upsertOAuthApp } from "../be/db-queries/oauth";
import {
  createTrackerSync,
  createTrackerSyncIfAbsent,
  getTrackerSyncByExternalId,
  updateTrackerSync,
} from "../be/db-queries/tracker";
import { findUserByExternalId, type IdentityActor, linkIdentity } from "../be/users";

const SYSTEM_ACTOR: IdentityActor = { kind: "system", id: "test" };

const TEST_DB_PATH = "./test-jira-sync.sqlite";
const BOT_ACCOUNT_ID = "bot-account-12345";
const SITE_URL = "https://example.atlassian.net";

beforeAll(() => {
  initDb(TEST_DB_PATH);
  // Seed an oauth_apps row + cloudId/siteUrl so URL helpers don't blow up
  upsertOAuthApp("jira", {
    clientId: "client-id",
    clientSecret: "client-secret",
    authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    redirectUri: "http://localhost:3013/api/trackers/jira/callback",
    scopes: "read:jira-work,write:jira-work,manage:jira-webhook,offline_access,read:me",
    metadata: JSON.stringify({ cloudId: "cloud-1", siteUrl: SITE_URL }),
  });

  // Seed a lead agent so task creation has a target.
  createAgent({
    name: "lead-1",
    isLead: true,
    status: "idle",
  });
});

afterAll(async () => {
  closeDb();
  await unlink(TEST_DB_PATH).catch(() => {});
  await unlink(`${TEST_DB_PATH}-wal`).catch(() => {});
  await unlink(`${TEST_DB_PATH}-shm`).catch(() => {});
});

// Import sync handlers AFTER seeding so module-level side effects (template
// registration) see a healthy DB.
const { _setBotAccountIdForTesting, handleCommentEvent, handleIssueEvent } = await import(
  "../jira/sync"
);
const { getTemplateDefinition } = await import("../prompts/registry");

beforeEach(async () => {
  // Reset tracker_sync rows + tasks each test
  getDb().query("DELETE FROM tracker_sync").run();
  getDb().query("DELETE FROM agent_tasks").run();
  _setBotAccountIdForTesting(BOT_ACCOUNT_ID);
  // Re-register Jira templates if a parallel test file has cleared the registry.
  if (!getTemplateDefinition("jira.issue.assigned")) {
    await import(`../jira/templates?t=${Date.now()}`);
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeIssueAssignedEvent(issueId: string, issueKey: string, summary = "An issue") {
  return {
    webhookEvent: "jira:issue_updated",
    issue: {
      id: issueId,
      key: issueKey,
      fields: {
        summary,
        description: { type: "doc", content: [] },
        reporter: { displayName: "Reporter Name", accountId: "reporter-1" },
      },
    },
    changelog: {
      items: [{ field: "assignee", fieldId: "assignee", from: null, to: BOT_ACCOUNT_ID }],
    },
  };
}

function makeCommentEvent(
  issueId: string,
  issueKey: string,
  authorAccountId: string,
  bodyText: string,
  mentionAccountIds: string[] = [],
) {
  const content: unknown[] = [{ type: "text", text: bodyText }];
  for (const id of mentionAccountIds) {
    content.push({ type: "mention", attrs: { id, text: `@User ${id}` } });
  }
  return {
    webhookEvent: "comment_created",
    issue: {
      id: issueId,
      key: issueKey,
      fields: {
        summary: "Issue with comments",
        description: { type: "doc", content: [] },
      },
    },
    comment: {
      id: "c-1",
      body: { type: "doc", content: [{ type: "paragraph", content }] },
      author: { accountId: authorAccountId, displayName: "Some User" },
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("handleIssueEvent — assignee→bot", () => {
  test("creates fresh task + tracker_sync when no prior row exists", async () => {
    await handleIssueEvent(makeIssueAssignedEvent("10001", "KAN-1", "Add feature"));

    const sync = getTrackerSyncByExternalId("jira", "task", "10001");
    expect(sync).not.toBeNull();
    expect(sync?.externalIdentifier).toBe("KAN-1");
    expect(sync?.lastSyncOrigin).toBe("external");
    expect(sync?.swarmId).toBeTruthy();

    const task = getTaskById(sync?.swarmId ?? "");
    expect(task).not.toBeNull();
    expect(task?.source).toBe("jira");
    expect(task?.taskType).toBe("jira-issue");
    expect(task?.task).toContain("KAN-1");
    expect(task?.task).toContain("Add feature");
  });

  test("ignores transitions away from bot (FROM=bot, TO=other)", async () => {
    const event = makeIssueAssignedEvent("10002", "KAN-2");
    event.changelog.items[0] = {
      field: "assignee",
      fieldId: "assignee",
      from: BOT_ACCOUNT_ID,
      to: "someone-else",
    };
    await handleIssueEvent(event);

    expect(getTrackerSyncByExternalId("jira", "task", "10002")).toBeNull();
  });

  test("UNIQUE-gates concurrent inserts (second call no-ops)", async () => {
    // Prime: create the sync row first as if a previous identical event already won.
    createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "",
      externalId: "10003",
      externalIdentifier: "KAN-3",
      lastSyncOrigin: "external",
      syncDirection: "inbound",
    });

    // Now run handler. With prior row + no swarmId, the handler should treat
    // the prior task as orphan/terminal and create a follow-up task.
    await handleIssueEvent(makeIssueAssignedEvent("10003", "KAN-3"));

    // Should only have ONE sync row (UNIQUE-gated insert).
    const rows = getDb()
      .query("SELECT COUNT(*) AS c FROM tracker_sync WHERE externalId = '10003'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  test("re-assignment with active prior task is ignored (no duplicate task)", async () => {
    // First assignment creates the task.
    await handleIssueEvent(makeIssueAssignedEvent("10004", "KAN-4"));
    const beforeRow = getTrackerSyncByExternalId("jira", "task", "10004");
    expect(beforeRow?.swarmId).toBeTruthy();
    const firstTaskId = beforeRow?.swarmId;

    // Re-assign while task is still active (not completed/failed/cancelled).
    await handleIssueEvent(makeIssueAssignedEvent("10004", "KAN-4"));

    const afterRow = getTrackerSyncByExternalId("jira", "task", "10004");
    expect(afterRow?.swarmId).toBe(firstTaskId ?? "");
    // Task count should still be 1
    const taskCount = getDb().query("SELECT COUNT(*) AS c FROM agent_tasks").get() as { c: number };
    expect(taskCount.c).toBe(1);
  });

  test("re-assignment after task completion creates follow-up task", async () => {
    await handleIssueEvent(makeIssueAssignedEvent("10005", "KAN-5"));
    const firstSync = getTrackerSyncByExternalId("jira", "task", "10005");
    const firstTaskId = firstSync?.swarmId;
    expect(firstTaskId).toBeTruthy();

    // Mark first task as completed
    if (firstTaskId) {
      completeTask(firstTaskId);
    }

    // Re-assign — should create a follow-up via jira.issue.followup template
    await handleIssueEvent(makeIssueAssignedEvent("10005", "KAN-5"));

    // We should now have 2 tasks for this externalId chain. Note tracker_sync's
    // swarmId points at the most-recent task.
    const taskCount = getDb().query("SELECT COUNT(*) AS c FROM agent_tasks").get() as { c: number };
    expect(taskCount.c).toBe(2);
    const afterSync = getTrackerSyncByExternalId("jira", "task", "10005");
    expect(afterSync?.swarmId).not.toBe(firstTaskId ?? "");
    const followupTask = getTaskById(afterSync?.swarmId ?? "");
    expect(followupTask?.task).toContain("Follow-up");
  });
});

describe("handleCommentEvent — short-circuits", () => {
  test("self-authored comment is skipped (no task created)", async () => {
    // Prime an empty inbox: no prior sync row.
    await handleCommentEvent(
      makeCommentEvent("10010", "KAN-10", BOT_ACCOUNT_ID, "Ping", [BOT_ACCOUNT_ID]),
    );
    expect(getTrackerSyncByExternalId("jira", "task", "10010")).toBeNull();
  });

  test("outbound-echo skip: lastSyncOrigin='swarm' within 5s short-circuits", async () => {
    // Pre-create a tracker_sync row marked as swarm-origin with a fresh
    // lastSyncedAt so the 5s echo window is active.
    const sync = createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "task-existing",
      externalId: "10011",
      externalIdentifier: "KAN-11",
      lastSyncOrigin: "swarm",
      syncDirection: "bidirectional",
    });
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "swarm",
      lastSyncedAt: new Date().toISOString(),
    });

    // External user mentions bot → should be skipped because of 5s window.
    await handleCommentEvent(
      makeCommentEvent("10011", "KAN-11", "user-other", "ping", [BOT_ACCOUNT_ID]),
    );

    const taskCount = getDb().query("SELECT COUNT(*) AS c FROM agent_tasks").get() as { c: number };
    expect(taskCount.c).toBe(0);
  });

  test("outbound-echo skip ages out after 6s — comment now creates a task", async () => {
    const sync = createTrackerSync({
      provider: "jira",
      entityType: "task",
      swarmId: "", // orphan → followup branch
      externalId: "10012",
      externalIdentifier: "KAN-12",
      lastSyncOrigin: "swarm",
      syncDirection: "bidirectional",
    });
    // 6s ago — outside the 5s window.
    updateTrackerSync(sync.id, {
      lastSyncOrigin: "swarm",
      lastSyncedAt: new Date(Date.now() - 6_000).toISOString(),
    });

    await handleCommentEvent(
      makeCommentEvent("10012", "KAN-12", "user-other", "ping", [BOT_ACCOUNT_ID]),
    );

    const taskCount = getDb()
      .query("SELECT COUNT(*) AS c FROM agent_tasks WHERE source = 'jira'")
      .get() as { c: number };
    expect(taskCount.c).toBe(1);
  });

  test("comment without bot mention is ignored", async () => {
    await handleCommentEvent(
      makeCommentEvent("10013", "KAN-13", "user-other", "no mention here", []),
    );
    expect(getTrackerSyncByExternalId("jira", "task", "10013")).toBeNull();
  });

  test("bot-mention with no prior sync creates fresh comment-mention task", async () => {
    await handleCommentEvent(
      makeCommentEvent("10014", "KAN-14", "user-other", "Hey ", [BOT_ACCOUNT_ID]),
    );
    const sync = getTrackerSyncByExternalId("jira", "task", "10014");
    expect(sync).not.toBeNull();
    const task = getTaskById(sync?.swarmId ?? "");
    expect(task?.source).toBe("jira");
  });

  test("bot-mention triggers follow-up on completed prior task", async () => {
    // Establish prior task via assignee path
    await handleIssueEvent(makeIssueAssignedEvent("10015", "KAN-15"));
    const sync = getTrackerSyncByExternalId("jira", "task", "10015");
    const firstTaskId = sync?.swarmId;
    expect(firstTaskId).toBeTruthy();
    if (firstTaskId) completeTask(firstTaskId);

    await handleCommentEvent(
      makeCommentEvent("10015", "KAN-15", "user-other", "follow-up please", [BOT_ACCOUNT_ID]),
    );

    const taskCount = getDb()
      .query("SELECT COUNT(*) AS c FROM agent_tasks WHERE source = 'jira'")
      .get() as { c: number };
    expect(taskCount.c).toBe(2);
  });
});

describe("identity resolution — Jira routes through resolveIdentity, never raw displayName", () => {
  test("issue-assigned: reporter linked by accountId -> requestedByUserId set + rendered pair in task text", async () => {
    const reporter = createUser({ name: "Zbigniew Reporter", email: "zbigniew-jira@example.com" });
    linkIdentity(reporter.id, "jira", "reporter-linked-1", SYSTEM_ACTOR);

    const event = makeIssueAssignedEvent("10030", "KAN-30", "Linked reporter issue");
    event.issue.fields.reporter = {
      displayName: "Reporter Name",
      accountId: "reporter-linked-1",
    };
    await handleIssueEvent(event);

    const sync = getTrackerSyncByExternalId("jira", "task", "10030");
    const task = getTaskById(sync?.swarmId ?? "");
    expect(task).not.toBeNull();
    expect(task?.requestedByUserId).toBe(reporter.id);
    expect(task?.task).toContain("Zbigniew Reporter (jira:reporter-linked-1)");
    expect(task?.task).not.toContain("Reporter Name");
  });

  test("issue-assigned: reporter with an email but no prior link auto-links via findOrCreateUserByEmail", async () => {
    const event = makeIssueAssignedEvent("10031", "KAN-31", "Email-cascade issue");
    event.issue.fields.reporter = {
      displayName: "Auto Linked",
      accountId: "reporter-autolink-1",
      emailAddress: "auto-linked-jira@example.com",
    };
    await handleIssueEvent(event);

    const linked = findUserByExternalId("jira", "reporter-autolink-1");
    expect(linked).not.toBeNull();
    expect(linked?.name).toBe("Auto Linked");

    const sync = getTrackerSyncByExternalId("jira", "task", "10031");
    const task = getTaskById(sync?.swarmId ?? "");
    expect(task?.requestedByUserId).toBe(linked?.id);
    expect(task?.task).toContain("Auto Linked (jira:reporter-autolink-1)");
  });

  test("issue-assigned: unlinked reporter with no email renders the UNKNOWN sentinel, never the displayName", async () => {
    const event = makeIssueAssignedEvent("10032", "KAN-32", "Unknown reporter issue");
    event.issue.fields.reporter = {
      displayName: "Never Registered",
      accountId: "reporter-unknown-1",
    };
    await handleIssueEvent(event);

    const sync = getTrackerSyncByExternalId("jira", "task", "10032");
    const task = getTaskById(sync?.swarmId ?? "");
    expect(task).not.toBeNull();
    expect(task?.requestedByUserId ?? null).toBeNull();
    expect(task?.task).toContain("jira:reporter-unknown-1 (unknown user)");
    expect(task?.task).not.toContain("Never Registered");
  });

  test("comment-mention: linked author -> requestedByUserId set + rendered pair as comment_author", async () => {
    const author = createUser({ name: "Manuel Commenter", email: "manuel-jira@example.com" });
    linkIdentity(author.id, "jira", "commenter-linked-1", SYSTEM_ACTOR);

    await handleCommentEvent(
      makeCommentEvent("10033", "KAN-33", "commenter-linked-1", "please take a look", [
        BOT_ACCOUNT_ID,
      ]),
    );

    const sync = getTrackerSyncByExternalId("jira", "task", "10033");
    const task = getTaskById(sync?.swarmId ?? "");
    expect(task).not.toBeNull();
    expect(task?.requestedByUserId).toBe(author.id);
    expect(task?.task).toContain("Manuel Commenter (jira:commenter-linked-1)");
    expect(task?.task).not.toContain("Some User");
  });

  test("comment-mention: unlinked author renders the UNKNOWN sentinel, never the raw displayName", async () => {
    await handleCommentEvent(
      makeCommentEvent("10034", "KAN-34", "commenter-unknown-1", "any updates?", [BOT_ACCOUNT_ID]),
    );

    const sync = getTrackerSyncByExternalId("jira", "task", "10034");
    const task = getTaskById(sync?.swarmId ?? "");
    expect(task).not.toBeNull();
    expect(task?.requestedByUserId ?? null).toBeNull();
    expect(task?.task).toContain("jira:commenter-unknown-1 (unknown user)");
    expect(task?.task).not.toContain("Some User");
  });
});

describe("createTrackerSyncIfAbsent — UNIQUE-gated insert", () => {
  test("first call inserts; second call returns existing", () => {
    const first = createTrackerSyncIfAbsent({
      provider: "jira",
      entityType: "task",
      swarmId: "",
      externalId: "10020",
      externalIdentifier: "KAN-20",
    });
    expect(first.inserted).toBe(true);

    const second = createTrackerSyncIfAbsent({
      provider: "jira",
      entityType: "task",
      swarmId: "",
      externalId: "10020",
      externalIdentifier: "KAN-20",
    });
    expect(second.inserted).toBe(false);
    expect(second.sync.id).toBe(first.sync.id);
  });
});
