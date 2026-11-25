import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isConstraintViolation, type TransactionObservation } from "@desplega/storage";
import { acquireProcessLock, createPostgresClient, type PostgresClient } from "../src";
import { createScratchDatabase, type ScratchDatabase } from "./scratch";

// The driver seam on Postgres: pool, pinned transactions, savepoints, the
// D6 retry and hook rules, the tx-replay mode, and the typed errors.

let scratch: ScratchDatabase;
let client: PostgresClient;

beforeAll(async () => {
  scratch = await createScratchDatabase("client");
  client = createPostgresClient(scratch.url, { max: 4 });
  await client.run(
    `CREATE TABLE t (id text PRIMARY KEY, "camelCol" text NOT NULL, n integer CHECK (n >= 0))`,
  );
  await client.run(`CREATE TABLE c (id text PRIMARY KEY, "tId" text REFERENCES t(id))`);
});

afterAll(async () => {
  await client.close();
  await scratch.drop();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("postgres client", () => {
  test("run counts changed rows; get returns the first row or null", async () => {
    expect(
      (
        await client.run(`INSERT INTO t VALUES ($1, $2, $3), ($4, $5, $6)`, [
          "a",
          "A",
          1,
          "b",
          "B",
          2,
        ])
      ).changes,
    ).toBe(2);
    expect(await client.get(`SELECT "camelCol" FROM t WHERE id = $1`, ["a"])).toEqual({
      camelCol: "A",
    });
    expect(await client.get(`SELECT * FROM t WHERE id = $1`, ["zz"])).toBeNull();
    expect((await client.run(`UPDATE t SET n = n + 1`)).changes).toBe(2);
  });

  test("a transaction pins one connection; client calls inside join it", async () => {
    const pids = await client.transaction(async () => {
      const a = await client.get<{ p: number }>(`SELECT pg_backend_pid() AS p`);
      await Promise.all([client.query(`SELECT 1`), client.query(`SELECT 2`)]);
      const b = await client.get<{ p: number }>(`SELECT pg_backend_pid() AS p`);
      return [a?.p, b?.p];
    });
    expect(pids[0]).toBe(pids[1]);
  });

  test("isolation: SERIALIZABLE by default, READ COMMITTED on opt-down (D7)", async () => {
    const level = () =>
      client.transaction(async () =>
        String(
          (await client.get<{ l: string }>(`SELECT current_setting('transaction_isolation') AS l`))
            ?.l,
        ),
      );
    expect(await level()).toBe("serializable");
    expect(
      await client.transaction(
        async () =>
          String(
            (
              await client.get<{ l: string }>(
                `SELECT current_setting('transaction_isolation') AS l`,
              )
            )?.l,
          ),
        { isolation: "read committed" },
      ),
    ).toBe("read committed");
  });

  test("a nested transaction is a savepoint: its failure keeps the outer one usable", async () => {
    await client.transaction(async () => {
      await client.run(`INSERT INTO t VALUES ('s1', 'x', 0)`);
      let caught: unknown;
      try {
        await client.transaction(async () => {
          await client.run(`INSERT INTO t VALUES ('s1', 'dup', 0)`);
        });
      } catch (err) {
        caught = err;
      }
      expect(isConstraintViolation(caught, "unique")).toBe(true);
      await client.run(`INSERT INTO t VALUES ('s2', 'y', 0)`);
    });
    const rows = await client.query<{ id: string }>(
      `SELECT id FROM t WHERE id IN ('s1', 's2') ORDER BY id`,
    );
    expect(rows.map((r) => r.id)).toEqual(["s1", "s2"]);
  });

  test("constraint errors carry the SQLite text and code", async () => {
    const errorOf = async (text: string) => {
      try {
        await client.run(text);
      } catch (err) {
        return err as Error & { code?: string; kind?: string };
      }
      throw new Error("no error");
    };
    const unique = await errorOf(`INSERT INTO t VALUES ('a', 'again', 0)`);
    expect(unique.message).toBe("UNIQUE constraint failed: t.id");
    expect(unique.code).toBe("SQLITE_CONSTRAINT_UNIQUE");
    const fk = await errorOf(`INSERT INTO c VALUES ('c1', 'nope')`);
    expect(fk.message).toBe("FOREIGN KEY constraint failed");
    expect(isConstraintViolation(fk, "foreignKey")).toBe(true);
    const notNull = await errorOf(`INSERT INTO t (id) VALUES ('nn')`);
    expect(notNull.message).toBe("NOT NULL constraint failed: t.camelCol");
    const check = await errorOf(`INSERT INTO t VALUES ('ck', 'x', -1)`);
    expect(isConstraintViolation(check, "check")).toBe(true);
    // A unique index on an expression: SQLite names the index, not the columns.
    await client.run(`CREATE TABLE ux (name text, owner text)`);
    await client.run(`CREATE UNIQUE INDEX ux_name_owner ON ux (name, COALESCE(owner, ''))`);
    await client.run(`INSERT INTO ux VALUES ('n', NULL)`);
    const expression = await errorOf(`INSERT INTO ux VALUES ('n', NULL)`);
    expect(expression.message).toBe("UNIQUE constraint failed: index 'ux_name_owner'");
    expect(expression.code).toBe("SQLITE_CONSTRAINT_UNIQUE");
  });

  test("afterCommit runs after COMMIT; a rolled-back transaction runs only its rollback hooks", async () => {
    const seen: string[] = [];
    await client.transaction(async () => {
      client.afterCommit(() => {
        seen.push("commit");
      });
      client.afterRollback(() => seen.push("rollback"));
      client.onAttemptRollback(() => seen.push("attempt"));
    });
    await tick();
    expect(seen).toEqual(["commit"]);

    seen.length = 0;
    await expect(
      client.transaction(async () => {
        client.afterCommit(() => {
          seen.push("commit");
        });
        client.afterRollback(() => seen.push("rollback"));
        client.onAttemptRollback(() => seen.push("attempt"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await tick();
    expect(seen).toEqual(["attempt", "rollback"]);
  });

  // A pooled read that runs between an UPDATE and its COMMIT sees the old row.
  // A cache keyed on a write epoch must bump it again at COMMIT, before the
  // writer's caller continues: `onCommit` runs then, `afterCommit` a turn later.
  test("onCommit runs after COMMIT and before transaction() resolves; afterCommit stays deferred", async () => {
    await client.run(`INSERT INTO t VALUES ('oc', 'old', 1)`);
    const seen: string[] = [];
    let release!: () => void;
    const wrote = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Started outside the transaction: it reads on the pool.
    const concurrent = (async () => {
      await wrote;
      return client.get<{ camelCol: string }>(`SELECT "camelCol" FROM t WHERE id = 'oc'`);
    })();
    await client.transaction(async () => {
      await client.run(`UPDATE t SET "camelCol" = 'new' WHERE id = 'oc'`);
      client.onCommit(() => seen.push("onCommit"));
      client.afterCommit(() => {
        seen.push("afterCommit");
      });
      await client.transaction(async () => {
        client.onCommit(() => seen.push("released savepoint"));
      });
      await expect(
        client.transaction(async () => {
          client.onCommit(() => seen.push("rolled-back savepoint"));
          throw new Error("inner");
        }),
      ).rejects.toThrow("inner");
      release();
      expect((await concurrent)?.camelCol).toBe("old");
      expect(seen).toEqual([]);
    });
    expect(seen).toEqual(["onCommit", "released savepoint"]);
    await tick();
    expect(seen).toEqual(["onCommit", "released savepoint", "afterCommit"]);

    seen.length = 0;
    await expect(
      client.transaction(async () => {
        client.onCommit(() => seen.push("rolled-back outer"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    client.onCommit(() => seen.push("no transaction"));
    expect(seen).toEqual(["no transaction"]);
  });

  // A fenced autocommit write runs in its own transaction: an observer that
  // registers `onCommit` for it (the API's request memo) sees it run before
  // the write resolves.
  test("a fenced autocommit write runs the onCommit hooks its statement registered before it resolves", async () => {
    const lock = await acquireProcessLock(scratch.url, { waitMs: 0 });
    const seen: string[] = [];
    const fenced: PostgresClient = createPostgresClient(scratch.url, {
      max: 2,
      fence: { ownerPid: lock.pid, ownerBackendStart: lock.backendStart },
      observer: {
        onStatement: (sql) => {
          if (sql.startsWith("UPDATE") && fenced.inTransaction()) {
            fenced.onCommit(() => seen.push("onCommit"));
            fenced.afterCommit(() => {
              seen.push("afterCommit");
            });
          }
        },
      },
    });
    try {
      await fenced.run(`UPDATE t SET "camelCol" = 'fenced' WHERE id = 'oc'`);
      expect(seen).toEqual(["onCommit"]);
      await tick();
      expect(seen).toEqual(["onCommit", "afterCommit"]);
    } finally {
      await fenced.close();
      await lock.release();
    }
  });

  test("a serialization failure retries the whole callback; failed attempts' hooks are discarded", async () => {
    await client.run(`INSERT INTO t VALUES ('ctr', 'x', 0)`);
    const commits: number[] = [];
    const syncCommits: number[] = [];
    let attempts = 0;
    let attemptRollbacks = 0;
    const bump = (label: number) =>
      client.transaction(async () => {
        attempts++;
        client.onAttemptRollback(() => attemptRollbacks++);
        const row = await client.get<{ n: number }>(`SELECT n FROM t WHERE id = 'ctr'`);
        await Bun.sleep(30);
        await client.run(`UPDATE t SET n = $1 WHERE id = 'ctr'`, [(row?.n ?? 0) + 1]);
        client.afterCommit(() => {
          commits.push(label);
        });
        client.onCommit(() => syncCommits.push(label));
      });
    const before = client.retriedAttempts;
    await Promise.all([bump(1), bump(2), bump(3)]);
    await tick();
    expect((await client.get<{ n: number }>(`SELECT n FROM t WHERE id = 'ctr'`))?.n).toBe(3);
    expect(commits.sort()).toEqual([1, 2, 3]);
    expect(syncCommits.sort()).toEqual([1, 2, 3]);
    expect(client.retriedAttempts).toBeGreaterThan(before);
    expect(attempts).toBe(3 + (client.retriedAttempts - before));
    expect(attemptRollbacks).toBe(client.retriedAttempts - before);
  });

  test("a serialization failure the callback swallowed still retries the whole callback", async () => {
    let attempts = 0;
    const value = await client.transaction(async () => {
      attempts += 1;
      await client.run(`INSERT INTO t VALUES ($1, $2, $3)`, [`swallow-${attempts}`, "S", 1]);
      if (attempts === 1) {
        // A caller that logs and continues (the hazard): Postgres has aborted the transaction.
        try {
          await client.run(
            `DO $$ BEGIN RAISE EXCEPTION 'conflict' USING ERRCODE = '40001'; END $$`,
          );
        } catch {
          // swallowed
        }
        try {
          await client.transaction(async () => {
            await client.run(`SELECT 1`);
          });
        } catch {
          // a later statement fails too (25P02); also swallowed
        }
      }
      return attempts;
    });
    expect(value).toBe(2);
    const rows = await client.query<{ id: string }>(
      `SELECT id FROM t WHERE id LIKE 'swallow-%' ORDER BY id`,
    );
    expect(rows.map((row) => row.id)).toEqual(["swallow-2"]);
  });

  test("a serialization failure caught around a savepoint retries the whole callback", async () => {
    let attempts = 0;
    const hooks: number[] = [];
    const value = await client.transaction(async () => {
      attempts += 1;
      const attempt = attempts;
      if (attempt === 1) {
        try {
          await client.transaction(async () => {
            await client.run(
              `DO $$ BEGIN RAISE EXCEPTION 'conflict' USING ERRCODE = '40001'; END $$`,
            );
          });
        } catch {
          // The savepoint rolled back; the outer transaction stays usable.
        }
      }
      await client.run(`INSERT INTO t VALUES ($1, $2, $3)`, [`sp-swallow-${attempt}`, "S", 1]);
      client.afterCommit(() => {
        hooks.push(attempt);
      });
      return attempt;
    });
    await tick();
    expect(value).toBe(2);
    expect(hooks).toEqual([2]);
    const rows = await client.query<{ id: string }>(
      `SELECT id FROM t WHERE id LIKE 'sp-swallow-%' ORDER BY id`,
    );
    expect(rows.map((row) => row.id)).toEqual(["sp-swallow-2"]);
  });

  test("a statement outside a transaction that loses a serialization race runs again", async () => {
    await client.run(`INSERT INTO t VALUES ('solo', 'x', 0)`);
    const before = client.retriedAttempts;
    const updated = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = client.transaction(async () => {
      await client.run(`UPDATE t SET n = n + 1 WHERE id = 'solo'`);
      updated.resolve();
      await release.promise;
    });
    await updated.promise;
    // Its snapshot predates the holder's commit, so it fails with 40001 once the holder commits.
    const solo = client.run(`UPDATE t SET n = n + 10 WHERE id = 'solo'`);
    await tick();
    release.resolve();
    await holder;
    expect((await solo).changes).toBe(1);
    expect((await client.get<{ n: number }>(`SELECT n FROM t WHERE id = 'solo'`))?.n).toBe(11);
    expect(client.retriedAttempts).toBe(before + 1);
  });

  test("the observer sees each transaction's attempts, retried SQLSTATEs and outcome", async () => {
    const seen: TransactionObservation[] = [];
    const observed = createPostgresClient(scratch.url, {
      max: 2,
      retry: { maxAttempts: 2, baseBackoffMs: 1, maxBackoffMs: 1 },
      observer: { onTransaction: (info) => seen.push(info) },
    });
    const conflict = `DO $$ BEGIN RAISE EXCEPTION 'conflict' USING ERRCODE = '40001'; END $$`;
    try {
      let attempts = 0;
      await observed.transaction(async () => {
        attempts += 1;
        if (attempts === 1) await observed.run(conflict);
      });
      await expect(observed.transaction(async () => observed.run(conflict))).rejects.toThrow();
      await expect(
        observed.transaction(async () => {
          throw new Error("not retryable");
        }),
      ).rejects.toThrow("not retryable");
      // A savepoint is part of its outermost transaction: no observation of its own.
      await observed.transaction(async () => observed.transaction(async () => undefined));
      expect(seen).toEqual([
        { attempts: 2, retries: ["40001"], outcome: "commit" },
        { attempts: 2, retries: ["40001"], outcome: "exhausted" },
        { attempts: 1, retries: [], outcome: "rollback" },
        { attempts: 1, retries: [], outcome: "commit" },
      ]);
    } finally {
      await observed.close();
    }
  });

  test("tx-replay runs each outermost callback twice and keeps only the second run", async () => {
    const replay = createPostgresClient(scratch.url, { max: 2, txReplay: true });
    try {
      let runs = 0;
      const seen: string[] = [];
      const value = await replay.transaction(async () => {
        runs++;
        await replay.run(`INSERT INTO t VALUES ($1, 'r', 0)`, [`replay-${runs}`]);
        replay.afterCommit(() => {
          seen.push(`commit-${runs}`);
        });
        replay.onAttemptRollback(() => seen.push("attempt"));
        return runs;
      });
      await tick();
      expect(runs).toBe(2);
      expect(value).toBe(2);
      expect(seen).toEqual(["attempt", "commit-2"]);
      const rows = await replay.query<{ id: string }>(
        `SELECT id FROM t WHERE id LIKE 'replay-%' ORDER BY id`,
      );
      expect(rows.map((r) => r.id)).toEqual(["replay-2"]);
      expect(replay.replayedTransactions).toBe(1);
    } finally {
      await replay.close();
    }
  });

  test("a read-only transaction rejects writes", async () => {
    await expect(
      client.transaction(async () => client.run(`INSERT INTO t VALUES ('ro', 'x', 0)`), {
        readOnly: true,
      }),
    ).rejects.toThrow(/read-only transaction/);
  });
});
