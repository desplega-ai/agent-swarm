import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { closeDb, getDbClient, initDb } from "../be/db";
import {
  canAccessResource,
  canCreateResource,
  canManageResourceProfile,
  canManageResourceTemplates,
  listAccessibleResources,
  resolveResourceAccess,
} from "../be/resources/access";
import { addResourceLink } from "../be/resources/db";
import { clearAuditSink, type RbacCheck, type RbacPrincipal, setAuditSink } from "../rbac";
import { removeResourceTestDb, resourceFixture } from "./resources-test-utils";

const path = "./test-resources-access.sqlite";
let f: Awaited<ReturnType<typeof resourceFixture>>;
beforeAll(async () => {
  await removeResourceTestDb(path);
  initDb(path);
  f = await resourceFixture();
});
afterAll(async () => {
  clearAuditSink();
  closeDb();
  await removeResourceTestDb(path);
});
const worker = (): RbacPrincipal => ({ kind: "agent", agentId: f.agent.id, isLead: false });

test("agents require an explicit owned task and never infer one of several tasks", async () => {
  expect(await resolveResourceAccess(worker())).toBeNull();
  expect(await resolveResourceAccess(worker(), f.foreign.id)).toBeNull();
  expect(
    await resolveResourceAccess(
      { kind: "agent", agentId: f.otherAgent.id, isLead: true },
      f.task.id,
    ),
  ).toBeNull();
  const access = (await resolveResourceAccess(worker(), f.sibling.id))!;
  expect(await canAccessResource(access, f.resource)).toBe(true);
  expect(await canAccessResource(access, f.browser, "resource.use")).toBe(true);
  const concurrent = (await resolveResourceAccess(worker(), f.concurrent.id))!;
  expect(await canAccessResource(concurrent, f.resource)).toBe(false);
  expect(await listAccessibleResources(concurrent, { limit: 50, offset: 0 })).toEqual([]);
  expect(await canCreateResource(access, f.profile.id)).toBe(true);
});

test("links never grant access and current task requesters control personal profiles", async () => {
  await addResourceLink({
    resourceId: f.resource.id,
    kind: "task",
    targetId: f.foreign.id,
    isPrimary: false,
  });
  const foreign = (await resolveResourceAccess(
    { kind: "agent", agentId: f.otherAgent.id, isLead: true },
    f.foreign.id,
  ))!;
  expect(await canAccessResource(foreign, f.resource)).toBe(false);
  const feedback = (await resolveResourceAccess(worker(), f.feedback.id))!;
  expect(feedback.requesterUserId).toBe(f.otherUser.id);
  expect(await canAccessResource(feedback, f.resource)).toBe(true);
  expect(await canAccessResource(feedback, f.browser)).toBe(false);
  expect(await canCreateResource(feedback, f.profile.id)).toBe(false);
  await expect(
    getDbClient().run("UPDATE resources SET requestedByUserId = ? WHERE id = ?", [
      f.otherUser.id,
      f.browser.id,
    ]),
  ).rejects.toThrow("requester attribution is immutable");
  expect(await canAccessResource(feedback, f.browser)).toBe(false);
});

test("operators manage templates and swarm profiles, users manage only their own profiles", async () => {
  const operator = { kind: "operator" } as const;
  const owner = { kind: "user", userId: f.user.id } as const;
  const stranger = { kind: "user", userId: f.otherUser.id } as const;
  expect(canManageResourceTemplates(operator)).toBe(true);
  for (const principal of [owner, stranger, worker()])
    expect(canManageResourceTemplates(principal)).toBe(false);
  for (const principal of [operator, owner, stranger, worker()]) {
    expect(canManageResourceProfile(principal, f.profile)).toBe(principal === owner);
    expect(canManageResourceProfile(principal, { ownerScope: "swarm", ownerUserId: null })).toBe(
      principal === operator,
    );
  }
  expect(await resolveResourceAccess(owner, f.foreign.id)).toBeNull();
  const access = (await resolveResourceAccess(owner))!;
  expect(await canAccessResource(access, f.resource)).toBe(true);
  expect(await canAccessResource(access, f.browser)).toBe(true);
  expect(await canAccessResource(access, f.browser, "resource.use")).toBe(false);
  expect(await canAccessResource(access, f.resource, "resource.destroy")).toBe(false);
  expect(await canAccessResource((await resolveResourceAccess(stranger))!, f.resource)).toBe(false);
  expect(await canCreateResource((await resolveResourceAccess(operator))!)).toBe(false);
  expect(await resolveResourceAccess({ kind: "guest" }, f.task.id)).toBeNull();
});

test("permission audits carry identifiers and verified booleans without private values", async () => {
  const audits: RbacCheck[] = [];
  setAuditSink((check) => audits.push(check));
  const access = (await resolveResourceAccess(worker(), f.task.id))!;
  for (const verb of [
    "resource.read",
    "resource.use",
    "resource.destroy",
    "resource.feedback",
  ] as const)
    expect(await canAccessResource(access, f.resource, verb)).toBe(true);
  const serialized = JSON.stringify(audits);
  expect(serialized).toContain(f.resource.id);
  for (const secret of [
    "providerHandle",
    "privateConfig",
    "cdpUrl",
    "liveUrl",
    "private-provider-session-handle",
    "private-resource-config-value",
  ])
    expect(serialized).not.toContain(secret);
  clearAuditSink();
});

test("missing ancestors fail closed", async () => {
  const id = crypto.randomUUID();
  await getDbClient().run(
    "INSERT INTO agent_tasks (id, task, status, createdAt, lastUpdatedAt, parentTaskId, agentId) VALUES (?, 'orphan', 'pending', ?, ?, ?, ?)",
    [id, new Date().toISOString(), new Date().toISOString(), crypto.randomUUID(), f.agent.id],
  );
  expect(await resolveResourceAccess(worker(), id)).toBeNull();
});

test("history reads use stored attribution after requester changes, reparenting, and source deletion", async () => {
  const h = await resourceFixture();
  const owner = (await resolveResourceAccess({ kind: "user", userId: h.user.id }))!;
  const stranger = (await resolveResourceAccess({ kind: "user", userId: h.otherUser.id }))!;
  const operator = (await resolveResourceAccess({ kind: "operator" }))!;
  const agent = (await resolveResourceAccess(
    { kind: "agent", agentId: h.agent.id, isLead: false },
    h.sibling.id,
  ))!;
  const trigger = (await getDbClient().get<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE name = 'session_task_parent_immutable'",
  ))!;
  // Simulate an imported or repaired tree. Normal writes forbid reparenting.
  await getDbClient().run("DROP TRIGGER session_task_parent_immutable");
  try {
    for (const change of ["requester", "parent", "delete"] as const) {
      if (change === "requester")
        await getDbClient().run("UPDATE agent_tasks SET requestedByUserId = ? WHERE id = ?", [
          h.otherUser.id,
          h.task.id,
        ]);
      if (change === "parent")
        await getDbClient().run("UPDATE agent_tasks SET parentTaskId = ? WHERE id = ?", [
          h.concurrent.id,
          h.task.id,
        ]);
      if (change === "delete")
        await getDbClient().run("DELETE FROM agent_tasks WHERE id = ?", [h.task.id]);
      for (const resource of [h.resource, h.browser]) {
        for (const access of [owner, operator]) {
          expect(await canAccessResource(access, resource)).toBe(true);
          expect(await listAccessibleResources(access, { limit: 100, offset: 0 })).toContainEqual(
            resource,
          );
        }
        expect(await canAccessResource(stranger, resource)).toBe(false);
        expect(
          await listAccessibleResources(stranger, { limit: 100, offset: 0 }),
        ).not.toContainEqual(resource);
        if (change !== "requester") {
          expect(await canAccessResource(agent, resource)).toBe(false);
          expect(await canAccessResource(agent, resource, "resource.use")).toBe(false);
          expect(await listAccessibleResources(agent, { limit: 100, offset: 0 })).toEqual([]);
        }
      }
    }
  } finally {
    await getDbClient().run(trigger.sql);
  }
});

test("operator private metadata visibility grants no implicit profile rights or browser control", async () => {
  const operator = (await resolveResourceAccess({ kind: "operator" }))!;
  expect(await canAccessResource(operator, f.browser)).toBe(true);
  expect(
    await listAccessibleResources(operator, { kind: "browser", limit: 100, offset: 0 }),
  ).toContainEqual(f.browser);
  for (const verb of ["resource.use", "resource.destroy", "resource.feedback"] as const)
    expect(await canAccessResource(operator, f.browser, verb)).toBe(false);
  expect(canManageResourceProfile(operator.principal, f.profile)).toBe(false);
  const selectedTask = (await resolveResourceAccess(operator.principal, f.task.id))!;
  expect(await canAccessResource(selectedTask, f.browser)).toBe(true);
  for (const verb of ["resource.use", "resource.destroy", "resource.feedback"] as const)
    expect(await canAccessResource(selectedTask, f.browser, verb)).toBe(false);
  expect(await canCreateResource(selectedTask, f.profile.id)).toBe(false);
  // Selecting a task still authorizes ordinary sandbox operations, not impersonation of its user.
  expect(await canCreateResource(selectedTask)).toBe(true);
  expect(await canAccessResource(selectedTask, f.resource, "resource.use")).toBe(true);
});

test("fresh assignment and requester checks reject stale access for create and use", async () => {
  const h = await resourceFixture();
  const principal = { kind: "agent", agentId: h.agent.id, isLead: false } as const;
  const access = (await resolveResourceAccess(principal, h.sibling.id))!;
  await getDbClient().run("UPDATE agent_tasks SET requestedByUserId = ? WHERE id = ?", [
    h.otherUser.id,
    h.sibling.id,
  ]);
  expect(await canCreateResource(access, h.profile.id)).toBe(false);
  expect(await canAccessResource(access, h.browser, "resource.use")).toBe(false);
  expect(await canAccessResource(access, h.browser)).toBe(false);
  await getDbClient().run("UPDATE agent_tasks SET agentId = ? WHERE id = ?", [
    h.otherAgent.id,
    h.sibling.id,
  ]);
  expect(await canCreateResource(access)).toBe(false);
  expect(await canAccessResource(access, h.resource, "resource.use")).toBe(false);
  expect(await canAccessResource(access, h.resource)).toBe(false);
  expect(await listAccessibleResources(access, { limit: 50, offset: 0 })).toEqual([]);
});

test("SQL listings filter before pagination and emit one audit regardless of candidate count", async () => {
  const { createResource } = await import("../be/resources/db");
  const h = await resourceFixture();
  const access = (await resolveResourceAccess(
    { kind: "agent", agentId: h.agent.id, isLead: false },
    h.task.id,
  ))!;
  for (let i = 0; i < 12; i++)
    await createResource({
      kind: "sandbox",
      provider: "fake",
      creatorAgentId: h.agent.id,
      sourceTaskId: h.task.id,
      createRequestKey: `page-${i}`,
      expiresAt: h.resource.expiresAt,
    });
  const audits: RbacCheck[] = [];
  setAuditSink((check) => audits.push(check));
  try {
    const all = await listAccessibleResources(access, {
      kind: "sandbox",
      state: "provisioning",
      limit: 100,
      offset: 0,
    });
    expect(all).toHaveLength(13);
    expect(audits).toHaveLength(1);
    audits.length = 0;
    const page = await listAccessibleResources(access, {
      kind: "sandbox",
      state: "provisioning",
      limit: 3,
      offset: 4,
    });
    expect(page).toEqual(all.slice(4, 7));
    expect(audits).toHaveLength(1);
    expect(
      await listAccessibleResources(access, { state: "destroyed", limit: 3, offset: 0 }),
    ).toEqual([]);
    expect(
      await listAccessibleResources(access, { kind: "sandbox", limit: 3, offset: 100 }),
    ).toEqual([]);
    for (const resource of all) expect(await canAccessResource(access, resource)).toBe(true);
    expect(await canAccessResource(access, f.resource)).toBe(false);
  } finally {
    clearAuditSink();
  }
});

test("agent listings anchor their recursive query to the authorized root", async () => {
  const access = (await resolveResourceAccess(worker(), f.sibling.id))!;
  const queries = spyOn(getDbClient(), "query");
  try {
    const resources = await listAccessibleResources(access, { limit: 100, offset: 0 });
    expect(resources).toContainEqual(f.resource);
    const recursive = queries.mock.calls.find(([sql]) => sql.startsWith("WITH RECURSIVE"));
    expect(recursive).toBeDefined();
    const [sql, params] = recursive!;
    expect(sql).toContain("WHERE id = ? AND parentTaskId IS NULL");
    expect(params?.[0]).toBe(f.task.id);
    const plan = await getDbClient().query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
    expect(
      plan.some(
        (row) => row.detail.includes("SEARCH agent_tasks") && row.detail.includes("(id=?)"),
      ),
    ).toBe(true);
  } finally {
    queries.mockRestore();
  }
});

test("Slack fallback uses the selected task requester and never the original feedback author", async () => {
  const { createTaskExtended } = await import("../be/db");
  const { createResource, resourceTaskContext } = await import("../be/resources/db");
  const { linkIdentity } = await import("../be/users");
  const h = await resourceFixture();
  const slackId = `slack-${crypto.randomUUID()}`;
  await linkIdentity(h.user.id, "slack", slackId, { kind: "system", id: "resource-test" });
  const task = await createTaskExtended("Slack source", {
    agentId: h.agent.id,
    slackUserId: slackId,
  });
  expect((await resourceTaskContext(task.id))?.requestedByUserId).toBe(h.user.id);
  await getDbClient().run("UPDATE resources SET liveReservation = 0 WHERE id = ?", [h.browser.id]);
  const resource = await createResource({
    kind: "browser",
    provider: "fake",
    creatorAgentId: h.agent.id,
    sourceTaskId: task.id,
    createRequestKey: "slack-create",
    profileId: h.profile.id,
    expiresAt: h.resource.expiresAt,
  });
  expect(resource.requestedByUserId).toBe(h.user.id);
  const feedback = await createTaskExtended("Feedback from another user", {
    agentId: h.agent.id,
    parentTaskId: task.id,
    requestedByUserId: h.otherUser.id,
    slackUserId: slackId,
    inheritParentRequester: false,
  });
  const access = (await resolveResourceAccess(
    { kind: "agent", agentId: h.agent.id, isLead: false },
    feedback.id,
  ))!;
  expect(access.requesterUserId).toBe(h.otherUser.id);
  expect(await canAccessResource(access, resource)).toBe(false);
  expect(await canCreateResource(access, h.profile.id)).toBe(false);
  await expect(
    createResource({
      kind: "browser",
      provider: "fake",
      creatorAgentId: h.agent.id,
      sourceTaskId: feedback.id,
      createRequestKey: "feedback-create",
      profileId: h.profile.id,
      expiresAt: resource.expiresAt,
    }),
  ).rejects.toThrow("cannot use this browser profile");
});
