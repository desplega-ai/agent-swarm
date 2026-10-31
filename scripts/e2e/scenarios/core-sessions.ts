import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  asUser,
  cancelQuietly,
  createAssignedTask,
  createUser,
  registerWorker,
  UUID,
} from "./core-helpers";

const GHOST = "00000000-0000-4000-8000-00000000dead";

/** The run nonce is shared by every scenario, so session searches use a marker of their own. */
const mark = (ctx: ScenarioContext) => `core-sessions-${ctx.nonce}`;

type Actor = { headers: Record<string, string> };

function as(userId: string): Actor {
  return { headers: asUser(userId) };
}

function taskKey(ctx: ScenarioContext, taskId: string): string {
  const row = ctx.db.get<{ key: string }>("SELECT key FROM agent_tasks WHERE id = ?", [taskId]);
  expect(row !== null, `No agent_tasks row for ${taskId}`);
  return row.key;
}

async function listSessions(ctx: ScenarioContext, actor: Actor | null, query: string) {
  const response = await ctx.api("GET", `/api/sessions${query}`, actor ?? {});
  expectStatus(response, [200], `list sessions ${query}`);
  return asRecord(response.json);
}

function hasRoot(list: Record<string, unknown>, rootId: string): boolean {
  return asRecords(list, "sessions").some((item) => asRecord(item.root).id === rootId);
}

/** Session ownership, listing, sharing and the per-user inbox. */
async function ownershipAndSharing(
  ctx: ScenarioContext,
  workerId: string,
  owner: string,
  reader: string,
  stranger: string,
): Promise<{ rootId: string; childId: string }> {
  const created = await ctx.api("POST", "/api/tasks", {
    body: {
      task: `Session root ${mark(ctx)}`,
      agentId: workerId,
      routingReason: "human_pinned",
      source: "api",
      requestedByUserId: owner,
    },
  });
  expectStatus(created, [201], "create the session root");
  const rootId = String(asRecord(created.json).id);
  const childId = await createAssignedTask(ctx, workerId, `Session child ${mark(ctx)}`, {
    parentTaskId: rootId,
    routingReason: "continuity",
    requestedByUserId: owner,
  });

  // GET /api/sessions: listing, filters, slim versus full roots.
  let list = await listSessions(ctx, as(owner), `?q=${mark(ctx)}`);
  const item = asRecords(list, "sessions").find((entry) => asRecord(entry.root).id === rootId);
  expect(item !== undefined, "The owner's session list omits the root");
  expect(item.chainTaskCount === 2, `chainTaskCount is ${String(item.chainTaskCount)}`);
  expect(list.total === 1 && list.offset === 0, `Unexpected list envelope ${JSON.stringify(list)}`);
  expect(item.groupKey === "shared/", `Default group key is ${String(item.groupKey)}`);
  expect(!("routingReason" in asRecord(item.root)), "A slim list root carries the full task");
  list = await listSessions(ctx, as(owner), `?q=${mark(ctx)}&fields=full`);
  expect(
    "routingReason" in asRecord(asRecords(list, "sessions")[0]?.root),
    "fields=full did not restore the full root",
  );
  list = await listSessions(ctx, as(owner), `?q=${mark(ctx)}&source=api&scope=mine&limit=1`);
  expect(
    hasRoot(list, rootId) && list.limit === 1,
    "scope=mine with a source filter lost the root",
  );
  list = await listSessions(ctx, as(owner), `?q=${mark(ctx)}&source=slack`);
  expect(!hasRoot(list, rootId), "A slack source filter returned an api session");
  list = await listSessions(ctx, null, "?scope=mine");
  expect(
    asRecords(list, "sessions").length === 0 && list.total === 0,
    "The operator key has no personal sessions",
  );
  expect(
    hasRoot(await listSessions(ctx, null, `?q=${mark(ctx)}`), rootId),
    "The operator key cannot see every session",
  );
  list = await listSessions(ctx, as(owner), `?q=${mark(ctx)}&triage=done`);
  expect(!hasRoot(list, rootId), "A fresh session is already done");

  // GET /api/sessions/{rootTaskId}: the whole chain plus the viewer's access.
  let response = await ctx.api("GET", `/api/sessions/${rootId}`, as(owner));
  expectStatus(response, [200], "owner reads the session");
  const session = asRecord(response.json);
  expect(
    asRecord(session.root).id === rootId &&
      asRecords(session, "chain").some((task) => task.id === childId) &&
      session.access === "owner" &&
      asRecord(session.owner).id === owner &&
      session.groupKey === "shared/",
    `Unexpected session ${JSON.stringify({ ...session, root: "<root>", chain: "<chain>" })}`,
  );
  response = await ctx.api("GET", `/api/sessions/${rootId}`);
  expect(asRecord(response.json).access === "owner", "The operator key should read as owner");
  expectStatus(await ctx.api("GET", `/api/sessions/${GHOST}`), [404], "unknown session");

  // Sharing: private by default, then a read grant, a write grant, then everyone.
  response = await ctx.api("GET", `/api/sessions/${rootId}`, as(reader));
  expectStatus(response, [403], "an unshared session is private");
  response = await ctx.api("GET", `/api/sessions/${rootId}/shares`, as(owner));
  expectStatus(response, [200], "read shares");
  expect(
    asRecord(response.json).everyone === "none" && asRecords(response.json, "users").length === 0,
    "A new session has shares",
  );
  expectStatus(
    await ctx.api("GET", `/api/sessions/${rootId}/shares`, as(stranger)),
    [403],
    "a stranger reads the shares",
  );
  expectStatus(await ctx.api("GET", `/api/sessions/${GHOST}/shares`), [404], "shares of unknown");

  response = await ctx.api("PUT", `/api/sessions/${rootId}/shares`, {
    ...as(owner),
    body: { everyone: "none", users: [{ userId: reader, access: "read" }] },
  });
  expectStatus(response, [200], "share with one reader");
  expect(
    JSON.stringify(asRecords(response.json, "users").map((u) => [u.userId, u.access])) ===
      JSON.stringify([[reader, "read"]]),
    `Share state ${response.text}`,
  );
  response = await ctx.api("GET", `/api/sessions/${rootId}`, as(reader));
  expectStatus(response, [200], "the reader opens the shared session");
  expect(asRecord(response.json).access === "read", "The reader should have read access");
  expect(
    hasRoot(await listSessions(ctx, as(reader), `?q=${mark(ctx)}&scope=shared`), rootId),
    "scope=shared omits the shared session",
  );
  expectStatus(
    await ctx.api("POST", `/api/tasks/${rootId}/steer`, {
      ...as(reader),
      body: { message: "reader tries to steer" },
    }),
    [403],
    "a reader cannot steer",
  );
  expectStatus(
    await ctx.api("PUT", `/api/sessions/${rootId}/shares`, {
      ...as(reader),
      body: { everyone: "write", users: [] },
    }),
    [403],
    "a reader cannot share",
  );
  expectStatus(
    await ctx.api("GET", `/api/sessions/${rootId}`, as(stranger)),
    [403],
    "a stranger is still locked out",
  );

  response = await ctx.api("PUT", `/api/sessions/${rootId}/shares`, {
    ...as(owner),
    body: { everyone: "read", users: [{ userId: reader, access: "write" }] },
  });
  expectStatus(response, [200], "upgrade the reader, open to everyone");
  expect(asRecord(response.json).everyone === "read", "everyone=read not stored");
  expectStatus(
    await ctx.api("GET", `/api/sessions/${rootId}`, as(stranger)),
    [200],
    "everyone=read opens the session",
  );
  expectStatus(
    await ctx.api("POST", `/api/tasks/${rootId}/steer`, {
      ...as(reader),
      body: { message: `writer steers ${ctx.nonce}` },
    }),
    [200],
    "a writer can steer",
  );
  const activeShares = ctx.db.query<{ access: string }>(
    "SELECT access FROM session_shares WHERE rootTaskId = ? AND revokedAt IS NULL",
    [rootId],
  );
  expect(activeShares.length >= 1, "No active share rows in session_shares");

  // Share validation.
  const dup = [
    { userId: reader, access: "read" },
    { userId: reader, access: "write" },
  ];
  expectStatus(
    await ctx.api("PUT", `/api/sessions/${rootId}/shares`, {
      ...as(owner),
      body: { everyone: "none", users: dup },
    }),
    [400],
    "a user listed twice",
  );
  expectStatus(
    await ctx.api("PUT", `/api/sessions/${rootId}/shares`, {
      ...as(owner),
      body: { everyone: "none", users: [{ userId: "f".repeat(32), access: "read" }] },
    }),
    [400],
    "sharing with an unknown user",
  );
  expectStatus(
    await ctx.api("PUT", `/api/sessions/${rootId}/shares`, {
      ...as(owner),
      body: { everyone: "everybody", users: [] },
    }),
    [400],
    "an unknown everyone level",
  );
  expectStatus(
    await ctx.api("PUT", `/api/sessions/${GHOST}/shares`, {
      body: { everyone: "none", users: [] },
    }),
    [404],
    "share an unknown session",
  );
  const ownerless = await createAssignedTask(ctx, workerId, `Ownerless root ${ctx.nonce}`);
  response = await ctx.api("PUT", `/api/sessions/${ownerless}/shares`, {
    body: { everyone: "read", users: [] },
  });
  expectStatus(response, [409], "an ownerless session cannot be shared");
  await cancelQuietly(ctx, ownerless);

  response = await ctx.api("PUT", `/api/sessions/${rootId}/shares`, {
    ...as(owner),
    body: { everyone: "none", users: [] },
  });
  expectStatus(response, [200], "revoke every share");
  expectStatus(
    await ctx.api("GET", `/api/sessions/${rootId}`, as(reader)),
    [403],
    "the revoked reader is locked out again",
  );
  expect(UUID.test(rootId), "Root id is not a UUID");
  return { rootId, childId };
}

/** Sidebar triage: done, back to inbox, read, unread. */
async function triage(ctx: ScenarioContext, owner: string, rootId: string) {
  const query = `?q=${mark(ctx)}`;
  let tree = asRecord((await ctx.api("GET", "/api/session-tree", as(owner))).json);
  const inboxBefore = asRecord(tree.inbox).total as number;
  expect(inboxBefore >= 1, "The session tree inbox does not count the new session");
  for (const bucket of ["inbox", "later", "done", "noGroup"]) {
    expect(typeof asRecord(tree[bucket]).total === "number", `session-tree lacks ${bucket}`);
  }
  expect(Array.isArray(tree.sources) && Array.isArray(tree.groups), "session-tree lacks sources");
  expectStatus(
    await ctx.api("GET", "/api/session-tree?show=all&hideSource=slack", as(owner)),
    [200],
    "session-tree with source filters",
  );

  let response = await ctx.api("POST", "/api/session-triage", {
    ...as(owner),
    body: { action: "done", triage: "inbox" },
  });
  expectStatus(response, [200], "mark the inbox done");
  expect(Number(asRecord(response.json).updated) >= 1, "Triage updated nothing");
  expect(
    hasRoot(await listSessions(ctx, as(owner), `${query}&triage=done`), rootId),
    "The session is not in the done list",
  );
  expect(
    !hasRoot(await listSessions(ctx, as(owner), `${query}&triage=inbox`), rootId),
    "The session is still in the inbox",
  );
  tree = asRecord((await ctx.api("GET", "/api/session-tree", as(owner))).json);
  expect(asRecord(tree.done).total === inboxBefore, "session-tree done bucket did not move");

  response = await ctx.api("POST", "/api/session-triage", {
    ...as(owner),
    body: { action: "inbox", triage: "done" },
  });
  expectStatus(response, [200], "move done back to the inbox");
  expect(
    hasRoot(await listSessions(ctx, as(owner), `${query}&triage=inbox`), rootId),
    "The session did not return to the inbox",
  );
  for (const action of ["read", "unread"]) {
    response = await ctx.api("POST", "/api/session-triage", {
      ...as(owner),
      body: { action, noGroup: true },
    });
    expectStatus(response, [200], `mark ${action}`);
    expect(typeof asRecord(response.json).updated === "number", `${action} has no count`);
  }
  response = await ctx.api("POST", "/api/session-triage", {
    ...as(owner),
    body: { action: "read", groupKey: "shared/", show: "all" },
  });
  expectStatus(response, [200], "triage one group");

  expectStatus(
    await ctx.api("POST", "/api/session-triage", { body: { action: "done", triage: "inbox" } }),
    [400],
    "triage without a picked user",
  );
  expectStatus(
    await ctx.api("POST", "/api/session-triage", { ...as(owner), body: { action: "done" } }),
    [400],
    "triage without a list",
  );
  expectStatus(
    await ctx.api("POST", "/api/session-triage", {
      ...as(owner),
      body: { action: "archive", triage: "inbox" },
    }),
    [400],
    "triage with an unknown action",
  );
}

/** Moving sessions between groups, singly and by prefix. */
async function moves(ctx: ScenarioContext, owner: string, rootId: string, childId: string) {
  const group = `shared/core-${ctx.nonce}/`;
  const renamed = `shared/core-${ctx.nonce}-renamed/`;
  let response = await ctx.api("POST", "/api/session-moves", {
    ...as(owner),
    body: { rootTaskIds: [rootId, childId, GHOST], groupKey: group },
  });
  expectStatus(response, [200], "move a session into a group");
  let result = asRecord(response.json);
  expect(
    JSON.stringify(result.moved) === JSON.stringify([rootId]),
    `Only the root should move, got ${JSON.stringify(result.moved)}`,
  );
  const skipped = asRecords(result, "skipped");
  expect(
    skipped.length === 2 &&
      skipped.some(
        (entry) => entry.rootTaskId === childId && /not a session root/i.test(String(entry.reason)),
      ) &&
      skipped.some((entry) => entry.rootTaskId === GHOST),
    `Unexpected skips ${JSON.stringify(skipped)}`,
  );
  expect(taskKey(ctx, rootId) === group, "The root key did not change");
  expect(taskKey(ctx, childId) === group, "The child did not follow its root");
  let list = await listSessions(ctx, as(owner), `?groupKey=${encodeURIComponent(group)}`);
  expect(hasRoot(list, rootId), "The group filter omits the moved session");
  expect(asRecords(list, "sessions")[0]?.groupKey === group, "The list item has another groupKey");
  const tree = asRecord((await ctx.api("GET", "/api/session-tree", as(owner))).json);
  expect(
    asRecords(tree, "groups").some((entry) => JSON.stringify(entry).includes(`core-${ctx.nonce}`)),
    "session-tree lacks the new group",
  );

  response = await ctx.api("POST", "/api/session-moves/prefix", {
    ...as(owner),
    body: { from: group, to: renamed },
  });
  expectStatus(response, [200], "rename a group");
  result = asRecord(response.json);
  expect(
    JSON.stringify(result.moved) === JSON.stringify([rootId]) && result.remaining === 0,
    `Prefix move result ${response.text}`,
  );
  expect(taskKey(ctx, rootId) === renamed, "The prefix move did not rewrite the key");

  for (const [label, body] of [
    ["a namespace root", { from: "shared/", to: renamed }],
    ["a destination inside the source", { from: renamed, to: `${renamed}inner/` }],
    ["a slack source group", { from: "shared/slack/C1/", to: renamed }],
  ] as const) {
    expectStatus(
      await ctx.api("POST", "/api/session-moves/prefix", { ...as(owner), body }),
      [400],
      `prefix move ${label}`,
    );
  }
  expectStatus(
    await ctx.api("POST", "/api/session-moves", {
      ...as(owner),
      body: { rootTaskIds: [], groupKey: "" },
    }),
    [400],
    "move with an empty group key",
  );

  // Deleting the group sends its sessions back to their own key.
  response = await ctx.api("POST", "/api/session-moves/prefix", {
    ...as(owner),
    body: { from: renamed, to: null },
  });
  expectStatus(response, [200], "delete a group");
  expect(
    JSON.stringify(asRecord(response.json).moved) === JSON.stringify([rootId]),
    "Group not emptied",
  );
  expect(
    taskKey(ctx, rootId) === `shared/task:${rootId}/`,
    "A deleted group did not reset the key",
  );
  response = await ctx.api("POST", "/api/session-moves", {
    ...as(owner),
    body: { rootTaskIds: [rootId], groupKey: group },
  });
  expectStatus(response, [200], "move again");
  response = await ctx.api("POST", "/api/session-moves", {
    ...as(owner),
    body: { rootTaskIds: [rootId], groupKey: null },
  });
  expectStatus(response, [200], "reset one session with a null group");
  expect(taskKey(ctx, rootId) === `shared/task:${rootId}/`, "A null group did not reset the key");
  list = await listSessions(ctx, as(owner), `?q=${mark(ctx)}&noGroup=true`);
  expect(hasRoot(list, rootId), "noGroup=true omits a reset session");
}

export const coreSessions: Scenario = {
  name: "core-sessions",
  order: 240,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "sessions", { maxTasks: 3 });
    const owner = await createUser(ctx, "session-owner");
    const reader = await createUser(ctx, "session-reader");
    const stranger = await createUser(ctx, "session-stranger");
    const { rootId, childId } = await ownershipAndSharing(ctx, workerId, owner, reader, stranger);
    await triage(ctx, owner, rootId);
    await moves(ctx, owner, rootId, childId);
    for (const id of [childId, rootId]) await cancelQuietly(ctx, id);
    const writerSteers = ctx.db.query<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'follow-up'",
      [rootId],
    );
    for (const row of writerSteers) await cancelQuietly(ctx, row.id);
  },
};
