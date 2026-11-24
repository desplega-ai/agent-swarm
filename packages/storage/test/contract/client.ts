import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DbExecutor, Storage } from "../../src";
import type { ContractEngine } from "./env";

const NOW = 1_800_000_000_000;
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/** Transaction semantics of the engine client that call sites rely on. */
export function clientContract(engine: ContractEngine): void {
  describe(`db client transactions [${engine.name}]`, () => {
    let storage: Storage;

    beforeEach(async () => {
      storage = await engine.fresh();
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const markers = async () =>
      (
        await storage.client.query<{ key: string }>(
          "SELECT key FROM kv_entries WHERE namespace = 'contract-tx' ORDER BY key",
        )
      ).map((row) => row.key);
    const mark = (executor: DbExecutor, key: string) =>
      executor.run(
        `INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at) VALUES ('contract-tx', '${key}', '1', 'json', NULL, ${NOW}, ${NOW})`,
      );

    test("a rolled-back savepoint drops its afterCommit hooks; a released one keeps them", async () => {
      const client = storage.client;
      const seen: string[] = [];
      await client.transaction(async () => {
        client.afterCommit(() => {
          seen.push("outer");
        });
        await expect(
          client.transaction(async () => {
            client.afterCommit(() => {
              seen.push("rolled-back");
            });
            throw new Error("inner boom");
          }),
        ).rejects.toThrow("inner boom");
        await client.transaction(async () => {
          await client.transaction(async () => {
            client.afterCommit(() => {
              seen.push("released");
            });
          });
        });
      });
      await tick();
      expect(seen).toEqual(["outer", "released"]);
    });

    test("a transaction handle kept past a rollback rejects writes", async () => {
      let kept: DbExecutor | undefined;
      await expect(
        storage.client.transaction(async (tx) => {
          kept = tx;
          await mark(tx, "inside");
          throw new Error("roll back");
        }),
      ).rejects.toThrow("roll back");
      await expect(mark(kept as DbExecutor, "after")).rejects.toThrow();
      expect(await markers()).toEqual([]);
    });

    test("a transaction handle kept past a commit rejects writes", async () => {
      let kept: DbExecutor | undefined;
      await storage.client.transaction(async (tx) => {
        kept = tx;
        await mark(tx, "inside");
      });
      await expect(mark(kept as DbExecutor, "after")).rejects.toThrow();
      expect(await markers()).toEqual(["inside"]);
    });

    test("a savepoint handle kept past its rollback rejects writes in the open outer transaction", async () => {
      await storage.client.transaction(async (outer) => {
        let kept: DbExecutor | undefined;
        await expect(
          storage.client.transaction(async (inner) => {
            kept = inner;
            throw new Error("roll back the savepoint");
          }),
        ).rejects.toThrow("roll back the savepoint");
        await expect(mark(kept as DbExecutor, "after-savepoint")).rejects.toThrow();
        await mark(outer, "outer");
      });
      expect(await markers()).toEqual(["outer"]);
    });

    test("a savepoint handle kept past its release rejects writes in the open outer transaction", async () => {
      await storage.client.transaction(async () => {
        let kept: DbExecutor | undefined;
        await storage.client.transaction(async (inner) => {
          kept = inner;
          await mark(inner, "inside");
        });
        await expect(mark(kept as DbExecutor, "after-release")).rejects.toThrow();
      });
      expect(await markers()).toEqual(["inside"]);
    });
  });
}
