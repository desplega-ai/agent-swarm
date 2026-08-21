import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunSqliteClient, type DbClient, type DbExecutor } from "../be/db-client";

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
    let leaked: DbExecutor | null = null;
    await client.transaction(async (tx) => {
      leaked = tx;
    });
    expect<DbExecutor | null>(leaked).not.toBeNull();
    const closedTx = leaked as DbExecutor | null;
    await expect(closedTx!.run("INSERT INTO items (name) VALUES (?)", ["late"])).rejects.toThrow(
      "after the transaction closed",
    );
  });

  test("afterCommit hook scheduled inside a transaction observes committed state", async () => {
    let observed: string[] | null = null;
    let hookDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      hookDone = resolve;
    });
    await client.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["committed"]);
      client.afterCommit(() => {
        void names().then((n) => {
          observed = n;
          hookDone?.();
        });
      });
      // The hook must NOT have run yet, even across microtask turns.
      await Promise.resolve();
      await Promise.resolve();
      expect(observed).toBeNull();
    });
    await done;
    expect<string[] | null>(observed).toEqual(["committed"]);
  });

  test("afterCommit hook registered in a rolled-back transaction never fires", async () => {
    let fired = false;
    await expect(
      client.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["doomed"]);
        client.afterCommit(() => {
          fired = true;
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Fence: a post-rollback hook scheduled with no open transaction runs
    // strictly after anything the rolled-back transaction could have queued.
    await new Promise<void>((resolve) => {
      client.afterCommit(resolve);
    });
    expect(fired).toBe(false);
    expect(await names()).toEqual([]);
  });

  test("a throwing getDatabase does not wedge the lock", async () => {
    let boom = true;
    const flaky = createBunSqliteClient(() => {
      if (boom) throw new Error("db unavailable");
      return raw;
    });
    await expect(flaky.transaction(async (tx) => tx.run("SELECT 1"))).rejects.toThrow(
      "db unavailable",
    );
    boom = false;
    const result = await flaky.run("INSERT INTO items (name) VALUES (?)", ["recovered"]);
    expect(result.changes).toBe(1);
  });

  test("afterCommit with no open transaction runs promptly", async () => {
    let ran = false;
    const done = new Promise<void>((resolve) => {
      client.afterCommit(() => {
        ran = true;
        resolve();
      });
    });
    await done;
    expect(ran).toBe(true);
  });

  test("concurrency soak: interleaved transactions and top-level ops, no deadlock, no interleaving", async () => {
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      work.push(
        client
          .transaction(async (tx) => {
            await tx.run("INSERT INTO items (name) VALUES (?)", [`tx-${i}-a`]);
            await Promise.resolve();
            await tx.run("INSERT INTO items (name) VALUES (?)", [`tx-${i}-b`]);
            if (i % 5 === 0) throw new Error(`abort-${i}`);
            return i;
          })
          .catch((e: Error) => e.message),
      );
      for (let j = 0; j < 4; j++) {
        work.push(client.run("INSERT INTO items (name) VALUES (?)", [`top-${i}-${j}`]));
      }
    }
    await Promise.all(work);
    const all = await names();
    // Aborted transactions (i % 5 === 0) contribute nothing; committed ones
    // contribute both rows, adjacent (no top-level write between a & b).
    const txRows = all.filter((n) => n.startsWith("tx-"));
    expect(txRows.length).toBe(40 * 2);
    for (const n of txRows) expect(n.endsWith("-a") || n.endsWith("-b")).toBe(true);
    for (let k = 0; k < all.length; k++) {
      if (all[k]!.startsWith("tx-") && all[k]!.endsWith("-a")) {
        expect(all[k + 1]).toBe(all[k]!.replace(/-a$/, "-b"));
      }
    }
    expect(all.filter((n) => n.startsWith("top-")).length).toBe(200);
  });

  test("afterCommit hook that throws does not break later hooks", async () => {
    const ran: string[] = [];
    const done = new Promise<void>((resolve) => {
      client.afterCommit(() => {
        ran.push("thrower");
        throw new Error("hook blew up");
      });
      client.afterCommit(() => {
        ran.push("survivor");
        resolve();
      });
    });
    await done;
    expect(ran).toEqual(["thrower", "survivor"]);
    // The client stays fully usable afterwards (no wedged lock, no unhandled
    // rejection surfacing as a failed op).
    const result = await client.run("INSERT INTO items (name) VALUES (?)", ["after-hooks"]);
    expect(result.changes).toBe(1);
  });

  test("async afterCommit hook rejection is contained, not an unhandled rejection", async () => {
    // Codex PR #1204 review, thread 3826157060: a rejecting async hook (e.g.
    // a post-commit telemetry read against a closing DB) must not crash the
    // process. Pre-fix, the scheduler discarded the hook's promise and the
    // rejection went unhandled.
    const ran: string[] = [];
    const done = new Promise<void>((resolve) => {
      client.afterCommit(async () => {
        ran.push("rejector");
        await Promise.resolve();
        throw new Error("post-commit read failed");
      });
      client.afterCommit(() => {
        ran.push("survivor");
        resolve();
      });
    });
    await done;
    // Let the rejected hook promise settle through the containment path.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toEqual(["rejector", "survivor"]);
    const result = await client.run("INSERT INTO items (name) VALUES (?)", ["after-async-hook"]);
    expect(result.changes).toBe(1);
  });

  test("async afterCommit hook inside a transaction observes committed state", async () => {
    let seen: string[] | null = null;
    const done = new Promise<void>((resolve) => {
      void client.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["async-hook-commit"]);
        client.afterCommit(async () => {
          seen = (await names()).filter((n) => n === "async-hook-commit");
          resolve();
        });
      });
    });
    await done;
    expect(seen).toEqual(["async-hook-commit"]);
  });

  test("sequential nested transactions under one outer commit independently", async () => {
    // Regression guard for monotonic savepoint naming: distinct sequential
    // savepoints must still release cleanly and roll back independently.
    await client.transaction(async (tx) => {
      await tx.run("INSERT INTO items (name) VALUES (?)", ["outer"]);
      await client.transaction(async (inner) => {
        await inner.run("INSERT INTO items (name) VALUES (?)", ["nested-1"]);
      });
      await expect(
        client.transaction(async (inner) => {
          await inner.run("INSERT INTO items (name) VALUES (?)", ["nested-doomed"]);
          throw new Error("inner boom");
        }),
      ).rejects.toThrow("inner boom");
      await client.transaction(async (inner) => {
        await inner.run("INSERT INTO items (name) VALUES (?)", ["nested-2"]);
      });
    });
    expect(await names()).toEqual(["outer", "nested-1", "nested-2"]);
  });

  test("out-of-LIFO concurrent sibling savepoints fail loudly, not silently", async () => {
    // SQLite savepoints are a stack: when the first-created sibling releases
    // first it implicitly destroys the second. Monotonic names turn that into
    // a loud "no such savepoint" error instead of silently discarding the
    // sibling's writes; the outer transaction then rolls back whole.
    await expect(
      client.transaction(async () => {
        await Promise.all([
          client.transaction(async (tx) => {
            await tx.run("INSERT INTO items (name) VALUES (?)", ["sib-a"]);
            await Promise.resolve(); // release AFTER sib-b's savepoint opens
          }),
          client.transaction(async (tx) => {
            await tx.run("INSERT INTO items (name) VALUES (?)", ["sib-b"]);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve(); // release after sib-a already released
          }),
        ]);
      }),
    ).rejects.toThrow();
    expect(await names()).toEqual([]);
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

describe("db-client transactions on a shared WAL file (second connection)", () => {
  // Mirrors the CI flake behind issue #1228: a test shares one DB file with a
  // spawned `src/http.ts`, and a read-then-write transaction in one process
  // raced a commit in the other. A deferred BEGIN fails that lock upgrade
  // with SQLITE_BUSY_SNAPSHOT ("database is locked"), which busy_timeout
  // never retries. BEGIN IMMEDIATE takes the write lock up front, so the
  // other connection cannot commit inside the window at all.
  let dir: string;
  let fileDb: Database;
  let other: Database;
  let fileClient: DbClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "db-client-wal-"));
    const path = join(dir, "shared.sqlite");
    fileDb = new Database(path);
    fileDb.run("PRAGMA journal_mode = WAL;");
    fileDb.run("PRAGMA busy_timeout = 5000;");
    fileDb.run("CREATE TABLE counters (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    fileDb.run("INSERT INTO counters (id, n) VALUES (1, 0)");
    other = new Database(path);
    // Fail fast instead of blocking the (single) test thread for 5 s.
    other.run("PRAGMA busy_timeout = 0;");
    fileClient = createBunSqliteClient(() => fileDb);
  });

  afterEach(() => {
    other.close();
    fileDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a read-then-write transaction holds the write lock from BEGIN, so no SQLITE_BUSY_SNAPSHOT", async () => {
    await fileClient.transaction(async (tx) => {
      const row = await tx.get<{ n: number }>("SELECT n FROM counters WHERE id = 1");
      expect(row?.n).toBe(0);
      // With a deferred BEGIN this write would succeed (WAL readers do not
      // block writers) and the tx.run below would then throw "database is
      // locked". With BEGIN IMMEDIATE the lock is already ours.
      expect(() => other.run("UPDATE counters SET n = 100 WHERE id = 1")).toThrow(
        /database is locked|SQLITE_BUSY/,
      );
      await tx.run("UPDATE counters SET n = ? WHERE id = 1", [(row?.n ?? 0) + 1]);
    });
    const after = other.query<{ n: number }, []>("SELECT n FROM counters WHERE id = 1").get();
    expect(after?.n).toBe(1);
  });

  test("after COMMIT the other connection writes again", async () => {
    await fileClient.transaction(async (tx) => {
      await tx.run("UPDATE counters SET n = n + 1 WHERE id = 1");
    });
    other.run("UPDATE counters SET n = n + 10 WHERE id = 1");
    const row = await fileClient.get<{ n: number }>("SELECT n FROM counters WHERE id = 1");
    expect(row?.n).toBe(11);
  });
});
