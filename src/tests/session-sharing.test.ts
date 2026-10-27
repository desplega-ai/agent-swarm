import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  initDb,
} from "../be/db";
import {
  getSessionRoot,
  listSessionShareHistory,
  sessionAccess,
  setSessionShares,
} from "../be/session-shares";
import { handleRealtimeTicket } from "../http/realtime";
import { handleSessions } from "../http/sessions";
import { handleTasks } from "../http/tasks";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { authorizeRoomNamespace } from "../realtime/auth";
import { redeemRealtimeTicket, sweepRealtimeTickets } from "../realtime/tickets";
import type { HttpRequestAuth } from "../utils/request-auth-context";
import { setRequestAuth } from "../utils/request-auth-context";

const OPERATOR: HttpRequestAuth = { kind: "operator", fingerprint: "op:test" };

type Call = {
  auth?: HttpRequestAuth;
  body?: unknown;
  /** Dashboard picked identity (`X-Swarm-User-Id`). */
  dashboardUserId?: string;
  agentId?: string;
};

function jsonReq(method: string, url: string, body?: unknown) {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json" };
  return req;
}

async function call(
  handler: "sessions" | "tasks" | "ticket",
  method: string,
  url: string,
  opts: Call = {},
): Promise<{ status: number; body: any }> {
  const req = jsonReq(method, url, opts.body);
  if (opts.dashboardUserId) req.headers["x-swarm-user-id"] = opts.dashboardUserId;
  if (opts.agentId) req.headers["x-agent-id"] = opts.agentId;
  setRequestAuth(req as never, opts.auth ?? OPERATOR);
  let status = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
    },
  };
  const segments = getPathSegments(url);
  const query = parseQueryParams(url);
  const handled =
    handler === "sessions"
      ? await handleSessions(req as never, res as never, segments, query, opts.agentId)
      : handler === "tasks"
        ? await handleTasks(req as never, res as never, segments, query, opts.agentId)
        : await handleRealtimeTicket(req as never, res as never, segments, query);
  expect(handled).toBe(true);
  return { status, body: chunks.length > 0 ? JSON.parse(chunks.join("")) : null };
}

let owner: { id: string };
let eze: { id: string };
let mar: { id: string };
let ezeAuth: HttpRequestAuth;

beforeAll(async () => {
  initDb(":memory:");
  owner = await createUser({ name: "Owner" });
  eze = await createUser({ name: "Eze" });
  mar = await createUser({ name: "Mar" });
  ezeAuth = { kind: "user", userId: eze.id, user: eze as never };
});

afterAll(() => {
  sweepRealtimeTickets(Number.MAX_SAFE_INTEGER);
  closeDb();
});

beforeEach(async () => {
  await getDbClient().run("DELETE FROM session_shares");
});

async function session(requestedByUserId?: string) {
  const root = await createTaskExtended("Fix flaky deploy", { requestedByUserId, source: "ui" });
  const child = await createTaskExtended("follow-up", {
    requestedByUserId,
    parentTaskId: root.id,
    source: "ui",
  });
  return { root, child, rootRef: { id: root.id, requestedByUserId: requestedByUserId ?? null } };
}

describe("sessionAccess", () => {
  test("owner, ownerless roots, private by default, best active share, child resolves to root", async () => {
    const { root, child, rootRef } = await session(owner.id);
    const ownerless = await session();

    expect(await sessionAccess(owner.id, root.id)).toBe("owner");
    expect(await sessionAccess(eze.id, ownerless.child.id)).toBe("owner");
    // No rows: private to the owner.
    expect(await sessionAccess(eze.id, root.id)).toBe("none");
    expect(await sessionAccess(null, root.id)).toBe("none");

    await setSessionShares(
      rootRef,
      { everyone: "read", users: [{ userId: eze.id, access: "write" }] },
      owner.id,
    );
    expect(await sessionAccess(eze.id, child.id)).toBe("write");
    expect(await sessionAccess(mar.id, child.id)).toBe("read");
    expect(await sessionAccess(null, root.id)).toBe("read");
    expect((await getSessionRoot(child.id))?.id).toBe(root.id);

    // Revoked rows grant nothing.
    await setSessionShares(rootRef, { everyone: "none", users: [] }, owner.id);
    expect(await sessionAccess(eze.id, child.id)).toBe("none");
    expect(await sessionAccess(mar.id, child.id)).toBe("none");
  });

  test("a chain deeper than 1000 tasks still resolves to its actual root", async () => {
    const { root, child, rootRef } = await session(owner.id);
    let leaf = child;
    for (let depth = 2; depth <= 1002; depth++) {
      leaf = await createTaskExtended(`step ${depth}`, {
        requestedByUserId: owner.id,
        parentTaskId: leaf.id,
        source: "ui",
      });
    }
    await setSessionShares(
      rootRef,
      { everyone: "none", users: [{ userId: eze.id, access: "write" }] },
      owner.id,
    );

    expect((await getSessionRoot(leaf.id))?.id).toBe(root.id);
    expect(await sessionAccess(eze.id, leaf.id)).toBe("write");
  });
});

describe("setSessionShares", () => {
  test("an access change revokes and re-inserts; untouched rows keep their id; nothing is deleted", async () => {
    const { rootRef } = await session(owner.id);
    await setSessionShares(
      rootRef,
      {
        everyone: "none",
        users: [
          { userId: eze.id, access: "read" },
          { userId: mar.id, access: "read" },
        ],
      },
      owner.id,
    );
    const first = await listSessionShareHistory(rootRef.id);
    const marRow = first.find((row) => row.userId === mar.id)!;

    const state = await setSessionShares(
      rootRef,
      {
        everyone: "none",
        users: [
          { userId: eze.id, access: "write" },
          { userId: mar.id, access: "read" },
          // The owner is never stored.
          { userId: owner.id, access: "read" },
        ],
      },
      owner.id,
    );
    expect(state.users.map((u) => [u.userId, u.access]).sort()).toEqual(
      [
        [eze.id, "write"],
        [mar.id, "read"],
      ].sort(),
    );

    const history = await listSessionShareHistory(rootRef.id);
    const ezeRows = history.filter((row) => row.userId === eze.id);
    expect(ezeRows).toHaveLength(2);
    expect(ezeRows[0]).toMatchObject({ access: "read", revokedBy: owner.id });
    expect(ezeRows[0]!.revokedAt).not.toBeNull();
    expect(ezeRows[1]).toMatchObject({ access: "write", revokedAt: null });
    expect(history.find((row) => row.userId === mar.id && !row.revokedAt)?.id).toBe(marRow.id);
    expect(history.some((row) => row.userId === owner.id)).toBe(false);

    // Remove = revoke: the row stays.
    await setSessionShares(rootRef, { everyone: "none", users: [] }, owner.id);
    const after = await listSessionShareHistory(rootRef.id);
    expect(after).toHaveLength(3);
    expect(after.every((row) => row.revokedAt !== null)).toBe(true);
  });

  test("the partial unique index allows one active row per target", async () => {
    const { rootRef } = await session(owner.id);
    await setSessionShares(rootRef, { everyone: "read", users: [] }, owner.id);
    const insert = () =>
      getDbClient().run(
        "INSERT INTO session_shares (id, rootTaskId, userId, access, createdAt) VALUES (?, ?, NULL, 'write', ?)",
        [crypto.randomUUID(), rootRef.id, new Date().toISOString()],
      );
    await expect(insert()).rejects.toThrow();
    await setSessionShares(rootRef, { everyone: "none", users: [] }, owner.id);
    await insert();
  });
});

describe("session routes", () => {
  test("detail: 403 without a share, access + owner with one, owner for agents and the bare operator key", async () => {
    const { root } = await session(owner.id);

    const denied = await call("sessions", "GET", `/api/sessions/${root.id}`, {
      dashboardUserId: eze.id,
    });
    expect(denied.status).toBe(403);

    const asOwner = await call("sessions", "GET", `/api/sessions/${root.id}`, {
      dashboardUserId: owner.id,
    });
    expect(asOwner.status).toBe(200);
    expect(asOwner.body).toMatchObject({ access: "owner", owner: { id: owner.id, name: "Owner" } });

    const put = await call("sessions", "PUT", `/api/sessions/${root.id}/shares`, {
      dashboardUserId: owner.id,
      body: { everyone: "none", users: [{ userId: eze.id, access: "read" }] },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      everyone: "none",
      users: [{ userId: eze.id, access: "read" }],
    });

    const shared = await call("sessions", "GET", `/api/sessions/${root.id}`, { auth: ezeAuth });
    expect(shared.body.access).toBe("read");

    for (const opts of [{}, { agentId: crypto.randomUUID(), dashboardUserId: eze.id }]) {
      const bypass = await call("sessions", "GET", `/api/sessions/${root.id}`, opts);
      expect(bypass.status).toBe(200);
      expect(bypass.body.access).toBe("owner");
    }
  });

  test("shares: owner only, unknown users rejected, ownerless sessions refused", async () => {
    const { root } = await session(owner.id);
    const ownerless = await session();

    const byEze = await call("sessions", "PUT", `/api/sessions/${root.id}/shares`, {
      auth: ezeAuth,
      body: { everyone: "write", users: [] },
    });
    expect(byEze.status).toBe(403);

    const unknown = await call("sessions", "PUT", `/api/sessions/${root.id}/shares`, {
      dashboardUserId: owner.id,
      body: { everyone: "none", users: [{ userId: "nobody", access: "read" }] },
    });
    expect(unknown.status).toBe(400);

    const open = await call("sessions", "PUT", `/api/sessions/${ownerless.root.id}/shares`, {
      body: { everyone: "read", users: [] },
    });
    expect(open.status).toBe(409);

    const read = await call("sessions", "GET", `/api/sessions/${root.id}/shares`, {
      dashboardUserId: eze.id,
    });
    expect(read.status).toBe(403);
  });

  test("list: default is mine + ownerless + shared; scope narrows it", async () => {
    const mine = await session(eze.id);
    const shared = await session(owner.id);
    const privateOne = await session(owner.id);
    const ownerless = await session();
    await setSessionShares(
      shared.rootRef,
      { everyone: "none", users: [{ userId: eze.id, access: "read" }] },
      owner.id,
    );

    const ids = async (query: string) => {
      const res = await call("sessions", "GET", `/api/sessions?limit=100${query}`, {
        dashboardUserId: eze.id,
      });
      return res.body.sessions.map((s: { root: { id: string } }) => s.root.id) as string[];
    };
    const all = await ids("");
    expect(all).toContain(mine.root.id);
    expect(all).toContain(shared.root.id);
    expect(all).toContain(ownerless.root.id);
    expect(all).not.toContain(privateOne.root.id);
    expect(await ids("&scope=mine")).toEqual([mine.root.id]);
    expect(await ids("&scope=shared")).toEqual([shared.root.id]);

    const operator = await call("sessions", "GET", "/api/sessions?limit=100");
    const operatorIds = operator.body.sessions.map((s: { root: { id: string } }) => s.root.id);
    expect(operatorIds).toContain(privateOne.root.id);
    const operatorScoped = await call("sessions", "GET", "/api/sessions?scope=shared");
    expect(operatorScoped.body.sessions).toEqual([]);
  });

  test("list, count and tree: a non-creator sees schedule runs like their creator", async () => {
    // The scheduler names the schedule's creator as the requester.
    const run = await createTaskExtended("SCHEDULED LIST RUN", {
      requestedByUserId: owner.id,
      scheduleId: crypto.randomUUID(),
      source: "schedule",
    });

    const view = async (userId: string) => {
      const list = await call(
        "sessions",
        "GET",
        "/api/sessions?limit=100&scope=tree&show=all&showSource=schedule",
        { dashboardUserId: userId },
      );
      const tree = await call("sessions", "GET", "/api/session-tree?show=all", {
        dashboardUserId: userId,
      });
      expect(list.status).toBe(200);
      expect(tree.status).toBe(200);
      return {
        ids: list.body.sessions.map((s: { root: { id: string } }) => s.root.id) as string[],
        total: list.body.total as number,
        treeTotal: (tree.body.sources as { source: string; total: number }[]).find(
          (s) => s.source === "schedule",
        )?.total,
      };
    };
    const creator = await view(owner.id);
    const other = await view(eze.id);
    expect(creator.ids).toContain(run.id);
    expect(other.ids).toContain(run.id);
    expect(other.total).toBe(creator.total);
    expect(other.treeTotal).toBe(creator.treeTotal);
    expect(other.treeTotal).toBeGreaterThan(0);
  });
});

describe("task routes", () => {
  test("GET /api/tasks/:id needs read access for a user, not for agents or the bare operator key", async () => {
    const { root, child, rootRef } = await session(owner.id);
    const userToken: HttpRequestAuth = ezeAuth;

    for (const task of [root, child]) {
      expect(
        (await call("tasks", "GET", `/api/tasks/${task.id}`, { auth: userToken })).status,
      ).toBe(403);
      expect(
        (await call("tasks", "GET", `/api/tasks/${task.id}`, { dashboardUserId: eze.id })).status,
      ).toBe(403);
      expect(
        (await call("tasks", "GET", `/api/tasks/${task.id}`, { dashboardUserId: owner.id })).status,
      ).toBe(200);
      expect((await call("tasks", "GET", `/api/tasks/${task.id}`)).status).toBe(200);
      expect(
        (
          await call("tasks", "GET", `/api/tasks/${task.id}`, {
            agentId: crypto.randomUUID(),
            dashboardUserId: eze.id,
          })
        ).status,
      ).toBe(200);
    }

    await setSessionShares(
      rootRef,
      { everyone: "none", users: [{ userId: eze.id, access: "read" }] },
      owner.id,
    );
    const shared = await call("tasks", "GET", `/api/tasks/${child.id}`, { auth: userToken });
    expect(shared.status).toBe(200);
    expect(shared.body.task).toBe("follow-up");
  });

  test("GET /api/tasks drops a user's unreadable sessions from every shape, and total counts what is shown", async () => {
    const root = await createTaskExtended("PRIVATE ROOT ALPHA", {
      requestedByUserId: owner.id,
      source: "ui",
    });
    const child = await createTaskExtended("PRIVATE CHILD BETA", {
      requestedByUserId: owner.id,
      parentTaskId: root.id,
      source: "ui",
    });
    const rootRef = { id: root.id, requestedByUserId: owner.id };
    const ownerless = await session();
    const shapes = ["", "&fields=slim", "&fields=timeline", "&fields=full"];
    const list = async (query: string, opts: Call) => {
      const { status, body } = await call("tasks", "GET", `/api/tasks?limit=1000${query}`, opts);
      expect(status).toBe(200);
      return body as { tasks: { id: string; task?: string }[]; total?: number };
    };

    for (const shape of shapes) {
      const body = await list(`${shape}&includeTotal=true`, { auth: ezeAuth });
      const ids = body.tasks.map((task) => task.id);
      expect(ids).not.toContain(root.id);
      expect(ids).not.toContain(child.id);
      expect(ids).toContain(ownerless.child.id);
      expect(JSON.stringify(body.tasks)).not.toContain("PRIVATE");
      expect(body.total).toBe(body.tasks.length);
    }
    // A search hit on hidden text counts nothing, so `total` is no oracle.
    for (const shape of shapes) {
      const hit = await list(`${shape}&search=PRIVATE%20ROOT&includeTotal=true`, { auth: ezeAuth });
      expect(hit).toEqual({ tasks: [], total: 0 });
    }

    for (const opts of [{}, { dashboardUserId: owner.id }, { agentId: crypto.randomUUID() }]) {
      for (const shape of shapes) {
        const body = await list(`${shape}&search=PRIVATE&includeTotal=true`, opts);
        expect(body.tasks.map((task) => task.id).sort()).toEqual([root.id, child.id].sort());
        expect(body.total).toBe(2);
      }
    }

    await setSessionShares(rootRef, { everyone: "read", users: [] }, owner.id);
    for (const shape of shapes) {
      const body = await list(`${shape}&search=PRIVATE&includeTotal=true`, { auth: ezeAuth });
      expect(body.tasks.map((task) => task.id).sort()).toEqual([root.id, child.id].sort());
      expect(body.total).toBe(2);
    }
  });

  test("a schedule session is readable by every user, but writable only by its creator", async () => {
    // The scheduler names the schedule's creator as the requester.
    const scheduleId = crypto.randomUUID();
    const root = await createTaskExtended("SCHEDULED RUN", {
      requestedByUserId: owner.id,
      scheduleId,
      source: "schedule",
    });
    const child = await createTaskExtended("SCHEDULED FOLLOW-UP", {
      requestedByUserId: owner.id,
      parentTaskId: root.id,
      source: "ui",
    });

    expect(await sessionAccess(eze.id, child.id)).toBe("read");
    expect(await sessionAccess(null, root.id)).toBe("read");
    expect(await sessionAccess(owner.id, child.id)).toBe("owner");

    const list = await call(
      "tasks",
      "GET",
      `/api/tasks?scheduleId=${scheduleId}&includeTotal=true`,
      {
        auth: ezeAuth,
      },
    );
    expect(list.status).toBe(200);
    expect(list.body.tasks.map((task: { id: string }) => task.id)).toEqual([root.id]);
    expect(list.body.total).toBe(1);
    expect((await call("tasks", "GET", `/api/tasks/${child.id}`, { auth: ezeAuth })).status).toBe(
      200,
    );
    expect(
      (await call("sessions", "GET", `/api/sessions/${root.id}`, { dashboardUserId: eze.id }))
        .status,
    ).toBe(200);

    const followUp = (dashboardUserId: string) =>
      call("tasks", "POST", "/api/tasks", {
        dashboardUserId,
        body: { task: "rerun it", parentTaskId: child.id, source: "ui" },
      });
    expect((await followUp(eze.id)).status).toBe(403);
    expect((await followUp(owner.id)).status).toBe(201);
  });
});

describe("write gate", () => {
  test("POST /api/tasks under someone else's session needs a write share", async () => {
    const { root, child, rootRef } = await session(owner.id);
    const followUp = (opts: Call) =>
      call("tasks", "POST", "/api/tasks", {
        ...opts,
        body: { task: "please also check the logs", parentTaskId: child.id, source: "ui" },
      });

    expect((await followUp({ dashboardUserId: eze.id })).status).toBe(403);
    await setSessionShares(
      rootRef,
      { everyone: "read", users: [{ userId: mar.id, access: "write" }] },
      owner.id,
    );
    const readOnly = await followUp({ dashboardUserId: eze.id });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.error).toContain("can't write in this session");

    expect((await followUp({ dashboardUserId: mar.id })).status).toBe(201);
    expect((await followUp({ dashboardUserId: owner.id })).status).toBe(201);
    // No picked user: the operator key keeps working.
    expect((await followUp({})).status).toBe(201);
    // Agents continue chains without a share.
    const agent = await createAgent({ name: "chain worker", isLead: true, status: "idle" });
    expect((await followUp({ agentId: agent.id, dashboardUserId: eze.id })).status).toBe(201);
    expect(root.id).toBeTruthy();
  });

  test("POST /api/tasks/:id/steer needs a write share, and a write share lets a user token steer", async () => {
    const previous = process.env.STEERING_ENABLED;
    process.env.STEERING_ENABLED = "true";
    try {
      const { child, rootRef } = await session(owner.id);
      const steer = (opts: Call) =>
        call("tasks", "POST", `/api/tasks/${child.id}/steer`, {
          ...opts,
          body: { message: "use the staging cluster" },
        });

      const none = await steer({ auth: ezeAuth });
      expect(none.status).toBe(403);
      expect(none.body.error).toContain("can't write in this session");

      await setSessionShares(rootRef, { everyone: "read", users: [] }, owner.id);
      expect((await steer({ dashboardUserId: eze.id })).status).toBe(403);

      await setSessionShares(
        rootRef,
        { everyone: "read", users: [{ userId: eze.id, access: "write" }] },
        owner.id,
      );
      // Past both gates: whatever the steering store answers, it is not a 403.
      expect((await steer({ auth: ezeAuth })).status).not.toBe(403);
      expect((await steer({ dashboardUserId: eze.id })).status).not.toBe(403);

      // An ownerless (Slack, schedule) session reads as `owner` for everyone,
      // but a user token still may not steer a task it did not request.
      const ownerless = await session();
      const slackSteer = await call("tasks", "POST", `/api/tasks/${ownerless.child.id}/steer`, {
        auth: ezeAuth,
        body: { message: "use the staging cluster" },
      });
      expect(slackSteer.status).toBe(403);
      expect(slackSteer.body.error).toContain("cannot steer this task");
    } finally {
      if (previous === undefined) delete process.env.STEERING_ENABLED;
      else process.env.STEERING_ENABLED = previous;
    }
  });
});

describe("session presence", () => {
  test("rooms need read access, dashboard auth, and presence-only ops", async () => {
    const { root, child, rootRef } = await session(owner.id);
    const ns = `presence:session:${root.id}`;

    expect(await authorizeRoomNamespace(ns, { userId: owner.id }, "join")).toBeNull();
    expect(await authorizeRoomNamespace(ns, { userId: eze.id }, "join")).toContain("access");
    expect(await authorizeRoomNamespace(ns, { isOperator: true }, "join")).toBeNull();
    expect(
      await authorizeRoomNamespace(ns, { isOperator: true, dashboardUserId: eze.id }, "presence"),
    ).toContain("access");
    expect(await authorizeRoomNamespace(ns, { agentId: "a1", isOperator: true }, "join")).toContain(
      "dashboard",
    );
    expect(await authorizeRoomNamespace(ns, { userId: owner.id }, "update")).toContain(
      "only allow",
    );
    expect(
      await authorizeRoomNamespace(`presence:session:${child.id}`, { userId: owner.id }, "join"),
    ).toContain("not found");

    await setSessionShares(rootRef, { everyone: "read", users: [] }, owner.id);
    expect(await authorizeRoomNamespace(ns, { userId: eze.id }, "join")).toBeNull();
    expect(
      await authorizeRoomNamespace(ns, { isOperator: true, dashboardUserId: eze.id }, "presence"),
    ).toBeNull();
  });

  test("the ticket route works with Comb off and carries the picked dashboard user", async () => {
    const previous = process.env.COMB_ENABLED;
    process.env.COMB_ENABLED = "false";
    try {
      const res = await call("ticket", "POST", "/api/realtime/ticket", { dashboardUserId: eze.id });
      expect(res.status).toBe(200);
      expect(redeemRealtimeTicket(res.body.ticket)).toMatchObject({
        kind: "operator",
        dashboardUserId: eze.id,
      });
    } finally {
      if (previous === undefined) delete process.env.COMB_ENABLED;
      else process.env.COMB_ENABLED = previous;
    }
  });
});
