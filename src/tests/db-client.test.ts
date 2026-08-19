import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBunSqliteClient, type DbClient } from "../be/db-client";

let raw: Database;
let client: DbClient;

beforeEach(() => {
  raw = new Database(":memory:");
  raw.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  client = createBunSqliteClient(() => raw);
});

afterEach(() => {
  raw.close();
});

const names = async (): Promise<string[]> =>
  (await client.query<{ name: string }>("SELECT name FROM items ORDER BY id")).map((r) => r.name);

describe("db-client basics", () => {
  test("run + query + get round-trip", async () => {
    const insert = await client.run("INSERT INTO items (name) VALUES (?)", ["a"]);
    expect(insert.changes).toBe(1);
    await client.run("INSERT INTO items (name) VALUES (?)", ["b"]);

    expect(await names()).toEqual(["a", "b"]);
    const row = await client.get<{ name: string }>("SELECT name FROM items WHERE name = ?", ["b"]);
    expect(row?.name).toBe("b");
    expect(await client.get("SELECT name FROM items WHERE name = ?", ["missing"])).toBeNull();
  });

  test("get supports RETURNING", async () => {
    const row = await client.get<{ id: number; name: string }>(
      "INSERT INTO items (name) VALUES (?) RETURNING *",
      ["c"],
    );
    expect(row?.name).toBe("c");
    expect(row?.id).toBeGreaterThan(0);
  });
});

describe("db-client transactions", () => {
  test("commit persists", async () => {
    const result = await client.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["t1"]);
      await tx.run("INSERT INTO items (name) VALUES (?)", ["t2"]);
      return "done";
    });
    expect(result).toBe("done");
    expect(await names()).toEqual(["t1", "t2"]);
  });

  test("throw rolls back", async () => {
    await expect(
      client.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["doomed"]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await names()).toEqual([]);
  });

  test("client-level calls inside the callback join the transaction", async () => {
    // Helper that uses the client (not the tx handle), as converted db.ts
    // helpers will. It must land inside the transaction and roll back with it.
    const helperInsert = async (name: string) => {
      await client.run("INSERT INTO items (name) VALUES (?)", [name]);
    };
    await expect(
      client.transaction(async () => {
        await helperInsert("via-client");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await names()).toEqual([]);
  });

  test("nested transaction becomes a savepoint: inner rollback, outer commit", async () => {
    await client.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["outer"]);
      await expect(
        client.transaction(async (inner) => {
          await inner.run("INSERT INTO items (name) VALUES (?)", ["inner"]);
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");
    });
    expect(await names()).toEqual(["outer"]);
  });

  test("concurrent top-level write waits for the open transaction", async () => {
    const order: string[] = [];
    const txPromise = client.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["in-tx"]);
      // Yield a few times so the concurrent write would interleave if it could.
      await Promise.resolve();
      await Promise.resolve();
      order.push("tx-end");
      throw new Error("rollback");
    });
    const concurrent = client
      .run("INSERT INTO items (name) VALUES (?)", ["outside"])
      .then(() => order.push("outside-done"));

    await expect(txPromise).rejects.toThrow("rollback");
    await concurrent;

    // The outside write must not have been swallowed by the rollback.
    expect(order).toEqual(["tx-end", "outside-done"]);
    expect(await names()).toEqual(["outside"]);
  });

  test("tx executor throws once the transaction closed", async () => {
    let leaked: { run: (sql: string, params?: unknown[]) => Promise<unknown> } | null = null;
    await client.transaction(async (tx) => {
      leaked = tx;
    });
    expect(leaked).not.toBeNull();
    await expect(
      (leaked as NonNullable<typeof leaked>).run("INSERT INTO items (name) VALUES (?)", ["late"]),
    ).rejects.toThrow("after the transaction closed");
  });

  test("post-commit continuation with stale context falls back to top level", async () => {
    // Simulates emitTaskLifecycleTelemetryAfterCommit-style queueMicrotask
    // work that inherits the ALS context but runs after COMMIT.
    let followUp: Promise<string[]> = Promise.resolve([]);
    await client.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["committed"]);
      followUp = new Promise((resolve) => {
        queueMicrotask(() => resolve(names()));
      });
    });
    expect(await followUp).toEqual(["committed"]);
  });
});
