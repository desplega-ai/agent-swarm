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

// app-action-status re-reads an action's run tree every 500 ms for up to 25 s.
// Each level read is LIMITed, but a sort in front of the LIMIT still reads every
// child of a wide level. EXPLAIN ANALYZE of each level read must show no Sort
// and no node that returns more rows than the LIMIT.

const CHAIN_DIR = join(import.meta.dir, "..", "..", "..", "src", "be", "migrations", "postgres");
const T0 = "2026-11-25T00:00:00.000Z";

let scratch: ScratchDatabase;
let client: PostgresClient;
let storage: Storage;
const reads: { text: string; params: DbParam[] }[] = [];

beforeAll(async () => {
  scratch = await createScratchDatabase("runtree");
  client = createPostgresClient(scratch.url, { max: 2 });
  await runPostgresMigrations(client, { migrationsDir: CHAIN_DIR, log: () => {}, warn: () => {} });
  await client.run(`INSERT INTO agents (id, name, status, "createdAt", "lastUpdatedAt")
    VALUES ('ag', 'ag', 'idle', '${T0}', '${T0}')`);
  await client.run(`INSERT INTO script_run_sources (hash, source) VALUES ('h', 'x')`);
  const run = `INSERT INTO script_runs (id, "agentId", source, "sourceHash", args, "startedAt", "parentScriptRunId")`;
  await client.run(`${run} VALUES ('root', 'ag', '', 'h', '{}', '${T0}', NULL)`);
  // 10,000 direct children of one root.
  await client.run(`${run}
    SELECT 'c' || lpad(i::text, 5, '0'), 'ag', '', 'h', '{}',
      to_char(timestamp '2026-11-25' + i * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'root'
    FROM generate_series(0, 9999) AS i`);
  // A second tree whose second level has a frontier of two parents.
  await client.run(`${run} VALUES ('m', 'ag', '', 'h', '{}', '${T0}', NULL),
    ('m-a', 'ag', '', 'h', '{}', '${T0}', 'm'), ('m-b', 'ag', '', 'h', '{}', '${T0}', 'm'),
    ('m-a-0', 'ag', '', 'h', '{}', '${T0}', 'm-a'), ('m-a-1', 'ag', '', 'h', '{}', '${T0}', 'm-a'),
    ('m-b-0', 'ag', '', 'h', '{}', '${T0}', 'm-b'), ('m-b-1', 'ag', '', 'h', '{}', '${T0}', 'm-b')`);
  // Record each level read (text and params) to EXPLAIN it afterwards.
  const recording = new Proxy(client, {
    get(target, prop) {
      if (prop === "query") {
        return (text: string, params?: DbParam[]) => {
          if (text.includes(`"parentScriptRunId" IN (`)) reads.push({ text, params: params ?? [] });
          return target.query(text, params);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  storage = createPostgresStorage(recording, { vectorSearch: false, dbQuery: false });
});

afterAll(async () => {
  await client?.close();
  await scratch?.drop();
});

type PlanNode = {
  "Node Type": string;
  "Index Name"?: string;
  "Actual Rows": number;
  Plans?: PlanNode[];
};

function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

/** Each recorded level read: every node of its actual plan, its LIMIT, its frontier size. */
type LevelPlan = { all: PlanNode[]; limit: number; parents: number };

async function levelPlans(): Promise<LevelPlan[]> {
  const out: LevelPlan[] = [];
  for (const { text, params } of reads.splice(0)) {
    const [row] = await client.query<{ "QUERY PLAN": unknown }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${text}`,
      params,
    );
    const raw = row?.["QUERY PLAN"];
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as [{ Plan: PlanNode }];
    const plan = parsed?.[0]?.Plan;
    if (!plan) throw new Error("no plan");
    out.push({ all: nodes(plan), limit: Number(params.at(-1)), parents: params.length - 1 });
  }
  return out;
}

function expectBounded(plans: LevelPlan[]): void {
  for (const { all, limit } of plans) {
    expect(all.map((n) => n["Node Type"])).not.toContain("Sort");
    expect(all.map((n) => n["Node Type"])).not.toContain("Seq Scan");
    expect(Math.max(...all.map((n) => n["Actual Rows"]))).toBeLessThanOrEqual(limit);
    expect(all.some((n) => n["Index Name"] === "idx_script_runs_parent_started")).toBe(true);
  }
}

test("a wide level is read in index order up to the LIMIT, with no sort", async () => {
  reads.length = 0;
  const probe = await storage.repos.scripts.listScriptRunTree("root", { maxRows: 1, maxDepth: 0 });
  expect(probe).toMatchObject({ rows: [{ id: "root" }], truncated: true });
  const capped = await storage.repos.scripts.listScriptRunTree("root", {
    maxRows: 3,
    maxDepth: 5,
  });
  expect(capped.rows.map((r) => r.id)).toEqual(["root", "c00000", "c00001"]);
  expect(capped.truncated).toBe(true);
  const plans = await levelPlans();
  expect(plans.map((p) => p.limit)).toEqual([1, 3]);
  expectBounded(plans);
});

test("a frontier of several parents reads in index order too, with no sort", async () => {
  reads.length = 0;
  const tree = await storage.repos.scripts.listScriptRunTree("m", { maxRows: 6, maxDepth: 5 });
  expect(tree.rows.map((r) => r.id)).toEqual(["m", "m-a", "m-b", "m-a-0", "m-a-1", "m-b-0"]);
  expect(tree.truncated).toBe(true);
  const plans = await levelPlans();
  expect(plans.map((p) => p.parents)).toEqual([1, 2]);
  expectBounded(plans);
});
