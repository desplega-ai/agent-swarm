#!/usr/bin/env bun
/**
 * Slack render-v2 reconcile bench: seeds a SQLite DB sized like production
 * (2026-11-03) and times the three discovery queries the watcher runs on every
 * reconcile tick, with their EXPLAIN QUERY PLAN.
 *
 *   bun scripts/bench-slack-render-v2.ts                        # seed + time
 *   bun scripts/bench-slack-render-v2.ts --db /tmp/rv2.sqlite   # reuse a seeded DB
 *   bun scripts/bench-slack-render-v2.ts --json > /tmp/rv2.json
 *
 * Seeded shape (production counts, 2026-11-03):
 * - 150,000 tasks in total; render v2 activated 89 days ago.
 * - 2,119 threads with a tree row, 260 of them updated in the last 7 days.
 * - 8,711 Slack tasks since activation, 590 of them in the last 7 days.
 * - 8,376 outcome cards. 1,774 tasks with deferredAt. 2,547 wake-up tasks
 *   (taskType = 'deferred').
 * - 3 threads with a running task, so the tree sweep returns 3 trees.
 *
 * The seed is deterministic (fixed PRNG) and relative to the seed time. A
 * `--db` path that already holds the seed is reused as is: seed once on one
 * checkout, copy the file, and open the copy on another checkout to compare.
 * Opening it on a newer checkout applies that checkout's migrations first.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  closeDb,
  getDb,
  getDbClient,
  getResolvableDeferralOutcomes,
  getSlackTreeMessages,
  initDb,
} from "../src/be/db";
import { getSlackTasksMissingTree } from "../src/be/db/tasks/read";

const { values: args } = parseArgs({
  options: {
    db: { type: "string", default: "/tmp/bench-slack-render-v2.sqlite" },
    runs: { type: "string", default: "30" },
    json: { type: "boolean", default: false },
  },
});

const log = (...parts: unknown[]) => console.error("[bench-slack-render-v2]", ...parts);
if (args.json) console.log = console.error;

const DAY = 86_400_000;
const TOTAL_TASKS = 150_000;
const TREES = 2_119;
const RECENT_TREES = 260;
const SLACK_TASKS = 8_711;
const RECENT_SLACK_TASKS = 590;
const PRE_ACTIVATION_SLACK_TASKS = 3_000;
const OUTCOME_CARDS = 8_376;
const DEFERRED_AT = 1_774;
const WAKES = 2_547;
const ACTIVE_TREES = 3;

let seed = 0x5eed;
function rand(): number {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const iso = (ms: number) => new Date(ms).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function seedDb(): void {
  const db = getDb();
  const now = Date.now();
  const activatedAt = now - 89 * DAY;
  db.run("INSERT OR REPLACE INTO slack_render_v2_state (id, activated_at) VALUES (1, ?)", [
    iso(activatedAt),
  ]);
  const insertTask = db.prepare(
    `INSERT INTO agent_tasks (id, task, status, source, taskType, parentTaskId,
       slackChannelId, slackThreadTs, createdAt, lastUpdatedAt, finishedAt, deferredAt)
     VALUES (?, 'bench', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMessage = db.prepare(
    `INSERT INTO slack_messages (id, context_key, channel_id, thread_ts, ts, kind, task_id,
       permalink, finalized_at, created_at, updated_at, deferral_resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'https://slack.example/p', ?, ?, ?, ?)`,
  );
  let n = 0;
  const seedAll = db.transaction(() => {
    // Threads: the newest RECENT_TREES were updated in the last 7 days.
    const threads: { channel: string; ts: string; start: number; end: number; recent: boolean }[] =
      [];
    for (let i = 0; i < TREES; i++) {
      const recent = i >= TREES - RECENT_TREES;
      const start = recent
        ? now - 7 * DAY + rand() * 7 * DAY
        : activatedAt + rand() * (82 * DAY - 2 * DAY);
      threads.push({
        channel: `C${(i % 40).toString().padStart(4, "0")}`,
        ts: `${Math.floor(start / 1000)}.${i.toString().padStart(6, "0")}`,
        start,
        end: start,
        recent,
      });
    }
    const slackTasks: { id: string; created: number; thread: (typeof threads)[number] }[] = [];
    for (let i = 0; i < SLACK_TASKS; i++) {
      const recent = i < RECENT_SLACK_TASKS;
      const pool = recent
        ? threads.slice(TREES - RECENT_TREES)
        : threads.slice(0, TREES - RECENT_TREES);
      const thread = pool[i % pool.length]!;
      const created = Math.min(now - 60_000, thread.start + rand() * 2 * DAY);
      const finished = created + 60_000 + rand() * 600_000;
      thread.end = Math.max(thread.end, finished);
      const id = uuid(++n);
      slackTasks.push({ id, created, thread });
      insertTask.run(
        id,
        // Tasks past the card count ended without an outcome card.
        i < OUTCOME_CARDS ? "completed" : "skipped",
        "slack",
        null,
        null,
        thread.channel,
        thread.ts,
        iso(created),
        iso(finished),
        iso(finished),
        null,
      );
    }
    // Slack threads from before activation, without trees.
    for (let i = 0; i < PRE_ACTIVATION_SLACK_TASKS; i++) {
      const created = activatedAt - rand() * 60 * DAY;
      insertTask.run(
        uuid(++n),
        "completed",
        "slack",
        null,
        null,
        `C${(i % 40).toString().padStart(4, "0")}`,
        `${Math.floor(created / 1000)}.9${i.toString().padStart(5, "0")}`,
        iso(created),
        iso(created + 60_000),
        iso(created + 60_000),
        null,
      );
    }
    // Outcome cards: one per Slack task, oldest-first, up to OUTCOME_CARDS.
    const carded = slackTasks.slice(0, OUTCOME_CARDS);
    // Deferral chains. DEFERRING_ASKS carded asks deferred once. CHAIN_ASKS of
    // them are recurring pollers: their wakes re-deferred, the last wake is
    // still pending, so their card stays unresolved and the resolution query
    // walks the whole chain on every tick. Every other card is resolved.
    const DEFERRING_ASKS = 1_000;
    const CHAIN_ASKS = 150;
    const REDEFER_WAKES = DEFERRED_AT - DEFERRING_ASKS;
    const deferring = carded.slice(0, DEFERRING_ASKS);
    const deferringIds = new Set(deferring.map((t) => t.id));
    const unresolvedIds = new Set(deferring.slice(0, CHAIN_ASKS).map((t) => t.id));
    for (const [i, t] of carded.entries()) {
      const finalized = iso(t.created + 700_000);
      insertMessage.run(
        uuid(++n),
        `slack:${t.thread.channel}:${t.thread.ts}`,
        t.thread.channel,
        t.thread.ts,
        `${t.thread.ts}.c${i}`,
        "outcome",
        t.id,
        finalized,
        finalized,
        finalized,
        deferringIds.has(t.id) && !unresolvedIds.has(t.id) ? finalized : null,
      );
    }
    db.run(
      `UPDATE agent_tasks SET deferredAt = finishedAt WHERE id IN (${deferring
        .map(() => "?")
        .join(",")})`,
      deferring.map((t) => t.id),
    );
    const insertWake = (
      parentId: string,
      created: number,
      opts: { tail?: boolean; redefer?: boolean },
    ) => {
      const id = uuid(++n);
      const done = iso(created + 60_000);
      insertTask.run(
        id,
        opts.tail ? "pending" : "completed",
        "schedule",
        "deferred",
        parentId,
        null,
        null,
        iso(created),
        opts.tail ? iso(created) : done,
        opts.tail ? null : done,
        opts.redefer ? done : null,
      );
      return id;
    };
    let wakeCount = 0;
    // One-shot deferrals: a single completed wake.
    for (const ask of deferring.slice(CHAIN_ASKS)) {
      insertWake(ask.id, ask.created + DAY, {});
      wakeCount++;
    }
    // Recurring chains: REDEFER_WAKES re-deferring links, then a pending tail.
    for (const [i, ask] of deferring.slice(0, CHAIN_ASKS).entries()) {
      const links =
        Math.floor(REDEFER_WAKES / CHAIN_ASKS) + (i < REDEFER_WAKES % CHAIN_ASKS ? 1 : 0);
      let parentId = ask.id;
      let created = ask.created;
      for (let l = 0; l < links; l++) {
        created += 3_600_000;
        parentId = insertWake(parentId, created, { redefer: true });
        wakeCount++;
      }
      insertWake(parentId, created + 3_600_000, { tail: true });
      wakeCount++;
    }
    // Other deferred-type tasks (wakes of non-Slack deferrals, already done).
    while (wakeCount < WAKES) {
      insertWake(uuid(TOTAL_TASKS + 1_000_000 + wakeCount), now - rand() * 80 * DAY, {});
      wakeCount++;
    }
    // Trees: one per thread, updated at the last task's finish.
    for (const [i, t] of threads.entries()) {
      insertMessage.run(
        uuid(++n),
        `slack:${t.channel}:${t.ts}`,
        t.channel,
        t.ts,
        `${t.ts}.t${i}`,
        "tree",
        null,
        null,
        iso(t.start),
        // After the last task and its outcome card (finalized ~12 min in).
        iso(t.end + 3_600_000),
        null,
      );
    }
    // Running tasks in the newest ACTIVE_TREES threads.
    for (const t of threads.slice(-ACTIVE_TREES)) {
      insertTask.run(
        uuid(++n),
        "in_progress",
        "slack",
        null,
        null,
        t.channel,
        t.ts,
        iso(now - 120_000),
        iso(now - 120_000),
        null,
        null,
      );
    }
    // Everything else: non-Slack history spread over 150 days.
    const types = [null, null, null, "feature", "bug", "research", "heartbeat"];
    while (n < TOTAL_TASKS + OUTCOME_CARDS + TREES) {
      const created = now - rand() * 150 * DAY;
      insertTask.run(
        uuid(++n),
        rand() < 0.02 ? "failed" : "completed",
        rand() < 0.5 ? "mcp" : "schedule",
        types[Math.floor(rand() * types.length)] ?? null,
        null,
        null,
        null,
        iso(created),
        iso(created + 60_000),
        iso(created + 60_000),
        null,
      );
    }
  });
  seedAll.immediate();
  // No ANALYZE: production has no sqlite_stat1, so the planner uses heuristics.
  db.run("CREATE TABLE IF NOT EXISTS bench_slack_render_v2_meta (seeded_at TEXT)");
  db.run("INSERT INTO bench_slack_render_v2_meta VALUES (?)", [iso(now)]);
}

async function captureSql(run: () => Promise<unknown>): Promise<string> {
  const client = getDbClient();
  const original = client.query.bind(client);
  const seen: string[] = [];
  client.query = ((sql: string, params?: unknown[]) => {
    seen.push(sql);
    return original(sql, params);
  }) as typeof client.query;
  try {
    await run();
  } finally {
    client.query = original;
  }
  return seen[0] ?? "";
}

async function timeIt(
  name: string,
  run: () => Promise<unknown[]>,
  params: unknown[] = [],
): Promise<{ name: string; rows: number; medianMs: number; p95Ms: number; plan: string }> {
  const sql = await captureSql(run);
  const plan = getDb()
    .query<{ detail: string }, any[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail)
    .join("\n");
  for (let i = 0; i < 3; i++) await run();
  const samples: number[] = [];
  let rows = 0;
  for (let i = 0; i < Number(args.runs); i++) {
    const start = performance.now();
    rows = (await run()).length;
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const pick = (q: number) => Number(samples[Math.floor(q * (samples.length - 1))]!.toFixed(2));
  return { name, rows, medianMs: pick(0.5), p95Ms: pick(0.95), plan };
}

const fresh = !existsSync(args.db);
initDb(args.db);
const seeded = getDb()
  .query<{ n: number }, []>(
    "SELECT count(*) AS n FROM sqlite_master WHERE name = 'bench_slack_render_v2_meta'",
  )
  .get();
if (fresh || !seeded?.n) {
  log(`seeding ${args.db}`);
  const start = performance.now();
  seedDb();
  log(`seeded in ${((performance.now() - start) / 1000).toFixed(1)}s`);
} else {
  log(`reusing ${args.db}`);
}

const results = [
  await timeIt("getSlackTasksMissingTree", () => getSlackTasksMissingTree()),
  await timeIt("getSlackTreeMessages", () => getSlackTreeMessages()),
  await timeIt("getResolvableDeferralOutcomes", () => getResolvableDeferralOutcomes(), [50]),
];
const total = Number(results.reduce((sum, r) => sum + r.medianMs, 0).toFixed(2));
if (args.json) {
  process.stdout.write(
    `${JSON.stringify({ db: args.db, results, totalMedianMs: total }, null, 2)}\n`,
  );
} else {
  for (const r of results) {
    console.error(`\n## ${r.name}: ${r.rows} rows, median ${r.medianMs} ms, p95 ${r.p95Ms} ms`);
    console.error(r.plan);
  }
  console.error(`\nSum of medians: ${total} ms`);
}
closeDb();
