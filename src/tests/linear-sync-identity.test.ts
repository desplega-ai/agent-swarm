import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createUser,
  deleteKv,
  getDb,
  getKv,
  getTaskById,
  initDb,
  upsertKv,
} from "../be/db";
import { getTrackerSyncByExternalId } from "../be/db-queries/tracker";
import { findUserByExternalId, linkIdentity } from "../be/users";
import { handleAgentSessionEvent, handleAgentSessionPrompted } from "../linear/sync";
import { _clearRecentDeliveries } from "../linear/webhook";
import { getTemplateDefinition } from "../prompts/registry";

const TEST_DB_PATH = "./test-linear-sync-identity.sqlite";
const UNMAPPED_NAMESPACE = "integration:unmapped:linear";
const APP_USER_ID_NAMESPACE = "integration:linear:bot-app-user-id";

// ── Helpers ──

let issueCounter = 0;
function makeIssue(): {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description: string;
} {
  issueCounter += 1;
  const n = String(issueCounter).padStart(3, "0");
  return {
    id: `issue-identity-${n}`,
    identifier: `IDP-${n}`,
    title: `Identity test issue ${n}`,
    url: `https://linear.app/team/issue/IDP-${n}`,
    description: "Test description",
  };
}

async function identityEventTypes(userId: string): Promise<string[]> {
  return (await getDb())
    .prepare<{ eventType: string }, string>(
      "SELECT eventType FROM user_identity_events WHERE userId = ? ORDER BY createdAt ASC, rowid ASC",
    )
    .all(userId)
    .map((r) => r.eventType);
}

async function externalIdsCount(): Promise<number> {
  const row = (await getDb())
    .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM user_external_ids")
    .get();
  return row?.n ?? 0;
}

async function usersCount(): Promise<number> {
  const row = (await getDb()).prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get();
  return row?.n ?? 0;
}

// ── Setup ──

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
  await initDb(TEST_DB_PATH);
  // Linear sync needs a lead agent to be present (it uses findLeadAgent()).
  const { createAgent } = await import("../be/db");
  createAgent({ name: "TestLead", isLead: true, status: "idle" });
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(`${TEST_DB_PATH}${suffix}`).catch(() => {});
  }
});

beforeEach(async () => {
  _clearRecentDeliveries();
  if (!getTemplateDefinition("linear.issue.assigned")) {
    await import(`../linear/templates?t=${Date.now()}`);
  }
  // Reset identity-relevant rows between tests so each case starts clean.
  // Order matters — agent_tasks has FK on users.id via requestedByUserId.
  const db = await getDb();
  db.prepare("DELETE FROM tracker_sync").run();
  db.prepare("DELETE FROM agent_tasks").run();
  db.prepare("DELETE FROM user_external_ids").run();
  db.prepare("DELETE FROM user_identity_events").run();
  db.prepare("DELETE FROM users").run();
  db.prepare("DELETE FROM kv_entries WHERE namespace = ?").run(UNMAPPED_NAMESPACE);
  db.prepare("DELETE FROM kv_entries WHERE namespace = ?").run(APP_USER_ID_NAMESPACE);
});

// ─── AgentSessionEvent.created ────────────────────────────────────────────────

describe("handleAgentSessionEvent — identity resolution (Q21.A fix)", () => {
  test("fast path: existing user_external_ids row resolves requestedByUserId", async () => {
    const issue = makeIssue();
    const linearUserId = "lin-user-fastpath-001";
    const u = await createUser({ name: "Existing Human", email: "existing@example.com" });
    await linkIdentity(u.id, "linear", linearUserId, { kind: "system", id: "test-fixture" });

    const beforeUsers = await usersCount();
    const beforeExt = await externalIdsCount();

    const event = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      agentSession: {
        id: "sess-1",
        url: "https://linear.app/sess/sess-1",
        issue,
        creator: { id: linearUserId, email: "existing@example.com", name: "Existing Human" },
      },
    };

    await handleAgentSessionEvent(event);

    const sync = await getTrackerSyncByExternalId("linear", "task", issue.id);
    expect(sync).not.toBeNull();
    const task = await getTaskById(sync!.swarmId);
    expect(task?.requestedByUserId).toBe(u.id);

    // No new user / no new external-id row was inserted.
    expect(await usersCount()).toBe(beforeUsers);
    expect(await externalIdsCount()).toBe(beforeExt);
  });

  test("cascade: unknown linear ID + email present creates user + links identity", async () => {
    const issue = makeIssue();
    const linearUserId = "lin-user-cascade-001";

    expect(await findUserByExternalId("linear", linearUserId)).toBeNull();

    const event = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      agentSession: {
        id: "sess-2",
        url: "https://linear.app/sess/sess-2",
        issue,
        creator: { id: linearUserId, email: "cascade@example.com", name: "Cascade Human" },
      },
    };

    await handleAgentSessionEvent(event);

    const sync = await getTrackerSyncByExternalId("linear", "task", issue.id);
    expect(sync).not.toBeNull();
    const task = await getTaskById(sync!.swarmId);
    expect(task?.requestedByUserId).toBeTruthy();

    const linked = await findUserByExternalId("linear", linearUserId);
    expect(linked).not.toBeNull();
    expect(linked!.email).toBe("cascade@example.com");
    expect(task?.requestedByUserId).toBe(linked!.id);

    // Both auto_merge (from findOrCreateUserByEmail's create branch emits
    // identity_added) and identity_added (from linkIdentity) should be present.
    const types = await identityEventTypes(linked!.id);
    expect(types).toContain("identity_added");
  });

  test("unknown linear ID + no email → unmapped kv rows written, requestedByUserId undefined", async () => {
    const issue = makeIssue();
    const linearUserId = "lin-user-unmapped-001";

    const event = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      agentSession: {
        id: "sess-3",
        url: "https://linear.app/sess/sess-3",
        issue,
        // No email — pure unmapped.
        creator: { id: linearUserId, name: "Unmapped Human" },
        comment: { body: "I need help with deploys" },
      },
    };

    await handleAgentSessionEvent(event);

    const sync = await getTrackerSyncByExternalId("linear", "task", issue.id);
    expect(sync).not.toBeNull();
    const task = await getTaskById(sync!.swarmId);
    expect(task?.requestedByUserId).toBeUndefined();

    const meta = await getKv(UNMAPPED_NAMESPACE, `${linearUserId}:meta`);
    expect(meta).not.toBeNull();
    expect(meta!.valueType).toBe("json");
    const metaValue = meta!.value as { sampleEventType: string; sampleContext: string | null };
    expect(metaValue.sampleEventType).toBe("AgentSessionEvent.created");
    expect(metaValue.sampleContext).toBe("I need help with deploys");

    const count = await getKv(UNMAPPED_NAMESPACE, `${linearUserId}:count`);
    expect(count).not.toBeNull();
    expect(count!.value).toBe(1);

    // No users / external-id rows were created.
    expect(await findUserByExternalId("linear", linearUserId)).toBeNull();
  });

  test("appUserId guard: creator.id === storedAppUserId → no user, no unmapped", async () => {
    const issue = makeIssue();
    const appUserId = "lin-app-user-bot-001";
    await upsertKv({
      namespace: APP_USER_ID_NAMESPACE,
      key: "org-1",
      value: appUserId,
      valueType: "string",
      expiresAt: null,
    });

    const before = { users: await usersCount(), ext: await externalIdsCount() };

    const event = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      agentSession: {
        id: "sess-4",
        url: "https://linear.app/sess/sess-4",
        issue,
        creator: { id: appUserId, email: "bot@swarm.example", name: "Agent Swarm" },
      },
    };

    await handleAgentSessionEvent(event);

    const sync = await getTrackerSyncByExternalId("linear", "task", issue.id);
    expect(sync).not.toBeNull();
    const task = await getTaskById(sync!.swarmId);
    expect(task?.requestedByUserId).toBeUndefined();

    // Crucially: no users row, no unmapped entry. The swarm doesn't hear itself.
    expect(await usersCount()).toBe(before.users);
    expect(await externalIdsCount()).toBe(before.ext);
    expect(await getKv(UNMAPPED_NAMESPACE, `${appUserId}:meta`)).toBeNull();
    expect(await getKv(UNMAPPED_NAMESPACE, `${appUserId}:count`)).toBeNull();
  });

  test("regression: OLD event.actor shape no longer enrolls a user", async () => {
    const issue = makeIssue();
    const before = { users: await usersCount(), ext: await externalIdsCount() };

    // Construct a payload in the broken old shape — top-level `actor` with no
    // `agentSession.creator`. The new extraction reads the nested path only;
    // this payload should produce no identity work at all.
    const event = {
      type: "AgentSessionEvent",
      action: "created",
      organizationId: "org-1",
      actor: { id: "lin-user-regression-001", email: "ghost@example.com", name: "Ghost" },
      agentSession: {
        id: "sess-5",
        url: "https://linear.app/sess/sess-5",
        issue,
        // Note: no `creator` field.
      },
    };

    await handleAgentSessionEvent(event);

    const sync = await getTrackerSyncByExternalId("linear", "task", issue.id);
    expect(sync).not.toBeNull();
    const task = await getTaskById(sync!.swarmId);
    expect(task?.requestedByUserId).toBeUndefined();
    expect(await usersCount()).toBe(before.users);
    expect(await externalIdsCount()).toBe(before.ext);
    expect(await getKv(UNMAPPED_NAMESPACE, `lin-user-regression-001:meta`)).toBeNull();
  });
});

// ─── AgentSessionEvent.prompted ───────────────────────────────────────────────

describe("handleAgentSessionPrompted — identity resolution (Q21.A fix)", () => {
  // Helper: seed a completed task + tracker_sync so the prompted handler
  // falls through to the follow-up branch where identity extraction runs.
  async function seedCompletedTask(issueId: string, identifier: string): Promise<void> {
    const { createTaskExtended } = await import("../be/db");
    const t = await createTaskExtended("Seeded prior", {
      source: "linear",
      taskType: "linear-issue",
    });
    (await getDb()).query("UPDATE agent_tasks SET status = 'completed' WHERE id = ?").run(t.id);
    const { createTrackerSync } = await import("../be/db-queries/tracker");
    await createTrackerSync({
      provider: "linear",
      entityType: "task",
      providerEntityType: "Issue",
      swarmId: t.id,
      externalId: issueId,
      externalIdentifier: identifier,
      externalUrl: `https://linear.app/team/issue/${identifier}`,
      lastSyncOrigin: "external",
      syncDirection: "inbound",
    });
  }

  test("fast path: existing external-id row populates requestedByUserId on followup", async () => {
    const issue = makeIssue();
    await seedCompletedTask(issue.id, issue.identifier);

    const linearUserId = "lin-user-prompted-fastpath-001";
    const u = await createUser({ name: "Prompted Human", email: "pf@example.com" });
    await linkIdentity(u.id, "linear", linearUserId, { kind: "system", id: "test-fixture" });

    const event = {
      type: "AgentSessionEvent",
      action: "prompted",
      organizationId: "org-1",
      agentSession: { id: "sess-p1", url: "x", issue },
      agentActivity: {
        signal: "",
        content: { body: "please continue" },
        user: { id: linearUserId, email: "pf@example.com", name: "Prompted Human" },
      },
    };

    await handleAgentSessionPrompted(event);

    const sync = await getTrackerSyncByExternalId("linear", "task", issue.id);
    expect(sync).not.toBeNull();
    const task = await getTaskById(sync!.swarmId);
    expect(task?.requestedByUserId).toBe(u.id);
  });

  test("cascade: prompted with unknown id + email creates and links", async () => {
    const issue = makeIssue();
    await seedCompletedTask(issue.id, issue.identifier);

    const linearUserId = "lin-user-prompted-cascade-001";

    const event = {
      type: "AgentSessionEvent",
      action: "prompted",
      organizationId: "org-1",
      agentSession: { id: "sess-p2", url: "x", issue },
      agentActivity: {
        signal: "",
        content: { body: "more context here" },
        user: { id: linearUserId, email: "pc@example.com", name: "Prompted Cascade" },
      },
    };

    await handleAgentSessionPrompted(event);

    const linked = await findUserByExternalId("linear", linearUserId);
    expect(linked).not.toBeNull();

    const sync = await getTrackerSyncByExternalId("linear", "task", issue.id);
    expect(sync).not.toBeNull();
    const task = await getTaskById(sync!.swarmId);
    expect(task?.requestedByUserId).toBe(linked!.id);
  });

  test("unmapped: prompted with unknown id + no email records kv", async () => {
    const issue = makeIssue();
    await seedCompletedTask(issue.id, issue.identifier);

    const linearUserId = "lin-user-prompted-unmapped-001";

    const event = {
      type: "AgentSessionEvent",
      action: "prompted",
      organizationId: "org-1",
      agentSession: { id: "sess-p3", url: "x", issue },
      agentActivity: {
        signal: "",
        content: { body: "anonymous follow-up" },
        user: { id: linearUserId, name: "No Email" },
      },
    };

    await handleAgentSessionPrompted(event);

    const meta = await getKv(UNMAPPED_NAMESPACE, `${linearUserId}:meta`);
    expect(meta).not.toBeNull();
    const metaValue = meta!.value as { sampleEventType: string; sampleContext: string | null };
    expect(metaValue.sampleEventType).toBe("AgentSessionEvent.prompted");
    expect(metaValue.sampleContext).toBe("anonymous follow-up");

    // Cleanup ledger so this test is hermetic across reruns.
    await deleteKv(UNMAPPED_NAMESPACE, `${linearUserId}:count`);
  });

  test("appUserId guard on prompted: user.id === storedAppUserId → no enrollment", async () => {
    const issue = makeIssue();
    await seedCompletedTask(issue.id, issue.identifier);

    const appUserId = "lin-app-user-bot-prompted-001";
    await upsertKv({
      namespace: APP_USER_ID_NAMESPACE,
      key: "org-1",
      value: appUserId,
      valueType: "string",
      expiresAt: null,
    });

    const before = { users: await usersCount(), ext: await externalIdsCount() };

    const event = {
      type: "AgentSessionEvent",
      action: "prompted",
      organizationId: "org-1",
      agentSession: { id: "sess-p4", url: "x", issue },
      agentActivity: {
        signal: "",
        content: { body: "swarm self-echo" },
        user: { id: appUserId, email: "bot@swarm.example", name: "Agent Swarm" },
      },
    };

    await handleAgentSessionPrompted(event);

    expect(await usersCount()).toBe(before.users);
    expect(await externalIdsCount()).toBe(before.ext);
    expect(await getKv(UNMAPPED_NAMESPACE, `${appUserId}:meta`)).toBeNull();
  });
});
