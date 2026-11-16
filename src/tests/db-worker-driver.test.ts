import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbClient, initDb, whenDbReady } from "../be/db";
import { createWorkerSqliteDriver, DbWorkerTransportError } from "../be/db/worker-driver";
import { createDbClient, type DbClient, DbTransactionDeadlineError } from "../be/db-client";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const roots: string[] = [];
const rawHandles: Database[] = [];
const clients: DbClient[] = [];
const workers: Worker[] = [];
function setup(
  filename?: string,
  vecExtensionPath: string | null = require("sqlite-vec").getLoadablePath(),
  vecExtensionRequired = true,
) {
  const dir = mkdtempSync(join(tmpdir(), "db-worker-transport-"));
  roots.push(dir);
  const path = join(dir, "db.sqlite");
  const raw = new Database(path);
  rawHandles.push(raw);
  raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, value BLOB)");
  const worker = new Worker(new URL("../be/db/db-worker.ts", import.meta.url).href);
  workers.push(worker);
  const driver = createWorkerSqliteDriver(
    {
      filename: filename ?? path,
      customSQLite:
        process.platform === "darwin"
          ? [
              "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
              "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
            ].find(existsSync)
          : undefined,
      vecExtensionPath: vecExtensionPath ?? undefined,
      vecExtensionRequired,
      pragmas: ["PRAGMA journal_mode=WAL", "PRAGMA busy_timeout=37", "PRAGMA synchronous=NORMAL"],
    },
    worker,
  );
  const client = createDbClient(driver);
  clients.push(client);
  return { path, raw, worker, driver, client };
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const worker of workers.splice(0)) worker.terminate();
  for (const raw of rawHandles.splice(0)) raw.close();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("startup failure rejects readiness and all queued calls without fallback", async () => {
  const { driver, client } = setup("/no-such-db-worker-directory/db.sqlite");
  const calls = [client.get("SELECT 1"), client.run("INSERT INTO items VALUES (1, NULL)")];
  const outcomes = await Promise.allSettled([driver.ready, ...calls]);
  expect(
    outcomes.every(
      (result) => result.status === "rejected" && result.reason instanceof DbWorkerTransportError,
    ),
  ).toBe(true);
});

test("startup distinguishes an absent vector extension from a required extension that fails", async () => {
  const absent = setup(undefined, null);
  expect((await absent.driver.ready).sqliteVec).toBe(false);
  expect(await absent.client.get("SELECT 1 AS n")).toEqual({ n: 1 });
  const optional = setup(undefined, "/no-such-db-worker-extension/vec0", false);
  expect((await optional.driver.ready).sqliteVec).toBe(false);
  expect(await optional.client.get("SELECT 1 AS n")).toEqual({ n: 1 });
  const invalid = setup(undefined, "/no-such-db-worker-extension/vec0");
  const outcomes = await Promise.allSettled([invalid.driver.ready, invalid.client.get("SELECT 1")]);
  expect(
    outcomes.every(
      (result) => result.status === "rejected" && result.reason instanceof DbWorkerTransportError,
    ),
  ).toBe(true);
});

test("uncloneable parameters reject only that request", async () => {
  const { client } = setup();
  const result = await Promise.allSettled([
    client.run("INSERT INTO items VALUES (1, ?)", [(() => {}) as never]),
  ]);
  expect((result[0] as PromiseRejectedResult).reason.message).toContain("could not be cloned");
  await client.run("INSERT INTO items VALUES (2, NULL)");
  expect(await client.get("SELECT id FROM items")).toEqual({ id: 2 });
});

test("timeout restoration observes legitimate ambient changes after prior operations", async () => {
  const { driver } = setup();
  await driver.run("INSERT INTO items VALUES (1, NULL)", [], { spinMs: 1 });
  await driver.exec("PRAGMA busy_timeout=83");
  await driver.run("INSERT INTO items VALUES (2, NULL)", [], { spinMs: 1 });
  expect((await driver.get("PRAGMA busy_timeout", [])).value).toEqual({ timeout: 83 });
});

test("a write with a lost statement reply executes once and rejects without replay", async () => {
  const { driver, worker, raw } = setup();
  await driver.ready;
  const receive = worker.onmessage!;
  let replies = 0;
  worker.onmessage = (event) => {
    if ("id" in event.data) {
      replies++;
      worker.terminate();
    } else receive.call(worker, event);
  };
  const result = await Promise.allSettled([driver.run("INSERT INTO items VALUES (1, NULL)", [])]);
  expect((result[0] as PromiseRejectedResult).reason).toBeInstanceOf(DbWorkerTransportError);
  expect(replies).toBe(1);
  expect(raw.query("SELECT id FROM items").all()).toEqual([{ id: 1 }]);
  expect(
    (await Promise.allSettled([driver.run("INSERT INTO items VALUES (2, NULL)", [])]))[0]?.status,
  ).toBe("rejected");
  expect(raw.query("SELECT id FROM items").all()).toEqual([{ id: 1 }]);
});

test("Worker loss during a transaction rolls back uncommitted writes without replay and runs rollback hooks", async () => {
  const { client, driver, worker, raw } = setup();
  await driver.ready;
  const receive = worker.onmessage!;
  const post = worker.postMessage.bind(worker);
  let writeId: number | undefined;
  let writes = 0;
  worker.postMessage = (message) => {
    if (message.sql?.startsWith("INSERT INTO items")) {
      writeId = message.id;
      writes++;
    }
    post(message);
  };
  worker.onmessage = (event) => {
    if (event.data.id === writeId) worker.terminate();
    else receive.call(worker, event);
  };
  let callbacks = 0;
  let rollback = 0;
  let committed = 0;
  const result = await Promise.allSettled([
    client.transaction(async (tx) => {
      callbacks++;
      client.afterRollback(() => {
        rollback++;
      });
      client.afterCommit(() => {
        committed++;
      });
      await tx.run("INSERT INTO items VALUES (1, NULL)");
    }),
  ]);
  expect((result[0] as PromiseRejectedResult).reason).toBeInstanceOf(DbWorkerTransportError);
  expect([callbacks, writes, rollback, committed]).toEqual([1, 1, 1, 0]);
  expect(raw.query("SELECT id FROM items").all()).toEqual([]);
});

test("actual Worker vector capability with the boot handle open, BLOB ownership and bigint match SQLite", async () => {
  const { driver, client, raw } = setup();
  expect((await driver.ready).sqliteVec).toBe(true);
  const blob = new Uint8Array([1, 2, 3, 4]);
  await client.run("INSERT INTO items VALUES (?, ?)", [1n, blob]);
  expect(blob).toEqual(new Uint8Array([1, 2, 3, 4]));
  const row = await client.get("SELECT id, value FROM items");
  expect(row).toEqual(raw.query("SELECT id, value FROM items").get());
  expect(await client.get("SELECT ? AS n", [9007199254740993n])).toEqual(
    raw.query("SELECT ? AS n").get(9007199254740993n),
  );
  await client.run("CREATE VIRTUAL TABLE temp.v USING vec0(embedding float[2])");
  const vector = new Uint8Array(new Float32Array([1, 0]).buffer);
  await client.run("INSERT INTO temp.v(rowid, embedding) VALUES(1, ?)", [vector]);
  expect(
    (
      await client.get<{ rowid: number }>(
        "SELECT rowid FROM temp.v WHERE embedding MATCH ? AND k=1",
        [vector],
      )
    )?.rowid,
  ).toBe(1);
});

test("confirmed BUSY preserves its code, failed timing and ambient timeout", async () => {
  const { driver, raw } = setup();
  await driver.ready;
  raw.exec("BEGIN IMMEDIATE");
  const outcome = await Promise.allSettled([
    driver.runTimed("INSERT INTO items VALUES (1, NULL)", [], { spinMs: 10 }),
  ]);
  raw.exec("ROLLBACK");
  expect(outcome[0]?.status).toBe("rejected");
  const error = (outcome[0] as PromiseRejectedResult).reason;
  expect(error.code).toBe("SQLITE_BUSY");
  expect(error.executionMs).toBeGreaterThan(0);
  expect((await driver.get<{ timeout: number }>("PRAGMA busy_timeout", [])).value?.timeout).toBe(
    37,
  );
});

test("Worker enforces a deadline after transport queue delay before COMMIT", async () => {
  const { driver, raw } = setup();
  await driver.ready;
  await driver.exec("BEGIN IMMEDIATE");
  await driver.run("INSERT INTO items VALUES (1, NULL)", []);
  const slow = driver.get(
    "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<2000000) SELECT sum(x) FROM c",
    [],
  );
  const commit = driver.exec("COMMIT", { deadlineAt: Date.now() + 10 });
  const outcomes = await Promise.allSettled([slow, commit]);
  expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(DbTransactionDeadlineError);
  await driver.exec("ROLLBACK");
  expect((raw.query("SELECT count(*) AS n FROM items").get() as { n: number }).n).toBe(0);
});

test("callback rejection prevents partial commit and pending siblings drain before rollback", async () => {
  const { client, raw } = setup();
  const result = await Promise.allSettled([
    client.transaction(async (tx) => {
      const pending = [
        tx.run("INSERT INTO items VALUES (1, NULL)"),
        tx.run("INSERT INTO missing VALUES (1)"),
        tx.run("INSERT INTO items VALUES (2, NULL)"),
      ];
      await Promise.all(pending);
    }),
  ]);
  expect(result[0]?.status).toBe("rejected");
  expect((raw.query("SELECT count(*) AS n FROM items").get() as { n: number }).n).toBe(0);
});

test("close drains admitted writes and async hooks, acknowledges exit and rejects stale calls", async () => {
  const { client, raw } = setup();
  const write = client.run("INSERT INTO items VALUES (1, NULL)");
  let hook = false;
  client.afterCommit(async () => {
    await Bun.sleep(10);
    await client.run("INSERT INTO items VALUES (2, NULL)");
    hook = true;
  });
  const closed = client.close();
  const late = await Promise.allSettled([client.get("SELECT 1")]);
  expect(late[0]?.status).toBe("rejected");
  await write;
  await closed;
  expect(hook).toBe(true);
  expect((raw.query("SELECT count(*) AS n FROM items").get() as { n: number }).n).toBe(2);
});

test("a malformed response permanently rejects the transport", async () => {
  const { driver, worker } = setup();
  await driver.ready;
  const receive = worker.onmessage!;
  worker.onmessage = (event) => receive.call(worker, { ...event, data: null });
  const outcomes = await Promise.allSettled([driver.get("SELECT 1", [])]);
  expect((outcomes[0] as PromiseRejectedResult).reason).toBeInstanceOf(DbWorkerTransportError);
  const stale = await Promise.allSettled([driver.get("SELECT 2", [])]);
  expect((stale[0] as PromiseRejectedResult).reason).toBeInstanceOf(DbWorkerTransportError);
});

test("shutdown without acknowledgement terminates the Worker and reports failure", async () => {
  const { driver, worker } = setup();
  await driver.ready;
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (message) => {
    if (message.type !== "close") post(message);
  };
  const outcomes = await Promise.allSettled([driver.close()]);
  const error = (outcomes[0] as PromiseRejectedResult).reason;
  expect(error).toBeInstanceOf(DbWorkerTransportError);
  expect(error.message).toContain("shutdown timed out; forced termination");
}, 20_000);

for (const loseAfterWrite of [false, true]) {
  test(`Worker loss ${loseAfterWrite ? "after" : "before"} a write rejects queued calls without replay`, async () => {
    const { client, driver, worker, raw } = setup();
    await driver.ready;
    if (loseAfterWrite) await client.run("INSERT INTO items VALUES (1, NULL)");
    worker.terminate();
    const results = await Promise.allSettled([
      client.run("INSERT INTO items VALUES (2, NULL)"),
      client.get("SELECT 1"),
    ]);
    expect(
      results.every(
        (result) => result.status === "rejected" && result.reason instanceof DbWorkerTransportError,
      ),
    ).toBe(true);
    expect((raw.query("SELECT count(*) AS n FROM items").get() as { n: number }).n).toBe(
      loseAfterWrite ? 1 : 0,
    );
  });
}

test("lost COMMIT reply preserves an unknown outcome and never runs rollback hooks or callback replay", async () => {
  const { client, driver, worker, raw } = setup();
  await driver.ready;
  const post = worker.postMessage.bind(worker);
  let commitId: number | undefined;
  worker.postMessage = (message) => {
    if (message.sql === "COMMIT") commitId = message.id;
    post(message);
  };
  const receive = worker.onmessage!;
  worker.onmessage = (event) => {
    if (event.data.id === commitId) worker.terminate();
    else receive.call(worker, event);
  };
  let callbacks = 0;
  let rollback = false;
  let committed = false;
  const result = await Promise.allSettled([
    client.transaction(async (tx) => {
      callbacks++;
      await tx.run("INSERT INTO items VALUES (1, NULL)");
      client.afterRollback(() => {
        rollback = true;
      });
      client.afterCommit(() => {
        committed = true;
      });
    }),
  ]);
  expect((result[0] as PromiseRejectedResult).reason).toBeInstanceOf(DbWorkerTransportError);
  expect(callbacks).toBe(1);
  expect(rollback).toBe(false);
  expect(committed).toBe(false);
  expect((raw.query("SELECT count(*) AS n FROM items").get() as { n: number }).n).toBe(1);
});

// This case migrates a real file twice and starts a Worker under parallel test load.
test(
  "runtime reopen invalidates stale clients and transaction executors",
  async () => {
    await closeDb();
    const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
    const template = globals.__testMigrationTemplate;
    delete globals.__testMigrationTemplate;
    const previous = process.env.DB_DRIVER;
    process.env.DB_DRIVER = "worker";
    const dir = mkdtempSync(join(tmpdir(), "db-worker-reopen-"));
    roots.push(dir);
    try {
      initDb(join(dir, "db.sqlite"));
      await whenDbReady();
      const old = getDbClient();
      await old.run("CREATE TABLE probe (id INTEGER)");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let began!: () => void;
      const started = new Promise<void>((resolve) => {
        began = resolve;
      });
      const admitted = old.transaction(async () => {
        began();
        await gate;
        await getDbClient().run("INSERT INTO probe VALUES(1)");
        getDbClient().afterCommit(async () => {
          await getDbClient().run("INSERT INTO probe VALUES(2)");
        });
      });
      await started;
      const closing = closeDb();
      expect(getDbClient()).toBe(old);
      const rejected = await Promise.allSettled([getDbClient().run("INSERT INTO probe VALUES(3)")]);
      expect(rejected[0]?.status).toBe("rejected");
      release();
      await admitted;
      await closing;
      initDb(join(dir, "db.sqlite"));
      await whenDbReady();
      const outcomes = await Promise.allSettled([old.run("INSERT INTO probe VALUES(1)")]);
      expect(outcomes[0]?.status).toBe("rejected");
      expect((await getDbClient().get<{ n: number }>("SELECT count(*) AS n FROM probe"))?.n).toBe(
        2,
      );
    } finally {
      await closeDb();
      globals.__testMigrationTemplate = template;
      if (previous === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = previous;
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test(
  "a child exits after acknowledged Worker shutdown",
  async () => {
    const driverPath = new URL("../be/db/worker-driver.ts", import.meta.url).pathname;
    const { path } = setup();
    const child = await runChild([
      process.execPath,
      "-e",
      `import {createWorkerSqliteDriver} from ${JSON.stringify(driverPath)};
const driver=createWorkerSqliteDriver({filename:${JSON.stringify(path)},pragmas:['PRAGMA journal_mode=WAL']});
await driver.ready; await driver.close(); console.log('shutdown acknowledged');`,
    ]);
    expectChildOk(child, "Worker shutdown");
    expect(child.stdout).toContain("shutdown acknowledged");
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test(
  "runtime exits nonzero and reports scrubbed causes for startup and ready Worker failures",
  async () => {
    for (const failure of ["startup", "exit", "error"] as const) {
      const dir = mkdtempSync(join(tmpdir(), "db-worker-review-fatal-"));
      roots.push(dir);
      const runtimePath = new URL("../be/db/runtime.ts", import.meta.url).pathname;
      const scrubberPath = new URL("../utils/secret-scrubber.ts", import.meta.url).pathname;
      const child = await runChild(
        [
          process.execPath,
          "-e",
          `
    import {initDb, whenDbReady} from ${JSON.stringify(runtimePath)};
    import {registerVolatileSecret} from ${JSON.stringify(scrubberPath)};
    const secret = 'workerFailureSyntheticSecret0123456789';
    registerVolatileSecret(secret, 'WORKER_FAILURE_TEST');
    const workers: Worker[] = [];
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) { super(...args); workers.push(this); }
    };
    const endpoint = new URL(process.env.DESPLEGA_TELEMETRY_ENDPOINT!);
    if (endpoint.hostname !== '127.0.0.1') throw new Error('Loopback telemetry is required');
    initDb(${JSON.stringify(join(dir, "db.sqlite"))});
    if (${JSON.stringify(failure)} === 'startup') await Bun.file(${JSON.stringify(join(dir, "db.sqlite"))}).delete();
    await whenDbReady();
    console.log('ready');
    if (${JSON.stringify(failure)} === 'error') {
      workers[0]!.onerror!(new ErrorEvent('error', {message: 'synthetic Worker failure ' + secret}));
    } else workers[0]!.terminate();
    await Bun.sleep(1000);
    process.exit(99);
  `,
        ],
        {
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            DB_DRIVER: "worker",
            NODE_ENV: "test",
            SECRETS_ENCRYPTION_KEY: "1".repeat(64),
            DESPLEGA_TELEMETRY_ENV: "test",
            DESPLEGA_TELEMETRY_ENDPOINT: "http://127.0.0.1:1/v1/events",
          },
        },
      );
      expect(child.timedOut).toBe(false);
      if (failure !== "startup") expect(child.stdout).toContain("ready");
      expect(child.exitCode).toBe(1);
      expect(child.stderr).toContain("Fatal database transport failure");
      expect(child.stderr).toContain("DbWorkerTransportError:");
      if (failure === "startup") {
        expect(child.stderr).toContain("startup failed");
        expect(child.stderr).toContain("unable to open database file");
      }
      if (failure === "error") {
        expect(child.stderr).toContain("synthetic Worker failure [REDACTED:WORKER_FAILURE_TEST]");
        expect(child.stderr).not.toContain("workerFailureSyntheticSecret0123456789");
      }
    }
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test(
  "optional boot extension failure does not promote a resolved package path to required Worker support",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "db-worker-review-optional-"));
    roots.push(dir);
    const runtimePath = new URL("../be/db/runtime.ts", import.meta.url).pathname;
    const child = await runChild(
      [
        process.execPath,
        "-e",
        `
    import {Database} from 'bun:sqlite';
    import {initDb, whenDbReady, getDbClient, isSqliteVecAvailable, closeDb} from ${JSON.stringify(runtimePath)};
    const load = Database.prototype.loadExtension;
    Database.prototype.loadExtension = () => { throw new Error('synthetic optional extension failure'); };
    try { initDb(${JSON.stringify(join(dir, "db.sqlite"))}); }
    finally { Database.prototype.loadExtension = load; }
    await whenDbReady();
    if (isSqliteVecAvailable()) throw new Error('Unavailable boot support must remain unavailable');
    try { await getDbClient().get('SELECT vec_version()'); throw new Error('Unexpected vector support'); }
    catch (error) { if (!String(error).includes('no such function')) throw error; }
    await closeDb();
    console.log('optional support unavailable');
  `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          DB_DRIVER: "worker",
          NODE_ENV: "test",
          SECRETS_ENCRYPTION_KEY: "1".repeat(64),
          DESPLEGA_TELEMETRY_ENV: "test",
          DESPLEGA_TELEMETRY_ENDPOINT: "http://127.0.0.1:1/v1/events",
        },
      },
    );
    expectChildOk(child, "Optional extension absence");
    expect(child.stdout).toContain("optional support unavailable");
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
