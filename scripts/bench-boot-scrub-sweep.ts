/**
 * Benchmark for the boot re-scrub sweep on a large local DB.
 *
 *   bun scripts/bench-boot-scrub-sweep.ts gen <db> [rows]   build a session_logs corpus (default 1M)
 *   bun scripts/bench-boot-scrub-sweep.ts run <db>          sweep it with a fresh version key
 *
 * `run` prints rows/s and how long the event loop was blocked: a 1 ms timer
 * measures the gap between its ticks while the sweep runs, which is the delay
 * a request would see. Work on a copy: the sweep redacts the planted secrets.
 */
import { Database } from "bun:sqlite";
import { buildLinePool, rng } from "./bench-boot-scrub-corpus";

const [mode, dbPath, rowsArg] = process.argv.slice(2);
if (!mode || !dbPath) {
  console.error("usage: bench-boot-scrub-sweep.ts gen|run <db> [rows]");
  process.exit(1);
}

if (mode === "gen") {
  const { initDb, closeDb } = await import("../src/be/db");
  initDb(dbPath);
  closeDb();
  const rows = Number(rowsArg ?? 1_000_000);
  const pool = buildLinePool(new URL("..", import.meta.url).pathname);
  const rand = rng(7);
  const db = new Database(dbPath);
  db.run("PRAGMA journal_mode = WAL");
  const insert = db.prepare(
    "INSERT INTO session_logs (id, sessionId, iteration, cli, content, lineNumber, createdAt) VALUES (?, ?, 1, 'claude', ?, ?, ?)",
  );
  const now = new Date().toISOString();
  const chunk = 10_000;
  for (let start = 0; start < rows; start += chunk) {
    db.transaction(() => {
      for (let i = start; i < Math.min(start + chunk, rows); i++) {
        const line = pool[Math.floor(rand() * pool.length)] as string;
        insert.run(crypto.randomUUID(), `session-${Math.floor(i / 500)}`, line, i % 500, now);
      }
    })();
  }
  db.close();
  console.log(`wrote ${rows} session_logs rows to ${dbPath}`);
} else {
  const { initDb, getDbClient } = await import("../src/be/db");
  const { runBootScrubSweep } = await import("../src/be/boot-scrub-sweep");
  initDb(dbPath);
  // The first scrub compiles the rule tables (seconds). The server pays that at boot, so keep it out of the loop-gap numbers.
  (await import("../src/utils/secret-scrubber")).scrubSecrets("warm up");
  const total = (await getDbClient().get<{ n: number }>("SELECT count(*) AS n FROM session_logs"))
    ?.n;

  // The delay a request sees: gaps between ticks of a 1 ms timer.
  const gaps: number[] = [];
  let last = performance.now();
  const runStart = last;
  let worst = { gap: 0, atSecond: 0 };
  const probe = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    if (now - last > 500) console.error(`loop gap ${Math.round(now - last)} ms at ${((now - runStart) / 1000).toFixed(1)}s`);
    if (now - last > worst.gap) worst = { gap: now - last, atSecond: (now - runStart) / 1000 };
    last = now;
  }, 1);

  const version = 900_000 + (Math.floor(Date.now() / 1000) % 100_000);
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const stats = await runBootScrubSweep({ version, reembed: false });
  const seconds = (performance.now() - started) / 1000;
  const cpu = process.cpuUsage(cpuStart);
  clearInterval(probe);

  gaps.sort((a, b) => a - b);
  const pct = (p: number) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] as number;
  const logs = stats?.find((s) => s.table === "session_logs");
  console.log(
    JSON.stringify({
      rows: total,
      scanned: logs?.scanned,
      changed: logs?.changed,
      seconds: Number(seconds.toFixed(1)),
      rowsPerSecond: Math.round((logs?.scanned ?? 0) / seconds),
      // CPU time of this process, which holds under host load where wall time does not.
      cpuSeconds: Number(((cpu.user + cpu.system) / 1e6).toFixed(1)),
      rowsPerCpuSecond: Math.round((logs?.scanned ?? 0) / ((cpu.user + cpu.system) / 1e6)),
      loopGapMs: {
        p50: Number(pct(0.5).toFixed(1)),
        p99: Number(pct(0.99).toFixed(1)),
        p999: Number(pct(0.999).toFixed(1)),
        max: Number((gaps[gaps.length - 1] ?? 0).toFixed(1)),
        maxAtSecond: Number(worst.atSecond.toFixed(1)),
      },
    }),
  );
}
process.exit(0);
