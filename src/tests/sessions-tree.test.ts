import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { keyPrefixRange, sessionGroupKey } from "../assets/key";
import {
  isSourceThreadKey,
  NESTED_THREAD_MIN_ROOTS,
  sessionThreadGroupKey,
} from "../assets/source-key";
import {
  closeDb,
  countSessions,
  createAgent,
  createSessionCost,
  createSteeringMessage,
  createTaskExtended,
  createUser,
  getDbClient,
  initDb,
  listRecentSessions,
  upsertInboxState,
} from "../be/db";
import { rememberSessionLabel } from "../be/db/session-labels";
import { getSessionTree, type SessionFilters, threadRootsSql } from "../be/db/session-tree";
import { setSessionShares } from "../be/session-shares";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { chatSdkContextKey } from "../tasks/context-key";
import { beginRequestAuthScope, setRequestAuth } from "../utils/request-auth-context";
import { listenOnFreePort } from "./test-net";

const NOW = "2026-10-21T12:00:00.000Z";
const RECENT = "2026-10-20T12:00:00.000Z";
const OLD = "2026-10-01T12:00:00.000Z";
let owner: { id: string };
let other: { id: string };
let server: Server;
let baseUrl: string;
const actor = () => ({ kind: "user", userId: owner.id }) as const;
const filters = (extra: SessionFilters & { limit?: number } = {}) => ({
  viewer: { userId: owner.id, scope: "mine" } as const,
  now: NOW,
  ...extra,
});

beforeAll(async () => {
  initDb(":memory:");
  owner = await createUser({ name: "Owner" });
  other = await createUser({ name: "Other" });
  server = createServer(async (req, res) => {
    try {
      beginRequestAuthScope();
      setRequestAuth(req, { kind: "operator", fingerprint: "sessions-tree-test" });
      if (
        await handleSessions(
          req,
          res,
          getPathSegments(req.url ?? ""),
          parseQueryParams(req.url ?? ""),
        )
      )
        return;
      res.writeHead(404).end();
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  });
  baseUrl = `http://127.0.0.1:${await listenOnFreePort(server)}`;
});
beforeEach(async () => {
  await getDbClient().run("DELETE FROM approval_requests");
  await getDbClient().run("DELETE FROM task_steering_messages");
  await getDbClient().run("DELETE FROM inbox_item_state");
  await getDbClient().run("DELETE FROM session_shares");
  await getDbClient().run("DELETE FROM agent_tasks");
  await getDbClient().run("DELETE FROM kv_entries WHERE namespace = 'session-labels'");
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

async function task(
  key = "shared/a/",
  extra: Parameters<typeof createTaskExtended>[1] = {},
  activity = RECENT,
) {
  const root = await createTaskExtended("Session test", {
    key,
    requestedByUserId: owner.id,
    ...extra,
  });
  await getDbClient().run(
    "UPDATE agent_tasks SET lastUpdatedAt = ?, status = 'completed' WHERE id = ?",
    [activity, root.id],
  );
  return root;
}
async function state(
  id: string,
  status: "open" | "done" | "snoozed" | "dismissed",
  lastUpdatedAt = NOW,
  extra: { lastReadAt?: string; snoozeUntil?: string } = {},
) {
  await upsertInboxState({ userId: owner.id, itemType: "to_read", itemId: id, status, ...extra });
  await getDbClient().run("UPDATE inbox_item_state SET lastUpdatedAt = ? WHERE itemId = ?", [
    lastUpdatedAt,
    id,
  ]);
}
async function share(
  root: { id: string; requestedByUserId?: string },
  users = [{ userId: owner.id, access: "read" as const }],
) {
  await setSessionShares(
    { id: root.id, requestedByUserId: root.requestedByUserId ?? null },
    { everyone: "none", users },
    other.id,
  );
}
async function pending(taskId: string, status = "pending") {
  const id = crypto.randomUUID();
  await getDbClient().run(
    `INSERT INTO approval_requests (id, sourceTaskId, title, questions, approvers, status)
    VALUES (?, ?, 'Approve deploy', '[]', '{}', ?)`,
    [id, taskId, status],
  );
  return id;
}
async function ids(extra: SessionFilters) {
  return (await listRecentSessions(filters(extra))).map((s) => s.root.id).sort();
}

describe("session groups and prefix bounds", () => {
  test("leaf helpers preserve group names and namespace roots", () => {
    expect(keyPrefixRange("shared/a/")).toEqual({ lo: "shared/a/", hi: "shared/a0" });
    for (const kind of ["task", "thread", "schedule", "workflow"]) {
      expect(sessionGroupKey(`shared/a/${kind}:abc/`)).toBe("shared/a/");
    }
    for (const key of [
      "shared/release:v2/",
      "shared/mytask:abc/",
      "shared/a/",
      `personal/${owner.id}/`,
    ]) {
      expect(sessionGroupKey(key)).toBe(key);
    }
  });
  test("non-BMP group keys agree between the tree count and the exact-group list", async () => {
    const group = "shared/🚀/";
    const leaf = await task(`${group}task:a/`);
    const root = await task(group);
    await task(`${group}b/`);
    expect(await ids({ groupKey: group })).toEqual([leaf.id, root.id].sort());
    const headers = { "x-swarm-user-id": owner.id };
    const tree = (await (
      await fetch(`${baseUrl}/api/session-tree`, { headers })
    ).json()) as Awaited<ReturnType<typeof getSessionTree>>;
    const total = tree.groups.find((g) => g.key === group)!.total;
    const response = await fetch(
      `${baseUrl}/api/sessions?scope=tree&groupKey=${encodeURIComponent(group)}`,
      { headers },
    );
    const body = (await response.json()) as { total: number; sessions: unknown[] };
    expect(total).toBe(2);
    expect(body.total).toBe(total);
    expect(body.sessions).toHaveLength(total);
  });
  test("exact group differs from prefix and the planner avoids a root table scan", async () => {
    const a = await task();
    const leaf = await task("shared/a/task:abc/");
    const nested = await task("shared/a/b/");
    await task("shared/ab/");
    expect(await ids({ groupKey: "shared/a/" })).toEqual([a.id, leaf.id].sort());
    expect(await ids({ keyPrefix: "shared/a/" })).toEqual([a.id, leaf.id, nested.id].sort());
    expect(await countSessions(filters({ groupKey: "shared/a/" }))).toBe(2);
    const client = getDbClient();
    const query = spyOn(client, "query");
    let call: (typeof query.mock.calls)[number];
    try {
      await listRecentSessions(
        filters({ groupKey: "shared/a/", showSource: ["slack"], hideSource: ["ui"] }),
      );
      call = query.mock.calls[0]!;
    } finally {
      query.mockRestore();
    }
    const [sql, params] = call;
    const plan = await client.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
    expect(plan.some((p) => p.detail.startsWith("SEARCH r USING INDEX"))).toBe(true);
    expect(plan.some((p) => p.detail === "SCAN r")).toBe(false);
    expect(sql).not.toContain("INDEXED BY");
    expect(sql).not.toContain('"key" LIKE');
  });
  test("No group includes shared and my personal namespace, including leaves", async () => {
    const a = await task("shared/");
    const b = await task(`personal/${owner.id}/thread:abc/`);
    await task(`personal/${other.id}/`);
    await task("shared/release:v2/");
    expect(await ids({ noGroup: true })).toEqual([a.id, b.id].sort());
  });
});

describe("nested source thread groups", () => {
  const channel = "shared/slack/c1/";
  const thread = `${channel}thread:1.2/`;
  const detailGroupKey = async (id: string) => {
    const res = await fetch(`${baseUrl}/api/sessions/${id}`, {
      headers: { "x-swarm-user-id": owner.id },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { groupKey: string }).groupKey;
  };

  test("two owned roots nest, lists agree, and a move collapses the group", async () => {
    const first = await task(thread, { source: "slack" });
    const second = await task(thread, { source: "mcp" }, NOW);
    await getDbClient().run("UPDATE agent_tasks SET createdAt = ?, title = ? WHERE id = ?", [
      OLD,
      "First conversation",
      first.id,
    ]);
    await getDbClient().run("UPDATE agent_tasks SET status = 'in_progress' WHERE id = ?", [
      second.id,
    ]);
    await pending(second.id);
    const single = await task(`${channel}thread:3/`);
    const tree = await getSessionTree(actor(), NOW);
    expect(tree.groups).toEqual([
      { key: channel, lastActivityAt: RECENT, total: 1, unread: 1, running: 0, needsYou: 0 },
      { key: thread, lastActivityAt: NOW, total: 2, unread: 2, running: 1, needsYou: 1 },
    ]);
    expect(tree.threadLabels).toEqual({ [thread]: "First conversation" });
    expect(tree.sourceGroups).toEqual([channel, thread]);
    expect(await ids({ groupKey: channel })).toEqual([single.id]);
    expect(await ids({ groupKey: thread })).toEqual([first.id, second.id].sort());
    expect(await countSessions(filters({ groupKey: channel }))).toBe(1);
    expect(await countSessions(filters({ groupKey: thread }))).toBe(2);
    const rows = await listRecentSessions(filters());
    expect(rows.find((r) => r.root.id === first.id)?.groupKey).toBe(thread);
    expect(rows.find((r) => r.root.id === single.id)?.groupKey).toBe(channel);
    // The session pane reveals the detail's group: the same rule as the list rows.
    expect(await detailGroupKey(first.id)).toBe(thread);
    expect(await detailGroupKey(single.id)).toBe(channel);

    const moved = await fetch(`${baseUrl}/api/session-moves`, {
      method: "POST",
      headers: { "x-swarm-user-id": owner.id, "content-type": "application/json" },
      body: JSON.stringify({ rootTaskIds: [second.id], groupKey: "shared/research/" }),
    });
    expect(moved.status).toBe(200);
    expect(
      (await getSessionTree(actor(), NOW)).groups.find((g) => g.key === thread),
    ).toBeUndefined();
    expect(await ids({ groupKey: channel })).toEqual([first.id, single.id].sort());
    expect(
      (await listRecentSessions(filters())).find((r) => r.root.id === first.id)?.groupKey,
    ).toBe(channel);
    expect(await detailGroupKey(first.id)).toBe(channel);
  });

  test("one owned root stays a channel row despite children and ownerless roots", async () => {
    const root = await task(thread);
    await task(thread, { parentTaskId: root.id });
    await task(thread, { requestedByUserId: undefined });
    const tree = await getSessionTree(actor(), NOW);
    expect(tree.groups.map((g) => [g.key, g.total])).toEqual([[channel, 1]]);
    expect(tree.threadLabels).toEqual({});
    expect((await listRecentSessions(filters({ tree: true })))[0].groupKey).toBe(channel);
  });

  test("nesting counts private roots but labels use only roots visible to each user", async () => {
    const visible = await task(thread, { source: "slack" });
    const hidden = await task(thread, { requestedByUserId: other.id });
    await getDbClient().run("UPDATE agent_tasks SET title = ? WHERE id = ?", [
      "Visible title",
      visible.id,
    ]);
    await getDbClient().run("UPDATE agent_tasks SET createdAt = ?, title = ? WHERE id = ?", [
      OLD,
      "Hidden oldest",
      hidden.id,
    ]);
    const tree = await getSessionTree(actor(), NOW, { mine: true, showSource: ["slack"] });
    expect(tree.groups.map((g) => [g.key, g.total])).toEqual([[thread, 1]]);
    expect(tree.threadLabels[thread]).toBe("Visible title");
    expect(await ids({ groupKey: channel })).toEqual([]);
    expect(await ids({ groupKey: thread })).toEqual([visible.id]);
    const filtered = await getSessionTree(actor(), NOW, { showSource: ["ui"] });
    expect(filtered.groups).toEqual([]);
    expect(filtered.sourceGroups).toEqual([channel, thread]);
    expect(filtered.threadLabels[thread]).toBe("Visible title");
    const otherTree = await getSessionTree({ kind: "user", userId: other.id }, NOW);
    expect(otherTree.groups.map((g) => [g.key, g.total])).toEqual([[thread, 1]]);
    expect(otherTree.threadLabels[thread]).toBe("Hidden oldest");
  });

  test("the route merges title fallbacks and cached labels, including hidden thread groups", async () => {
    const root = await task(thread);
    await task(thread);
    const text = "Oldest task text. ".repeat(8);
    await getDbClient().run(
      "UPDATE agent_tasks SET task = ?, title = '', createdAt = ? WHERE id = ?",
      [text, OLD, root.id],
    );
    const headers = { "x-swarm-user-id": owner.id };
    const read = async () => {
      const res = await fetch(`${baseUrl}/api/session-tree?show=all&showSource=ui`, { headers });
      expect(res.status).toBe(200);
      return (await res.json()) as { labels: Record<string, string>; sourceGroups?: string[] };
    };
    await rememberSessionLabel(channel, "#engineering");
    expect((await read()).labels).toEqual({
      [channel]: "#engineering",
      [thread]: text.trim(),
    });
    await rememberSessionLabel(thread, "Cached thread label");
    const result = await read();
    expect(result.labels[thread]).toBe("Cached thread label");
    expect(result.sourceGroups).toBeUndefined();
  });

  test("a title fallback skips the thread context and keeps the list preview shape", async () => {
    const root = await task(thread);
    await task(thread);
    const label = async (prompt: string) => {
      await getDbClient().run(
        "UPDATE agent_tasks SET task = ?, title = '', createdAt = ? WHERE id = ?",
        [prompt, OLD, root.id],
      );
      return (await getSessionTree(actor(), NOW)).threadLabels[thread];
    };
    const ask = "<@U1|Lena>: Fix the release notes";
    expect(await label(`<thread_context>\nT: earlier message\n</thread_context>\n\n${ask}`)).toBe(
      ask,
    );
    // A Chat SDK prompt puts its header line before the block.
    const chat = await label(
      "[chat] from: Lena\n\n<thread_context>\nLena: hi\n</thread_context>\n\nShip it",
    );
    expect(chat).toStartWith("[chat] from: Lena");
    expect(chat).toEndWith("Ship it");
    expect(chat).not.toContain("Lena: hi");
    // A tag inside a line is text, not a block.
    expect(await label("Explain the <thread_context> tag")).toBe(
      "Explain the <thread_context> tag",
    );
    // 300 characters and "…": the list preview the UI repairs (`isListPreview`).
    expect(await label(`<thread_context>\nT: hi\n</thread_context>\n\n${"a".repeat(400)}`)).toBe(
      `${"a".repeat(300)}…`,
    );
    // A prompt that is only thread context has no label: the UI shows `Thread · <ts>`.
    expect(await label("<thread_context>\nT: hi\n</thread_context>")).toBe("");
  });

  test("only source thread leaves nest, including Telegram and Discord", async () => {
    for (const [key, expectedGroup] of [
      ["shared/telegram/-100/thread:42/", "shared/telegram/-100/thread:42/"],
      ["shared/discord/77/thread:99/", "shared/discord/77/thread:99/"],
      ["shared/slack/c1/thread:parent/thread:🚀/", "shared/slack/c1/thread:parent/thread:🚀/"],
      ["shared/slack/c1/thread:parent/child/", "shared/slack/c1/thread:parent/child/"],
      ["shared/slack/c1/task:leaf/", channel],
      [`personal/${owner.id}/thread:1/`, `personal/${owner.id}/`],
      ["shared/notes/thread:1/", "shared/notes/"],
    ]) {
      await getDbClient().run("DELETE FROM agent_tasks");
      const root = await task(key);
      await task(key);
      expect(sessionThreadGroupKey(key, NESTED_THREAD_MIN_ROOTS)).toBe(expectedGroup);
      expect(sessionThreadGroupKey(key, NESTED_THREAD_MIN_ROOTS - 1)).toBe(sessionGroupKey(key));
      const threadRoots = threadRootsSql();
      const count = await getDbClient().get<{ roots: number }>(
        `SELECT ${threadRoots.sql} AS roots FROM agent_tasks r WHERE r.id = ?`,
        [...threadRoots.params, root.id],
      );
      expect(count?.roots).toBe(isSourceThreadKey(key) ? NESTED_THREAD_MIN_ROOTS : 0);
      expect((await listRecentSessions(filters({ rootId: root.id })))[0].groupKey).toBe(
        expectedGroup,
      );
      const tree = await getSessionTree(actor(), NOW);
      const noGroup = expectedGroup === `personal/${owner.id}/`;
      expect(tree.noGroup.total).toBe(noGroup ? 2 : 0);
      expect(tree.groups).toEqual(
        noGroup
          ? []
          : [
              {
                key: expectedGroup,
                lastActivityAt: RECENT,
                total: 2,
                unread: 2,
                running: 0,
                needsYou: 0,
              },
            ],
      );
    }
  });

  test("channel and thread queries retain indexed key lookup without LIKE", async () => {
    await task(thread);
    await task(thread);
    for (const groupKey of [channel, thread]) {
      const client = getDbClient();
      const query = spyOn(client, "query");
      let call: (typeof query.mock.calls)[number];
      try {
        await listRecentSessions(filters({ groupKey }));
        call = query.mock.calls[0]!;
      } finally {
        query.mockRestore();
      }
      const [sql, params] = call;
      const plan = await client.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params);
      expect(plan.some((p) => p.detail.startsWith("SEARCH r USING INDEX"))).toBe(true);
      expect(
        plan.some((p) =>
          p.detail.includes("SEARCH session_thread_root USING INDEX idx_agent_tasks_asset_key"),
        ),
      ).toBe(true);
      expect(
        plan.some((p) => p.detail === "SCAN r" || p.detail === "SCAN session_thread_root"),
      ).toBe(false);
      expect(sql).not.toContain('"key" LIKE');
      expect(sql).not.toContain("INDEXED BY");
    }
  });
});

describe("chain-wide read state", () => {
  test("every CASE branch uses the fixed clock and chain activity", async () => {
    const cases = [
      { activity: RECENT, expected: "unread" },
      { activity: OLD, expected: "read" },
      { activity: "2026-10-14T12:00:00.000Z", expected: "read" },
      { status: "dismissed", updated: OLD, expected: "done" },
      { status: "done", updated: NOW, expected: "done" },
      // Agent activity after the Done mark keeps it Done.
      { status: "done", updated: OLD, expected: "done" },
      { status: "snoozed", snoozeUntil: "2026-10-22T12:00:00.000Z", expected: "later" },
      { status: "snoozed", snoozeUntil: NOW, expected: "unread" },
      { status: "snoozed", expected: "unread" },
      { status: "open", updated: OLD, expected: "unread" },
      { status: "open", updated: NOW, expected: "read" },
      { status: "open", updated: NOW, lastReadAt: OLD, expected: "unread" },
      { status: "open", updated: OLD, lastReadAt: RECENT, expected: "read" },
    ] as const;
    for (const fixture of cases) {
      const root = await task("shared/a/", {}, "activity" in fixture ? fixture.activity : RECENT);
      if ("status" in fixture)
        await state(root.id, fixture.status, "updated" in fixture ? fixture.updated : NOW, {
          ...("lastReadAt" in fixture ? { lastReadAt: fixture.lastReadAt } : {}),
          ...("snoozeUntil" in fixture ? { snoozeUntil: fixture.snoozeUntil } : {}),
        });
      const row = (await listRecentSessions(filters({ limit: 100 }))).find(
        (s) => s.root.id === root.id,
      )!;
      expect({ id: root.id, state: row.readState }).toEqual({
        id: root.id,
        state: fixture.expected,
      });
    }
    const root = await task("shared/a/", {}, OLD);
    await task("shared/a/", { parentTaskId: root.id }, RECENT);
    expect(
      (await listRecentSessions(filters({ limit: 100 }))).find((s) => s.root.id === root.id)
        ?.readState,
    ).toBe("unread");
    const tree = await getSessionTree(actor(), NOW);
    const rows = await listRecentSessions(filters({ limit: 100 }));
    expect(tree.inbox.unread).toBe(rows.filter((s) => s.readState === "unread").length);
    expect(tree.later.total).toBe(rows.filter((s) => s.readState === "later").length);
    expect(tree.done.total).toBe(rows.filter((s) => s.readState === "done").length);
  });
  test("Later and Done leave group, prefix, No group and Inbox lists", async () => {
    const read = await task("shared/");
    const later = await task("shared/");
    const laterFirst = await task("shared/");
    const done = await task("shared/");
    await state(later.id, "snoozed", NOW, { snoozeUntil: "2026-10-23T12:00:00.000Z" });
    await state(laterFirst.id, "snoozed", NOW, { snoozeUntil: "2026-10-22T12:00:00.000Z" });
    await state(done.id, "done");
    for (const extra of [
      { noGroup: true },
      { groupKey: "shared/" },
      { keyPrefix: "shared/" },
      { triage: "inbox" as const },
    ]) {
      expect(await ids(extra)).toEqual([read.id]);
      expect(await countSessions(filters(extra))).toBe(1);
    }
    expect((await listRecentSessions(filters({ triage: "later" }))).map((s) => s.root.id)).toEqual([
      laterFirst.id,
      later.id,
    ]);
    expect(await ids({ triage: "done" })).toEqual([done.id]);
    const tree = await getSessionTree(actor(), NOW);
    expect(tree.noGroup.total).toBe(1);
    expect(tree.inbox.total).toBe(1);
  });
});

describe("Done holds until the session needs the user", () => {
  const DONE_AT = "2026-10-21T11:00:00.000Z";
  const BEFORE = "2026-10-21T10:30:00.000Z";
  const AFTER = "2026-10-21T11:30:00.000Z";
  const readState = async (id: string) =>
    (await listRecentSessions(filters({ limit: 100 }))).find((s) => s.root.id === id)?.readState;
  const doneSession = async () => {
    const root = await task("shared/", { source: "ui" }, BEFORE);
    await getDbClient().run(
      "UPDATE agent_tasks SET createdAt = ?, status = 'in_progress' WHERE id = ?",
      [BEFORE, root.id],
    );
    await state(root.id, "done", DONE_AT);
    expect(await readState(root.id)).toBe("done");
    return root;
  };
  const child = async (
    parentTaskId: string,
    extra: Parameters<typeof createTaskExtended>[1],
    createdAt = AFTER,
  ) => {
    const row = await createTaskExtended("Child", { parentTaskId, key: "shared/", ...extra });
    await getDbClient().run(
      "UPDATE agent_tasks SET createdAt = ?, lastUpdatedAt = ?, status = 'completed' WHERE id = ?",
      [createdAt, createdAt, row.id],
    );
    return row;
  };
  const approval = async (taskId: string, createdAt: string, status = "pending") =>
    getDbClient().run(
      `INSERT INTO approval_requests (id, sourceTaskId, title, questions, approvers, status, createdAt)
      VALUES (?, ?, 'Approve deploy', '[]', '{}', ?, ?)`,
      [crypto.randomUUID(), taskId, status, createdAt],
    );

  test("agent progress and a status change keep it Done", async () => {
    const root = await doneSession();
    await getDbClient().run(
      "UPDATE agent_tasks SET lastUpdatedAt = ?, status = 'completed' WHERE id = ?",
      [AFTER, root.id],
    );
    expect(await readState(root.id)).toBe("done");
    const tree = await getSessionTree(actor(), NOW);
    expect(tree.done.total).toBe(1);
    expect(tree.inbox.total).toBe(0);
  });

  test("agent-created child and delegated tasks keep it Done", async () => {
    const root = await doneSession();
    // Inherits the requester from its parent.
    const inherited = await child(root.id, { source: "mcp" });
    // Lead delegation, a deferred wake-up and a follow-up name the requester explicitly.
    await child(inherited.id, { source: "mcp", requestedByUserId: owner.id });
    await child(root.id, { source: "schedule", requestedByUserId: owner.id });
    await child(root.id, { source: "system", requestedByUserId: owner.id });
    await child(root.id, { source: "workflow", requestedByUserId: owner.id });
    expect(await readState(root.id)).toBe("done");
  });

  test("a pending approval created after Done returns it to the Inbox", async () => {
    const before = await doneSession();
    await approval(before.id, BEFORE);
    const resolved = await doneSession();
    await approval(resolved.id, AFTER, "approved");
    expect(await readState(before.id)).toBe("done");
    expect(await readState(resolved.id)).toBe("done");

    const root = await doneSession();
    const agent = await child(root.id, { source: "mcp" });
    await approval(agent.id, AFTER);
    expect(await readState(root.id)).toBe("unread");
    expect(await ids({ triage: "inbox" })).toEqual([root.id]);
  });

  test("a human follow-up after Done returns it to the Inbox", async () => {
    const earlier = await doneSession();
    await child(earlier.id, { source: "ui", requestedByUserId: owner.id }, BEFORE);
    expect(await readState(earlier.id)).toBe("done");

    const root = await doneSession();
    await child(root.id, { source: "ui", requestedByUserId: owner.id });
    expect(await readState(root.id)).toBe("unread");
    const slack = await doneSession();
    await child(slack.id, { source: "slack", requestedByUserId: other.id });
    expect(await readState(slack.id)).toBe("unread");
    const tree = await getSessionTree(actor(), NOW);
    expect(tree.inbox.total).toBe(2);
    expect(tree.done.total).toBe(1);
  });

  test("a person's steer or queued message after Done returns it to the Inbox", async () => {
    // The real writer stamps created_at with the column default, after DONE_AT.
    const steered = await doneSession();
    await createSteeringMessage({
      taskId: steered.id,
      body: "Change course",
      mode: "steer",
      source: "ui",
      createdByKind: "user",
      createdByUserId: owner.id,
    });
    expect(await readState(steered.id)).toBe("unread");

    const queued = await doneSession();
    const agent = await child(queued.id, { source: "mcp" });
    await createSteeringMessage({
      taskId: agent.id,
      body: "Also check this",
      mode: "queue",
      source: "slack",
      createdByKind: "user",
      createdByUserId: owner.id,
    });
    expect(await readState(queued.id)).toBe("unread");
    expect((await ids({ triage: "inbox" })).sort()).toEqual([steered.id, queued.id].sort());
  });

  test("agent, system, cancelled and earlier steering keep it Done", async () => {
    const steer = async (
      taskId: string,
      createdByKind: "user" | "agent" | "system",
      createdAt = AFTER,
      status = "pending",
    ) =>
      getDbClient().run(
        `INSERT INTO task_steering_messages
          (id, task_id, body, mode, status, source, created_by_kind, created_at)
        VALUES (?, ?, 'Steer', 'queue', ?, 'mcp', ?, ?)`,
        [crypto.randomUUID(), taskId, status, createdByKind, createdAt],
      );
    const root = await doneSession();
    await steer(root.id, "agent");
    await steer(root.id, "system");
    await steer(root.id, "user", AFTER, "cancelled");
    await steer(root.id, "user", BEFORE, "handled");
    expect(await readState(root.id)).toBe("done");
  });
});

test("needs attention uses the latest failed status and pending approvals anywhere in the chain", async () => {
  const failed = await task();
  const child = await task("shared/a/", { parentTaskId: failed.id }, NOW);
  await getDbClient().run("UPDATE agent_tasks SET status = 'failed' WHERE id = ?", [child.id]);
  const readFailed = await task();
  await getDbClient().run("UPDATE agent_tasks SET status = 'failed' WHERE id = ?", [readFailed.id]);
  await state(readFailed.id, "open", NOW, { lastReadAt: NOW });
  const approved = await task();
  const approvalChild = await task("shared/a/", { parentTaskId: approved.id }, NOW);
  const approvalId = await pending(approvalChild.id);
  const resolved = await task();
  await pending(resolved.id, "approved");
  expect(await ids({ status: "needs" })).toEqual([failed.id, approved.id].sort());
  expect(await ids({ status: "failed" })).toEqual([failed.id, readFailed.id].sort());
  expect(await countSessions(filters({ status: "needs" }))).toBe(2);
  const response = await fetch(`${baseUrl}/api/sessions/${approved.id}`);
  expect(((await response.json()) as { approvals: unknown[] }).approvals).toEqual([
    { id: approvalId, status: "pending", sourceTaskId: approvalChild.id, title: "Approve deploy" },
  ]);
  expect((await getSessionTree(actor(), NOW)).inbox.needsYou).toBe(2);
});

test("running and person filters examine descendants after aggregation", async () => {
  const roots = [];
  for (const status of ["pending", "in_progress"]) {
    const root = await task();
    const child = await task(
      "shared/a/",
      { parentTaskId: root.id, requestedByUserId: other.id },
      NOW,
    );
    await getDbClient().run("UPDATE agent_tasks SET status = ? WHERE id = ?", [status, child.id]);
    roots.push(root.id);
  }
  await task();
  expect(await ids({ status: "running" })).toEqual(roots.sort());
  expect(await ids({ withUserId: other.id })).toEqual(roots.sort());
  const shared = await task();
  await share(shared, [{ userId: other.id, access: "read" }]);
  expect(await ids({ withUserId: other.id })).toEqual([...roots, shared.id].sort());
  expect(await countSessions(filters({ withUserId: other.id }))).toBe(3);
});

test("people are distinct, requester first, capped at 8, with batched shares and previews", async () => {
  const root = await task();
  const members: { id: string }[] = [];
  for (let i = 0; i < 9; i++) {
    const user = await createUser({ name: `Member ${i}` });
    members.push(user);
    await task("shared/a/", { parentTaskId: root.id, requestedByUserId: user.id }, RECENT);
  }
  await share(root, [{ userId: other.id, access: "read" }]);
  const output = await task("shared/a/", { parentTaskId: root.id }, NOW);
  await getDbClient().run("UPDATE agent_tasks SET output = ? WHERE id = ?", [
    "p".repeat(250),
    output.id,
  ]);
  const review = await task(
    "shared/a/",
    { parentTaskId: root.id, source: "system", taskType: "follow-up" },
    "2026-10-22T00:00:00.000Z",
  );
  await getDbClient().run("UPDATE agent_tasks SET output = 'auto review' WHERE id = ?", [
    review.id,
  ]);
  const empty = await task("shared/b/");
  for (const value of ["", "   "]) {
    const blank = await task("shared/a/", { parentTaskId: root.id }, "2026-10-23T00:00:00.000Z");
    await getDbClient().run("UPDATE agent_tasks SET output = ? WHERE id = ?", [value, blank.id]);
  }
  await getDbClient().run("UPDATE agent_tasks SET output = '   ' WHERE id = ?", [empty.id]);
  const query = spyOn(getDbClient(), "query");
  let rows: Awaited<ReturnType<typeof listRecentSessions>>;
  let calls: number;
  try {
    rows = await listRecentSessions(filters());
    calls = query.mock.calls.length;
  } finally {
    query.mockRestore();
  }
  expect(calls).toBe(3);
  const row = rows.find((s) => s.root.id === root.id)!;
  expect(row.people).toHaveLength(8);
  expect(row.people![0]).toEqual({ id: owner.id, name: "Owner" });
  expect(row.peopleCount).toBe(11);
  expect(row.people!.slice(1).every((p) => members.some((m) => m.id === p.id))).toBe(true);
  expect(row.shared).toBe(true);
  expect(row.shares).toEqual([{ userId: other.id, name: "Other", access: "read" }]);
  expect(row.preview).toBe("p".repeat(200));
  expect(rows.find((s) => s.root.id === empty.id)).toMatchObject({
    shared: false,
    shares: [],
    preview: null,
  });
});

test("tree visibility includes mine and shares, excludes ownerless, and preserves Done-only groups", async () => {
  const mine = await task("shared/a/");
  const shared = await task(`personal/${other.id}/notes/`, { requestedByUserId: other.id });
  await share(shared);
  await task("shared/private/", { requestedByUserId: other.id });
  await task("shared/ownerless/", { requestedByUserId: undefined });
  const done = await task("shared/finished/");
  await state(done.id, "done");
  const tree = await getSessionTree(actor(), NOW);
  expect(tree.groups.map((g) => g.key).sort()).toEqual(
    ["shared/a/", `personal/${other.id}/notes/`, "shared/finished/"].sort(),
  );
  expect(tree.groups.find((g) => g.key === "shared/finished/")?.total).toBe(0);
  expect(tree.inbox.total).toBe(2);
  for (const group of tree.groups) {
    expect(group.total).toBe(
      await countSessions(
        filters({ viewer: { userId: owner.id, scope: "all" }, groupKey: group.key }),
      ),
    );
  }
  expect((await getSessionTree({ kind: "bypass" }, NOW)).inbox.total).toBe(5);
  const bypassRows = await listRecentSessions();
  expect(bypassRows).toHaveLength(5);
  expect(bypassRows.every((r) => r.readState === undefined)).toBe(true);
  const route = await fetch(`${baseUrl}/api/session-tree`, {
    headers: { "x-swarm-user-id": owner.id },
  });
  expect(route.status).toBe(200);
  expect(((await route.json()) as Awaited<ReturnType<typeof getSessionTree>>).inbox.total).toBe(2);
  expect(await ids({ triage: "inbox" })).toEqual([mine.id]);
});

test("tree scope list totals match sections while default scope includes ownerless roots", async () => {
  await task("shared/a/");
  await task("shared/");
  const later = await task("shared/a/");
  await task("shared/a/", { requestedByUserId: undefined });
  await task("shared/", { requestedByUserId: undefined });
  const ownerlessLater = await task("shared/a/", { requestedByUserId: undefined });
  const snoozeUntil = new Date(Date.now() + 86400000).toISOString();
  for (const root of [later, ownerlessLater]) {
    await state(root.id, "snoozed", NOW, { snoozeUntil });
  }
  const headers = { "x-swarm-user-id": owner.id };
  const response = await fetch(`${baseUrl}/api/session-tree`, { headers });
  const tree = (await response.json()) as Awaited<ReturnType<typeof getSessionTree>>;
  const comparisons = [
    ["triage=inbox", tree.inbox.total, 2],
    ["noGroup=true", tree.noGroup.total, 1],
    ["groupKey=shared/a/", tree.groups.find((g) => g.key === "shared/a/")!.total, 1],
    ["triage=later", tree.later.total, 1],
  ] as const;
  for (const [params, expected, ownerless] of comparisons) {
    const scoped = await fetch(`${baseUrl}/api/sessions?scope=tree&${params}`, { headers });
    const body = (await scoped.json()) as { total: number; sessions: unknown[] };
    expect(body.total).toBe(expected);
    expect(body.sessions).toHaveLength(expected);
    const legacy = await fetch(`${baseUrl}/api/sessions?${params}`, { headers });
    expect(((await legacy.json()) as { total: number }).total).toBe(expected + ownerless);
  }
  const bypass = await fetch(`${baseUrl}/api/sessions?scope=tree`);
  const body = (await bypass.json()) as { total: number; sessions: { readState?: string }[] };
  expect(body.total).toBe(6);
  expect(body.sessions.every((row) => row.readState === undefined)).toBe(true);
  for (const scope of ["mine", "shared"]) {
    const response = await fetch(`${baseUrl}/api/sessions?scope=${scope}`);
    expect(((await response.json()) as { total: number }).total).toBe(0);
  }
});

test("session detail carries the viewer's read state with the list rule", async () => {
  // The route reads the real clock, so the activity sits inside the 7-day window.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const root = await task("shared/a/", {}, new Date(Date.now() - 7_200_000).toISOString());
  const child = await task("shared/a/", { parentTaskId: root.id }, hourAgo);
  const headers = { "x-swarm-user-id": owner.id };
  type Detail = { readState?: string; lastActivityAt?: string };
  const detail = async (id: string, init?: RequestInit) =>
    (await (await fetch(`${baseUrl}/api/sessions/${id}`, init)).json()) as Detail;
  const listRow = async () => {
    const res = await fetch(`${baseUrl}/api/sessions?scope=tree&limit=50`, { headers });
    const body = (await res.json()) as {
      sessions: { root: { id: string }; readState?: string; lastActivityAt: string }[];
    };
    return body.sessions.find((row) => row.root.id === root.id)!;
  };

  // Chain activity, not the root's own, decides it: the same row as the list.
  const unread = await detail(root.id, { headers });
  expect(unread).toMatchObject({ readState: "unread", lastActivityAt: hourAgo });
  const row = await listRow();
  expect({ readState: row.readState, lastActivityAt: row.lastActivityAt }).toEqual({
    readState: unread.readState,
    lastActivityAt: unread.lastActivityAt,
  });

  await state(root.id, "done", new Date().toISOString());
  expect((await detail(root.id, { headers })).readState).toBe("done");
  // A child id opens the same session, with the root's state.
  expect((await detail(child.id, { headers })).readState).toBe("done");

  // No picked user: no one to read for, so both fields stay out.
  const bypass = await detail(root.id);
  expect(bypass.readState).toBeUndefined();
  expect(bypass.lastActivityAt).toBeUndefined();
});

test("session detail carries each chain task's cost, so the header can total the whole session", async () => {
  const agent = await createAgent({ name: "cost-agent", isLead: false, status: "idle" });
  const root = await task();
  const child = await task("shared/a/", { parentTaskId: root.id });
  const grandchild = await task("shared/a/", { parentTaskId: child.id });
  const followUp = await task("shared/a/", { parentTaskId: root.id });
  const noCost = await task("shared/a/", { parentTaskId: root.id });
  const spend = async (taskId: string, totalCostUsd: number) =>
    createSessionCost({
      sessionId: crypto.randomUUID(),
      taskId,
      agentId: agent.id,
      totalCostUsd,
      durationMs: 1_000,
      numTurns: 1,
      model: "test-model",
    });
  await spend(root.id, 0.2);
  await spend(root.id, 0.0051);
  await spend(child.id, 0.5);
  await spend(grandchild.id, 0.25);
  await spend(followUp.id, 0.335);

  const res = await fetch(`${baseUrl}/api/sessions/${root.id}`);
  const body = (await res.json()) as { chain: { id: string; totalCostUsd?: number }[] };
  const costs = Object.fromEntries(body.chain.map((t) => [t.id, t.totalCostUsd]));
  expect(costs[root.id]).toBeCloseTo(0.2051, 6);
  expect(costs[child.id]).toBeCloseTo(0.5, 6);
  expect(costs[grandchild.id]).toBeCloseTo(0.25, 6);
  expect(costs[followUp.id]).toBeCloseTo(0.335, 6);
  expect(costs[noCost.id]).toBeUndefined();
  const total = body.chain.reduce((sum, t) => sum + (t.totalCostUsd ?? 0), 0);
  expect(total).toBeCloseTo(1.2901, 6);
});

test("limit clamps to 200 and count without chain filters does not recurse", async () => {
  await getDbClient().transaction(async () => {
    for (let i = 0; i < 205; i++)
      await getDbClient().run(
        `INSERT INTO agent_tasks
      (id, task, status, "key", requestedByUserId, createdAt, lastUpdatedAt)
      VALUES (?, 'Paging', 'completed', 'shared/a/', ?, ?, ?)`,
        [crypto.randomUUID(), owner.id, RECENT, RECENT],
      );
  });
  const query = spyOn(getDbClient(), "get");
  let total: number;
  let sql: string;
  try {
    total = await countSessions(filters());
    sql = query.mock.calls[0]![0];
  } finally {
    query.mockRestore();
  }
  expect(total).toBe(205);
  expect(sql).not.toContain("RECURSIVE");
  const res = await fetch(`${baseUrl}/api/sessions?limit=500`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { limit: number; sessions: unknown[]; total: number };
  expect(body.limit).toBe(200);
  expect(body.sessions).toHaveLength(200);
  expect(body.total).toBe(205);
});

describe("Mine view hides machine-started roots", () => {
  test("a workflow root attributed to the viewer is hidden by default and shown under All", async () => {
    // Positive control: pr-review-demo fan-out carries the trigger user as requester.
    const demo = await task("shared/", { source: "workflow", tags: ["pr-review-demo"] });
    const scheduled = await task("shared/", { source: "schedule" });
    const heartbeat = await task("shared/", { source: "system" });
    // Negative controls: the viewer's own human sessions stay.
    const slack = await task("shared/", { source: "slack" });
    const ui = await task("shared/", { source: "ui" });
    const whatsapp = await task("shared/", { source: "system", taskType: "kapso-inbound" });
    // A workflow root someone else shared with the viewer stays too.
    const sharedRun = await task("shared/", { source: "workflow", requestedByUserId: other.id });
    await share(sharedRun);
    // Ownerless roots stay out of both views, as before.
    await task("shared/", { source: "workflow", requestedByUserId: undefined });

    const headers = { "x-swarm-user-id": owner.id };
    const list = async (query: string) => {
      const res = await fetch(`${baseUrl}/api/sessions?scope=tree&limit=50&${query}`, { headers });
      const body = (await res.json()) as { total: number; sessions: { root: { id: string } }[] };
      expect(body.sessions).toHaveLength(body.total);
      return body.sessions.map((s) => s.root.id).sort();
    };
    const tree = async (query: string) => {
      const res = await fetch(`${baseUrl}/api/session-tree?${query}`, { headers });
      return ((await res.json()) as Awaited<ReturnType<typeof getSessionTree>>).noGroup.total;
    };

    const mine = [slack.id, ui.id, whatsapp.id, sharedRun.id].sort();
    const all = [...mine, demo.id, scheduled.id, heartbeat.id].sort();
    expect(await list("")).toEqual(mine);
    expect(await list("show=mine")).toEqual(mine);
    expect(await list("show=all")).toEqual(all);
    expect(await tree("")).toBe(mine.length);
    expect(await tree("show=all")).toBe(all.length);

    // No picked user: the bypass actor still sees every root, ownerless included.
    const bypass = await fetch(`${baseUrl}/api/sessions?scope=tree&limit=50`);
    expect(((await bypass.json()) as { total: number }).total).toBe(all.length + 1);
    // Access is unchanged: the hidden session still opens by direct link.
    const detail = await fetch(`${baseUrl}/api/sessions/${demo.id}`, { headers });
    expect(detail.status).toBe(200);
  });
});

describe("source filter and list triage", () => {
  const asOwner = () => ({ "x-swarm-user-id": owner.id, "content-type": "application/json" });
  const treeOf = async (query = "") => {
    const res = await fetch(`${baseUrl}/api/session-tree?${query}`, { headers: asOwner() });
    expect(res.status).toBe(200);
    return (await res.json()) as Awaited<ReturnType<typeof getSessionTree>>;
  };
  const listOf = async (query: string) => {
    const res = await fetch(`${baseUrl}/api/sessions?scope=tree&limit=50&${query}`, {
      headers: asOwner(),
    });
    const body = (await res.json()) as {
      total: number;
      sessions: { root: { id: string }; readState?: string }[];
    };
    return body;
  };
  const triage = (body: Record<string, unknown>, withUser = true) =>
    fetch(`${baseUrl}/api/session-triage`, {
      method: "POST",
      headers: withUser ? asOwner() : { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("effective sources agree across lists, tree facets and triage", async () => {
    const slack = await task("shared/slack/c1/thread:1/", { source: "slack" });
    const mcpSlack = await task("shared/slack/c1/thread:2/", { source: "mcp" });
    const telegram = await task("shared/telegram/-100/thread:42/", {
      source: "chat",
      contextKey: chatSdkContextKey("telegram:-100:42"),
    });
    const discord = await task("shared/discord/c1/task:root/", { source: "chat" });
    const ui = await task("shared/", { source: "ui" });
    const mcp = await task("shared/research/", { source: "mcp" });
    const chat = await task("shared/research/", { source: "chat" });
    const facets = (await treeOf("show=all")).sources;
    expect(facets).toEqual([
      { source: "slack", total: 2 },
      { source: "chat", total: 1 },
      { source: "discord", total: 1 },
      { source: "mcp", total: 1 },
      { source: "telegram", total: 1 },
      { source: "ui", total: 1 },
    ]);
    const cases = [
      ["slack", [slack.id, mcpSlack.id]],
      ["telegram", [telegram.id]],
      ["discord", [discord.id]],
      ["mcp", [mcp.id]],
      ["ui", [ui.id]],
      ["chat", [chat.id]],
    ] as const;
    for (const [source, expected] of cases) {
      const query = `show=all&showSource=${source}`;
      const list = await listOf(`triage=inbox&${query}`);
      expect(list.sessions.map((row) => row.root.id).sort()).toEqual([...expected].sort());
      expect(list.total).toBe(expected.length);
      const tree = await treeOf(query);
      expect(tree.inbox.total).toBe(expected.length);
      expect(tree.sources).toEqual(facets);
      const res = await triage({
        action: "done",
        triage: "inbox",
        show: "all",
        showSource: [source],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ updated: expected.length });
      const done = await listOf("triage=done&show=all");
      expect(done.sessions.map((row) => row.root.id).sort()).toEqual([...expected].sort());
      expect((await treeOf(query)).done.total).toBe(expected.length);
      const reset = await triage({ action: "inbox", triage: "done", show: "all" });
      expect(await reset.json()).toEqual({ updated: expected.length });
    }
    const hidden = await listOf("triage=inbox&show=all&hideSource=slack");
    expect(hidden.total).toBe(5);
    expect(hidden.sessions.map((row) => row.root.id)).not.toContain(mcpSlack.id);
    const hiddenTree = await treeOf("show=all&hideSource=slack");
    expect(hiddenTree.inbox.total).toBe(5);
    expect(hiddenTree.sources).toEqual(facets);
    expect(await ids({ source: ["mcp"] })).toEqual([mcp.id, mcpSlack.id].sort());
    expect(await ids({ showSource: ["slack"], hideSource: ["slack"] })).toEqual([]);
    expect((await treeOf("show=all&showSource=slack&hideSource=slack")).inbox.total).toBe(0);
  });

  test("hideSource leaves a source out of sections and lists, and sources still count it", async () => {
    const slackA = await task("shared/", { source: "slack" });
    const slackB = await task("shared/a/", { source: "slack" });
    const ui = await task("shared/", { source: "ui" });
    const chat = await task("shared/", { source: "chat" });

    const full = await treeOf();
    expect(full.inbox.total).toBe(4);
    expect(full.sources).toEqual([
      { source: "slack", total: 2 },
      { source: "chat", total: 1 },
      { source: "ui", total: 1 },
    ]);

    const hidden = await treeOf("hideSource=slack,chat");
    expect(hidden.inbox.total).toBe(1);
    expect(hidden.noGroup.total).toBe(1);
    expect(hidden.groups).toEqual([]);
    // The menu still offers the hidden sources back.
    expect(hidden.sources).toEqual(full.sources);

    const inbox = await listOf("triage=inbox&hideSource=slack,chat");
    expect(inbox.total).toBe(1);
    expect(inbox.sessions.map((s) => s.root.id)).toEqual([ui.id]);
    const all = await listOf("triage=inbox");
    expect(all.sessions.map((s) => s.root.id).sort()).toEqual(
      [slackA.id, slackB.id, ui.id, chat.id].sort(),
    );
  });

  test("showSource keeps only the listed sources, and an empty list keeps none", async () => {
    await task("shared/", { source: "slack" });
    const ui = await task("shared/a/", { source: "ui" });
    await task("shared/", { source: "github" });

    const full = await treeOf();
    const shown = await treeOf("showSource=ui");
    expect(shown.inbox.total).toBe(1);
    expect(shown.groups.map((g) => g.key)).toEqual(["shared/a/"]);
    expect(shown.sources).toEqual(full.sources);
    const inbox = await listOf("triage=inbox&showSource=ui");
    expect(inbox.total).toBe(1);
    expect(inbox.sessions.map((s) => s.root.id)).toEqual([ui.id]);

    const none = await treeOf("showSource=");
    expect(none.inbox.total).toBe(0);
    expect(none.sources).toEqual(full.sources);
    expect((await listOf("triage=inbox&showSource=")).total).toBe(0);

    expect((await triage({ action: "done", triage: "inbox", showSource: ["ui"] })).status).toBe(
      200,
    );
    expect((await listOf("triage=done")).sessions.map((s) => s.root.id)).toEqual([ui.id]);
  });

  test("triage by list writes every matching session, honoring the list and the filters", async () => {
    const a = await task("shared/", { source: "ui" });
    const b = await task("shared/", { source: "ui" }, OLD);
    const slack = await task("shared/", { source: "slack" });
    const grouped = await task("shared/a/", { source: "ui" });
    const workflow = await task("shared/", { source: "workflow" });
    const later = await task("shared/", { source: "ui" });
    await state(later.id, "snoozed", NOW, { snoozeUntil: "2999-01-01T00:00:00.000Z" });

    // No group, Slack hidden, Mine view: a and b only.
    let res = await triage({ action: "done", noGroup: true, hideSource: ["slack"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2 });
    let done = await listOf("triage=done");
    expect(done.sessions.map((s) => s.root.id).sort()).toEqual([a.id, b.id].sort());
    // The rest keep their state; the workflow root (All only) was not touched.
    const inbox = await listOf("triage=inbox&show=all");
    expect(inbox.sessions.map((s) => s.root.id).sort()).toEqual(
      [slack.id, grouped.id, workflow.id].sort(),
    );
    expect((await listOf("triage=later")).sessions.map((s) => s.root.id)).toEqual([later.id]);

    // Back to the Inbox from the Done list, then read and unread across the Inbox.
    res = await triage({ action: "inbox", triage: "done" });
    expect(await res.json()).toEqual({ updated: 2 });
    expect((await listOf("triage=done")).total).toBe(0);
    res = await triage({ action: "unread", triage: "inbox" });
    expect(await res.json()).toEqual({ updated: 4 });
    expect((await treeOf()).inbox.unread).toBe(4);
    res = await triage({ action: "read", triage: "inbox" });
    expect(await res.json()).toEqual({ updated: 4 });
    const tree = await treeOf();
    expect(tree.inbox.unread).toBe(0);
    expect(tree.inbox.total).toBe(4);

    // One group only.
    res = await triage({ action: "done", groupKey: "shared/a/" });
    expect(await res.json()).toEqual({ updated: 1 });
    done = await listOf("triage=done");
    expect(done.sessions.map((s) => s.root.id)).toEqual([grouped.id]);
    // Show All reaches the workflow root.
    res = await triage({ action: "done", triage: "inbox", show: "all" });
    expect(await res.json()).toEqual({ updated: 4 });
    expect((await listOf("triage=inbox&show=all")).total).toBe(0);
  });

  test("triage by list acts on the Later list", async () => {
    const snoozedA = await task("shared/", { source: "ui" });
    const snoozedB = await task("shared/", { source: "ui" });
    const open = await task("shared/", { source: "ui" });
    for (const id of [snoozedA.id, snoozedB.id]) {
      await state(id, "snoozed", NOW, { snoozeUntil: "2999-01-01T00:00:00.000Z" });
    }

    let res = await triage({ action: "done", triage: "later" });
    expect(await res.json()).toEqual({ updated: 2 });
    expect((await listOf("triage=later")).total).toBe(0);
    const done = await listOf("triage=done");
    expect(done.sessions.map((s) => s.root.id).sort()).toEqual([snoozedA.id, snoozedB.id].sort());
    const cleared = await getDbClient().query<{ snoozeUntil: string | null }>(
      "SELECT snoozeUntil FROM inbox_item_state WHERE itemId IN (?, ?)",
      [snoozedA.id, snoozedB.id],
    );
    expect(cleared.map((row) => row.snoozeUntil)).toEqual([null, null]);

    await state(snoozedA.id, "snoozed", NOW, { snoozeUntil: "2999-01-01T00:00:00.000Z" });
    res = await triage({ action: "inbox", triage: "later" });
    expect(await res.json()).toEqual({ updated: 1 });
    const inbox = await listOf("triage=inbox");
    expect(inbox.sessions.map((s) => s.root.id).sort()).toEqual([snoozedA.id, open.id].sort());
  });

  test("triage by list writes the same row fields as the one-session PATCH", async () => {
    type Row = {
      status: string;
      snoozeUntil: string | null;
      dismissedAt: string | null;
      doneAt: string | null;
      readAt: string | null;
      lastReadAt: string | null;
    };
    const rowOf = async (id: string) =>
      (await getDbClient().get<Row>("SELECT * FROM inbox_item_state WHERE itemId = ?", [
        id,
      ])) as Row;
    const unreadCursor = "1970-01-01T00:00:00.000Z";
    for (const action of ["done", "inbox", "read", "unread"] as const) {
      // Two sessions with the same earlier state: read once, then snoozed past
      // the wake time (back in the Inbox). One gets the dashboard's PATCH
      // write, the other the list write.
      const one = await task(`shared/${action}-one/`, { source: "ui" });
      const list = await task(`shared/${action}-list/`, { source: "ui" });
      for (const id of [one.id, list.id]) {
        await state(id, "snoozed", NOW, { snoozeUntil: OLD, lastReadAt: OLD });
        await getDbClient().run("UPDATE inbox_item_state SET readAt = ? WHERE itemId = ?", [
          OLD,
          id,
        ]);
      }
      const listed = (await fetch(
        `${baseUrl}/api/sessions?scope=tree&groupKey=shared/${action}-one/`,
        {
          headers: asOwner(),
        },
      ).then((res) => res.json())) as { sessions: { lastActivityAt: string }[] };
      const lastActivityAt = listed.sessions[0]?.lastActivityAt;
      expect(lastActivityAt).toBeTruthy();
      // The write of `writeFor` in apps/ui/src/api/hooks/use-session-triage.ts.
      const write =
        action === "done"
          ? { status: "done" as const }
          : action === "read"
            ? { status: "open" as const, readAt: NOW, lastReadAt: lastActivityAt }
            : action === "unread"
              ? { status: "open" as const, lastReadAt: unreadCursor }
              : { status: "open" as const };
      await upsertInboxState({ userId: owner.id, itemType: "to_read", itemId: one.id, ...write });
      const res = await triage({ action, groupKey: `shared/${action}-list/` });
      expect(await res.json()).toEqual({ updated: 1 });

      const [a, b] = [await rowOf(one.id), await rowOf(list.id)];
      expect({ ...b, doneAt: b.doneAt !== null }).toMatchObject({
        status: a.status,
        snoozeUntil: a.snoozeUntil,
        dismissedAt: a.dismissedAt,
        doneAt: a.doneAt !== null,
        readAt: a.readAt,
        lastReadAt: a.lastReadAt,
      });
      // readAt is sticky: the first view stays.
      expect(b.readAt).toBe(OLD);
    }
  });

  test("triage by list needs a picked user and exactly one list", async () => {
    await task("shared/", { source: "ui" });
    expect((await triage({ action: "done", triage: "inbox" }, false)).status).toBe(400);
    expect((await triage({ action: "done" })).status).toBe(400);
    expect((await triage({ action: "done", triage: "inbox", noGroup: true })).status).toBe(400);
    expect((await listOf("triage=inbox")).total).toBe(1);
  });
});
