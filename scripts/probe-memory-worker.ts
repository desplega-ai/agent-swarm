/** Phase 3 synthetic acceptance probe. Run with --no-env-file and DB_DRIVER=sqlite or worker. */
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { closeDb, getDbClient, getDbDriver, initDb } from "../src/be/db";
import type { DbClient } from "../src/be/db-client";
import { getMemoryStore } from "../src/be/memory";
import { SqliteMemoryStore } from "../src/be/memory/providers/sqlite-store";

if (process.platform === "darwin") {
  const library = "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib";
  if (await Bun.file(library).exists()) Database.setCustomSQLite(library);
}
const dir = (
  await Bun.$`mktemp -d ${join(process.env.TMPDIR ?? "/tmp", "worker-sqlite-phase3-probe-XXXXXX")}`.text()
).trim();
// File-backed means file-backed, including under the root preload.
Reflect.deleteProperty(globalThis, "__testMigrationTemplate");
const vector = (axis: number) => {
  const v = new Float32Array(512);
  v[axis] = 1;
  return v;
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function rejectsSame(work: Promise<unknown>, error: unknown) {
  const [result] = await Promise.allSettled([work]);
  assert.equal(result!.status, "rejected");
  if (result!.status === "rejected") assert.equal(result!.reason, error);
}
const result: Record<string, unknown> = { driver: process.env.DB_DRIVER, fixture: 20_000 };
let releasePopulation = () => {};
let timer: ReturnType<typeof setInterval> | undefined;
try {
  if (process.argv.includes("--optional-vec")) {
    // Exercise optional absence on both actual runtime connections.
    Database.prototype.loadExtension = () => {
      throw new Error("synthetic optional vector absence");
    };
  }
  initDb(join(dir, "memory.sqlite"));
  const client = getDbClient();
  assert.equal(getDbDriver(), process.env.DB_DRIVER);
  if (process.argv.includes("--optional-vec")) {
    const optional = getMemoryStore();
    await optional.whenReady();
    const row = await optional.store({
      agentId: null,
      scope: "swarm",
      name: "optional",
      content: "optional synthetic keyword",
      source: "manual",
    });
    await optional.updateEmbedding(row.id, vector(0), "synthetic");
    const health = await optional.getHealth();
    assert.equal(health.sqliteVec.extensionLoaded, false);
    assert.ok(health.reasons.includes("sqlite_vec_extension_unavailable"));
    assert.equal(
      (await optional.search(vector(0), crypto.randomUUID(), { limit: 1 }))[0]?.id,
      row.id,
    );
    await closeDb();
    console.log(JSON.stringify({ driver: process.env.DB_DRIVER, optionalAbsence: "passed" }));
  } else {
    const warm = new SqliteMemoryStore();
    await warm.whenReady();
    await warm.whenVecPopulated();
    await warm.whenFtsPopulated();
    const seed = await warm.store({
      agentId: null,
      scope: "swarm",
      name: "seed",
      content: "synthetic",
      source: "manual",
    });
    const columns = (await client.query<{ name: string }>("PRAGMA table_info(agent_memory)")).map(
      (r) => r.name,
    );
    const projection = columns
      .map((c) =>
        c === "id"
          ? "printf('80000000-0000-4000-8000-%012d', n.i)"
          : c === "key"
            ? "'fixture/' || n.i"
            : c === "embedding"
              ? "?"
              : c === "name"
                ? "'fixture ' || n.i"
                : c === "content"
                  ? "'synthetic token' || n.i"
                  : `s."${c}"`,
      )
      .join(",");
    await client.run(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<20000)
    INSERT INTO agent_memory(${columns.map((c) => `"${c}"`).join(",")}) SELECT ${projection} FROM n, agent_memory s WHERE s.id=?`,
      [Buffer.from(vector(1).buffer), seed.id],
    );
    await warm.delete(seed.id);
    await client.run(
      "UPDATE agent_memory SET embedding=? WHERE id='80000000-0000-4000-8000-000000020000'",
      [Buffer.from(vector(0).buffer)],
    );
    await client.run("DELETE FROM memory_fts");

    const realTransaction = client.transaction.bind(client);
    const initialQuery = client.query;
    const batchDone = latch();
    const ftsScanDone = latch();
    const resume = latch();
    const resumeFts = latch();
    releasePopulation = () => {
      resume.release();
      resumeFts.release();
    };
    let batches = 0;
    let sourceScans = 0;
    client.query = (async (sql, params) => {
      const rows = await initialQuery.call(client, sql, params);
      if (sql.includes("SELECT rowid AS rowid, id FROM agent_memory") && ++sourceScans === 1) {
        ftsScanDone.release();
        await resumeFts.promise;
      }
      return rows;
    }) as DbClient["query"];
    client.transaction = (async (fn, opts) => {
      const population = fn.toString().includes("ORDER BY id LIMIT 500");
      const value = await realTransaction(fn, opts);
      if (population && ++batches === 1) {
        batchDone.release();
        await resume.promise;
      }
      return value;
    }) as DbClient["transaction"];
    const constructorMethods = {
      get: client.get,
      query: client.query,
      run: client.run,
      transaction: client.transaction,
    };
    let constructorCalls = 0;
    client.get = ((...args) => {
      constructorCalls++;
      return constructorMethods.get.apply(client, args);
    }) as DbClient["get"];
    client.query = ((...args) => {
      constructorCalls++;
      return constructorMethods.query.apply(client, args);
    }) as DbClient["query"];
    client.run = ((...args) => {
      constructorCalls++;
      return constructorMethods.run.apply(client, args);
    }) as DbClient["run"];
    client.transaction = ((...args) => {
      constructorCalls++;
      return constructorMethods.transaction.apply(client, args);
    }) as DbClient["transaction"];
    const store = new SqliteMemoryStore();
    assert.equal(constructorCalls, 0);
    Object.assign(client, constructorMethods);
    const started = performance.now();
    await store.whenReady();
    await batchDone.promise;
    await ftsScanDone.promise;
    let lag = 0;
    let last = performance.now();
    timer = setInterval(() => {
      const now = performance.now();
      lag = Math.max(lag, now - last - 5);
      last = now;
    }, 5);
    const searching = performance.now();
    const first = await store.search(vector(0), crypto.randomUUID(), { limit: 1 });
    assert.equal(first[0]?.id, "80000000-0000-4000-8000-000000020000");
    assert.equal(first[0]?.retrievalSource, "fallback");
    result.firstSearchMs = performance.now() - searching;
    await store.updateEmbedding("80000000-0000-4000-8000-000000020000", vector(2), "synthetic");
    await store.delete("80000000-0000-4000-8000-000000019999");
    await store.edit({
      id: "80000000-0000-4000-8000-000000000002",
      content: "changed concurrent token",
      mode: "replace",
      intent: "synthetic",
    });
    // Insert actual UUIDs until one precedes the cursor.
    let inserted = await store.store({
      agentId: null,
      scope: "swarm",
      name: "inserted",
      content: "inserted concurrent token",
      source: "manual",
    });
    while (inserted.id >= "80000000-0000-4000-8000-000000000500") {
      await store.delete(inserted.id);
      inserted = await store.store({
        agentId: null,
        scope: "swarm",
        name: "inserted",
        content: "inserted concurrent token",
        source: "manual",
      });
    }
    const earlier = inserted.id;
    await store.updateEmbedding(earlier, vector(3), "synthetic");
    releasePopulation();
    await store.whenVecPopulated();
    await store.whenFtsPopulated();
    await tick();
    clearInterval(timer);
    timer = undefined;
    client.transaction = realTransaction;
    client.query = initialQuery;
    result.populateMs = performance.now() - started;
    result.maxMainThreadLagMs = lag;
    result.batches = batches;
    const health = await store.getHealth();
    assert.equal(health.counts.total, 20_000);
    assert.equal(health.counts.missingFromVec, 0);
    assert.equal(health.counts.extraInVec, 0);
    assert.equal(health.retrievalMode, "vec");
    assert.equal((await client.get<{ n: number }>("SELECT count(*) n FROM memory_fts"))?.n, 20_000);
    assert.equal(
      (await client.get<{ n: number }>("SELECT count(DISTINCT memory_id) n FROM memory_fts"))?.n,
      20_000,
    );
    assert.equal(
      (
        await client.get<{ n: number }>(
          "SELECT count(*) n FROM memory_fts f JOIN agent_memory m ON m.id=f.memory_id WHERE f.name != m.name OR f.content != m.content",
        )
      )?.n,
      0,
    );
    assert.equal(
      (
        await client.get<{ n: number }>(
          "SELECT count(*) n FROM memory_vec v JOIN agent_memory m ON m.id=v.memory_id WHERE vec_distance_cosine(v.embedding,m.embedding)>0.00001",
        )
      )?.n,
      0,
    );
    assert.equal(
      (await store.search(vector(3), crypto.randomUUID(), { limit: 1 }))[0]?.id,
      earlier,
    );
    if (process.env.DB_DRIVER === "worker")
      assert.ok(lag < 50, `Main-thread lag ${lag}ms exceeds 50ms`);

    // Pending initialization behind an existing lock must reject in that lock.
    const pending = new SqliteMemoryStore();
    await realTransaction(async () => {
      await assert.rejects(pending.whenReady(), /before starting a database transaction/);
    });
    const pendingGate = latch();
    const initialized = latch();
    const holding = realTransaction(async () => {
      initialized.release();
      await pendingGate.promise;
      await assert.rejects(pending.whenReady(), /before starting a database transaction/);
    });
    await initialized.promise;
    const readiness = pending.whenReady();
    pendingGate.release();
    await holding;
    await readiness;
    await pending.whenVecPopulated();
    await pending.whenFtsPopulated();

    // Preserve the exact schema error rather than marking optional degradation.
    const schemaError = new Error("synthetic schema failure");
    client.transaction = (async () => {
      throw schemaError;
    }) as DbClient["transaction"];
    const broken = new SqliteMemoryStore();
    await rejectsSame(broken.whenReady(), schemaError);
    await rejectsSame(broken.getHealth(), schemaError);
    client.transaction = realTransaction;

    await client.run("DROP TABLE memory_fts");
    await client.run("CREATE VIEW memory_fts AS SELECT 1 AS invalid_schema");
    const invalidSchema = new SqliteMemoryStore();
    const [schemaResult] = await Promise.allSettled([invalidSchema.whenReady()]);
    assert.equal(schemaResult!.status, "rejected");
    if (schemaResult!.status === "rejected")
      await rejectsSame(invalidSchema.getHealth(), schemaResult!.reason);
    await client.run("DROP VIEW memory_fts");
    await client.run("CREATE TABLE memory_fts(memory_id TEXT, name TEXT, content TEXT)");
    const ordinaryFts = new SqliteMemoryStore();
    const [ordinaryResult] = await Promise.allSettled([ordinaryFts.whenReady()]);
    assert.equal(ordinaryResult!.status, "rejected");
    if (ordinaryResult!.status === "rejected") {
      assert.match(String(ordinaryResult!.reason), /FTS5 virtual table/);
      await rejectsSame(ordinaryFts.getHealth(), ordinaryResult!.reason);
    }
    await client.run("DROP TABLE memory_fts");
    const repaired = new SqliteMemoryStore();
    await repaired.whenReady();
    await repaired.whenVecPopulated();
    await repaired.whenFtsPopulated();

    // A failed index write must roll back its source and version changes.
    const atomic = await repaired.store({
      agentId: null,
      scope: "swarm",
      source: "manual",
      name: "atomic",
      content: "oldkeyword",
    });
    await repaired.updateEmbedding(atomic.id, vector(0), "synthetic");
    const ftsWriteError = new Error("synthetic FTS write failure");
    client.transaction = ((fn, opts) =>
      realTransaction(
        async (tx) =>
          fn({
            ...tx,
            run: (sql, params) =>
              sql.startsWith("INSERT INTO memory_fts(")
                ? Promise.reject(ftsWriteError)
                : tx.run(sql, params),
          }),
        opts,
      )) as DbClient["transaction"];
    try {
      await rejectsSame(
        repaired.edit({ id: atomic.id, mode: "replace", content: "newkeyword", intent: "probe" }),
        ftsWriteError,
      );
      await rejectsSame(
        repaired.rewriteForScrub(
          atomic.id,
          { name: "atomic", content: "oldkeyword", summary: null },
          { name: "atomic", content: "newkeyword", summary: null },
        ),
        ftsWriteError,
      );
      await rejectsSame(
        repaired.store({
          agentId: null,
          scope: "swarm",
          source: "manual",
          name: "rejected",
          content: "newkeyword",
        }),
        ftsWriteError,
      );
    } finally {
      client.transaction = realTransaction;
    }
    const unchanged = await repaired.peek(atomic.id);
    assert.equal(unchanged?.content, "oldkeyword");
    assert.equal(unchanged?.version, 1);
    assert.equal(
      (
        await client.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_memory_version WHERE memory_id = ?",
          [atomic.id],
        )
      )?.n,
      1,
    );
    assert.equal(
      (
        await client.get<{ content: string }>(
          "SELECT content FROM memory_fts WHERE memory_id = ?",
          [atomic.id],
        )
      )?.content,
      "oldkeyword",
    );
    assert.equal(
      (
        await client.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM agent_memory WHERE name = 'rejected'",
        )
      )?.n,
      0,
    );
    await repaired.edit({ id: atomic.id, mode: "replace", content: "newkeyword", intent: "probe" });
    assert.equal(
      (await repaired.search(new Float32Array(), crypto.randomUUID(), { queryText: "oldkeyword" }))
        .length,
      0,
    );
    assert.equal(
      (
        await repaired.search(new Float32Array(), crypto.randomUUID(), { queryText: "newkeyword" })
      )[0]?.id,
      atomic.id,
    );

    // Pause a health read between counts. A competing mutation must wait for its snapshot.
    const expectedCounts = (await repaired.getHealth()).counts;
    const countRead = latch();
    const resumeCounts = latch();
    const healthGet = client.get;
    let pauseCounts = true;
    client.get = (async (sql, params) => {
      const value = await healthGet.call(client, sql, params);
      if (pauseCounts && sql.includes("embedding IS NOT NULL AND length(embedding) =")) {
        pauseCounts = false;
        countRead.release();
        await resumeCounts.promise;
      }
      return value;
    }) as DbClient["get"];
    const snapshot = repaired.getHealth();
    await countRead.promise;
    let mutationEntered = false;
    const mutation = client.transaction(async () => {
      mutationEntered = true;
      await repaired.delete(atomic.id);
    });
    try {
      await Bun.sleep(25);
      assert.equal(mutationEntered, false);
    } finally {
      resumeCounts.release();
    }
    const snapshotHealth = await snapshot;
    await mutation;
    client.get = healthGet;
    assert.deepEqual(snapshotHealth.counts, expectedCounts);
    assert.equal((await repaired.getHealth()).counts.total, expectedCounts.total - 1);
    result.ftsAndHealth =
      "atomic source/index writes, FTS5 schema, consistent health snapshot passed";

    // Population failures are independent. Search still sees source embeddings.
    const populationError = new Error("synthetic vector population failure");
    client.transaction = (async (fn, opts) => {
      if (fn.toString().includes("ORDER BY id LIMIT 500")) throw populationError;
      return realTransaction(fn, opts);
    }) as DbClient["transaction"];
    const failed = new SqliteMemoryStore();
    await failed.whenReady();
    await rejectsSame(failed.whenVecPopulated(), populationError);
    await failed.whenFtsPopulated();
    assert.ok((await failed.getHealth()).reasons.includes("memory_vec_population_failed"));
    assert.equal(
      (await failed.search(vector(3), crypto.randomUUID(), { limit: 1 }))[0]?.id,
      earlier,
    );
    client.transaction = realTransaction;
    const ftsError = new Error("synthetic FTS population failure");
    const realQuery = client.query;
    client.query = ((sql, params) => {
      if (sql.includes("SELECT rowid AS rowid, id FROM agent_memory"))
        return Promise.reject(ftsError);
      return realQuery.call(client, sql, params);
    }) as DbClient["query"];
    const ftsFailed = new SqliteMemoryStore();
    await ftsFailed.whenReady();
    await rejectsSame(ftsFailed.whenFtsPopulated(), ftsError);
    await ftsFailed.whenVecPopulated();
    assert.ok((await ftsFailed.getHealth()).reasons.includes("memory_fts_population_failed"));
    assert.equal(
      (
        await ftsFailed.search(vector(3), crypto.randomUUID(), { limit: 1, queryText: "inserted" })
      )[0]?.id,
      earlier,
    );
    client.query = realQuery;
    const neverInitialized = new SqliteMemoryStore();
    const oldSingleton = getMemoryStore();
    await oldSingleton.whenReady();
    const closing = closeDb();
    await closing;
    await assert.rejects(store.getHealth(), /closed/);
    await assert.rejects(pending.peek(earlier), /closed/);
    initDb(join(dir, "reopened.sqlite"));
    await assert.rejects(neverInitialized.whenReady(), /closed/);
    const fresh = getMemoryStore();
    assert.notEqual(fresh, oldSingleton);
    await fresh.whenReady();
    assert.equal((await fresh.getHealth()).counts.total, 0);
    await assert.rejects(
      store.store({
        agentId: null,
        scope: "swarm",
        source: "manual",
        name: "stale",
        content: "stale",
      }),
      /closed/,
    );
    await closeDb();
    result.lifecycle =
      "schema error identity, pending transaction rejection, vector failure, fallback, shutdown, reopen passed";
    // Every DB-bearing public operation must wait individually, including error paths.
    initDb(join(dir, "ownership.sqlite"));
    const owned = new SqliteMemoryStore();
    await owned.whenReady();
    await owned.whenVecPopulated();
    await owned.whenFtsPopulated();
    const observedClient = getDbClient();
    let operationsBeforeReady = 0;
    const originalMethods = {
      query: observedClient.query,
      get: observedClient.get,
      run: observedClient.run,
      transaction: observedClient.transaction,
    };
    observedClient.query = ((...args) => {
      operationsBeforeReady++;
      return originalMethods.query.apply(observedClient, args);
    }) as DbClient["query"];
    observedClient.get = ((...args) => {
      operationsBeforeReady++;
      return originalMethods.get.apply(observedClient, args);
    }) as DbClient["get"];
    observedClient.run = ((...args) => {
      operationsBeforeReady++;
      return originalMethods.run.apply(observedClient, args);
    }) as DbClient["run"];
    observedClient.transaction = ((...args) => {
      operationsBeforeReady++;
      return originalMethods.transaction.apply(observedClient, args);
    }) as DbClient["transaction"];
    const blocked = new Error("synthetic readiness gate");
    const operations = [
      () =>
        owned.store({ agentId: null, scope: "swarm", name: "x", content: "x", source: "manual" }),
      () => owned.storeBatch([]),
      () =>
        owned.replaceDocument({ key: "x", scope: "swarm", agentId: null, source: "manual" }, []),
      () => owned.get(earlier),
      () => owned.peek(earlier),
      () => owned.search(vector(0), crypto.randomUUID(), {}),
      () => owned.list(crypto.randomUUID(), {}),
      () => owned.count(crypto.randomUUID(), {}),
      () => owned.edit({ id: earlier, mode: "replace", content: "x", intent: "probe" }),
      () => owned.listForCuration(),
      () => owned.listForReembedding(),
      () => owned.delete(earlier),
      () => owned.deleteBySourcePath("x", crypto.randomUUID()),
      () => owned.purgeExpired(),
      () => owned.updateEmbedding(earlier, vector(0), "synthetic"),
      () => owned.clearEmbedding(earlier),
      () =>
        owned.rewriteForScrub(
          earlier,
          { name: "x", content: "x", summary: null },
          { name: "y", content: "y", summary: null },
        ),
      () => owned.getStats(crypto.randomUUID()),
      () => owned.getHealth(),
    ];
    // Prove each call waits on its own gate.
    for (const operation of operations) {
      const gate = latch();
      let settled = false;
      owned.whenReady = async () => {
        await gate.promise;
        throw blocked;
      };
      const work = operation();
      const joined = work.then(
        () => {
          settled = true;
          assert.fail("The operation fulfilled after readiness rejected.");
        },
        (error) => {
          assert.equal(error, blocked);
          settled = true;
        },
      );
      await tick();
      assert.equal(settled, false);
      assert.equal(operationsBeforeReady, 0);
      gate.release();
      await joined;
      assert.equal(operationsBeforeReady, 0);
    }
    Object.assign(observedClient, originalMethods);
    result.individualReadinessGates = operations.length;

    // Queued initialization must not extend the client's shutdown deadline.
    const ownerEntered = latch();
    const releaseOwner = latch();
    releasePopulation = releaseOwner.release;
    const owner = observedClient.transaction(async () => {
      ownerEntered.release();
      await releaseOwner.promise;
    });
    const ownerResult = Promise.allSettled([owner]);
    await ownerEntered.promise;
    const queuedStore = new SqliteMemoryStore();
    const queuedReadiness = Promise.allSettled([queuedStore.whenReady()]);
    const deadline = Promise.withResolvers<never>();
    const deadlineTimer = setTimeout(
      () => deadline.reject(new Error("closeDb exceeded its shutdown bound")),
      15_000,
    );
    try {
      const [closed] = await Promise.race([Promise.allSettled([closeDb()]), deadline.promise]);
      assert.equal(closed!.status, "rejected");
      if (closed!.status === "rejected")
        assert.match(String(closed!.reason), /shutdown drain timed out/);
      const [readiness] = await Promise.race([queuedReadiness, deadline.promise]);
      assert.equal(readiness!.status, "rejected");
      if (readiness!.status === "rejected") assert.match(String(readiness!.reason), /closed/);
      initDb(join(dir, "after-timeout.sqlite"));
      const afterTimeout = getMemoryStore();
      await afterTimeout.whenReady();
      assert.equal((await afterTimeout.getHealth()).counts.total, 0);
    } finally {
      clearTimeout(deadlineTimer);
      releaseOwner.release();
      await ownerResult;
    }
    result.shutdownBound = "queued initialization rejected and forced closure remained bounded";
    console.log(JSON.stringify(result));
  }
} finally {
  releasePopulation();
  if (timer) clearInterval(timer);
  await closeDb();
  await Bun.$`rm -rf ${dir}`;
}
