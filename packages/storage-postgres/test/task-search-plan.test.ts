import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { DbParam, Storage } from "@desplega/storage";
import {
  createPostgresClient,
  createPostgresStorage,
  type PostgresClient,
  runPostgresMigrations,
} from "../src";
import { createScratchDatabase, type ScratchDatabase } from "./scratch";

// A task search must read the full-text indexes, not rebuild the tsvector of
// each task text: on a production-sized table each rebuild costs milliseconds
// and a search took 25-45 s. Every task here has both "ping" and "gate", and
// three have the phrase "ping-gate". EXPLAIN ANALYZE of every search query must
// rebuild the tsvector of at most a handful of rows.

const CHAIN_DIR = join(import.meta.dir, "..", "..", "..", "src", "be", "migrations", "postgres");
const ROWS = 2000;

let scratch: ScratchDatabase;
let client: PostgresClient;
let storage: Storage;
const reads: { text: string; params: DbParam[]; indexOnly: boolean }[] = [];
let indexOnly = false;

beforeAll(async () => {
  scratch = await createScratchDatabase("tasksearch");
  client = createPostgresClient(scratch.url, { max: 2 });
  await runPostgresMigrations(client, { migrationsDir: CHAIN_DIR, log: () => {}, warn: () => {} });
  await client.run(`UPDATE agent_tasks_fts_state SET "indexedThrough" = 9007199254740991 WHERE id = 1`);
  await client.run(`INSERT INTO agent_tasks (id, task, title, status, "createdAt", "lastUpdatedAt")
    SELECT 'task-' || lpad(i::text, 5, '0'),
      'ping ' || (SELECT string_agg(md5((i * 100 + j)::text), ' ') FROM generate_series(1, 40) j)
        || ' gate ' || md5(i::text)
        || CASE WHEN i IN (7, 700, 1400) THEN ' run ping-gate now' WHEN i = 900 THEN ' ping gate alpha' ELSE '' END,
      'title ' || i, 'completed',
      timestamptz '2026-11-01Z' + i * interval '1 minute', timestamptz '2026-11-01Z' + i * interval '1 minute'
    FROM generate_series(1, ${ROWS}) AS i`);
  await client.run(`ANALYZE agent_tasks`);
  // Record each search read (text, params and the enable_seqscan setting it
  // ran under) to EXPLAIN it afterwards.
  const record = (text: string, params?: DbParam[]) => {
    if (/enable_seqscan = off/.test(text)) indexOnly = true;
    if (/enable_seqscan TO DEFAULT/.test(text)) indexOnly = false;
    if (/agent_tasks/.test(text) && /@@|"_rowid" IN/.test(text)) {
      reads.push({ text, params: params ?? [], indexOnly });
    }
  };
  const recording = new Proxy(client, {
    get(target, prop) {
      if (prop === "query" || prop === "get" || prop === "run") {
        return (text: string, params?: DbParam[]) => {
          record(text, params);
          return target[prop](text, params);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  storage = createPostgresStorage(recording, { vectorSearch: false, dbQuery: false });
}, 60_000); // applies the full baseline: a budget, not a retry

afterAll(async () => {
  await client?.close();
  await scratch?.drop();
});

type PlanNode = {
  "Node Type": string;
  Filter?: string;
  "Recheck Cond"?: string;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  "Actual Rows": number;
  "Actual Loops": number;
  Plans?: PlanNode[];
};

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

/** Rows whose tsvector a plan rebuilt: each row a tsvector filter or recheck read. */
function rebuiltRows(plan: PlanNode): number {
  let rows = 0;
  for (const node of nodes(plan)) {
    const loops = node["Actual Loops"] || 1;
    if (node.Filter?.includes("to_tsvector")) {
      rows += (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * loops;
    }
    if (node["Recheck Cond"]?.includes("to_tsvector")) {
      rows += (node["Rows Removed by Index Recheck"] ?? 0) * loops;
    }
  }
  return rows;
}

/** The largest rebuild count across the recorded search reads. */
async function maxRebuilt(): Promise<number> {
  let max = 0;
  for (const { text, params, indexOnly } of reads.splice(0)) {
    const [row] = await client.transaction(async (tx) => {
      if (indexOnly) await tx.run("SET LOCAL enable_seqscan = off");
      return tx.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params);
    });
    const raw = row?.["QUERY PLAN"];
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as [{ Plan: PlanNode }];
    const plan = parsed?.[0]?.Plan;
    if (!plan) throw new Error("no plan");
    max = Math.max(max, rebuiltRows(plan));
  }
  return max;
}

async function search(term: string): Promise<{ page: string[]; count: number }> {
  const rows = await storage.repos.tasks.listTasks(
    { search: term },
    { limit: 25, offset: 0 },
    "slim",
  );
  const count = await storage.repos.tasks.countTasks({ search: term });
  return { page: rows.map((row) => String(row.id)).sort(), count };
}

test("a two-word phrase whose words every task has reads the pair index", async () => {
  reads.length = 0;
  const phrase = { page: ["task-00007", "task-00700", "task-00900", "task-01400"], count: 4 };
  expect(await search("ping-gate")).toEqual(phrase);
  expect(await search("PING gat")).toEqual(phrase);
  expect(await maxRebuilt()).toBeLessThanOrEqual(5);
});

test("a longer phrase rebuilds only the rows that have every pair", async () => {
  reads.length = 0;
  expect(await search("ping gate alpha")).toEqual({ page: ["task-00900"], count: 1 });
  expect(await search("gate ping")).toEqual({ page: [], count: 0 });
  expect(await maxRebuilt()).toBeLessThanOrEqual(5);
});

test("a word that matches no task, one that matches all, and an id prefix", async () => {
  reads.length = 0;
  expect(await search("zzqxnonsense")).toEqual({ page: [], count: 0 });
  const common = await search("ping");
  expect(common.page).toHaveLength(25);
  expect(common.count).toBe(ROWS);
  expect(await search("task-0001")).toEqual({
    page: Array.from({ length: 10 }, (_, i) => `task-0001${i}`),
    count: 10,
  });
  expect(await maxRebuilt()).toBeLessThanOrEqual(5);
});
