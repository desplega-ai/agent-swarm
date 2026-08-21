import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  closeDb,
  createPage,
  createUser,
  getDbClient,
  getLatestPageBySlug,
  getPageBySlug,
  initDb,
  listUserFavorites,
  setUserFavorite,
} from "../be/db";
import { handleFavorites } from "../http/favorites";
import { getPathSegments, parseQueryParams } from "../http/utils";
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
});
