import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  closeDb,
  createPage,
  createScheduledTask,
  createUser,
  createWorkflow,
  deleteScheduledTask,
  deleteWorkflow,
  getDb,
  getDbClient,
  getLatestPageBySlug,
  getPageBySlug,
  initDb,
  listFavorites,
  listUserFavorites,
  setFavorite,
  setUserFavorite,
} from "../be/db";
import { handleFavorites } from "../http/favorites";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { HttpRequestAuth } from "../utils/request-auth-context";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-favorites.sqlite";

function jsonReq(
  method: string,
  url: string,
  body?: unknown,
): Readable & { method: string; url: string; headers: Record<string, string> } {
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

const OPERATOR: HttpRequestAuth = { kind: "operator", fingerprint: "op:test-hosted-ui" };

/** One favorites call as the dashboard makes it, optionally naming its picked user. */
async function callFavorites(
  method: "GET" | "PUT",
  url: string,
  auth: HttpRequestAuth,
  opts: { body?: unknown; dashboardUserId?: string } = {},
) {
  const req = jsonReq(method, url, opts.body);
  if (opts.dashboardUserId) req.headers["x-swarm-user-id"] = opts.dashboardUserId;
  setRequestAuth(req, auth);
  const recorder = resRecorder();
  await handleFavorites(
    req,
    recorder.res as never,
    getPathSegments(req.url),
    parseQueryParams(req.url),
    undefined,
  );
  return recorder.result();
}

function resRecorder() {
  let statusCode = 200;
  const chunks: string[] = [];
  return {
    res: {
      setHeader: () => {},
      writeHead: (code: number) => {
        statusCode = code;
      },
      end: (chunk?: string) => {
        if (chunk) chunks.push(chunk);
      },
    },
    result: () => ({
      statusCode,
      body: chunks.length > 0 ? JSON.parse(chunks.join("")) : null,
    }),
  };
}

describe("favorites and page slug resolution", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(`${TEST_DB_PATH}${suffix}`);
      } catch {}
    }
  });

  test("setUserFavorite toggles per-user rows", async () => {
    const user = await createUser({ name: "Favorites User" });

    const row = await setUserFavorite({
      userId: user.id,
      itemType: "page",
      itemId: "page-1",
      favorite: true,
    });
    expect(row?.itemId).toBe("page-1");
    expect(
      (await listUserFavorites({ userId: user.id, itemType: "page" })).map((f) => f.itemId),
    ).toEqual(["page-1"]);

    const removed = await setUserFavorite({
      userId: user.id,
      itemType: "page",
      itemId: "page-1",
      favorite: false,
    });
    expect(removed).toBeNull();
    expect(await listUserFavorites({ userId: user.id, itemType: "page" })).toHaveLength(0);
  });

  test("global page slug resolution picks newest updated page across agents", async () => {
    const slug = `shared-slug-${crypto.randomUUID().slice(0, 8)}`;
    const oldPage = await createPage({
      agentId: "agent-old",
      slug,
      title: "Old",
      contentType: "text/html",
      authMode: "public",
      body: "<h1>old</h1>",
    });
    const newPage = await createPage({
      agentId: "agent-new",
      slug,
      title: "New",
      contentType: "text/html",
      authMode: "public",
      body: "<h1>new</h1>",
    });
    await getDbClient().run("UPDATE pages SET updatedAt = ? WHERE id = ?", [
      "2099-01-01T00:00:00.000Z",
      newPage.id,
    ]);

    expect((await getPageBySlug("agent-old", slug))?.id).toBe(oldPage.id);
    expect((await getLatestPageBySlug(slug))?.id).toBe(newPage.id);
  });

  test("favorites HTTP endpoints use trusted request user", async () => {
    const user = await createUser({ name: "HTTP Favorites User" });
    const req = jsonReq("PUT", "/api/favorites", {
      itemType: "workflow",
      itemId: "workflow-1",
      favorite: true,
    });
    setRequestAuth(req, { kind: "user", userId: user.id, user });

    const recorder = resRecorder();
    await handleFavorites(
      req,
      recorder.res as never,
      getPathSegments(req.url),
      parseQueryParams(req.url),
      undefined,
    );
    expect(recorder.result()).toMatchObject({
      statusCode: 200,
      body: { favorite: true, itemType: "workflow", itemId: "workflow-1" },
    });

    const listReq = jsonReq("GET", "/api/favorites?itemType=workflow&itemIds=workflow-1");
    setRequestAuth(listReq, { kind: "user", userId: user.id, user });
    const listRecorder = resRecorder();
    await handleFavorites(
      listReq,
      listRecorder.res as never,
      getPathSegments(listReq.url),
      parseQueryParams(listReq.url),
      undefined,
    );
    expect(listRecorder.result().body.favoriteIds).toEqual(["workflow-1"]);
  });

  test("favorites HTTP endpoints accept the hosted UI operator principal", async () => {
    const req = jsonReq("PUT", "/api/favorites", {
      itemType: "page",
      itemId: "operator-page-1",
      favorite: true,
    });
    setRequestAuth(req, { kind: "operator", fingerprint: "op:test-hosted-ui" });

    const recorder = resRecorder();
    await handleFavorites(
      req,
      recorder.res as never,
      getPathSegments(req.url),
      parseQueryParams(req.url),
      undefined,
    );
    expect(recorder.result()).toMatchObject({
      statusCode: 200,
      body: { favorite: true, itemType: "page", itemId: "operator-page-1" },
    });

    const listReq = jsonReq("GET", "/api/favorites?itemType=page&itemIds=operator-page-1");
    setRequestAuth(listReq, { kind: "operator", fingerprint: "op:test-hosted-ui" });
    const listRecorder = resRecorder();
    await handleFavorites(
      listReq,
      listRecorder.res as never,
      getPathSegments(listReq.url),
      parseQueryParams(listReq.url),
      undefined,
    );
    expect(listRecorder.result()).toMatchObject({
      statusCode: 200,
      body: { favoriteIds: ["operator-page-1"] },
    });
  });
  test("dashboard users on the shared operator key keep separate favorites", async () => {
    const alice = await createUser({ name: "Dashboard Alice" });
    const bob = await createUser({ name: "Dashboard Bob" });
    const put = (dashboardUserId: string | undefined, itemId: string) =>
      callFavorites("PUT", "/api/favorites", OPERATOR, {
        body: { itemType: "workflow", itemId, favorite: true },
        dashboardUserId,
      });
    const list = async (dashboardUserId?: string) =>
      (
        await callFavorites("GET", "/api/favorites?itemType=workflow", OPERATOR, {
          dashboardUserId,
        })
      ).body.favoriteIds;

    expect((await put(alice.id, "wf-alice")).statusCode).toBe(200);
    expect((await put(bob.id, "wf-bob")).statusCode).toBe(200);

    expect(await list(alice.id)).toEqual(["wf-alice"]);
    expect(await list(bob.id)).toEqual(["wf-bob"]);
    // A tab with no picked user keeps the shared operator set, untouched.
    expect(await list()).not.toContain("wf-alice");
    expect(await list()).not.toContain("wf-bob");

    const [row] = await listFavorites({ favoriteScope: `user:${alice.id}`, itemType: "workflow" });
    expect(row).toMatchObject({ userId: alice.id, createdBy: alice.id });
  });

  test("the dashboard user header is ignored without operator dashboard auth", async () => {
    const alice = await createUser({ name: "Token Alice" });
    const mallory = await createUser({ name: "Token Mallory" });
    // A user token cannot write into another user's favorites.
    const res = await callFavorites(
      "PUT",
      "/api/favorites",
      { kind: "user", userId: mallory.id, user: mallory },
      {
        body: { itemType: "page", itemId: "spoofed-page", favorite: true },
        dashboardUserId: alice.id,
      },
    );
    expect(res.statusCode).toBe(200);
    expect(await listUserFavorites({ userId: alice.id, itemType: "page" })).toHaveLength(0);
    expect(
      (await listUserFavorites({ userId: mallory.id, itemType: "page" })).map((f) => f.itemId),
    ).toEqual(["spoofed-page"]);

    // An agent-authored page session runs on the operator key; it gets no user scope.
    await callFavorites(
      "PUT",
      "/api/favorites",
      { ...OPERATOR, page: { id: "page-x", executionAgentId: "agent-x" } },
      {
        body: { itemType: "page", itemId: "page-session-page", favorite: true },
        dashboardUserId: alice.id,
      },
    );
    expect(await listUserFavorites({ userId: alice.id, itemType: "page" })).toHaveLength(0);
  });

  test("an unknown or suspended dashboard user falls back to the operator set", async () => {
    const suspended = await createUser({ name: "Suspended Dashboard User" });
    await getDbClient().run("UPDATE users SET status = 'suspended' WHERE id = ?", [suspended.id]);
    for (const dashboardUserId of [suspended.id, "no-such-user"]) {
      const res = await callFavorites("PUT", "/api/favorites", OPERATOR, {
        body: { itemType: "schedule", itemId: `fallback-${dashboardUserId}`, favorite: true },
        dashboardUserId,
      });
      expect(res.body.row).toMatchObject({ itemId: `fallback-${dashboardUserId}` });
      expect(res.body.row.userId).toBeUndefined();
    }
    expect(await listUserFavorites({ userId: suspended.id })).toHaveLength(0);
  });

  test("deleting a workflow or schedule drops every user's favorite of it", async () => {
    const user = await createUser({ name: "Orphan Favorites User" });
    const workflow = await createWorkflow({
      name: `fav-wf-${crypto.randomUUID()}`,
      definition: { nodes: [{ id: "a", type: "script", config: {} }] },
    });
    const schedule = await createScheduledTask({
      name: `fav-sched-${crypto.randomUUID()}`,
      cronExpression: "0 * * * *",
      taskTemplate: "test",
      timezone: "UTC",
    });
    for (const favoriteScope of [`user:${user.id}`, "operator"]) {
      const userId = favoriteScope === "operator" ? null : user.id;
      await setFavorite({
        favoriteScope,
        userId,
        itemType: "workflow",
        itemId: workflow.id,
        favorite: true,
      });
      await setFavorite({
        favoriteScope,
        userId,
        itemType: "schedule",
        itemId: schedule.id,
        favorite: true,
      });
    }

    expect(await deleteWorkflow(workflow.id)).toBe(true);
    expect(await deleteScheduledTask(schedule.id)).toBe(true);

    const left = await getDbClient().query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM user_favorites WHERE itemId IN (?, ?)",
      [workflow.id, schedule.id],
    );
    expect(left[0]?.n).toBe(0);
  });

  test("migration 205 copies shared operator favorites to each active user and drops orphans", async () => {
    const db = getDbClient();
    await db.run("DELETE FROM user_favorites");
    const active = await createUser({ name: "Migrated Active" });
    const suspended = await createUser({ name: "Migrated Suspended" });
    await db.run("UPDATE users SET status = 'suspended' WHERE id = ?", [suspended.id]);
    const page = await createPage({
      agentId: "agent-migrate",
      slug: `migrated-${crypto.randomUUID().slice(0, 8)}`,
      title: "Migrated",
      contentType: "text/html",
      authMode: "public",
      body: "<p>x</p>",
    });
    await setFavorite({
      favoriteScope: "operator",
      itemType: "page",
      itemId: page.id,
      favorite: true,
    });
    await setFavorite({
      favoriteScope: "operator",
      itemType: "workflow",
      itemId: "gone-workflow",
      favorite: true,
    });
    // An existing per-user row is kept as is.
    await setUserFavorite({ userId: active.id, itemType: "page", itemId: page.id, favorite: true });

    getDb().exec(
      await Bun.file(
        new URL("../be/migrations/205_favorites_per_dashboard_user.sql", import.meta.url),
      ).text(),
    );

    expect((await listFavorites({ favoriteScope: "operator" })).map((f) => f.itemId)).toEqual([
      page.id,
    ]);
    expect(
      (await listUserFavorites({ userId: active.id })).map((f) => [f.itemType, f.itemId]),
    ).toEqual([["page", page.id]]);
    expect(await listUserFavorites({ userId: suspended.id })).toHaveLength(0);
  });
});
