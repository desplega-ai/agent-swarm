import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkerSqliteDriver } from "../be/db/worker-driver";
import {
  type BusyRetryOptions,
  createBunSqliteClient,
  createDbClient,
  createSyncSqliteDriver,
  type DbClient,
  type DbExecutor,
} from "../be/db-client";
import { withLoopPath } from "../be/event-loop-lag";
import { clearVolatileSecretsForTesting, registerVolatileSecret } from "../utils/secret-scrubber";

// Preserve synchronous spies. Worker observations inspect the actual transport options.
describe.each(["sqlite", "worker"] as const)("driver %s", (driverName) => {
  const ownedClients: DbClient[] = [];
  const attempts: { spinMs: number; busy: boolean }[] = [];
  const createTestClient = (getDatabase: () => Database, retry?: BusyRetryOptions): DbClient => {
    if (driverName === "sqlite") return createBunSqliteClient(getDatabase, retry);
    const database = getDatabase();
    const driver = createWorkerSqliteDriver({
      filename: database.filename,
      customSQLite:
        process.platform === "darwin"
          ? [
              "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
              "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
            ].find(existsSync)
          : undefined,
      pragmas: [
        "PRAGMA journal_mode=WAL",
        `PRAGMA busy_timeout=${(database.query("PRAGMA busy_timeout").get() as { timeout: number }).timeout}`,
        "PRAGMA foreign_keys=ON",
        "PRAGMA synchronous=NORMAL",
      ],
    });
    const run = driver.run.bind(driver);
    driver.run = async (sql, params, options) => {
      try {
        const value = await run(sql, params, options);
        if (sql.startsWith("INSERT INTO items"))
          attempts.push({ spinMs: options?.spinMs ?? -1, busy: false });
        return value;
      } catch (error) {
        if (sql.startsWith("INSERT INTO items"))
          attempts.push({
            spinMs: options?.spinMs ?? -1,
            busy: (error as { code?: string }).code === "SQLITE_BUSY",
          });
        throw error;
      }
    };
    const client = createDbClient(driver, retry);
    ownedClients.push(client);
    return client;
  };
  afterEach(async () => {
    for (const client of ownedClients.splice(0)) await client.close();
    attempts.length = 0;
  });

  let raw: Database;
  let client: DbClient;
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "db-worker-seam-"));
    raw = new Database(join(baseDir, "db.sqlite"));
    raw.exec("PRAGMA journal_mode=WAL");
    raw.run("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    client = createTestClient(() => raw);
  });

  afterEach(async () => {
    await client.close();
    raw.close();
    rmSync(baseDir, { recursive: true, force: true });
  });

  const names = async (): Promise<string[]> =>
    (await client.query<{ name: string }>("SELECT name FROM items ORDER BY id")).map((r) => r.name);

  describe("db-client basics", () => {
    test("bound calls report failed execution time with the correct driver", async () => {
      raw.exec(`CREATE TRIGGER slow_failure BEFORE INSERT ON items BEGIN
        SELECT (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT sum(x) FROM c);
        SELECT RAISE(ABORT, 'synthetic slow failure');
      END`);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const method of ["query", "get", "run"] as const) {
          warn.mockClear();
          await client.transaction(async (tx) => {
            const [outcome] = await Promise.allSettled([
              tx[method]("INSERT INTO items(name) VALUES (?)", ["private-param"]),
            ]);
            expect(outcome?.status).toBe("rejected");
            if (outcome?.status === "rejected")
              expect(outcome.reason.message).toBe("synthetic slow failure");
          });
          const lines = warn.mock.calls.map((args) => String(args[0]));
          const warning = lines.filter((line) => line.includes("[db-client] slow"));
          expect(warning).toHaveLength(1);
          expect(warning[0]).toContain(
            driverName === "sqlite" ? "slow sync statement" : "slow worker statement",
          );
          expect(warning[0]).not.toContain("private-param");
          if (driverName === "worker") expect(warning[0]).not.toContain("blocked the event loop");
        }
        expect(await names()).toEqual([]);
      } finally {
        warn.mockRestore();
      }
    });
    test("null or undefined thrown during COMMIT cannot bypass rollback hooks", async () => {
      for (const error of [null, undefined]) {
        const driver = createSyncSqliteDriver(() => raw);
        const exec = driver.exec.bind(driver);
        driver.exec = (sql, options) => {
          if (sql === "COMMIT") throw error;
          return exec(sql, options);
        };
        const failingClient = createDbClient(driver);
        let rolledBack = false;
        const result = await Promise.allSettled([
          failingClient.transaction(async (tx) => {
            failingClient.afterRollback(() => {
              rolledBack = true;
            });
            await tx.run("INSERT INTO items(name) VALUES ('gone')");
          }),
        ]);
        expect(result[0]?.status).toBe("rejected");
        expect((result[0] as PromiseRejectedResult).reason).toBe(error);
        expect(rolledBack).toBe(true);
        expect(raw.query("SELECT name FROM items").all()).toEqual([]);
        await failingClient.close();
      }
    });
    test("caught transport loss and failed savepoint recovery cannot authorize commit", async () => {
      for (const failure of ["transport", "rollback"] as const) {
        const driver = createSyncSqliteDriver(() => raw);
        const run = driver.run.bind(driver);
        const exec = driver.exec.bind(driver);
        driver.run = (sql, params, options) => {
          if (sql === "synthetic transport loss") {
            const error = new Error("synthetic transport loss");
            error.name = "DbWorkerTransportError";
            throw error;
          }
          return run(sql, params, options);
        };
        driver.exec = (sql, options) => {
          if (failure === "rollback" && sql.startsWith("ROLLBACK TO SAVEPOINT"))
            throw new Error("synthetic rollback failure");
          return exec(sql, options);
        };
        const failingClient = createDbClient(driver);
        let committed = false;
        const result = await Promise.allSettled([
          failingClient.transaction(async (tx) => {
            failingClient.afterCommit(() => {
              committed = true;
            });
            await tx.run("INSERT INTO items(name) VALUES ('gone')");
            if (failure === "transport") await tx.run("synthetic transport loss").catch(() => {});
            else
              await failingClient
                .transaction(async () => {
                  throw new Error("callback failure");
                })
                .catch(() => {});
          }),
        ]);
        expect(result[0]?.status).toBe("rejected");
        expect(committed).toBe(false);
        expect(await names()).toEqual([]);
        await failingClient.close();
      }
    });

    test("caught outer and nested statement failures preserve native commit semantics", async () => {
      await client.transaction(async (tx) => {
        await tx.run("INSERT INTO items(name) VALUES ('outer')");
        await client
          .transaction(async () => {
            // The outer executor still routes to the same connection inside the savepoint.
            await tx.run("INSERT INTO missing_outer VALUES (1)").catch(() => {});
            await client.run("INSERT INTO missing_inner VALUES (1)");
          })
          .catch(() => {});
      });
      expect(await names()).toEqual(["outer"]);
    });

    test("another client's hook cannot inherit a closed savepoint scope", async () => {
      const peerDb = new Database(join(baseDir, "peer.sqlite"));
      peerDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE items (name TEXT)");
      const peer = createTestClient(() => peerDb);
      const started = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<unknown>();
      try {
        await client.transaction(async () => {
          await client.transaction(async () => {
            peer.afterCommit(async () => {
              started.resolve();
              try {
                await gate.promise;
                await peer.transaction(async (tx) => {
                  await tx.run("INSERT INTO items VALUES ('bound')");
                  await peer.run("INSERT INTO items VALUES ('ambient')");
                });
                completed.resolve(undefined);
              } catch (error) {
                completed.resolve(error);
              }
            });
            await started.promise;
          });
        });
        gate.resolve();
        expect(await completed.promise).toBeUndefined();
        expect(await peer.query("SELECT name FROM items ORDER BY rowid")).toEqual([
          { name: "bound" },
          { name: "ambient" },
        ]);
      } finally {
        gate.resolve();
        await peer.close();
        peerDb.close();
      }
    });

    test("detached hook continuations lose shutdown admission when their hook settles", async () => {
      let releaseHook!: () => void;
      const holdHook = new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      let releaseDetached!: () => void;
      const holdDetached = new Promise<void>((resolve) => {
        releaseDetached = resolve;
      });
      let detached!: Promise<unknown>;
      let started!: () => void;
      const hookStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      client.afterCommit(() => {
        detached = holdDetached.then(() =>
          client.run("INSERT INTO items(name) VALUES ('escaped')"),
        );
        started();
      });
      client.afterCommit(() => holdHook);
      await hookStarted;
      const closing = client.close();
      // The first hook has settled. The second hook keeps shutdown open.
      await Bun.sleep(0);
      releaseDetached();
      const result = await Promise.allSettled([detached]);
      releaseHook();
      await closing;
      expect((result[0] as PromiseRejectedResult).reason.message).toContain("client is closed");
      expect(raw.query("SELECT name FROM items").all()).toEqual([]);
    });
    test("run + query + get round-trip", async () => {
      const insert = await client.run("INSERT INTO items (name) VALUES (?)", ["a"]);
      expect(insert.changes).toBe(1);
      await client.run("INSERT INTO items (name) VALUES (?)", ["b"]);

      expect(await names()).toEqual(["a", "b"]);
      const row = await client.get<{ name: string }>("SELECT name FROM items WHERE name = ?", [
        "b",
      ]);
      expect(row?.name).toBe("b");
      expect(await client.get("SELECT name FROM items WHERE name = ?", ["missing"])).toBeNull();
    });

    test("runTimed charges the statement for driver execution, not for queueing behind the lock", async () => {
      // A transaction holds the FIFO lock across an await, so the runTimed below
      // cannot begin executing until it commits. Wall time around the call
      // therefore includes that queueing — which is what made a caller-side
      // measurement report a responsive process as stalled for multiple seconds.
      const holding = client.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["holder"]);
        await Bun.sleep(250);
      });
      const startedAt = performance.now();
      const timed = await client.runTimed("INSERT INTO items (name) VALUES (?)", ["queued"]);
      const wallMs = performance.now() - startedAt;
      await holding;

      expect(timed.changes).toBe(1);
      // It really did wait out the holder...
      expect(wallMs).toBeGreaterThan(200);
      // ...but only the driver call itself is charged to the statement. One
      // in-memory INSERT is microseconds; the bound is loose on purpose.
      expect(timed.executionMs).toBeGreaterThan(0);
      expect(timed.executionMs).toBeLessThan(50);
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
        (
          await settled(
            client.transaction(async (tx) => {
              await tx.run("INSERT INTO items (name) VALUES (?)", ["doomed"]);
              throw new Error("boom");
            }),
          )
        )[0],
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
        (
          await settled(
            client.transaction(async () => {
              await helperInsert("via-client");
              throw new Error("rollback");
            }),
          )
        )[0],
      ).rejects.toThrow("rollback");
      expect(await names()).toEqual([]);
    });

    test("nested transaction becomes a savepoint: inner rollback, outer commit", async () => {
      await client.transaction(async (tx) => {
        await tx.run("INSERT INTO items (name) VALUES (?)", ["outer"]);
        await expect(
          (
            await settled(
              client.transaction(async (inner) => {
                await inner.run("INSERT INTO items (name) VALUES (?)", ["inner"]);
                throw new Error("inner boom");
              }),
            )
          )[0],
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

      await expect((await settled(txPromise))[0]).rejects.toThrow("rollback");
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
      await expect(
        (await settled(closedTx!.run("INSERT INTO items (name) VALUES (?)", ["late"])))[0],
      ).rejects.toThrow("after the transaction closed");
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
        (
          await settled(
            client.transaction(async (tx) => {
              await tx.run("INSERT INTO items (name) VALUES (?)", ["doomed"]);
              client.afterCommit(() => {
                fired = true;
              });
              throw new Error("boom");
            }),
          )
        )[0],
      ).rejects.toThrow("boom");
      // Fence: a post-rollback hook scheduled with no open transaction runs
      // strictly after anything the rolled-back transaction could have queued.
      await new Promise<void>((resolve) => {
        client.afterCommit(resolve);
      });
      expect(fired).toBe(false);
      expect(await names()).toEqual([]);
    });

    test("afterRollback runs when the outer transaction rolls back, not when it commits", async () => {
      const fired: string[] = [];
      await client.transaction(async () => {
        await client.transaction(async (tx) => {
          await tx.run("INSERT INTO items (name) VALUES (?)", ["kept"]);
          client.afterRollback(() => fired.push("committed"));
        });
      });
      await expect(
        (
          await settled(
            client.transaction(async () => {
              await client.transaction(async (tx) => {
                await tx.run("INSERT INTO items (name) VALUES (?)", ["doomed"]);
                client.afterRollback(() => fired.push("rolled back"));
              });
              throw new Error("boom");
            }),
          )
        )[0],
      ).rejects.toThrow("boom");
      client.afterRollback(() => fired.push("no transaction"));
      expect(fired).toEqual(["rolled back"]);
      expect(await names()).toEqual(["kept"]);
    });

    test("a throwing getDatabase does not wedge the lock", async () => {
      let boom = true;
      const flaky = createBunSqliteClient(() => {
        if (boom) throw new Error("db unavailable");
        return raw;
      });
      await expect(
        (await settled(flaky.transaction(async (tx) => tx.run("SELECT 1"))))[0],
      ).rejects.toThrow("db unavailable");
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
          (
            await settled(
              client.transaction(async (inner) => {
                await inner.run("INSERT INTO items (name) VALUES (?)", ["nested-doomed"]);
                throw new Error("inner boom");
              }),
            )
          )[0],
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
        (
          await settled(
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
          )
        )[0],
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
      fileClient = createTestClient(() => fileDb);
    });

    afterEach(async () => {
      await fileClient.close();
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

  describe("db-client event-loop time slicing", () => {
    // ~5 ms of pure CPU per driver call. 24 chains x 6 statements queue behind
    // the FIFO lock, whose hand-off is a microtask, so without slicing the whole
    // burst (~700 ms) runs as one macrotask and starves every timer and socket.
    const CPU_SQL =
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c";
    const ROWS = 30_000;

    /** Longest gap between two 1 ms timer ticks while `work` runs. */
    async function maxTimerGapDuring(work: () => Promise<unknown>): Promise<number> {
      let last = performance.now();
      let maxGap = 0;
      let running = true;
      const ticker = (async () => {
        while (running) {
          await new Promise((r) => setTimeout(r, 1));
          const now = performance.now();
          maxGap = Math.max(maxGap, now - last);
          last = now;
        }
      })();
      await work();
      running = false;
      await ticker;
      return maxGap;
    }

    const burst = () =>
      Promise.all(
        Array.from({ length: 24 }, async () => {
          for (let i = 0; i < 6; i++) await client.get(CPU_SQL, [ROWS]);
        }),
      );

    test("a burst of queued statements lets timers run between statements", async () => {
      const startedAt = performance.now();
      const gap = await maxTimerGapDuring(burst);
      const totalMs = performance.now() - startedAt;
      // Premise: the burst is long enough that an unsliced run would blow the bound.
      expect(totalMs).toBeGreaterThan(300);
      expect(gap).toBeLessThan(totalMs / 4);
    });

    test("a transaction callback with many statements lets timers run too", async () => {
      const gap = await maxTimerGapDuring(() =>
        client.transaction(async (tx) => {
          for (let i = 0; i < 100; i++) await tx.get(CPU_SQL, [ROWS]);
        }),
      );
      expect(gap).toBeLessThan(150);
    });
  });

  describe("db-client time slicing keeps transaction boundaries", () => {
    const burn = (ms: number) => {
      const end = performance.now() + ms;
      while (performance.now() < end) {
        // spin: exhausts the 25 ms slice
      }
    };
    const settle = () => new Promise((r) => setTimeout(r, 30));
    const insert = (e: DbExecutor | DbClient, name: string) =>
      e.run("INSERT INTO items (name) VALUES (?)", [name]);

    test("ambient sibling of a failing statement cannot escape a rolled-back transaction", async () => {
      await expect(
        (
          await settled(
            client.transaction(async () => {
              await insert(client, "inside");
              burn(35);
              await Promise.all([
                client.run("INSERT INTO missing VALUES (1)"),
                insert(client, "escaped"),
              ]);
            }),
          )
        )[0],
      ).rejects.toThrow();
      await settle();
      expect(await names()).toEqual([]);
    });

    test("tx-executor sibling of a failing statement cannot escape a rolled-back transaction", async () => {
      await expect(
        (
          await settled(
            client.transaction(async (tx) => {
              await insert(tx, "inside");
              burn(35);
              await Promise.all([tx.run("INSERT INTO missing VALUES (1)"), insert(tx, "escaped")]);
            }),
          )
        )[0],
      ).rejects.toThrow();
      await settle();
      expect(await names()).toEqual([]);
    });

    test("sibling inside a rolled-back savepoint cannot escape it", async () => {
      await client.transaction(async () => {
        await insert(client, "kept");
        await expect(
          (
            await settled(
              client.transaction(async () => {
                await insert(client, "inner");
                burn(35);
                await Promise.all([
                  client.run("INSERT INTO missing VALUES (1)"),
                  insert(client, "escaped"),
                ]);
              }),
            )
          )[0],
        ).rejects.toThrow();
        await settle();
      });
      expect(await names()).toEqual(["kept"]);
    });

    test("an unawaited statement still belongs to its transaction after the slice is spent", async () => {
      await client.transaction(async () => {
        await insert(client, "inside");
        burn(35);
        void insert(client, "late"); // runs at call time, as before slicing
      });
      expect(await names()).toEqual(["inside", "late"]);
      await expect(
        (
          await settled(
            client.transaction(async () => {
              await insert(client, "gone");
              burn(35);
              void insert(client, "gone-late");
              throw new Error("boom");
            }),
          )
        )[0],
      ).rejects.toThrow("boom");
      await settle();
      expect(await names()).toEqual(["inside", "late"]);

      // A continuation can reserve another operation while the original tail drains.
      for (const nested of [false, true]) {
        let pending: Promise<unknown> | undefined;
        const callback = async (tx: DbExecutor) => {
          pending = insert(tx, "chained").then(() => tx.run("INSERT INTO missing VALUES (1)"));
          await pending;
        };
        const attempt = nested
          ? client.transaction(async () => {
              await expect((await settled(client.transaction(callback)))[0]).rejects.toThrow(
                "no such table",
              );
            })
          : client.transaction(callback);
        const outcome = await settled(attempt);
        if (nested) await outcome[0];
        else await expect(outcome[0]).rejects.toThrow("no such table");
        await pending?.catch(() => {});
        expect(await names()).toEqual(["inside", "late"]);
      }
    });

    test("concurrent ambient statements after a rollback all land, none leak from the rollback", async () => {
      await expect(
        (
          await settled(
            client.transaction(async () => {
              await insert(client, "rolled-back");
              burn(35);
              await Promise.all([
                client.run("INSERT INTO missing VALUES (1)"),
                insert(client, "escaped"),
              ]);
            }),
          )
        )[0],
      ).rejects.toThrow();
      burn(35);
      await Promise.all(["a", "b", "c"].map((n) => insert(client, n)));
      await settle();
      expect((await names()).sort()).toEqual(["a", "b", "c"]);
    });
  });

  describe("db-client slow statement warning", () => {
    beforeEach(async () => {
      await client.close();
      client = createBunSqliteClient(() => raw);
    });
    // A recursive CTE is pure CPU inside one driver call, so it blocks the
    // event loop the same way a slow production query does.
    const SLOW_SQL = `/* ${"padding ".repeat(40)} */ WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c WHERE ? IS NOT NULL`;
    const SLOW_ROWS = 3_000_000;
    const PARAM_SECRET = "param-value-that-must-not-be-logged";

    const slowWarnings = (spy: ReturnType<typeof spyOn>): string[] =>
      spy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.includes("[db-client] slow sync statement"));

    test("logs a statement that blocked the loop past 100ms, with truncated SQL and no params", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const startedAt = performance.now();
        const row = await client.get<{ n: number }>(SLOW_SQL, [SLOW_ROWS, PARAM_SECRET]);
        const elapsedMs = performance.now() - startedAt;
        expect(row?.n).toBe(SLOW_ROWS);
        // Guard the premise: on a machine fast enough to finish under the
        // threshold, the warning is correctly absent and this test says so.
        expect(elapsedMs).toBeGreaterThan(100);
        const lines = slowWarnings(warn);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/blocked the event loop for \d+ms path=unknown: \/\* padding/);
        expect(lines[0]).not.toContain(PARAM_SECRET);
        expect(lines[0]).not.toContain("WITH RECURSIVE");
        expect(lines[0]?.endsWith("…")).toBe(true);
      } finally {
        warn.mockRestore();
      }
    });

    test("scrubs a secret that straddles the SQL cutoff and a secret in the path", async () => {
      const secret = "slowsqlSECRET0123456789abcdef"; // gitleaks:allow (synthetic test fixture)
      registerVolatileSecret(secret, "SLOW_SQL_TEST_SECRET");
      // "/* " plus 186 chars puts the secret at char 189, across the 200-char cut.
      const sql = `/* ${"p".repeat(185)} ${secret} */ WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c WHERE ? IS NOT NULL`;
      expect(sql.indexOf(secret)).toBeLessThan(200);
      expect(sql.indexOf(secret) + secret.length).toBeGreaterThan(200);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const startedAt = performance.now();
        await withLoopPath(`route ${secret}`, () => client.get(sql, [SLOW_ROWS, PARAM_SECRET]));
        expect(performance.now() - startedAt).toBeGreaterThan(100);
        const lines = slowWarnings(warn);
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain(secret.slice(0, 10));
        expect(lines[0]).toContain("path=route [REDACTED:SLOW_SQL_TEST_SECRET]");
        expect(lines[0]).toContain("[REDACTED:SLOW_SQL_TEST_SECRET]");
      } finally {
        warn.mockRestore();
        clearVolatileSecretsForTesting();
      }
    });

    test("logs a slow statement run inside a transaction", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await client.transaction(async (tx) => {
          await tx.get(SLOW_SQL, [SLOW_ROWS, PARAM_SECRET]);
        });
        const lines = slowWarnings(warn);
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain(PARAM_SECRET);
      } finally {
        warn.mockRestore();
      }
    });

    test("does not count a slow database open against the first statement", async () => {
      // The first call opens the database (and applies migrations) through the
      // client's getter. That cost is boot work, not the statement's.
      let opened = false;
      const lazy = createBunSqliteClient(() => {
        if (!opened) {
          opened = true;
          Bun.sleepSync(150);
        }
        return raw;
      });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await lazy.query("SELECT name FROM items");
        expect(opened).toBe(true);
        expect(slowWarnings(warn)).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });

    test("does not log fast statements", async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await client.run("INSERT INTO items (name) VALUES (?)", ["fast"]);
        await client.query("SELECT name FROM items");
        expect(slowWarnings(warn)).toHaveLength(0);
      } finally {
        warn.mockRestore();
      }
    });
  });
});

// Bun 1.4.4 nested rejection matchers do not dispatch Worker messages.
// Settle transport work first, then retain the original rejection assertion.
async function settled<T>(promise: Promise<T>): Promise<[Promise<T>]> {
  try {
    return [Promise.resolve(await promise)];
  } catch (error) {
    const rejected = Promise.reject<T>(error);
    void rejected.catch(() => {});
    return [rejected];
  }
}
