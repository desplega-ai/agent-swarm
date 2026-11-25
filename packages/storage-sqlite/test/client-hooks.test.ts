import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createBunSqliteClient } from "../src";

// `onCommit` on the SQLite client: synchronous after COMMIT, before
// `transaction()` resolves, with the savepoint and rollback rules of `afterCommit`.
test("onCommit runs before transaction() resolves; savepoint and outer rollbacks drop it", async () => {
  const db = new Database(":memory:");
  const client = createBunSqliteClient(() => db);
  const seen: string[] = [];
  await client.transaction(async () => {
    client.onCommit(() => seen.push("outer"));
    await client.transaction(async () => {
      client.onCommit(() => seen.push("released savepoint"));
    });
    await expect(
      client.transaction(async () => {
        client.onCommit(() => seen.push("rolled-back savepoint"));
        throw new Error("inner");
      }),
    ).rejects.toThrow("inner");
    expect(seen).toEqual([]);
  });
  expect(seen).toEqual(["outer", "released savepoint"]);
  await expect(
    client.transaction(async () => {
      client.onCommit(() => seen.push("rolled-back outer"));
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  client.onCommit(() => seen.push("no transaction"));
  expect(seen).toEqual(["outer", "released savepoint", "no transaction"]);
  db.close();
});
