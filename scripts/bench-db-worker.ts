#!/usr/bin/env bun
/** Raw Phase 0 comparisons use one connection per fresh process.
 * Production --assert uses the boot and client connections.
 * bun --expose-gc scripts/bench-db-worker.ts --json
 * bun tsc --noEmit -p scripts/bench-db-worker.tsconfig.json
 * Local serialization experiments run in separate processes after memory measurements.
 */
import { deserialize, serialize } from "bun:jsc";
import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { packageManager } from "../package.json";
import {
  checkVector,
  configureSQLite,
  EMBEDDING_DIMENSIONS,
  errorDetails,
  execute,
  LONG_SQL,
  openDatabase,
  type Query,
  type Row,
  resolveSqliteVecExtensionPath,
  seedFixture,
  threadHeap,
} from "./bench-db-worker-fixture";
import type { Request } from "./bench-db-worker-thread";

const { values: args } = parseArgs({
  options: {
    json: { type: "boolean" },
    assert: { type: "boolean" },
    child: { type: "string" },
    directory: { type: "string" },
    driver: { type: "string" },
    case: { type: "string" },
    "worker-extension": { type: "string" },
  },
});
const compiled = import.meta.url.includes("/$bunfs/");
const settings = {
  warmups: 3,
  runs: 20,
  rounds: 2,
  longWarmups: 1,
  longRuns: 6,
  probeIntervalMs: 5,
  rssSampleIntervalMs: 5,
  longTargetMs: 1000,
  maxWorkerLagMs: 50,
};
const round = (n: number) => Math.round(n * 1000) / 1000;
function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!);
  return { p50: at(0.5), p95: at(0.95), max: round(sorted[sorted.length - 1]!) };
}
type Case = Query & { name: string; expectedRows: number; statementsPerRun: number; long: boolean };
const cases: Case[] = [
  {
    name: "session_logs",
    expectedRows: 200,
    sql: "SELECT * FROM session_logs WHERE sessionId = ? ORDER BY lineNumber LIMIT 200",
    params: ["phase0-session"],
    statementsPerRun: 1,
    long: false,
  },
  {
    name: "agent_tasks",
    expectedRows: 100,
    sql: "SELECT * FROM agent_tasks ORDER BY createdAt, id LIMIT 100",
    params: [],
    statementsPerRun: 1,
    long: false,
  },
  {
    name: "agent_memory",
    expectedRows: 50,
    sql: "SELECT * FROM agent_memory WHERE scope = ? ORDER BY accessedAt, id LIMIT 50",
    params: ["swarm"],
    statementsPerRun: 1,
    long: false,
  },
  {
    name: "kv_entries",
    expectedRows: 20000,
    sql: "SELECT * FROM kv_entries WHERE namespace = ? ORDER BY key LIMIT 20000",
    params: ["phase0"],
    statementsPerRun: 1,
    long: false,
  },
  {
    name: "recursive_cte",
    expectedRows: 1,
    sql: LONG_SQL,
    params: [],
    statementsPerRun: 1,
    long: true,
  },
  {
    name: "small_statements",
    expectedRows: 1,
    sql: "SELECT 1 AS n",
    params: [],
    statementsPerRun: 100,
    long: false,
  },
];
const selected = args.case ? cases.filter((c) => c.name === args.case) : cases;
if (!selected.length) throw new Error("The benchmark case does not exist.");
if (args.driver && !["sqlite", "worker"].includes(args.driver))
  throw new Error("The benchmark driver is invalid.");

function connect(worker: Worker) {
  let pending: { resolve: (value: unknown) => void; reject: (error: Error) => void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeEvent: { code: number } | undefined;
  const fail = (error: Error) => {
    clearTimeout(timer);
    pending?.reject(error);
    pending = undefined;
  };
  worker.onmessage = ({ data }) => {
    clearTimeout(timer);
    const call = pending;
    pending = undefined;
    if (data.error) call?.reject(Object.assign(new Error(data.error.message), data.error));
    else call?.resolve(data);
  };
  worker.onerror = (event) =>
    fail(new Error(`Worker error: ${event.message}`, { cause: event.error }));
  worker.addEventListener("close", (event) => {
    closeEvent = { code: event.code };
    fail(new Error(`The benchmark Worker closed with code ${event.code}.`));
  });
  return {
    request: <T>(request: Request) =>
      new Promise<T>((resolve, reject) => {
        if (pending) return reject(new Error("The benchmark permits one outstanding request."));
        pending = { resolve: (value) => resolve(value as T), reject };
        timer = setTimeout(
          () => fail(new Error(`Worker request timed out: ${request.type}`)),
          30000,
        );
        try {
          worker.postMessage(request);
        } catch (error) {
          fail(new Error("Worker submission failed.", { cause: error }));
        }
      }),
    async waitForExit() {
      const deadline = performance.now() + 5000;
      while (!closeEvent && performance.now() < deadline) await Bun.sleep(5);
      if (!closeEvent)
        throw new Error("The Worker close event did not arrive within five seconds.");
      if (closeEvent.code !== 0) throw new Error(`The Worker exited with code ${closeEvent.code}.`);
      return closeEvent;
    },
  };
}
async function probe<T>(work: () => Promise<T>) {
  let lagMs = 0;
  let previous = performance.now();
  const tick = () => {
    const now = performance.now();
    lagMs = Math.max(lagMs, now - previous - settings.probeIntervalMs);
    previous = now;
  };
  const timer = setInterval(tick, settings.probeIntervalMs);
  try {
    await Bun.sleep(settings.probeIntervalMs * 3);
    const result = await work();
    await Bun.sleep(settings.probeIntervalMs * 2);
    tick();
    return { result, lagMs };
  } finally {
    clearInterval(timer);
  }
}
function decode(rows: Row[]) {
  for (const row of rows) {
    for (const key of ["content", "tags", "dependsOn", "value"]) {
      const value = row[key];
      if (typeof value === "string" && (value.startsWith("{") || value.startsWith("[")))
        JSON.parse(value);
    }
    if (
      row.embedding instanceof Uint8Array &&
      row.embedding.byteLength !== EMBEDDING_DIMENSIONS * 4
    ) {
      throw new Error("An embedding has an unexpected BLOB length.");
    }
  }
}
// Hash typed values and their positions after the memory window.
function signature(rows: Row[]) {
  let hash = 0n;
  for (const [index, row] of rows.entries())
    for (const [key, value] of Object.entries(row)) {
      const type = value === null ? "null" : value instanceof Uint8Array ? "blob" : typeof value;
      hash = BigInt(Bun.hash(JSON.stringify([index, key, type]), hash));
      hash = BigInt(Bun.hash(value instanceof Uint8Array ? value : String(value), hash));
    }
  return { rows: rows.length, columns: Object.keys(rows[0] ?? {}), hash: hash.toString() };
}
type Execution = ReturnType<typeof execute>;
type Sample = {
  roundTripMs: number;
  executionMs: number;
  transportResidualMs: number;
  decodeMs: number;
  transportLagMs: number;
  decodeLagMs: number;
};
const frame = (data: unknown) => process.stdout.write(`${JSON.stringify(data)}\n`);
async function boundary(stage: string) {
  frame({ stage });
  // Permit the external sampler to observe idle boundaries independently of the query thread.
  await Bun.sleep(60);
}
async function customSQLitePath() {
  if (process.platform !== "darwin") return null;
  for (const path of [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ]) {
    if (await Bun.file(path).exists()) return path;
  }
  throw new Error("macOS requires a SQLite library that supports extensions.");
}
async function child() {
  const failures: ReturnType<typeof errorDetails>[] = [];
  const result: Record<string, unknown> = {};
  let db: Database | undefined;
  let worker: Worker | undefined;
  let connection: ReturnType<typeof connect> | undefined;
  const exitFlag = new Int32Array(new SharedArrayBuffer(4));
  let workerConnectionClosed = false;
  let workerCloseObserved = false;
  try {
    if (Bun.version !== packageManager.split("@")[1])
      throw new Error("Bun does not match the repository pin.");
    if (!Number.isInteger(EMBEDDING_DIMENSIONS) || EMBEDDING_DIMENSIONS < 1)
      throw new Error("Embedding dimensions must be positive integers.");
    const path = await customSQLitePath();
    Bun.gc(true);
    result.baselineMainHeap = threadHeap();
    await boundary("baseline");
    frame({ stage: "setup" });
    const filename = join(args.directory!, "fixture.sqlite");
    if (args.child === "seed") {
      configureSQLite(path);
      db = openDatabase(filename, true);
      result.capability = checkVector(db, resolveSqliteVecExtensionPath());
      result.fixture = seedFixture(db);
    } else {
      const entry = selected[0]!;
      let run: (query: Query) => Promise<Execution>;
      if (args.driver === "worker") {
        worker = new Worker(
          compiled
            ? "./bench-db-worker-thread.ts"
            : new URL("./bench-db-worker-thread.ts", import.meta.url).href,
        );
        connection = connect(worker);
        result.capability = await connection.request({
          type: "open",
          filename,
          customSQLite: path,
          extensionPath: args["worker-extension"] ?? resolveSqliteVecExtensionPath(),
          exitFlag: exitFlag.buffer as SharedArrayBuffer,
        });
        run = (query) => connection!.request<Execution>({ type: "query", query });
      } else {
        result.customSQLite = configureSQLite(path);
        db = openDatabase(filename, false);
        result.capability = {
          vector: checkVector(db, resolveSqliteVecExtensionPath()),
          sqliteVersion: db.query("SELECT sqlite_version() AS version").get(),
        };
        run = async (query) => execute(db!, query);
      }
      const collect = async () => {
        // Collect the SQL thread before the receiving thread in Worker mode.
        const sql = connection
          ? await connection.request<ReturnType<typeof threadHeap>>({ type: "heap", collect: true })
          : null;
        Bun.gc(true);
        await Bun.sleep(10);
        return { main: threadHeap(), sqlWorker: sql };
      };
      const query: Query = { sql: entry.sql, params: [...entry.params] };
      if (entry.long) {
        let iterations = 100000;
        const calibration: { iterations: number; executionMs: number[] }[] = [];
        result.calibration = calibration;
        for (let step = 0; step < 8; step++) {
          const samples = [];
          for (let i = 0; i < 3; i++) {
            await collect();
            samples.push((await run({ sql: LONG_SQL, params: [iterations] })).executionMs);
          }
          calibration.push({ iterations, executionMs: samples.map(round) });
          const median = stats(samples).p50;
          if (median >= settings.longTargetMs * 0.85 && median <= settings.longTargetMs * 1.15)
            break;
          if (step === 7)
            throw new Error("The recursive query did not reach the calibration interval.");
          iterations = Math.min(
            100000000,
            Math.max(
              1,
              Math.round(iterations * Math.min(10, settings.longTargetMs / Math.max(1, median))),
            ),
          );
        }
        query.params = [iterations];
        result.iterations = iterations;
      }
      if (args.child === "transfer") {
        result.transfer = transferCost((await run(query)).rows);
      } else {
        const runBatch = async () => {
          let executionMs = 0;
          let rows: Row[] = [];
          const started = performance.now();
          for (let j = 0; j < entry.statementsPerRun; j++) {
            const execution = await run(query);
            executionMs += execution.executionMs;
            rows = execution.rows;
          }
          return { rows, executionMs, roundTripMs: performance.now() - started };
        };
        for (let i = 0; i < (entry.long ? settings.longWarmups : settings.warmups); i++) {
          await collect();
          const warmup = await runBatch();
          warmup.rows.length = 0;
        }
        result.idleHeap = await collect();
        await boundary("idleAfterWarmup");
        const samples: Sample[] = [];
        result.samples = samples;
        await boundary("workload");
        for (
          let i = 0;
          i < (entry.long ? settings.longRuns : settings.runs) / settings.rounds;
          i++
        ) {
          await collect();
          // JSON decoding gets its own probe and occurs only after the transport probe stops.
          const transport = await probe(runBatch);
          const { rows, executionMs, roundTripMs } = transport.result;
          const decoding = await probe(async () => {
            const started = performance.now();
            decode(rows);
            return performance.now() - started;
          });
          samples.push({
            roundTripMs,
            executionMs,
            transportResidualMs: roundTripMs - executionMs,
            decodeMs: decoding.result,
            transportLagMs: transport.lagMs,
            decodeLagMs: decoding.lagMs,
          });
          if (rows.length !== entry.expectedRows)
            throw new Error("The query returned an unexpected row count.");
          if (
            entry.long &&
            rows[0]?.total !== (Number(query.params[0]) * (Number(query.params[0]) + 1)) / 2
          )
            throw new Error("The recursive query returned an incorrect sum.");
          result.afterWorkHeap = {
            main: threadHeap(),
            sqlWorker: connection
              ? await connection.request({ type: "heap", collect: false })
              : null,
          };
          // Async frames can retain the last result across the next GC boundary.
          // Clear the shared array so neither driver carries rows into the next sample.
          rows.length = 0;
        }
        // No result array remains live across this boundary.
        result.afterCollectionHeap = await collect();
        await boundary("afterCollection");
        // Verify all values after the memory window so hashing cannot inflate its peak.
        frame({ stage: "validation" });
        const verification = await run(query);
        result.signature = signature(verification.rows);
        verification.rows.length = 0;
        frame({ stage: "cleanup" });
      }
    }
  } catch (error) {
    failures.push(errorDetails(error));
  } finally {
    if (connection && worker) {
      try {
        const closed = await connection.request<{ closed: boolean }>({ type: "close" });
        workerConnectionClosed = closed.closed;
        if (!closed.closed)
          failures.push(
            errorDetails(new Error("The Worker did not acknowledge database closure.")),
          );
      } catch (error) {
        failures.push(errorDetails(error));
        worker.terminate();
      }
      try {
        await connection.waitForExit();
        workerCloseObserved = true;
      } catch (error) {
        failures.push(errorDetails(error));
        worker.terminate();
      }
      if (Atomics.load(exitFlag, 0) !== 1)
        failures.push(errorDetails(new Error("The Worker exit callback did not run.")));
    }
    let mainConnectionClosed = !db;
    try {
      db?.close();
      mainConnectionClosed = true;
    } catch (error) {
      failures.push(errorDetails(error));
    }
    result.cleanup = {
      mainConnectionClosed,
      workerConnectionClosed: worker ? workerConnectionClosed : null,
      workerCloseObserved: worker ? workerCloseObserved : null,
      workerExitCallbackObserved: worker ? Atomics.load(exitFlag, 0) === 1 : null,
    };
  }
  frame({ result, failures });
  if (failures.length) process.exitCode = 1;
}
function transferCost(rows: Row[]) {
  const serializeMs: number[] = [];
  const deserializeMs: number[] = [];
  const cloneMs: number[] = [];
  let serializedBytes = 0;
  for (let i = -settings.warmups; i < settings.runs; i++) {
    let start = performance.now();
    const wire = serialize(rows);
    const serialized = performance.now() - start;
    serializedBytes = wire.byteLength;
    start = performance.now();
    const restored: Row[] = deserialize(wire);
    const deserialized = performance.now() - start;
    start = performance.now();
    structuredClone(rows);
    const cloned = performance.now() - start;
    if (restored.length !== rows.length) throw new Error("Deserialization changed the row count.");
    if (i >= 0) {
      serializeMs.push(serialized);
      deserializeMs.push(deserialized);
      cloneMs.push(cloned);
    }
  }
  return {
    serializedBytes,
    serializeMs: stats(serializeMs),
    deserializeMs: stats(deserializeMs),
    structuredCloneMs: stats(cloneMs),
  };
}

type Resident = { rssBytes: number; rssAnonBytes: number | null; rssFileBytes: number | null };
async function resident(pid: number): Promise<Resident | null> {
  if (process.platform === "linux") {
    try {
      const status = await Bun.file(`/proc/${pid}/status`).text();
      const field = (name: string) => {
        const match = status.match(new RegExp(`^${name}:\\s+(\\d+) kB`, "m"));
        return match ? Number(match[1]) * 1024 : null;
      };
      const rssBytes = field("VmRSS");
      return rssBytes === null
        ? null
        : { rssBytes, rssAnonBytes: field("RssAnon"), rssFileBytes: field("RssFile") };
    } catch (error) {
      if (Reflect.get(error as object, "code") === "ENOENT") return null;
      throw error;
    }
  }
  const ps = Bun.spawn(["/bin/ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(ps.stdout).text();
  const stderr = await new Response(ps.stderr).text();
  const code = await ps.exited;
  if (code === 1 && !output.trim() && !stderr.trim()) return null;
  if (code !== 0) throw new Error(`RSS sampling failed (${code}): ${stderr}`);
  if (Number(output.trim()) <= 0) return null;
  return { rssBytes: Number(output.trim()) * 1024, rssAnonBytes: null, rssFileBytes: null };
}
type ChildResult = {
  samples?: Sample[];
  signature?: ReturnType<typeof signature>;
  iterations?: number;
  calibration?: unknown;
  fixture?: unknown;
  transfer?: unknown;
  cleanup: {
    mainConnectionClosed: boolean;
    workerConnectionClosed: boolean | null;
    workerCloseObserved: boolean | null;
    workerExitCallbackObserved: boolean | null;
  };
};
async function runChild(childArgs: string[], sampleMemory = false) {
  const command = compiled
    ? [process.execPath]
    : [process.execPath, "--expose-gc", import.meta.path];
  const child = Bun.spawn([...command, ...childArgs], { stdout: "pipe", stderr: "pipe" });
  const stderrPromise = new Response(child.stderr).text();
  let stage = "startup";
  let done = false;
  let final: { result: ChildResult; failures: ReturnType<typeof errorDetails>[] } | undefined;
  const phases: Record<
    string,
    { samples: number; last: Resident; peak: Resident; maxIntervalMs: number }
  > = {};
  const sampler = (async () => {
    let previous = performance.now();
    while (!done && sampleMemory) {
      const sampledStage = stage;
      const sample = await resident(child.pid);
      const now = performance.now();
      // A sample spanning a stage change cannot establish either stage's memory usage.
      if (sample && stage === sampledStage) {
        const phase = phases[sampledStage];
        if (!phase)
          phases[sampledStage] = {
            samples: 1,
            last: sample,
            peak: { ...sample },
            maxIntervalMs: 0,
          };
        else {
          phase.samples++;
          phase.last = sample;
          for (const key of ["rssBytes", "rssAnonBytes", "rssFileBytes"] as const) {
            if (sample[key] !== null)
              phase.peak[key] = Math.max(phase.peak[key] ?? 0, sample[key]!);
          }
          phase.maxIntervalMs = Math.max(phase.maxIntervalMs, now - previous);
        }
      }
      previous = now;
      await Bun.sleep(settings.rssSampleIntervalMs);
    }
  })();
  const timeout = setTimeout(() => child.kill(), 180000);
  let parseError: unknown;
  try {
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const message = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (message.stage) stage = message.stage;
        else final = message;
        newline = pending.indexOf("\n");
      }
    }
    pending += decoder.decode();
    if (pending.trim()) throw new Error(`The child left an incomplete output frame: ${pending}`);
  } catch (error) {
    parseError = error;
    child.kill();
  }
  const exitCode = await child.exited;
  clearTimeout(timeout);
  done = true;
  await sampler;
  const stderr = await stderrPromise;
  if (parseError) throw parseError;
  if (!final || exitCode !== 0 || final.failures.length) {
    throw new Error(
      `Benchmark child failed (${exitCode}): ${JSON.stringify(final ?? {})}. ${stderr}`,
    );
  }
  const baseline = phases.baseline?.last;
  const idle = phases.idleAfterWarmup?.last;
  const peak = phases.workload?.peak;
  if (sampleMemory && (!baseline || !idle || !peak))
    throw new Error("The external sampler missed a required measurement boundary.");
  return {
    ...final.result,
    memory: sampleMemory
      ? {
          source: process.platform === "linux" ? "/proc/PID/status" : "ps -o rss (KiB)",
          baseline,
          idleAfterWarmup: idle,
          sampledWorkloadPeak: peak,
          sampledPeakChangeFromIdleBytes: peak!.rssBytes - idle!.rssBytes,
          sampledPeakChangeFromBaselineBytes: peak!.rssBytes - baseline!.rssBytes,
          afterCollection: phases.afterCollection?.last,
          phases,
        }
      : null,
  };
}
async function main() {
  const failures: ReturnType<typeof errorDetails>[] = [];
  const reviewTriggers: string[] = [];
  const report: Record<string, unknown> = {
    evidenceVersion: 2,
    phase: 0,
    platform: process.platform,
    arch: process.arch,
    compiled,
    bun: Bun.version,
    bunRevision: Bun.revision,
    pinnedBun: packageManager.split("@")[1],
    settings,
    measuredAtBCN: `${new Date().toLocaleString("sv-SE", { timeZone: "Europe/Madrid" })} BCN`,
    method:
      "Fresh process per case, driver, and round. Order sqlite/worker then worker/sqlite. Separate seed and transfer processes. External RSS sampling during work. Explicit synchronous GC in each active JS thread before warmups and samples.",
  };
  let directory: string | undefined;
  let directoryRemoved = false;
  try {
    directory = (await Bun.$`mktemp -d ${join(tmpdir(), "db-worker-phase0-XXXXXX")}`.text()).trim();
    const common = ["--directory", directory];
    report.seed = await runChild(["--child", "seed", ...common]);
    const results: unknown[] = [];
    report.cases = results;
    for (const entry of selected) {
      const rounds = [];
      for (let roundIndex = 0; roundIndex < settings.rounds; roundIndex++) {
        const order = args.driver
          ? [args.driver]
          : roundIndex === 0
            ? ["sqlite", "worker"]
            : ["worker", "sqlite"];
        const modes: Record<string, Awaited<ReturnType<typeof runChild>>> = {};
        for (const driver of order) {
          const workerExtension = args["worker-extension"]
            ? ["--worker-extension", args["worker-extension"]]
            : [];
          modes[driver] = await runChild(
            [
              "--child",
              "measure",
              "--driver",
              driver,
              "--case",
              entry.name,
              ...common,
              ...workerExtension,
            ],
            true,
          );
        }
        if (
          !entry.long &&
          modes.sqlite &&
          modes.worker &&
          !Bun.deepEquals(modes.sqlite.signature, modes.worker.signature)
        )
          throw new Error(`Rows differ for ${entry.name}.`);
        rounds.push({ order, modes });
      }
      const summaries: Record<string, Record<keyof Sample, ReturnType<typeof stats>>> = {};
      for (const driver of args.driver ? [args.driver] : ["sqlite", "worker"]) {
        const samples = rounds.flatMap((r) => r.modes[driver]!.samples!);
        summaries[driver] = Object.fromEntries(
          Object.keys(samples[0]!).map((key) => [
            key,
            stats(samples.map((s) => s[key as keyof Sample])),
          ]),
        ) as (typeof summaries)[string];
        if (entry.long) {
          if (
            driver === "worker" &&
            summaries[driver]!.transportLagMs.max > settings.maxWorkerLagMs
          )
            throw new Error("Worker long-query transport lag exceeds 50 ms.");
          if (
            summaries[driver]!.executionMs.p50 < settings.longTargetMs * 0.75 ||
            summaries[driver]!.executionMs.p50 > settings.longTargetMs * 1.5
          )
            throw new Error(
              `${driver} long-query execution no longer meets the calibration interval.`,
            );
        }
      }
      const sqlite = summaries.sqlite;
      const worker = summaries.worker;
      const ratio =
        !entry.long && sqlite && worker ? worker.roundTripMs.p50 / sqlite.roundTripMs.p50 : null;
      const overheadMs =
        !entry.long && sqlite && worker ? worker.roundTripMs.p50 - sqlite.roundTripMs.p50 : null;
      if (ratio !== null && ratio > 3)
        reviewTriggers.push(`${entry.name}: ${round(ratio)}x, ${round(overheadMs!)} ms overhead`);
      // Recursive queries calibrate independently. Their RTT difference cannot measure transport savings.
      const transfer = entry.long
        ? null
        : (
            await runChild([
              "--child",
              "transfer",
              "--driver",
              "sqlite",
              "--case",
              entry.name,
              ...common,
            ])
          ).transfer;
      results.push({
        name: entry.name,
        rows: entry.expectedRows,
        statementsPerRun: entry.statementsPerRun,
        summaries,
        ratio: ratio === null ? null : round(ratio),
        overheadMs: overheadMs === null ? null : round(overheadMs),
        transfer,
        rounds: rounds.map((r) => ({
          order: r.order,
          modes: Object.fromEntries(
            Object.entries(r.modes).map(([driver, data]) => {
              const { samples, ...rest } = data;
              return [
                driver,
                {
                  ...rest,
                  samples: samples!.map((s) =>
                    Object.fromEntries(
                      Object.entries(s).map(([key, value]) => [key, round(value)]),
                    ),
                  ),
                },
              ];
            }),
          ),
        })),
      });
      console.error(`[db-worker-phase0] ${entry.name}: ${JSON.stringify(summaries)}`);
    }
  } catch (error) {
    failures.push(errorDetails(error));
  } finally {
    if (directory) {
      try {
        await Bun.$`rm -rf ${directory}`.quiet();
        try {
          await stat(directory);
          failures.push(errorDetails(new Error("The owned directory still exists.")));
        } catch (error) {
          if (Reflect.get(error as object, "code") === "ENOENT") directoryRemoved = true;
          else failures.push(errorDetails(error));
        }
      } catch (error) {
        failures.push(errorDetails(error));
      }
    }
    report.cleanup = { directoryRemoved };
  }
  report.gate = {
    platformVerdict: failures.length ? "failed" : "review",
    failures,
    reviewTriggers,
    memoryDecision:
      "No memory acceptance budget exists. The parent must assess isolated memory and transfer costs.",
    crossPlatformVerdict: "Require macOS and compiled Linux evidence.",
  };
  process.stdout.write(`${JSON.stringify(report, null, args.json ? 0 : 2)}\n`);
  if (failures.length) process.exitCode = 1;
}
async function productionAssertion() {
  if (compiled)
    throw new Error(
      "Run production assertions from the source checkout. Verify the compiled API separately.",
    );
  const { mkdtemp, rm } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "db-worker-production-"));
  const oldDriver = process.env.DB_DRIVER;
  const oldPath = process.env.DATABASE_PATH;
  const oldKey = process.env.SECRETS_ENCRYPTION_KEY;
  process.env.DB_DRIVER = args.driver ?? "sqlite";
  process.env.DATABASE_PATH = join(directory, "db.sqlite");
  process.env.SECRETS_ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
  const template = globals.__testMigrationTemplate;
  delete globals.__testMigrationTemplate;
  let closeRuntime: (() => Promise<void>) | undefined;
  try {
    configureSQLite(await customSQLitePath());
    // Keep the Phase 0 compiled image independent of the API dependency graph.
    // Production assertions run from this checkout and load the actual runtime.
    const runtimePath = new URL("../src/be/db/runtime.ts", import.meta.url).href;
    const runtime: typeof import("../src/be/db/runtime") = await import(runtimePath);
    closeRuntime = runtime.closeDb;
    runtime.initDb(process.env.DATABASE_PATH);
    const client = runtime.getDbClient();
    await runtime.whenDbReady();
    if (runtime.getDbDriver() !== process.env.DB_DRIVER)
      throw new Error("The production client selected the wrong driver.");
    await client.run("CREATE TABLE phase1_probe (id INTEGER PRIMARY KEY, body TEXT)");
    await client.run("INSERT INTO phase1_probe VALUES (1, ?)", ["persisted"]);
    const row = await client.get<{ body: string }>("SELECT body FROM phase1_probe WHERE id=1");
    if (row?.body !== "persisted") throw new Error("The production write/read failed.");
    await client.run("CREATE VIRTUAL TABLE temp.phase1_vec USING vec0(embedding float[512])");
    const vector = new Uint8Array(new Float32Array(512).fill(0.25).buffer);
    await client.run("INSERT INTO temp.phase1_vec(rowid, embedding) VALUES (1, ?)", [vector]);
    const nearest = await client.get<{ rowid: number }>(
      "SELECT rowid FROM temp.phase1_vec WHERE embedding MATCH ? AND k=1",
      [vector],
    );
    if (nearest?.rowid !== 1 || !runtime.isSqliteVecAvailable())
      throw new Error("The production vector query failed.");
    const timedSql = `INSERT INTO phase1_probe(body) SELECT total FROM (${LONG_SQL})`;
    let iterations = 1_000_000;
    const calibration: unknown[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    const lagPath = new URL("../src/be/event-loop-lag.ts", import.meta.url).href;
    const {
      startEventLoopLagProbe,
      stopEventLoopLagProbe,
    }: typeof import("../src/be/event-loop-lag") = await import(lagPath);
    const threshold = process.env.EVENT_LOOP_STALL_WARN_MS;
    process.env.EVENT_LOOP_STALL_WARN_MS = "1";
    console.warn = (...values) => {
      warnings.push(values.map(String).join(" "));
    };
    startEventLoopLagProbe(5);
    let measured: { result: { changes: number; executionMs: number }; lagMs: number } | undefined;
    let roundTripMs = 0;
    try {
      for (let attempt = 0; attempt < 8; attempt++) {
        let statementRoundTripMs = 0;
        const candidate = await probe(async () => {
          const startedAt = performance.now();
          const result = await client.runTimed(timedSql, [iterations]);
          statementRoundTripMs = performance.now() - startedAt;
          return result;
        });
        calibration.push({
          iterations,
          executionMs: candidate.result.executionMs,
          roundTripMs: statementRoundTripMs,
          lagMs: candidate.lagMs,
        });
        if (candidate.result.executionMs >= 850 && candidate.result.executionMs <= 1300) {
          measured = candidate;
          roundTripMs = statementRoundTripMs;
          break;
        }
        iterations = Math.round((iterations * 1000) / Math.max(candidate.result.executionMs, 1));
      }
      if (runtime.getDbDriver() === "worker") {
        // A separate synthetic stall makes attribution observable after a reply.
        // It does not enter the measured query's lag or round-trip samples.
        stopEventLoopLagProbe();
        startEventLoopLagProbe(5);
        await client.get(LONG_SQL, [1_000_000]);
        const stallStartedAt = performance.now();
        while (performance.now() - stallStartedAt < 20) {}
      }
      await Bun.sleep(20);
    } finally {
      stopEventLoopLagProbe();
      console.warn = originalWarn;
      if (threshold === undefined) delete process.env.EVENT_LOOP_STALL_WARN_MS;
      else process.env.EVENT_LOOP_STALL_WARN_MS = threshold;
    }
    if (!measured) throw new Error("The production query could not calibrate near one second.");
    const worker = runtime.getDbDriver() === "worker";
    const stalls = warnings.filter((line) => line.includes("[event-loop] stall"));
    if (worker && stalls.some((line) => /db_ms=[1-9]/.test(line)))
      throw new Error("Worker duration entered synchronous stall attribution.");
    if (worker && !stalls.some((line) => line.includes("driver=worker worker_execution_ms=")))
      throw new Error("The Worker attribution probe did not observe execution time.");
    if (worker && measured.lagMs >= 50)
      throw new Error(`Worker main-thread lag exceeded 50ms: ${measured.lagMs}`);
    if (!worker && measured.lagMs < 500)
      throw new Error("The synchronous baseline did not block the main thread.");
    console.log(
      JSON.stringify(
        {
          productionClient: true,
          driver: runtime.getDbDriver(),
          vector: true,
          writeRead: true,
          calibration,
          ...measured,
          roundTripMs,
          transportAndSchedulingMs: roundTripMs - measured.result.executionMs,
          stalls: stalls.slice(-5),
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await closeRuntime?.();
    } finally {
      globals.__testMigrationTemplate = template;
      if (oldDriver === undefined) delete process.env.DB_DRIVER;
      else process.env.DB_DRIVER = oldDriver;
      if (oldPath === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = oldPath;
      if (oldKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
      else process.env.SECRETS_ENCRYPTION_KEY = oldKey;
      await rm(directory, { recursive: true, force: true });
    }
  }
}
if (args.assert) await productionAssertion();
else if (args.child) await child();
else await main();
