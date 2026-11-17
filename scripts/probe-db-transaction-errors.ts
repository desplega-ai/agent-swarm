/** Verify Phase 1's approved caught-error contract. Exit nonzero for any regression. */
import { Database } from "bun:sqlite";
import {
  closeDb,
  createAgent,
  createWorkflow,
  getDbClient,
  initDb,
  whenDbReady,
} from "../src/be/db";
import type { DbExecutor } from "../src/be/db-client";
import { SqliteMemoryStore } from "../src/be/memory/providers/sqlite-store";
import { snapshotAndUpdateWorkflow } from "../src/workflows/version";

const endpoint = new URL(process.env.DESPLEGA_TELEMETRY_ENDPOINT ?? "");
if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
  throw new Error("A loopback telemetry endpoint is required.");
}
// The probe needs vectors on both drivers. Configure before opening any connection.
if (process.platform === "darwin") {
  for (const path of [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ]) {
    if (await Bun.file(path).exists()) {
      Database.setCustomSQLite(path);
      break;
    }
  }
}
const root = `/private/tmp/db-worker-review-errors-${crypto.randomUUID()}`;
await Bun.$`mkdir -p ${root}`.quiet();
const results: { driver: string; case: string; passed: boolean; outcome: string }[] = [];
// Discarded failure patterns belong to the static corpus, not runtime acceptance.
// This probe installs no rejection listener and uses native Promise consumption.
const record = async (driver: string, name: string, check: () => Promise<boolean>) => {
  try {
    results.push({ driver, case: name, passed: await check(), outcome: "settled" });
  } catch (error) {
    results.push({
      driver,
      case: name,
      passed: false,
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
};
try {
  for (const driver of ["sqlite", "worker"]) {
    process.env.DB_DRIVER = driver;
    const raw = initDb(`${root}/${driver}.sqlite`);
    await whenDbReady();
    const client = getDbClient();
    await client.run("CREATE TABLE probe (n INTEGER)");
    const broken = (tx: DbExecutor) => tx.run("INSERT INTO absent_probe VALUES (1)");
    const handled: Record<string, (tx: DbExecutor) => Promise<unknown>> = {
      native_await: async (tx) => {
        try {
          await broken(tx);
        } catch {}
      },
      async_wrapper: async (tx) => {
        const helper = async () => await broken(tx);
        try {
          await helper();
        } catch {}
      },
      client_wrapper: async () => {
        try {
          await client.run("INSERT INTO absent_probe VALUES (1)");
        } catch {}
      },
      catch: (tx) => broken(tx).catch(() => {}),
      finally_then_catch: (tx) =>
        broken(tx)
          .finally(() => {})
          .catch(() => {}),
      then_rethrow_caught: async (tx) => {
        try {
          await broken(tx).then(undefined, (error) => {
            throw error;
          });
        } catch {}
      },
    };
    for (const [name, handle] of Object.entries(handled)) {
      await record(driver, name, async () => {
        await client.transaction(async (tx) => {
          await tx.run("INSERT INTO probe VALUES (1)");
          await handle(tx);
        });
        return (await client.get<{ n: number }>("SELECT count(*) AS n FROM probe"))!.n === 1;
      });
      await client.run("DELETE FROM probe");
    }
    await record(driver, "callback_rejection_rollback", async () => {
      const outcome = await Promise.allSettled([
        client.transaction(async (tx) => {
          await tx.run("INSERT INTO probe VALUES (1)");
          await broken(tx);
        }),
      ]);
      return (
        outcome[0]!.status === "rejected" &&
        (await client.get<{ n: number }>("SELECT count(*) AS n FROM probe"))!.n === 0
      );
    });
    await record(driver, "nested_callback_isolation", async () => {
      await client.transaction(async (tx) => {
        await tx.run("INSERT INTO probe VALUES (1)");
        try {
          await client.transaction(async (inner) => {
            await inner.run("INSERT INTO probe VALUES (2)");
            await broken(inner);
          });
        } catch {}
        await client.transaction(async (inner) => {
          await inner.run("INSERT INTO probe VALUES (3)");
          try {
            await broken(inner);
          } catch {}
        });
      });
      const rows = await client.query<{ n: number }>("SELECT n FROM probe ORDER BY n");
      await client.run("DELETE FROM probe");
      return JSON.stringify(rows.map((row) => row.n)) === "[1,3]";
    });
    await record(driver, "chained_success_drain", async () => {
      await client.transaction(async (tx) => {
        void tx
          .run("INSERT INTO probe VALUES (1)")
          .then(() => tx.run("INSERT INTO probe VALUES (2)"));
      });
      return (await client.get<{ n: number }>("SELECT count(*) AS n FROM probe"))!.n === 2;
    });
    const workflow = await createWorkflow({ name: "probe", definition: { nodes: [] } });
    raw.run(
      "CREATE TRIGGER probe_snapshot BEFORE INSERT ON workflow_versions BEGIN SELECT RAISE(ABORT, 'synthetic snapshot failure'); END",
    );
    await record(driver, "snapshotOptional", async () => {
      const result = await snapshotAndUpdateWorkflow(
        workflow.id,
        { name: "preserved" },
        { snapshotOptional: true },
      );
      return result.workflow?.name === "preserved" && result.version === null;
    });
    const agentId = crypto.randomUUID();
    await createAgent({ id: agentId, name: "probe", status: "idle", isLead: false });
    const store = new SqliteMemoryStore();
    await store.whenFtsPopulated();
    const memory = await store.store({
      agentId,
      name: "probe",
      content: "synthetic",
      source: "manual",
      scope: "agent",
    });
    // Start with an existing vector. A failed replacement must remove the obsolete vector.
    const initialEmbedding = new Float32Array(512);
    initialEmbedding[0] = 1;
    await store.updateEmbedding(memory.id, initialEmbedding, "old-model");
    await record(driver, "replacement_failure_removes_obsolete_vector", async () => {
      raw.run("DROP TABLE memory_vec");
      raw.run("CREATE TABLE memory_vec(memory_id TEXT, embedding BLOB)");
      raw.run("INSERT INTO memory_vec VALUES (?, ?)", [memory.id, initialEmbedding]);
      raw.run(
        "CREATE TRIGGER probe_vec BEFORE INSERT ON memory_vec BEGIN SELECT RAISE(ABORT, 'synthetic vector failure'); END",
      );
      await store.updateEmbedding(memory.id, initialEmbedding, "new-model");
      const row = await client.get<{ embeddingModel: string }>(
        "SELECT embeddingModel FROM agent_memory WHERE id = ?",
        [memory.id],
      );
      const count = await client.get<{ n: number }>(
        "SELECT count(*) AS n FROM memory_vec WHERE memory_id = ?",
        [memory.id],
      );
      raw.run("DROP TABLE memory_vec");
      raw.run(
        "CREATE VIRTUAL TABLE memory_vec USING vec0(memory_id TEXT PRIMARY KEY, embedding float[512])",
      );
      return row?.embeddingModel === "new-model" && count?.n === 0;
    });
    // Corrupt only this owned vector fixture, after the store initialized it.
    raw.run("DROP TABLE memory_vec_vector_chunks00");
    await record(driver, "updateEmbedding_best_effort", async () => {
      const embedding = new Float32Array(512);
      embedding[0] = 1;
      await store.updateEmbedding(memory.id, embedding, "preserved-model");
      return (
        (
          await client.get<{ embeddingModel: string }>(
            "SELECT embeddingModel FROM agent_memory WHERE id = ?",
            [memory.id],
          )
        )?.embeddingModel === "preserved-model"
      );
    });
    await closeDb();
  }
} finally {
  await closeDb();
  await Bun.$`rm -rf ${root}`.quiet();
}
console.log(JSON.stringify(results, null, 2));

if (results.some((result) => !result.passed)) process.exitCode = 1;
