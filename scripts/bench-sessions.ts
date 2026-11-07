#!/usr/bin/env bun
/**
 * Sessions page bench: seeds a SQLite DB with the production chain shape and
 * times the sidebar queries (list, count, tree) plus the task progress write.
 *
 *   bun scripts/bench-sessions.ts --text-kb 16 --json > /tmp/bench.json
 *   bun scripts/bench-sessions.ts --db /tmp/bench-sessions.sqlite   # reuse a seeded DB
 *
 * The seed is deterministic (fixed PRNG). A `--db` path that already holds the
 * bench seed is reused as is, so later runs time the same data. Logs go to
 * stderr; `--json` prints only the result object on stdout.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { defaultAssetKey } from "../src/assets/key";
import {
  closeDb,
  countSessions,
  getDb,
  initDb,
  listRecentSessions,
  updateTaskProgress,
} from "../src/be/db";
import { getSessionTree, type SessionFilters, sessionSummaryQuery } from "../src/be/db/session-tree";

const { values: args } = parseArgs({
  options: {
    db: { type: "string", default: "/tmp/bench-sessions.sqlite" },
    "text-kb": { type: "string", default: "16" },
    roots: { type: "string", default: "29230" },
    runs: { type: "string", default: "20" },
    updates: { type: "string", default: "5000" },
    json: { type: "boolean", default: false },
  },
});

const log = (...parts: unknown[]) => console.error("[bench-sessions]", ...parts);
// initDb and the migration runner log to stdout; keep stdout for the JSON result.
if (args.json) console.log = console.error;
const ROOTS = Number(args.roots);
const TEXT_BYTES = Number(args["text-kb"]) * 1024;
const RUNS = Number(args.runs);
const UPDATES = Number(args.updates);
const USERS = 20;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const DAY = 86_400_000;

// mulberry32: a small deterministic PRNG, so every run seeds the same data.
let seed = 0x5e55_1015;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
const iso = (ms: number) => new Date(ms).toISOString();
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const n = Math.floor(rand() * 16);
    return (c === "x" ? n : (n & 0x3) | 0x8).toString(16);
  });

/**
 * Chain sizes with the production histogram (2026-10-27): 22,273 singletons,
 * 6,371 chains of 2-10, 583 of 11-100 and 3 of 102, about 54.8k tasks.
 */
function chainSize(): number {
  const r = rand() * 29_230;
  if (r < 22_273) return 1;
  if (r < 22_273 + 6_371) return 2 + Math.floor(9 * rand() ** 6);
  if (r < 29_227) return 11 + Math.floor(90 * rand() ** 5);
  return 102;
}

const ROOT_SOURCES = ["ui", "ui", "ui", "slack", "slack", "mcp", "schedule", "workflow", "system", "api"];
const CHILD_SOURCES = ["mcp", "mcp", "system", "workflow", "ui", "slack"];
const STATUSES = ["completed", "completed", "completed", "completed", "failed", "cancelled", "in_progress"];

function seedDb(): { userIds: string[]; taskIds: string[] } {
  const db = getDb();
  const filler = "lorem ipsum dolor sit amet ".repeat(Math.ceil(TEXT_BYTES / 27)).slice(0, TEXT_BYTES);
  const userIds = Array.from({ length: USERS }, (_, i) => `benchuser${String(i).padStart(2, "0")}`);
  const insertUser = db.prepare(
    "INSERT INTO users (id, name, email, role, status, createdAt, lastUpdatedAt) VALUES (?, ?, ?, 'member', 'active', ?, ?)",
  );
  const insertTask = db.prepare(
    `INSERT INTO agent_tasks (id, "key", task, title, status, source, parentTaskId, requestedByUserId,
       requestedByUserIdInherited, slackChannelId, output, createdAt, lastUpdatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertState = db.prepare(
    `INSERT INTO inbox_item_state (userId, itemType, itemId, status, snoozeUntil, lastReadAt, createdAt, lastUpdatedAt)
     VALUES (?, 'to_read', ?, ?, ?, ?, ?, ?)`,
  );
  const insertShare = db.prepare(
    "INSERT INTO session_shares (id, rootTaskId, userId, access, createdAt) VALUES (?, ?, ?, 'read', ?)",
  );
  const taskIds: string[] = [];
  db.transaction(() => {
    for (const id of userIds) insertUser.run(id, id, `${id}@bench.local`, iso(NOW - 400 * DAY), iso(NOW));
    for (let i = 0; i < ROOTS; i++) {
      const rootId = uuid();
      const source = pick(ROOT_SOURCES);
      const human = source === "ui" || source === "slack" || source === "api";
      const user = human || rand() < 0.5 ? pick(userIds) : null;
      const channel = source === "slack" ? `C${Math.floor(rand() * 40)}` : null;
      const key = channel
        ? `shared/slack/${channel.toLowerCase()}/thread:${Math.floor(rand() * 4000)}.1/`
        : defaultAssetKey("task", rootId);
      const createdMs = NOW - Math.floor(rand() ** 2 * 90 * DAY);
      const size = chainSize();
      const members: { id: string; at: number }[] = [{ id: rootId, at: createdMs }];
      let last = createdMs + Math.floor(rand() * 600_000);
      insertTask.run(
        rootId,
        key,
        `${rootId} ${filler}`,
        `Session ${i}`,
        size === 1 ? pick(STATUSES) : "completed",
        source,
        null,
        user,
        0,
        channel,
        rand() < 0.7 ? `Done: ${i}` : null,
        iso(createdMs),
        iso(last),
      );
      taskIds.push(rootId);
      for (let c = 1; c < size; c++) {
        const id = uuid();
        // Half the children extend the newest task (deep chains), half fan out.
        const parent = rand() < 0.5 ? members[members.length - 1]! : pick(members);
        const at = parent.at + Math.floor(rand() * 3_600_000);
        last = Math.max(last, at + Math.floor(rand() * 600_000));
        const childSource = pick(CHILD_SOURCES);
        const explicit = (childSource === "ui" || childSource === "slack") && user !== null;
        insertTask.run(
          id,
          defaultAssetKey("task", id),
          `${id} ${filler}`,
          null,
          c === size - 1 ? pick(STATUSES) : "completed",
          childSource,
          parent.id,
          user,
          explicit ? 0 : 1,
          null,
          rand() < 0.7 ? `Child output ${c}` : null,
          iso(at),
          iso(last),
        );
        members.push({ id, at });
        taskIds.push(id);
      }
      // The viewer triaged some of their sessions; a few are shared.
      if (user && rand() < 0.35) {
        const status = pick(["done", "done", "snoozed", "open"]);
        insertState.run(
          user,
          rootId,
          status,
          status === "snoozed" ? iso(NOW + DAY) : null,
          iso(last),
          iso(last),
          iso(last),
        );
      }
      if (user && rand() < 0.02) insertShare.run(uuid(), rootId, pick(userIds), iso(last));
    }
  })();
  return { userIds, taskIds };
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    runs: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted[sorted.length - 1]!),
    mean: round(sorted.reduce((s, n) => s + n, 0) / sorted.length),
  };
}

async function time(label: string, runs: number, fn: () => Promise<unknown>) {
  for (let i = 0; i < 2; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  const result = stats(samples);
  log(`${label}: p50 ${result.p50} ms, p95 ${result.p95} ms`);
  return result;
}

function plan(sql: string, params: unknown[]): string[] {
  return getDb()
    .prepare<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(params as never[]))
    .map((row) => row.detail);
}

async function main() {
  const reuse = existsSync(args.db!);
  initDb(args.db);
  const db = getDb();
  // The plan dump must reflect a DB with no ANALYZE stats, as on prod.
  db.run("DROP TABLE IF EXISTS sqlite_stat1");
  const seeded = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE id LIKE 'benchuser%'").get()!.n > 0;
  let seedMs: number | null = null;
  if (!seeded) {
    log(`seeding ${ROOTS} roots with ${args["text-kb"]} KB task text into ${args.db}`);
    const start = performance.now();
    seedDb();
    seedMs = Math.round(performance.now() - start);
    log(`seeded in ${seedMs} ms`);
  } else if (!reuse) {
    throw new Error("unreachable: a new DB cannot hold the bench seed");
  } else {
    log(`reusing seeded DB ${args.db}`);
  }
  const shape = db
    .prepare<{ tasks: number; roots: number; mb: number }, []>(
      `SELECT COUNT(*) AS tasks, SUM(parentTaskId IS NULL) AS roots,
        (SELECT page_count * page_size / 1048576 FROM pragma_page_count, pragma_page_size) AS mb
       FROM agent_tasks`,
    )
    .get()!;
  log(`shape: ${shape.tasks} tasks, ${shape.roots} roots, ${shape.mb} MB`);

  // The viewer with the most triaged sessions, so the Inbox filter has work to do.
  const viewer = db
    .prepare<{ userId: string }, []>(
      "SELECT userId FROM inbox_item_state WHERE userId LIKE 'benchuser%' GROUP BY userId ORDER BY COUNT(*) DESC LIMIT 1",
    )
    .get()!.userId;
  const now = new Date(NOW).toISOString();
  // GET /api/sessions?scope=tree&limit=20&triage=inbox&showSource=ui (the sidebar Inbox).
  const sidebar: SessionFilters = {
    viewer: { userId: viewer, scope: "all" },
    tree: true,
    mine: true,
    showSource: ["ui"],
    triage: "inbox",
    now,
  };
  const list = await time("list (inbox, page 1)", RUNS, () =>
    listRecentSessions({ ...sidebar, limit: 20, slim: true }),
  );
  const count = await time("count (inbox)", RUNS, () => countSessions(sidebar));
  const tree = await time("tree (mine)", RUNS, () =>
    getSessionTree({ kind: "user", userId: viewer }, now, { mine: true, showSource: ["ui"] }),
  );
  const treeAll = await time("tree (all)", RUNS, () =>
    getSessionTree({ kind: "user", userId: viewer }, now, { mine: false, showSource: ["ui"] }),
  );

  const chainTasks = db
    .prepare<{ id: string }, []>(
      "SELECT id FROM agent_tasks WHERE parentTaskId IS NOT NULL ORDER BY id LIMIT 2000",
    )
    .all()
    .map((row) => row.id);
  const updateSamples: number[] = [];
  for (let i = 0; i < UPDATES; i++) {
    const id = chainTasks[i % chainTasks.length]!;
    const start = performance.now();
    await updateTaskProgress(id, `bench progress ${i}`);
    updateSamples.push(performance.now() - start);
  }
  const progress = stats(updateSamples);
  log(`updateTaskProgress x${UPDATES}: p50 ${progress.p50} ms, p95 ${progress.p95} ms`);

  const summary = sessionSummaryQuery(sidebar);
  const result = {
    db: args.db,
    textKb: Number(args["text-kb"]),
    seedMs,
    shape,
    viewer,
    timingsMs: { list, count, tree, treeAll, updateTaskProgress: progress },
    queryPlan: { sessionSummary: plan(summary.sql, summary.params) },
  };
  closeDb();
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else log(JSON.stringify(result.queryPlan, null, 2));
}

await main();
