import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { closeDb, getDb, initDb } from "../be/db";
import { runMigrations } from "../be/migrations/runner";
import { handleFavorites } from "../http/favorites";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setRequestAuth } from "../utils/request-auth-context";

// Migration 188 adds the Comb pin item type `agent-fs-path` to user_favorites.

const TEST_DB_PATH = "./test-favorites-agent-fs-path.sqlite";
const MIGRATIONS_DIR = join(import.meta.dir, "../be/migrations");

async function removeDb(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${path}${suffix}`);
    } catch {}
  }
}

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
  setRequestAuth(req, { kind: "operator", fingerprint: "op:test-comb-pins" });
  return req;
}

async function call(method: string, url: string, body?: unknown) {
  const req = jsonReq(method, url, body);
  let statusCode = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      statusCode = code;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
    },
  };
  await handleFavorites(
    req,
    res as never,
    getPathSegments(req.url),
    parseQueryParams(req.url),
    undefined,
  );
  return { statusCode, body: chunks.length > 0 ? JSON.parse(chunks.join("")) : null };
}

describe("favorites: agent-fs-path item type (fresh DB)", () => {
  beforeAll(async () => {
    await removeDb(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDb(TEST_DB_PATH);
  });

  test("PUT pins a folder and a file, GET lists them back", async () => {
    for (const itemId of ["org/drive/comb-qa/", "org/drive/comb-qa/my notes 100%.md"]) {
      const put = await call("PUT", "/api/favorites", {
        itemType: "agent-fs-path",
        itemId,
        favorite: true,
      });
      expect(put).toMatchObject({
        statusCode: 200,
        body: { favorite: true, itemType: "agent-fs-path", itemId },
      });
    }

    const list = await call("GET", "/api/favorites?itemType=agent-fs-path");
    expect(list.statusCode).toBe(200);
    expect([...list.body.favoriteIds].sort()).toEqual([
      "org/drive/comb-qa/",
      "org/drive/comb-qa/my notes 100%.md",
    ]);
    for (const row of list.body.favorites) expect(row.itemType).toBe("agent-fs-path");

    // Other item types do not see the pins.
    expect((await call("GET", "/api/favorites?itemType=page")).body.favoriteIds).toEqual([]);
  });

  test("PUT with favorite=false unpins", async () => {
    await call("PUT", "/api/favorites", {
      itemType: "agent-fs-path",
      itemId: "org/drive/comb-qa/",
      favorite: false,
    });
    const list = await call("GET", "/api/favorites?itemType=agent-fs-path");
    expect(list.body.favoriteIds).toEqual(["org/drive/comb-qa/my notes 100%.md"]);
  });

  test("GET lists pins newest first", async () => {
    const db = getDb();
    const ids = ["org/drive/order/a.md", "org/drive/order/b.md", "org/drive/order/c.md"];
    for (const [i, itemId] of ids.entries()) {
      await call("PUT", "/api/favorites", { itemType: "agent-fs-path", itemId, favorite: true });
      db.run(
        "UPDATE user_favorites SET lastUpdatedAt = ? WHERE itemType = 'agent-fs-path' AND itemId = ?",
        [`2030-01-0${i + 1}T00:00:00.000Z`, itemId],
      );
    }
    const list = await call("GET", "/api/favorites?itemType=agent-fs-path");
    const listed = list.body.favoriteIds.filter((id: string) => id.startsWith("org/drive/order/"));
    expect(listed).toEqual([...ids].reverse());
  });

  test("an unknown item type is still rejected", async () => {
    const put = await call("PUT", "/api/favorites", {
      itemType: "agent-fs-file",
      itemId: "org/drive/a.md",
      favorite: true,
    });
    expect(put.statusCode).toBe(400);
    const list = await call("GET", "/api/favorites?itemType=agent-fs-file");
    expect(list.statusCode).toBe(400);
  });
});

describe("migration 188 (existing DB)", () => {
  // In memory: the full migration chain on a file DB passed the 10 s test timeout on a loaded CI shard.
  test("keeps every favorite row and the indexes, and widens the CHECK", async () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);

      // Roll back to the pre-188 shape: re-run 116 on the empty table (it
      // rebuilds user_favorites with the old CHECK and the same indexes).
      db.exec(await Bun.file(join(MIGRATIONS_DIR, "116_favorite_principal_scope.sql")).text());
      db.run("DELETE FROM _migrations WHERE version = 188");
      expect(() =>
        db.run(
          "INSERT INTO user_favorites (favoriteScope, itemType, itemId) VALUES ('operator:x', 'agent-fs-path', 'o/d/a.md')",
        ),
      ).toThrow(/CHECK constraint failed/);

      db.run("INSERT INTO users (id, name) VALUES ('user-1', 'Pin User')");
      const insert = db.prepare(
        `INSERT INTO user_favorites
           (id, favoriteScope, userId, itemType, itemId, createdAt, lastUpdatedAt, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      // Page, workflow, and schedule favorites for a user scope and the
      // operator scope, with distinct timestamps and audit values per row.
      let n = 0;
      for (const [scope, userId] of [
        ["user:user-1", "user-1"],
        ["operator", null],
      ] as const) {
        for (const itemType of ["page", "workflow", "schedule"]) {
          n++;
          insert.run(
            `fav-${n}`,
            scope,
            userId,
            itemType,
            `${itemType}-${n}`,
            `2026-09-0${n}T00:00:00.000Z`,
            `2026-09-1${n}T00:00:00.000Z`,
            n % 2 ? "op:abc" : null,
            n % 3 ? userId : null,
          );
        }
      }
      const before = db.query("SELECT * FROM user_favorites ORDER BY id").all();
      expect(before).toHaveLength(6);

      runMigrations(db);

      expect(db.query("SELECT version FROM _migrations WHERE version = 188").get()).not.toBeNull();
      expect(db.query("SELECT * FROM user_favorites ORDER BY id").all()).toEqual(before);

      const indexes = db
        .query<{ name: string; unique: number }, []>("PRAGMA index_list(user_favorites)")
        .all();
      expect(indexes.map((index) => index.name)).toEqual(
        expect.arrayContaining([
          "idx_user_favorites_scope_type",
          "idx_user_favorites_user_type",
          "idx_user_favorites_item",
        ]),
      );
      // The UNIQUE (favoriteScope, itemType, itemId) constraint survives.
      const unique = indexes
        .filter((index) => index.unique === 1)
        .map((index) =>
          db
            .query<{ name: string }, []>(`PRAGMA index_info("${index.name}")`)
            .all()
            .map((column) => column.name),
        );
      expect(unique).toContainEqual(["favoriteScope", "itemType", "itemId"]);

      // The new type is accepted, an unknown type is still rejected.
      db.run(
        "INSERT INTO user_favorites (favoriteScope, itemType, itemId) VALUES ('operator', 'agent-fs-path', 'o/d/comb-qa/')",
      );
      expect(() =>
        db.run(
          "INSERT INTO user_favorites (favoriteScope, itemType, itemId) VALUES ('operator', 'bogus', 'x')",
        ),
      ).toThrow(/CHECK constraint failed/);

      // The user FK still cascades.
      db.run("DELETE FROM users WHERE id = 'user-1'");
      expect(db.query("SELECT id FROM user_favorites WHERE userId = 'user-1'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
