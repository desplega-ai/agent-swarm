import { Database, type SQLQueryBindings } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import compoundInsights from "../be/seed-scripts/catalog/compound-insights";
import toolUsage from "../be/seed-scripts/catalog/tool-usage";

afterEach(() => setSystemTime());

test("seeded reports respect the millisecond cutoff on the cutoff date", async () => {
  setSystemTime(new Date("2026-11-19T12:00:00.500Z"));
  using db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_logs (content TEXT, createdAt TEXT);
    CREATE TABLE agent_tasks (status TEXT, failureReason TEXT, createdAt TEXT);
    CREATE TABLE agent_memory (
      id TEXT, name TEXT, content TEXT, scope TEXT, source TEXT, accessCount INTEGER,
      sourceTaskId TEXT, sourcePath TEXT, alpha REAL, beta REAL, embedding BLOB, createdAt TEXT
    );
  `);

  const entries = [
    { tool: "before", status: "failed", source: "manual", time: "2026-11-18T12:00:00.499Z" },
    { tool: "exact", status: "pending", source: "file_index", time: "2026-11-18T12:00:00.500Z" },
    {
      tool: "after",
      status: "completed",
      source: "file_index",
      time: "2026-11-18T12:00:00.501Z",
    },
  ];
  for (const { tool, status, source, time } of entries) {
    db.run("INSERT INTO session_logs VALUES (?, ?)", [
      JSON.stringify({ type: "tool_use", name: tool }),
      time,
    ]);
    db.run("INSERT INTO agent_tasks VALUES (?, NULL, ?)", [status, time]);
    db.run(
      "INSERT INTO agent_memory (scope, source, accessCount, sourcePath, createdAt) VALUES ('agent', ?, 0, '/test', ?)",
      [source, time],
    );
  }

  const ctx = {
    swarm: {
      async db_query({ sql, params = [] }: { sql: string; params?: SQLQueryBindings[] }) {
        const stmt = db.query(sql);
        const rows = stmt.values(...params);
        return { dialect: "sqlite", columns: stmt.columnNames, rows };
      },
    },
  };
  const histogram = await toolUsage({ days: 1 }, ctx);
  const report = await compoundInsights(
    {
      days: 1,
      includeScheduleHealth: false,
      includeScriptCandidates: false,
      includeScriptUsage: false,
      includeCostAndTokens: false,
      includeByAgent: false,
      publishPage: false,
    },
    ctx,
  );

  expect({
    histogram: histogram.tools?.map(({ tool }) => tool),
    reportTools: report.toolUsage.map(({ tool }: { tool: string }) => tool),
    tasks: report.taskSummary.statusCounts,
    staleRefs: report.memoryHealth.pollution.zeroAccessStaleRefs.bySource,
  }).toEqual({
    histogram: ["after"],
    reportTools: ["after"],
    tasks: { completed: 1 },
    staleRefs: { manual: 1 },
  });
});
